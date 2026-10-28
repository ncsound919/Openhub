// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { MissionTranscript } from '../src/mission/MissionTranscript';

afterEach(cleanup);

describe('MissionTranscript', () => {
  it('renders the agent reply and the tools it ran', () => {
    const view = render(
      React.createElement(MissionTranscript, {
        status: 'done',
        entries: [
          { id: 'msg_u', role: 'user', text: 'create final-gpu.txt', tools: [] },
          {
            id: 'msg_a',
            role: 'assistant',
            text: 'Added final-gpu.txt containing “Adreno GPU verified”.',
            tools: [{ id: 'prt_tool', name: 'write', title: 'final-gpu.txt', status: 'completed' }],
          },
        ],
      }),
    );

    expect(view.getByText('create final-gpu.txt')).toBeTruthy();
    expect(view.getByText('Added final-gpu.txt containing “Adreno GPU verified”.')).toBeTruthy();
    expect(view.getByText('write · final-gpu.txt')).toBeTruthy();
    expect(view.getByText('completed')).toBeTruthy();
  });

  it('shows that the agent is working before the first response', () => {
    const view = render(React.createElement(MissionTranscript, { status: 'running', entries: [] }));
    expect(view.getByText(/Agent is working/)).toBeTruthy();
  });

  it('does not pretend a finished mission replied when history is empty', () => {
    const view = render(React.createElement(MissionTranscript, { status: 'done', entries: [] }));
    expect(view.getByText(/No response was recorded/)).toBeTruthy();
  });

  it('shows the session error above the conversation', () => {
    const view = render(
      React.createElement(MissionTranscript, { status: 'failed', entries: [], error: 'ProviderNoProvidersError' }),
    );
    expect(view.getByRole('alert').textContent).toContain('ProviderNoProvidersError');
  });
});
