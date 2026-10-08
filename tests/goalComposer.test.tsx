// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { GoalComposer } from '../src/mission/GoalComposer';

const runButton = (view: ReturnType<typeof render>) =>
  view.getByRole('button', { name: /run/i }) as HTMLButtonElement;

afterEach(cleanup);

describe('GoalComposer', () => {
  it('disables Run when the engine is offline', () => {
    const onSubmit = vi.fn();
    const view = render(React.createElement(GoalComposer, { engineOnline: false, onSubmit }));
    expect(runButton(view).disabled).toBe(true);
  });

  it('calls onSubmit with the trimmed goal when Run is clicked', () => {
    const onSubmit = vi.fn();
    const view = render(React.createElement(GoalComposer, { engineOnline: true, onSubmit }));
    const textarea = view.getByPlaceholderText('Describe the mission…');
    fireEvent.change(textarea, { target: { value: '  ship the thing  ' } });
    const button = runButton(view);
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledWith('ship the thing');
  });

  it('keeps Run disabled while the goal is empty even when the engine is online', () => {
    const view = render(React.createElement(GoalComposer, { engineOnline: true, onSubmit: vi.fn() }));
    expect(runButton(view).disabled).toBe(true);
  });
});
