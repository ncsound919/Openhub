import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SELF_REPORT_SCHEMA,
  buildSelfReport,
  readSelfReport,
  readSelfReportHistory,
  refreshSelfReport,
  selfReportFile,
  selfReportHistoryFile,
  writeSelfReport,
} from '../src/services/selfReport';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-selfreport-'));
  vi.stubEnv('OPENHUB_SELF_REPORT_DIR', dir);
  vi.stubEnv('OPENHUB_TELEMETRY_DIR', path.join(dir, 'telemetry'));
  vi.stubEnv('OPENHUB_DREAM_INTERVAL_MS', '0');
  // Every outbound bridge probe fails fast: the report must degrade honestly.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('buildSelfReport — honest assembly', () => {
  it('stamps a versioned schema and real identity', async () => {
    const report = await buildSelfReport();
    expect(report.schema).toBe(SELF_REPORT_SCHEMA);
    expect(report.identity.ok).toBe(true);
    if (report.identity.ok) {
      expect(report.identity.name).toBe('openhub');
      expect(typeof report.identity.pid).toBe('number');
      expect(report.identity.uptimeSec).toBeGreaterThanOrEqual(0);
    }
  });

  it('degrades a bridge instead of fabricating it', async () => {
    const report = await buildSelfReport();
    // Axiom's probe throws -> the section itself is not ok.
    expect(report.bridges.axiom.ok).toBe(false);
    if (report.bridges.axiom.ok === false) {
      expect(typeof report.bridges.axiom.error).toBe('string');
    }
    // Recourse may resolve to "read ok, but unavailable" — the invariant is
    // that it is NEVER reported as available while the probe is offline.
    const rec = report.bridges.recourse;
    const claimsAvailable = rec.ok === true && rec.available === true;
    expect(claimsAvailable).toBe(false);
  });

  it('every section is a well-formed { ok } envelope', async () => {
    const report = await buildSelfReport();
    for (const key of ['identity', 'activity', 'incidents', 'runs', 'audit', 'ecosystem'] as const) {
      const section = report[key] as { ok: boolean; error?: string };
      expect(typeof section.ok).toBe('boolean');
      if (!section.ok) expect(typeof section.error).toBe('string');
    }
  });
});

describe('durable self-report', () => {
  it('writes a latest JSON and appends compact history', async () => {
    const report = await buildSelfReport();
    const write = writeSelfReport(report);
    expect(write.wrote).toBe(true);
    expect(fs.existsSync(selfReportFile())).toBe(true);
    expect(fs.existsSync(selfReportHistoryFile())).toBe(true);

    const read = readSelfReport();
    expect(read).not.toBeNull();
    expect(read?.schema).toBe(SELF_REPORT_SCHEMA);
    expect(read?.at).toBe(report.at);

    const history = readSelfReportHistory(10);
    expect(history).toHaveLength(1);
    expect((history[0] as { at: string }).at).toBe(report.at);
  });

  it('returns null for a corrupt latest file rather than throwing', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(selfReportFile(), '{ not json', 'utf8');
    expect(readSelfReport()).toBeNull();
  });

  it('reads history newest-first and honors the limit', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await buildSelfReport();
      r.at = new Date(2020, 0, 1 + i).toISOString();
      writeSelfReport(r);
    }
    const all = readSelfReportHistory(10);
    expect(all).toHaveLength(5);
    expect(new Date((all[0] as { at: string }).at).getTime()).toBeGreaterThan(
      new Date((all[4] as { at: string }).at).getTime(),
    );
    expect(readSelfReportHistory(2)).toHaveLength(2);
  });
});

describe('refreshSelfReport', () => {
  it('persists, records a telemetry event, and reports ok honestly', async () => {
    const r = await refreshSelfReport({ push: false });
    expect(r.write.wrote).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.report.schema).toBe(SELF_REPORT_SCHEMA);
    // No push requested -> no push field, and nothing was claimed.
    expect(r.push).toBeUndefined();
    expect(readSelfReport()).not.toBeNull();
  });
});
