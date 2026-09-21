import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { advise, calibration, computeState, lessons, listEpisodes, recordEpisode, skillStats } from '../src/services/selfLearning';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-selflearn-'));
  vi.stubEnv('OPENHUB_SELFLEARNING_DIR', dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('selfLearning episodes', () => {
  it('rejects malformed episodes and records valid ones', () => {
    expect(recordEpisode({ kind: '', outcome: 'accepted' } as never).wrote).toBe(false);
    expect(recordEpisode({ kind: 'supervision', outcome: '' } as never).wrote).toBe(false);
    expect(recordEpisode({ kind: 'supervision', outcome: 'accepted', skills: ['RepoRank'] }).wrote).toBe(true);
    const episodes = listEpisodes();
    expect(episodes).toHaveLength(1);
    expect(episodes[0].skills).toEqual(['RepoRank']);
  });

  it('skips corrupt lines', () => {
    recordEpisode({ kind: 'supervision', outcome: 'accepted' });
    fs.appendFileSync(path.join(dir, 'episodes.jsonl'), '{bad json}\n');
    recordEpisode({ kind: 'supervision', outcome: 'rejected' });
    expect(listEpisodes()).toHaveLength(2);
  });
});

describe('skill effectiveness + lessons', () => {
  it('computes Laplace-smoothed weights and derives strong/weak lessons', () => {
    for (let i = 0; i < 3; i += 1) recordEpisode({ kind: 'supervision', outcome: 'accepted', skills: ['GoodSkill'] });
    for (let i = 0; i < 3; i += 1) recordEpisode({ kind: 'supervision', outcome: 'rejected', skills: ['BadSkill'] });

    const stats = skillStats();
    const good = stats.find((s) => s.name === 'GoodSkill')!;
    const bad = stats.find((s) => s.name === 'BadSkill')!;
    expect(good.weight).toBeGreaterThan(0.7);
    expect(bad.weight).toBeLessThan(0.3);

    const all = lessons(10);
    expect(all.some((l) => l.id === 'skill-strong:GoodSkill')).toBe(true);
    expect(all.some((l) => l.id === 'skill-weak:BadSkill')).toBe(true);
  });

  it('advise ranks learned skills and returns lessons', () => {
    for (let i = 0; i < 2; i += 1) recordEpisode({ kind: 'supervision', outcome: 'accepted', goal: 'fix parser', skills: ['ParserFix'] });
    recordEpisode({ kind: 'supervision', outcome: 'rejected', goal: 'fix parser', skills: ['NoisyTool'] });
    const advice = advise('fix the parser');
    expect(advice.skills[0].name).toBe('ParserFix');
    expect(advice.skills[0].kind).toBe('learned');
    expect(advice.lessons.length).toBeGreaterThan(0);
  });
});

describe('calibration self-tuning', () => {
  it('raises the bar when outcomes are strong', () => {
    for (let i = 0; i < 5; i += 1) recordEpisode({ kind: 'supervision', outcome: 'accepted' });
    const cal = calibration();
    expect(cal.sampleSize).toBe(5);
    expect(cal.passRate).toBe(1);
    expect(cal.passRateThreshold).toBe(0.7);
  });

  it('lowers the bar during a rough patch', () => {
    for (let i = 0; i < 4; i += 1) recordEpisode({ kind: 'supervision', outcome: 'rejected' });
    recordEpisode({ kind: 'supervision', outcome: 'accepted' });
    const cal = calibration();
    expect(cal.passRate).toBeCloseTo(0.2, 5);
    expect(cal.passRateThreshold).toBe(0.4);
  });

  it('stays at the baseline with too little evidence', () => {
    recordEpisode({ kind: 'supervision', outcome: 'accepted' });
    expect(calibration().passRateThreshold).toBe(0.5);
  });
});

describe('computeState', () => {
  it('returns a coherent snapshot', () => {
    recordEpisode({ kind: 'supervision', outcome: 'accepted', skills: ['A'] });
    const state = computeState();
    expect(state.episodeCount).toBe(1);
    expect(state.skills[0].name).toBe('A');
    expect(state.calibration).toBeTruthy();
    expect(Array.isArray(state.lessons)).toBe(true);
  });
});
