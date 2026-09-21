import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Deterministic local channel — an ntfy-compatible message bus hosted inside
 * OpenHub. Open-Chat's built-in ntfy protocol subscribes to it, so Draymond,
 * Hermes, and the operator share one local-first channel with no third-party
 * server and no exposed secrets.
 *
 * Contract (matches what src/protocols/NtfyClient.js expects):
 *   - Publish:   POST  {base}          JSON { topic, title?, message, priority?, tags? }
 *   - Subscribe: GET   {base}/{topic}/json   NDJSON, one message object per line
 *
 * Messages are also appended to a JSONL file (best-effort) so history survives a
 * restart. In-memory ring buffer bounds memory.
 */

export interface ChannelMessage {
  id: string;
  time: number;
  topic: string;
  title?: string;
  message: string;
  priority?: number;
  tags?: string[];
}

export interface PublishInput {
  topic: string;
  message: string;
  title?: string;
  priority?: number;
  tags?: string[];
}

const MAX_PER_TOPIC = 500;
const subscribers = new Map<string, Set<(m: ChannelMessage) => void>>();
const buffers = new Map<string, ChannelMessage[]>();

function normalizeTopic(topic: string): string {
  return String(topic || '').trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
}

function channelDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENHUB_CHANNEL_DIR || path.join(process.cwd(), 'data', 'channel');
}

function appendJsonl(msg: ChannelMessage, env: NodeJS.ProcessEnv): void {
  try {
    const dir = channelDir(env);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${msg.topic}.jsonl`), `${JSON.stringify(msg)}\n`);
  } catch {
    /* best-effort history; never fail a publish on disk */
  }
}

/** Publish a message to a topic. Returns the stored message (with id/time). */
export function publishToChannel(input: PublishInput, env: NodeJS.ProcessEnv = process.env): ChannelMessage {
  const topic = normalizeTopic(input.topic);
  const msg: ChannelMessage = {
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 20),
    time: Math.floor(Date.now() / 1000),
    topic,
    message: String(input.message ?? ''),
    ...(input.title !== undefined ? { title: String(input.title) } : {}),
    ...(input.priority !== undefined ? { priority: Number(input.priority) } : {}),
    ...(Array.isArray(input.tags) ? { tags: input.tags.slice(0, 5).map(String) } : {}),
  };

  const buf = buffers.get(topic) ?? [];
  buf.push(msg);
  if (buf.length > MAX_PER_TOPIC) buf.splice(0, buf.length - MAX_PER_TOPIC);
  buffers.set(topic, buf);
  appendJsonl(msg, env);

  for (const push of subscribers.get(topic) ?? []) {
    try { push(msg); } catch { /* a slow subscriber must not break publishing */ }
  }
  return msg;
}

/** Recent messages for a topic (newest last). Reads disk once when memory is cold. */
export function channelHistory(topic: string, limit = 100, env: NodeJS.ProcessEnv = process.env): ChannelMessage[] {
  const t = normalizeTopic(topic);
  if (!buffers.has(t)) {
    const out: ChannelMessage[] = [];
    try {
      const file = path.join(channelDir(env), `${t}.jsonl`);
      if (fs.existsSync(file)) {
        const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines.slice(-MAX_PER_TOPIC)) {
          try { out.push(JSON.parse(line) as ChannelMessage); } catch { /* skip */ }
        }
      }
    } catch { /* no history */ }
    buffers.set(t, out);
  }
  const buf = buffers.get(t) ?? [];
  return buf.slice(-Math.max(0, limit));
}

/** Subscribe to live messages on a topic. Returns an unsubscribe function. */
export function subscribeToChannel(topic: string, onMessage: (m: ChannelMessage) => void): () => void {
  const t = normalizeTopic(topic);
  let set = subscribers.get(t);
  if (!set) { set = new Set(); subscribers.set(t, set); }
  set.add(onMessage);
  return () => {
    const current = subscribers.get(t);
    if (!current) return;
    current.delete(onMessage);
    if (current.size === 0) subscribers.delete(t);
  };
}

/** Topics with message counts + last activity (for the UI). */
export function channelTopics(env: NodeJS.ProcessEnv = process.env): Array<{ topic: string; count: number; lastAt: number | null }> {
  const dir = channelDir(env);
  const topics = new Map<string, { count: number; lastAt: number | null }>();
  for (const [topic, buf] of buffers.entries()) {
    topics.set(topic, { count: buf.length, lastAt: buf.length ? buf[buf.length - 1].time : null });
  }
  try {
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.jsonl')) continue;
        const topic = file.slice(0, -'.jsonl'.length);
        if (topics.has(topic)) continue;
        const lines = fs.readFileSync(path.join(dir, file), 'utf-8').split('\n').filter(Boolean);
        let lastAt: number | null = null;
        if (lines.length) {
          try { lastAt = (JSON.parse(lines[lines.length - 1]) as ChannelMessage).time; } catch { /* ignore */ }
        }
        topics.set(topic, { count: lines.length, lastAt });
      }
    }
  } catch { /* no dir */ }
  return [...topics.entries()].map(([topic, v]) => ({ topic, ...v })).sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
}

/** Resolve an ntfy `since` query value to a lower-bound timestamp (seconds). */
export function resolveSince(since: string | undefined, nowMs = Date.now()): number {
  if (!since) return 0;
  const duration = /^(\d+)(ms|s|m|h|d)$/.exec(since.trim());
  if (duration) {
    const n = Number(duration[1]);
    const unit = duration[2];
    const ms = unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000;
    return Math.floor((nowMs - ms) / 1000);
  }
  // Unknown form (e.g. a message id): return everything we have.
  return 0;
}
