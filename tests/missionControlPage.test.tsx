// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MissionControlPage } from '../src/mission/MissionControlPage';
import { useMissionStore } from '../src/lib/missionStore.js';

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A stream that never enqueues or closes, so a subscription stays open. */
function neverEndingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start() {} });
}

interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
}

/**
 * A fetch mock covering the page's calls. `overrides` are matched first by URL
 * substring so a test can force one endpoint to fail.
 */
function makeFetch(
  overrides: Record<string, (url: string, init?: RequestInit) => Response | Promise<Response>> = {},
) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url: u, method, body });

    for (const key of Object.keys(overrides)) {
      if (u.includes(key)) return overrides[key](u, init);
    }
    if (u.includes('/api/opencode/status')) return jsonRes({ ok: true, data: { available: true } });
    if (u.includes('/api/opencode/events')) return new Response(neverEndingStream(), { status: 200 });
    if (u.endsWith('/api/opencode/sessions') && method === 'POST') {
      return jsonRes({ ok: true, data: { id: 'ses_new' } });
    }
    if (u.includes('/abort')) return jsonRes({ ok: true, data: {} });
    if (u.includes('/prompt')) return jsonRes({ ok: true, data: {} });
    if (u.includes('/diff')) return jsonRes({ ok: true, data: [] });
    if (u.includes('/todos')) return jsonRes({ ok: true, data: [] });
    if (u.includes('/api/opencode/sessions')) return jsonRes({ ok: true, data: [] });
    return jsonRes({ ok: true, data: {} });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

function seedRunning(id: string) {
  useMissionStore.setState({
    missions: [{ id, goal: 'seeded mission', sessionId: id, status: 'running', createdAt: new Date().toISOString() }],
    activeId: id,
    events: {},
  });
}

beforeEach(() => useMissionStore.getState().clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MissionControlPage', () => {
  it('onSubmit creates a session, then prompts it, moving the mission to running', async () => {
    const { calls } = makeFetch();
    const view = render(React.createElement(MissionControlPage));

    const input = await view.findByLabelText('Mission goal');
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));

    fireEvent.change(input, { target: { value: 'ship the fix' } });
    fireEvent.click(view.getByRole('button', { name: /^run$/i }));

    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith('/api/opencode/sessions') && c.method === 'POST')).toBe(true);
    });
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/prompt') && c.method === 'POST')).toBe(true);
    });

    const created = calls.find((c) => c.url.endsWith('/api/opencode/sessions') && c.method === 'POST');
    expect(created?.body).toEqual({ title: 'ship the fix' });
    expect(useMissionStore.getState().missions.find((m) => m.id === 'ses_new')?.status).toBe('running');
  });

  it('onStop marks the mission done only after the abort succeeds', async () => {
    seedRunning('ses_run');
    const { calls } = makeFetch();
    const view = render(React.createElement(MissionControlPage));

    fireEvent.click(await view.findByRole('button', { name: /stop/i }));

    await waitFor(() => {
      expect(useMissionStore.getState().missions.find((m) => m.id === 'ses_run')?.status).toBe('done');
    });
    expect(calls.some((c) => c.url.includes('/abort') && c.method === 'POST')).toBe(true);
  });

  it('onStop keeps running and surfaces the error when the abort fails', async () => {
    seedRunning('ses_run');
    makeFetch({ '/abort': () => jsonRes({ ok: false, error: 'abort refused' }) });
    const view = render(React.createElement(MissionControlPage));

    fireEvent.click(await view.findByRole('button', { name: /stop/i }));

    expect(await view.findByText(/abort refused/i)).toBeTruthy();
    expect(useMissionStore.getState().missions.find((m) => m.id === 'ses_run')?.status).toBe('running');
  });
});
