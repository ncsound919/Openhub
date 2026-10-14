import { describe, expect, it, afterEach, vi } from 'vitest';
import { teamCatalog, jobTypeTeams, teamsForDayStep, dayStepTeams, runTeam, runJobType, draymondRoutines, learnFromRun, synergyOverview } from '../src/services/toolTeams';

const CLOSED = 'http://127.0.0.1:9';
const saved: Record<string, string | undefined> = {
  RECOURSE_URL: process.env.RECOURSE_URL,
  DEV_BRAIN_URL: process.env.DEV_BRAIN_URL,
  AXIOM_URL: process.env.AXIOM_URL,
  DRAYMOND_URL: process.env.DRAYMOND_URL,
  KEYWIRE_URL: process.env.KEYWIRE_URL,
  RECOURSE_API_SECRET: process.env.RECOURSE_API_SECRET,
};

function closedEnv(): NodeJS.ProcessEnv {
  return { RECOURSE_URL: CLOSED, DEV_BRAIN_URL: CLOSED, AXIOM_URL: CLOSED, DRAYMOND_URL: CLOSED, KEYWIRE_URL: CLOSED };
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

describe('jobTypeTeams', () => {
  it('maps each job type to its MINIMAL team set', () => {
    expect(jobTypeTeams('repair')).toEqual(['axiom']);
    expect(jobTypeTeams('cron')).toEqual(['draymond']);
    expect(jobTypeTeams('growth')).toEqual(['recourse']);
    expect(jobTypeTeams('reasoning')).toEqual(['devBrain']);
    expect(jobTypeTeams('review')).toEqual(['openhub']);
    expect(jobTypeTeams('nonsense')).toEqual([]);
  });
});

describe('teamsForDayStep', () => {
  it('maps Draymond day-step handlers to their minimal team set', () => {
    expect(teamsForDayStep('run_overlay_qa')).toEqual(['axiom', 'openhub']);
    expect(teamsForDayStep('self_repair_check')).toEqual(['axiom']);
    expect(teamsForDayStep('ingest_news')).toEqual(['draymond']);
    expect(teamsForDayStep('self_learning_loop')).toEqual(['draymond', 'recourse']);
    expect(teamsForDayStep('not_a_real_step')).toEqual([]);
  });

  it('exposes the full step→team map for the console to join against the day plan', () => {
    const map = dayStepTeams();
    expect(map.run_overlay_qa).toEqual(['axiom', 'openhub']);
    expect(Object.keys(map).length).toBeGreaterThan(20);
    expect(Object.values(map).every((t) => Array.isArray(t))).toBe(true);
  });
});

describe('teamCatalog', () => {
  it('exposes all five teams with their tool lists', () => {
    const { teams, jobTypes } = teamCatalog(closedEnv());
    expect(teams.map((t) => t.id)).toEqual(['recourse', 'draymond', 'axiom', 'devBrain', 'openhub']);
    expect(teams.every((t) => t.tools.length > 0)).toBe(true);
    expect(Object.keys(jobTypes).length).toBeGreaterThan(5);
  });
});

describe('runTeam', () => {
  it('reports honest per-tool failures when the peer is unreachable (never fabricated)', async () => {
    const result = await runTeam('recourse', {}, closedEnv());
    expect(result.busy).toBe(false);
    expect(result.tools.length).toBeGreaterThan(0);
    expect(result.tools.every((t) => t.result.ok === false)).toBe(true);
    expect(result.tools[0].result.error).toBeTruthy();
  });

  it('returns busy:true while a team run is already in flight (no stacking)', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(() => gate.then(() => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    vi.stubGlobal('fetch', fetchImpl);
    const env = closedEnv();
    const first = runTeam('recourse', {}, env); // starts, hangs on fetch
    await new Promise((r) => setTimeout(r, 10));
    const second = await runTeam('recourse', {}, env);
    expect(second.busy).toBe(true);
    expect(second.tools).toEqual([]);
    release?.();
    await first;
  });
});

describe('runJobType', () => {
  it('calls ONLY the teams a job type needs', async () => {
    const result = await runJobType('cron', { job: { name: 'circle-report', job_type: 'report' } }, closedEnv());
    expect(result.jobType).toBe('cron');
    expect(result.teams).toEqual(['draymond']);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].team).toBe('draymond');
  });
});

describe('draymondRoutines', () => {
  it('reports honestly when Draymond is unreachable', async () => {
    const r = await draymondRoutines(closedEnv());
    expect(r.day.ok).toBe(false);
    expect(r.schedules.ok).toBe(false);
    expect(r.jobTypes.cron).toEqual(['draymond']);
  });
});

describe('learnFromRun', () => {
  it('skips feedback when disabled', async () => {
    const r = await learnFromRun('cron', [], { ...closedEnv(), OPENHUB_TEAMS_LEARN: '0' });
    expect(r.recourse.memory.ok).toBe(false);
    expect(r.recourse.memory.error).toMatch(/disabled/);
    expect(r.draymond.ok).toBe(false);
  });

  it('reports honestly when Recourse and Draymond are unreachable', async () => {
    const r = await learnFromRun('cron', [{ team: 'draymond', busy: false, tools: [{ id: 'x', label: 'x', result: { ok: true, status: 200, latencyMs: 1 } }] }], closedEnv());
    expect(r.recourse.memory.ok).toBe(false);
    expect(r.recourse.episode.ok).toBe(false);
    expect(r.draymond.ok).toBe(false);
    expect(r.recourse.memory.error).toMatch(/fetch failed|not configured/);
  });
});

describe('synergyOverview', () => {
  it('reports honestly when both learners are unreachable', async () => {
    const r = await synergyOverview(closedEnv());
    expect(r.recourse.synergyMap.ok).toBe(false);
    expect(r.recourse.learnStatus.ok).toBe(false);
    expect(r.draymond.lessons.ok).toBe(false);
  });
});

describe('runJobType learning feedback', () => {
  it('includes a learn payload on the result (honest when peers down)', async () => {
    const result = await runJobType('cron', { job: { name: 'x', job_type: 'report' } }, closedEnv());
    expect(result.learn).not.toBeNull();
    expect(result.learn?.recourse.memory.ok).toBe(false);
  });
});