// Pure tests for the delta-application / "show the ghost or not" decision that
// the Monaco provider uses to turn streamed completions into ghost text.
import { describe, it, expect } from 'vitest';
import {
  createCompletionStreamState,
  reduceCompletionEvent,
  decideGhostText,
} from '../src/ide/completionStream';

describe('reduceCompletionEvent + decideGhostText', () => {
  it('shows accumulated local-model text and truncates in single-line mode', () => {
    let state = createCompletionStreamState();
    state = reduceCompletionEvent(state, { type: 'delta', text: 'const x', source: 'local-model', firstTokenMs: 18 });
    expect(decideGhostText(state)).toEqual({ show: true, text: 'const x' });
    expect(state.meta.firstTokenMs).toBe(18);

    state = reduceCompletionEvent(state, { type: 'delta', text: 'const x = 1\nconst y', source: 'local-model' });
    expect(decideGhostText(state)).toEqual({ show: true, text: 'const x = 1\nconst y' });
    expect(decideGhostText(state, { singleLine: true })).toEqual({ show: true, text: 'const x = 1' });
  });

  it('never shows text for a non-local source (unavailable model stays silent)', () => {
    let state = createCompletionStreamState();
    state = reduceCompletionEvent(state, { type: 'done', text: 'ghost', source: 'none' });
    expect(decideGhostText(state)).toEqual({ show: false, text: '' });
  });

  it('keeps earlier metadata when a later frame omits it, and done carries the final text', () => {
    let state = createCompletionStreamState();
    state = reduceCompletionEvent(state, { type: 'delta', text: 'a', source: 'local-model', firstTokenMs: 5 });
    state = reduceCompletionEvent(state, { type: 'done', text: 'abc', lane: 'fim' });
    expect(state.phase).toBe('done');
    expect(state.text).toBe('abc');
    expect(state.meta.source).toBe('local-model');
    expect(state.meta.lane).toBe('fim');
    expect(decideGhostText(state)).toEqual({ show: true, text: 'abc' });
  });

  it('does not wipe accumulated text on an empty delta', () => {
    let state = createCompletionStreamState();
    state = reduceCompletionEvent(state, { type: 'delta', text: 'partial', source: 'local-model' });
    state = reduceCompletionEvent(state, { type: 'delta', text: '', source: 'local-model' });
    expect(state.text).toBe('partial');
  });

  it('records a terminal error without showing ghost text', () => {
    let state = createCompletionStreamState();
    state = reduceCompletionEvent(state, { type: 'error', message: 'boom' });
    expect(state.phase).toBe('error');
    expect(state.error).toBe('boom');
    expect(decideGhostText(state)).toEqual({ show: false, text: '' });
  });
});
