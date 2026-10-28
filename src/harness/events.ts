import type { Response } from 'express';

/**
 * One SSE stream per chat session. Named events + id/retry + a heartbeat, per
 * the MDN event-stream format. Browsers on HTTP/1.1 cap connections per domain,
 * so this is deliberately one stream, not one per tool card.
 */

type Subscriber = Response;
const subscribers = new Map<string, Set<Subscriber>>();
const sequence = new Map<string, number>();

export function serializeEvent(type: string, id: number, data: unknown): string {
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function publish(sessionId: string, type: string, data: unknown): void {
  const set = subscribers.get(sessionId);
  if (!set || set.size === 0) return;
  const next = (sequence.get(sessionId) ?? 0) + 1;
  sequence.set(sessionId, next);
  const frame = serializeEvent(type, next, data);
  for (const res of set) {
    try {
      res.write(frame);
    } catch {
      set.delete(res);
    }
  }
}

export function subscribe(sessionId: string, res: Response): () => void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();

  const set = subscribers.get(sessionId) ?? new Set<Subscriber>();
  set.add(res);
  subscribers.set(sessionId, set);

  const current = sequence.get(sessionId) ?? 0;
  res.write(`retry: 3000\nid: ${current}\nevent: ready\ndata: ${JSON.stringify({ sessionId })}\n\n`);

  let closed = false;
  let cleanup: () => void = () => {};

  const heartbeat = setInterval(() => {
    try {
      res.write(`: keep-alive ${Date.now()}\n\n`);
    } catch {
      cleanup();
    }
  }, 15_000);

  cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    set.delete(res);
    if (set.size === 0) subscribers.delete(sessionId);
  };

  res.on('close', cleanup);
  res.on('error', cleanup);

  return cleanup;
}

/** Test seam. */
export function subscriberCount(sessionId: string): number {
  return subscribers.get(sessionId)?.size ?? 0;
}
