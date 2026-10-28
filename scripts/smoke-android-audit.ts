/**
 * Smoke test for the OpenHub -> Android Audit Desk proxy.
 *
 *   npx tsx scripts/smoke-android-audit.ts
 *
 * Requires the desk on ANDROID_AUDIT_DESK_URL (default 127.0.0.1:8765) with at
 * least one snapshot. Exits non-zero if the proxy cannot reach the desk.
 */
import express from 'express';
import { createAndroidAuditRouter } from '../src/routes/androidAudit.js';

const PORT = Number(process.env.SMOKE_PORT || 8899);
const app = express();
app.use('/api', createAndroidAuditRouter({ authMiddleware: (_req, _res, next) => next() }));

const server = app.listen(PORT, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${PORT}/api/android-audit`;
  try {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    console.log('health:', JSON.stringify(health));
    if (!health.ok) throw new Error(health.reason || 'desk offline');

    const profiles = await fetch(`${base}/profiles`).then((r) => r.json());
    const first = profiles.profiles?.[0];
    console.log('profiles:', profiles.profiles?.length ?? 0, first ? `first=#${first.id} ${first.app_name}` : '');

    if (first) {
      const tasks = await fetch(`${base}/report?id=${first.id}&format=agent-json`).then((r) => r.json());
      console.log('agent tasks:', tasks.tasks?.length ?? 0, 'schema:', tasks.schema);
      const md = await fetch(`${base}/report?id=${first.id}&format=agent-md`).then((r) => r.text());
      console.log('agent markdown:', md.split('\n')[0], '| bytes:', md.length);
    }
    console.log('SMOKE OK');
  } catch (err) {
    console.error('SMOKE FAILED:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
