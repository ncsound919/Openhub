// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRecallPanel } from '../src/components/MemoryRecallPanel';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const RECALL_OK = {
  ok: true,
  query: 'how do approvals work',
  k: 8,
  gateway: 'https://mobile-gateway.tap4500.workers.dev',
  results: {
    sieve: {
      source: 'sieve',
      available: true,
      endpoint: 'https://mobile-gateway.tap4500.workers.dev/v1/sieve/recall',
      latencyMs: 812,
      status: 200,
      hits: [
        {
          id: 'src/auth.ts:42',
          text: 'the agent asks for bash approval before running shell commands',
          score: 0.83,
          path: 'src/auth.ts',
          line: 42,
          layers: ['code'],
        },
      ],
      layers: {
        code: { available: true, count: 1, mode: 'hybrid' },
        recourse: { available: false, count: 0, reason: 'recourse unreachable' },
      },
    },
    recourse: {
      source: 'recourse',
      available: true,
      endpoint: 'https://mobile-gateway.tap4500.workers.dev/v1/recourse/recall',
      latencyMs: 901,
      status: 200,
      hits: [{ id: 'lesson-1', text: 'a durable lesson about approvals', score: 0.7, kind: 'lesson' }],
    },
  },
};

const RECALL_OFFLINE = {
  ok: false,
  query: 'x',
  k: 8,
  gateway: 'https://mobile-gateway.tap4500.workers.dev',
  error: 'Every requested memory bridge is offline — see each reason.',
  results: {
    sieve: {
      source: 'sieve',
      available: false,
      endpoint: 'https://mobile-gateway.tap4500.workers.dev/v1/sieve/recall',
      latencyMs: 12,
      status: 503,
      hits: [],
      reason: 'SIEVE_URL not configured',
    },
  },
};

let bodies: Array<Record<string, unknown>> = [];

function stubFetch(reply: () => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return reply();
    }),
  );
}

async function submit(view: ReturnType<typeof render>, text = 'how do approvals work') {
  fireEvent.change(view.getByLabelText('Recall query'), { target: { value: text } });
  fireEvent.click(view.getByRole('button', { name: /Recall/ }));
}

beforeEach(() => {
  bodies = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MemoryRecallPanel', () => {
  it('shows an idle prompt and does not call the server on mount', () => {
    stubFetch(() => json(RECALL_OK));
    const view = render(React.createElement(MemoryRecallPanel));
    expect(view.getByText(/No recall yet/)).toBeTruthy();
    expect(bodies).toHaveLength(0);
  });

  it('refuses an empty query without hitting the server', () => {
    stubFetch(() => json(RECALL_OK));
    const view = render(React.createElement(MemoryRecallPanel));
    fireEvent.click(view.getByRole('button', { name: /Recall/ }));
    expect(view.getByText(/recall needs a query/)).toBeTruthy();
    expect(bodies).toHaveLength(0);
  });

  it('sends the query with the chosen scope and renders both sources', async () => {
    stubFetch(() => json(RECALL_OK));
    const view = render(React.createElement(MemoryRecallPanel));

    fireEvent.click(view.getByRole('button', { name: 'Recourse' }));
    await submit(view);

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ query: 'how do approvals work', source: 'recourse', k: 8 });

    expect(await view.findByText(/the agent asks for bash approval/)).toBeTruthy();
    expect(view.getByText(/a durable lesson about approvals/)).toBeTruthy();
    expect(view.getByText(/via mobile-gateway.tap4500.workers.dev/)).toBeTruthy();
    // Sieve's honest per-layer state is surfaced, not hidden.
    expect(view.getByText('recourse unavailable')).toBeTruthy();
    expect(view.getByText('code:1')).toBeTruthy();
  });

  it('expands a hit to reveal its full text', async () => {
    stubFetch(() => json(RECALL_OK));
    const view = render(React.createElement(MemoryRecallPanel));
    await submit(view);

    const hit = await view.findByRole('button', { name: /the agent asks for bash approval/ });
    expect(hit.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(hit);
    expect(hit.getAttribute('aria-expanded')).toBe('true');
  });

  it('surfaces the offline reason instead of an empty success', async () => {
    stubFetch(() => json(RECALL_OFFLINE, 503));
    const view = render(React.createElement(MemoryRecallPanel));
    await submit(view, 'x');

    // Wait for the offline banner (the header copy also says "offline").
    await view.findByText(/Every requested memory bridge is offline/);
    expect(view.getAllByText(/offline/i).length).toBeGreaterThan(0);
    expect(view.getByText('SIEVE_URL not configured')).toBeTruthy();
    expect(view.queryByText(/Answered, but nothing matched/)).toBeNull();
  });

  it('reports a server-side error payload without fabricating results', async () => {
    stubFetch(() => json({ ok: false, error: 'OPENHUB_MOBILE_GATEWAY_URL is not set' }, 503));
    const view = render(React.createElement(MemoryRecallPanel));
    await submit(view, 'x');

    expect(await view.findByText(/OPENHUB_MOBILE_GATEWAY_URL is not set/)).toBeTruthy();
    expect(view.getByText(/No recall yet/)).toBeTruthy();
  });
});