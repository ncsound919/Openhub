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
  it('reads sessionID nested under properties.info, and title as text', () => {
    const e = parseEventFrame(JSON.stringify({
      type: 'message.updated.1',
      properties: { info: { sessionID: 'ses_nested', title: 'planning' } },
    }));
    expect(e?.sessionId).toBe('ses_nested');
    expect(e?.text).toBe('planning');
  });
  it('reads sessionID nested under properties.part and part text', () => {
    const e = parseEventFrame(JSON.stringify({
      type: 'message.part.updated',
      properties: { part: { sessionID: 'ses_part', text: 'chunk' } },
    }));
    expect(e?.sessionId).toBe('ses_part');
    expect(e?.text).toBe('chunk');
  });
  it('reads sessionID from properties.info.id fallback', () => {
    const e = parseEventFrame(JSON.stringify({
      type: 'message.updated',
      properties: { info: { id: 'ses_id' } },
    }));
    expect(e?.sessionId).toBe('ses_id');
  });
  it('returns null on garbage', () => {
    expect(parseEventFrame('not json')).toBeNull();
    expect(parseEventFrame('')).toBeNull();
  });
});
