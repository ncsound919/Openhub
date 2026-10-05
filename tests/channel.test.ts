import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import {
  publishToChannel,
  channelHistory,
  subscribeToChannel,
  channelTopics,
  resolveSince,
} from '../src/services/channel';
import { createNtfyRouter } from '../src/routes/ntfy';

const NTFY_TEST_TOKEN = 'test-ntfy-token';
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-channel-'));
  process.env.OPENHUB_CHANNEL_DIR = dir;
  // The ntfy router fails closed: with no token configured it refuses every
  // request, so the HTTP cases configure one explicitly.
  process.env.OPENHUB_NTFY_TOKEN = NTFY_TEST_TOKEN;
  delete process.env.OPENHUB_NTFY_ALLOW_ANONYMOUS;
});

afterEach(() => {
  delete process.env.OPENHUB_CHANNEL_DIR;
  delete process.env.OPENHUB_NTFY_TOKEN;
  delete process.env.OPENHUB_NTFY_ALLOW_ANONYMOUS;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('channel store', () => {
  it('publishes, persists, and returns history', () => {
    const msg = publishToChannel({ topic: 'reports', title: 't', message: 'hello' });
    expect(msg.id).toHaveLength(20);
    expect(msg.topic).toBe('reports');
    const history = channelHistory('reports');
    expect(history).toHaveLength(1);
    expect(history[0].message).toBe('hello');
    expect(fs.existsSync(path.join(dir, 'reports.jsonl'))).toBe(true);
  });

  it('sanitizes topics and lists them', () => {
    publishToChannel({ topic: 'a b/c!', message: 'x' });
    const topics = channelTopics();
    expect(topics.map((t) => t.topic)).toContain('a_b_c_');
  });

  it('delivers live messages to subscribers and unsubscribes', () => {
    const seen: string[] = [];
    const off = subscribeToChannel('live', (m) => seen.push(m.message));
    publishToChannel({ topic: 'live', message: 'one' });
    publishToChannel({ topic: 'live', message: 'two' });
    off();
    publishToChannel({ topic: 'live', message: 'three' });
    expect(seen).toEqual(['one', 'two']);
  });

  it('resolves ntfy `since` durations', () => {
    const now = 1_700_000_000_000;
    expect(resolveSince('10m', now)).toBe(Math.floor((now - 600_000) / 1000));
    expect(resolveSince('1h', now)).toBe(Math.floor((now - 3_600_000) / 1000));
    expect(resolveSince('abc', now)).toBe(0);
  });
});

describe('ntfy-compatible router (Open-Chat ingress)', () => {
  const app = express();
  app.use(express.json());
  app.use('/ntfy', createNtfyRouter());

  const bearer = `Bearer ${NTFY_TEST_TOKEN}`;

  it('refuses every request when no token is configured', async () => {
    // Regression: an unset token used to mean "no auth needed", publishing an
    // unauthenticated read/write message bus on whatever interface OpenHub was
    // bound to.
    delete process.env.OPENHUB_NTFY_TOKEN;
    const res = await request(app).post('/ntfy').send({ topic: 'openhub-reports', message: 'x' });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const res = await request(app)
      .post('/ntfy')
      .set('authorization', 'Bearer not-the-token')
      .send({ topic: 'openhub-reports', message: 'x' });
    expect(res.status).toBe(401);
  });

  it('publishes and reads back over the ntfy contract', async () => {
    const pub = await request(app)
      .post('/ntfy')
      .set('authorization', bearer)
      .send({ topic: 'openhub-reports', title: 'Report', message: 'line one' });
    expect(pub.status).toBe(200);
    expect(pub.body.event).toBe('message');
    expect(pub.body.id).toBeTruthy();

    const poll = await request(app)
      .get('/ntfy/openhub-reports/json?poll=1')
      .set('authorization', bearer);
    expect(poll.status).toBe(200);
    const lines = String(poll.text).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe('message');
    expect(lines[0].title).toBe('Report');
    expect(lines[0].message).toBe('line one');
  });

  it('rejects a publish missing topic or message', async () => {
    const res = await request(app)
      .post('/ntfy')
      .set('authorization', bearer)
      .send({ topic: 'x' });
    expect(res.status).toBe(400);
  });
});
