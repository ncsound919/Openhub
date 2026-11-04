import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTondoResearch,
  describeTondoResearch,
  TondoResearchError,
} from '../orchestrator/services/tondoResearch';

let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function serve(
  status: number,
  response: string,
  capture: { body?: string; headers?: Record<string, string> },
): Promise<string> {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      capture.body = body;
      capture.headers = Object.fromEntries(
        Object.entries(req.headers).map(([key, value]) => [
          key,
          Array.isArray(value) ? value[0] : String(value ?? ''),
        ]),
      );
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(response);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe('Tondo research client', () => {
  it('sends the app identity and parses the cited answer', async () => {
    const capture: { body?: string; headers?: Record<string, string> } = {};
    const baseUrl = await serve(
      200,
      JSON.stringify({
        requestId: 'req-1',
        app: 'openhub',
        service: 'tondo',
        operation: 'build diagnosis',
        question: 'Why did the build fail?',
        status: 'assisted',
        summary: 'The failure is a missing peer dependency.',
        findings: [
          { claim: 'The lockfile is stale.', support: 'model_prior', confidence: 0.5, kind: 'mechanism' },
        ],
        actions: [{ step: 'Regenerate the lockfile.', why: 'It predates the dependency.', risk: 'low' }],
        unresolved: [],
        citations: [],
        escalate: false,
        lane: 'mesh',
        latencyMs: 12,
      }),
      capture,
    );

    const tondo = createTondoResearch({ baseUrl, appId: 'openhub', token: 'device-key' });
    const result = await tondo.assist({
      operation: 'build diagnosis',
      question: 'Why did the build fail?',
      symptom: 'npm ci exited 1',
    });

    expect(result.status).toBe('assisted');
    expect(result.findings[0].claim).toContain('lockfile');
    expect(describeTondoResearch(result)).toContain('Tondo assisted');
    expect(JSON.parse(capture.body!)).toMatchObject({
      app: 'openhub',
      operation: 'build diagnosis',
      data_class: 'internal',
    });
    expect(capture.headers?.['x-tondo-app']).toBe('openhub');
    expect(capture.headers?.authorization).toBe('Bearer device-key');
  });

  it('surfaces the structured refusal', async () => {
    const baseUrl = await serve(
      422,
      JSON.stringify({
        error: 'phi_not_allowed',
        detail: 'de-identify the question or use the on-device lane',
      }),
      {},
    );
    const tondo = createTondoResearch({ baseUrl, appId: 'openhub', token: 'device-key' });
    await expect(
      tondo.assist({ operation: 'diagnosis', question: 'patient case', dataClass: 'phi' }),
    ).rejects.toMatchObject({ status: 422, code: 'phi_not_allowed' });
  });

  it('fails locally when no endpoint or key is configured', () => {
    const tondo = createTondoResearch({ baseUrl: '', appId: 'openhub', token: '' });
    expect(() => tondo.assist({ operation: 'diagnosis', question: 'why' })).toThrow(
      TondoResearchError,
    );
  });
});
