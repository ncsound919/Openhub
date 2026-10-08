import { describe, it, expect } from 'vitest';
import { parseEventFrame } from '../src/mission/useMission.js';

describe('parseEventFrame', () => {
  it('parses a session-scoped text event', () => {
    const e = parseEventFrame(JSON.stringify({ type: 'session.updated.1', sessionID: 'ses_1', data: { text: 'hello' } }));
    expect(e?.kind).toBe('session.updated');
    expect(e?.text).toBe('hello');
  });
  it('reads sessionID from properties', () => {
    const e = parseEventFrame(JSON.stringify({ type: 'message.part.updated', properties: { sessionID: 'ses_2', text: 'x' } }));
    expect(e?.kind).toBe('message.part.updated');
  });
  it('returns null on garbage', () => {
    expect(parseEventFrame('not json')).toBeNull();
    expect(parseEventFrame('')).toBeNull();
  });
});
