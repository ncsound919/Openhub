// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { MissionStatusHeader, formatElapsed } from '../src/mission/MissionStatusHeader';
import type { Mission } from '../src/lib/missionStore.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const mk = (over: Partial<Mission>): Mission => ({
  id: 'm1',
  goal: 'ship it',
  sessionId: null,
  status: 'running',
  createdAt: new Date(Date.now() - 65_000).toISOString(),
  ...over,
});

describe('MissionStatusHeader', () => {
  it('renders the status word and a ticking mm:ss elapsed', () => {
    const fixed = Date.parse('2026-10-07T12:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(fixed);
    const view = render(
      React.createElement(MissionStatusHeader, {
        mission: mk({ status: 'running', createdAt: new Date(fixed - 65_000).toISOString() }),
      }),
    );
    expect(view.getByText('running')).toBeTruthy();
    expect(view.getByLabelText('elapsed time').textContent).toBe('01:05');
  });

  it('shows the running pulse class so reduced-motion CSS can disable it', () => {
    const view = render(React.createElement(MissionStatusHeader, { mission: mk({ status: 'running' }) }));
    expect(view.container.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('renders a calm empty header and does not crash with no mission', () => {
    const view = render(React.createElement(MissionStatusHeader, { mission: null }));
    expect(view.getByText('No active mission')).toBeTruthy();
  });

  it('formats elapsed as mm:ss and h:mm:ss', () => {
    expect(formatElapsed(65_000)).toBe('01:05');
    expect(formatElapsed(3_665_000)).toBe('1:01:05');
    expect(formatElapsed(-5)).toBe('00:00');
  });
});
