import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  MAX_BRAIN_FILE_BYTES,
  resolveDraymondDir,
  recordPipelineLesson,
  recordAuditEvent,
} from '../src/services/ecosystemMemory';
import type {
  AuditEventRecord,
  PipelineLessonRecord,
} from '../src/services/ecosystemMemory';

const LESSON_ID_RE = /^lesson-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECAP_ID_RE = /^recap-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('ecosystemMemory (dual-write fleet memory)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecosystem-memory-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('recordPipelineLesson creates learning-lessons.json with one lesson record', () => {
    const env = { OPENHUB_DRAYMOND_DIR: tmp };
    const res = recordPipelineLesson(
      { id: 'run-123', status: 'completed', repoId: 'acme/web', pillar: 'Uplift Health' },
      env,
    );
    expect(res.wrote).toBe(true);
    expect(res.file).toBe(path.join(tmp, 'learning-lessons.json'));
    expect(res.error).toBeUndefined();

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmp, 'learning-lessons.json'), 'utf-8'),
    ) as { lessons: PipelineLessonRecord[] };
    expect(onDisk.lessons).toHaveLength(1);
    const rec = onDisk.lessons[0];
    expect(rec.id).toMatch(LESSON_ID_RE);
    expect(rec.agentId).toBe('openhub');
    expect(rec.pattern).toBe('pipeline.completed');
    expect(rec.lesson).toBe('Pipeline run-123 finished completed');
    expect(rec.evidenceCount).toBe(1);
    expect(rec.source).toBe('pipeline');
    expect(new Date(rec.lastSeen).getTime()).not.toBeNaN();
    expect(rec.repoId).toBe('acme/web');
    expect(rec.pillar).toBe('Uplift Health');
  });

  it('appends inside object-wrapped brain files (real fleet format: {\"lessons\":[...]})', () => {
    const env = { OPENHUB_DRAYMOND_DIR: tmp };
    // Real fleet files are object-wrapped, not top-level arrays.
    fs.writeFileSync(
      path.join(tmp, 'learning-lessons.json'),
      JSON.stringify({ lessons: [{ id: 'existing', agentId: 'fleet' }] }, null, 2),
    );
    fs.writeFileSync(
      path.join(tmp, 'recaps.json'),
      JSON.stringify({ recaps: [{ id: 'existing-recap' }] }, null, 2),
    );

    const lesson = recordPipelineLesson({ id: 'run-9', status: 'failed' }, env);
    expect(lesson.wrote).toBe(true);
    const recap = recordAuditEvent({ userId: 'u1', action: 'security.file_scan' }, env);
    expect(recap.wrote).toBe(true);

    const lessons = JSON.parse(fs.readFileSync(path.join(tmp, 'learning-lessons.json'), 'utf-8'));
    expect(lessons.lessons).toHaveLength(2); // existing fleet record preserved
    expect(lessons.lessons[1].agentId).toBe('openhub');

    const recaps = JSON.parse(fs.readFileSync(path.join(tmp, 'recaps.json'), 'utf-8'));
    expect(recaps.recaps).toHaveLength(2);
  });

  it('appends a SECOND lesson record on the next call (append-only: first stays intact)', () => {
    const env = { OPENHUB_DRAYMOND_DIR: tmp };
    const first = recordPipelineLesson({ id: 'run-1', status: 'completed' }, env);
    expect(first.wrote).toBe(true);
    const second = recordPipelineLesson({ id: 'run-2', status: 'failed' }, env);
    expect(second.wrote).toBe(true);

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmp, 'learning-lessons.json'), 'utf-8'),
    ) as { lessons: PipelineLessonRecord[] };
    expect(onDisk.lessons).toHaveLength(2);
    expect(onDisk.lessons[0].lesson).toBe('Pipeline run-1 finished completed');
    expect(onDisk.lessons[0].pattern).toBe('pipeline.completed');
    expect(onDisk.lessons[1].lesson).toBe('Pipeline run-2 finished failed');
    expect(onDisk.lessons[1].pattern).toBe('pipeline.failed');
    expect(onDisk.lessons[0].id).not.toBe(onDisk.lessons[1].id);
  });

  it('recordAuditEvent appends an audit recap to recaps.json', () => {
    const env = { OPENHUB_DRAYMOND_DIR: tmp };
    const res = recordAuditEvent(
      { userId: 'user-42', action: 'pipeline.run.finalized', details: 'run-7 took 84s', repoId: 'acme/web' },
      env,
    );
    expect(res.wrote).toBe(true);
    expect(res.file).toBe(path.join(tmp, 'recaps.json'));

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmp, 'recaps.json'), 'utf-8'),
    ) as { recaps: AuditEventRecord[] };
    expect(onDisk.recaps).toHaveLength(1);
    const rec = onDisk.recaps[0];
    expect(rec.id).toMatch(RECAP_ID_RE);
    expect(rec.agentId).toBe('openhub');
    expect(rec.action).toBe('pipeline.run.finalized');
    expect(rec.details).toBe('run-7 took 84s');
    expect(rec.repoId).toBe('acme/web');
    expect(rec.userId).toBe('user-42');
    expect(new Date(rec.createdAt).getTime()).not.toBeNaN();
  });

  it('returns { wrote: false } without throwing when the directory is missing', () => {
    const missingDir = path.join(tmp, 'no-such-dir');
    const env = { OPENHUB_DRAYMOND_DIR: missingDir };

    expect(() => recordPipelineLesson({ id: 'run-9' }, env)).not.toThrow();
    expect(() => recordAuditEvent({ userId: 'u', action: 'x' }, env)).not.toThrow();

    const lessonRes = recordPipelineLesson({ id: 'run-9' }, env);
    expect(lessonRes.wrote).toBe(false);
    expect(lessonRes.file).toBeNull();
    expect(typeof lessonRes.error).toBe('string');

    const auditRes = recordAuditEvent({ userId: 'u', action: 'x' }, env);
    expect(auditRes.wrote).toBe(false);
    expect(auditRes.file).toBeNull();
    expect(typeof auditRes.error).toBe('string');

    // Nothing was created anywhere in the sandbox (no stray files or dirs).
    expect(fs.existsSync(missingDir)).toBe(false);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('prefers OPENHUB_DRAYMOND_DIR over the ecosystem-root fallback path', () => {
    const ecoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecosystem-root-'));
    const fallbackDraymond = path.join(ecoRoot, 'Draymond-Orchestrator', '.draymond');
    fs.mkdirSync(fallbackDraymond, { recursive: true });
    const preexisting = [{ id: 'legacy-record', agentId: 'some-agent' }];
    fs.writeFileSync(path.join(fallbackDraymond, 'learning-lessons.json'), JSON.stringify(preexisting, null, 2));

    try {
      const env = { OPENHUB_DRAYMOND_DIR: tmp, OPENHUB_ECOSYSTEM_ROOT: ecoRoot };
      expect(resolveDraymondDir(env)).toBe(tmp);

      const res = recordPipelineLesson({ id: 'run-prio', status: 'completed' }, env);
      expect(res.wrote).toBe(true);
      expect(res.file).toBe(path.join(tmp, 'learning-lessons.json'));

      // The env-configured dir received the record…
      const inEnvDir = JSON.parse(
        fs.readFileSync(path.join(tmp, 'learning-lessons.json'), 'utf-8'),
      ) as { lessons: PipelineLessonRecord[] };
      expect(inEnvDir.lessons).toHaveLength(1);
      expect(inEnvDir.lessons[0].lesson).toBe('Pipeline run-prio finished completed');

      // …and the ecosystem-root fallback file is untouched.
      const inFallback = JSON.parse(
        fs.readFileSync(path.join(fallbackDraymond, 'learning-lessons.json'), 'utf-8'),
      ) as Array<{ id: string; agentId: string }>;
      expect(inFallback).toHaveLength(1);
      expect(inFallback[0].id).toBe('legacy-record');
    } finally {
      fs.rmSync(ecoRoot, { recursive: true, force: true });
    }
  });

  it('refuses with { wrote: false, error: "file too large" } when the brain file exceeds 10 MB — no truncation', () => {
    const env = { OPENHUB_DRAYMOND_DIR: tmp };
    const file = path.join(tmp, 'learning-lessons.json');
    fs.writeFileSync(file, Buffer.alloc(MAX_BRAIN_FILE_BYTES + 1, 0x20));

    const res = recordPipelineLesson({ id: 'run-big', status: 'completed' }, env);
    expect(res.wrote).toBe(false);
    expect(res.file).toBe(file);
    expect(res.error).toBe('file too large');

    // The oversized file was left completely untouched (explicit, no truncation).
    expect(fs.statSync(file).size).toBe(MAX_BRAIN_FILE_BYTES + 1);
  });

  it('refuses to overwrite valid non-array, non-wrapper JSON (append-only safety)', () => {
    const env = { OPENHUB_DRAYMOND_DIR: tmp };
    const file = path.join(tmp, 'learning-lessons.json');
    const original = JSON.stringify({ metadata: { source: 'legacy' } }, null, 2);
    fs.writeFileSync(file, original, 'utf-8');

    const res = recordPipelineLesson({ id: 'run-x', status: 'completed' }, env);
    expect(res.wrote).toBe(false);
    expect(res.file).toBe(file);
    expect(res.error).toContain('refusing to overwrite');

    // Byte-for-byte identical — existing fleet brain state is preserved.
    expect(fs.readFileSync(file, 'utf-8')).toBe(original);
  });
});