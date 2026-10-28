// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { EditorAgentPanel } from '../src/ide/EditorAgentPanel';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let promptBodies: Array<Record<string, unknown>> = [];
let savedHistory: unknown[] = [];
let abortCalls = 0;

beforeEach(() => {
  promptBodies = [];
  savedHistory = [];
  abortCalls = 0;
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/opencode/status')) {
      return json({ ok: true, data: { available: true, providerCount: 1, version: '1.19.4' } });
    }
    // The live event stream stays open for the life of the panel.
    if (url.includes('/api/opencode/events')) return new Promise<Response>(() => {});
    if (url.endsWith('/api/opencode/sessions') && method === 'POST') {
      return json({ ok: true, data: { id: 'ses_test' } });
    }
    if (url.includes('/sessions/ses_test/prompt') && method === 'POST') {
      promptBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return json({ ok: true, data: {} });
    }
    if (url.includes('/sessions/ses_test/abort') && method === 'POST') {
      abortCalls += 1;
      return json({ ok: true, data: {} });
    }
    if (url.includes('/sessions/ses_saved/messages')) return json({ ok: true, data: savedHistory });
    if (url.includes('/messages')) return json({ ok: true, data: [] });
    if (url.includes('/todos')) return json({ ok: true, data: [] });
    if (url.includes('/permissions')) return json({ ok: true, data: [] });
    return json({ ok: true, data: {} });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function ask(view: ReturnType<typeof render>, text: string) {
  fireEvent.change(view.getByLabelText('Ask the coding agent'), { target: { value: text } });
}

describe('EditorAgentPanel', () => {
  it('starts the native plan agent when plan-first is on', async () => {
    const view = render(React.createElement(EditorAgentPanel, { activeProjectName: 'openhub' }));

    expect(view.getByText('In openhub')).toBeTruthy();
    expect(view.getByText(/Ask the agent to plan/)).toBeTruthy();
    expect(view.getByRole('button', { name: /Plan first/ }).getAttribute('aria-pressed')).toBe('true');

    ask(view, 'Add a health endpoint');
    fireEvent.click(view.getByRole('button', { name: /^Plan$/ }));

    await waitFor(() => expect(promptBodies).toHaveLength(1));
    expect(promptBodies[0].agent).toBe('plan');
    const parts = promptBodies[0].parts as Array<{ text?: string }>;
    expect(parts[0]?.text).toContain('Create an implementation plan');
    expect(parts[0]?.text).toContain('Add a health endpoint');
    await waitFor(() => expect((view.getByLabelText('Ask the coding agent') as HTMLTextAreaElement).value).toBe(''));
  });

  it('restores the durable session and its reply after a reload', async () => {
    const created = Date.now() - 60_000;
    savedHistory = [
      { info: { id: 'msg_u1', role: 'user', time: { created } }, parts: [{ type: 'text', text: 'Saved task' }] },
      {
        info: { id: 'msg_a1', role: 'assistant', time: { created: created + 1_000 }, finish: 'stop' },
        parts: [{ type: 'text', text: 'Saved reply from the durable session.' }],
      },
    ];
    localStorage.setItem('openhub.editor.agent.v1', JSON.stringify({ id: 'ses_saved', goal: 'Saved task', phase: 'done' }));

    const view = render(React.createElement(EditorAgentPanel, {}));

    await waitFor(() => expect(view.getByText('Saved reply from the durable session.')).toBeTruthy());
    expect(view.getByText('Saved task')).toBeTruthy();
    expect((view.getByLabelText('Ask the coding agent') as HTMLTextAreaElement).value).toBe('');
  });

  it('drops an editor selection into the composer without sending it', async () => {
    const seed = 'In `src/greet.ts` (lines 2-2):\n\n```ts\n  return name;\n```\n';
    const view = render(React.createElement(EditorAgentPanel, { seed: { id: 1, text: seed } }));

    await waitFor(() => expect((view.getByLabelText('Ask the coding agent') as HTMLTextAreaElement).value).toBe(seed));
    expect(promptBodies).toHaveLength(0);
  });

  it('interrupts a running turn on Escape', async () => {
    const view = render(React.createElement(EditorAgentPanel, {}));
    ask(view, 'Plan a refactor');
    fireEvent.click(view.getByRole('button', { name: /^Plan$/ }));
    await waitFor(() => expect(promptBodies).toHaveLength(1));

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(abortCalls).toBe(1));
  });

  it('runs the build agent directly when plan-first is off', async () => {
    const view = render(React.createElement(EditorAgentPanel, {}));

    fireEvent.click(view.getByRole('button', { name: /Plan first/ }));
    expect(view.getByRole('button', { name: /Plan first/ }).getAttribute('aria-pressed')).toBe('false');

    ask(view, 'Explain the router');
    fireEvent.click(view.getByRole('button', { name: /^Run$/ }));

    await waitFor(() => expect(promptBodies).toHaveLength(1));
    expect(promptBodies[0].agent).toBe('build');
    const parts = promptBodies[0].parts as Array<{ text?: string }>;
    expect(parts[0]?.text).toBe('Explain the router');
  });
});
