// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { MissionRail } from '../src/mission/MissionRail';
import type { Mission } from '../src/lib/missionStore.js';

afterEach(cleanup);

const mission = (over: Partial<Mission>): Mission => ({
  id: 'm1',
  goal: 'g',
  sessionId: null,
  status: 'done',
  createdAt: new Date().toISOString(),
  ...over,
});

describe('MissionRail', () => {
  it('renders a row per mission, newest first, with a count', () => {
    const missions = [
      mission({ id: 'old', goal: 'old goal', createdAt: '2026-10-01T00:00:00.000Z' }),
      mission({ id: 'new', goal: 'new goal', createdAt: '2026-10-07T00:00:00.000Z' }),
    ];
    const view = render(React.createElement(MissionRail, { missions, activeId: null, onSelect: vi.fn() }));
    expect(view.getByText('old goal')).toBeTruthy();
    expect(view.getByText('new goal')).toBeTruthy();
    expect(view.getByText('2')).toBeTruthy();
    const buttons = view.getAllByRole('button');
    expect(buttons[0].textContent).toContain('new goal');
  });

  it('renders the empty state when there are no missions', () => {
    const view = render(React.createElement(MissionRail, { missions: [], activeId: null, onSelect: vi.fn() }));
    expect(view.getByText('No missions yet')).toBeTruthy();
  });

  it('fires onSelect with the mission id when a row is clicked', () => {
    const onSelect = vi.fn();
    const missions = [mission({ id: 'abc', goal: 'click me' })];
    const view = render(React.createElement(MissionRail, { missions, activeId: null, onSelect }));
    fireEvent.click(view.getByRole('button', { name: /click me/i }));
    expect(onSelect).toHaveBeenCalledWith('abc');
  });
});
