import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAgentRoster } from '../src/services/agentRegistry';

describe('agentRegistry audit roster', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-roster-'));
    // Fixture mirrors the real default roster: every default backs a live
    // scorer (Claw-Protect <- claw/sca, Grader <- grader).
    fs.mkdirSync(path.join(root, 'Draymond-Orchestrator', 'agents', 'Claw-Protect-main'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'Draymond-Orchestrator', 'agents', 'Claw-Protect-main', 'metadata.json'),
      JSON.stringify({ name: 'claw-protect', description: 'secret + dependency audit agent' }),
    );
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('includes Claw-Protect in the audit team by default', () => {
    const roster = getAgentRoster({ UPLIFT_ROOT: root });
    const claw = roster.audit.find((a) => a.slug === 'Claw-Protect-main');
    expect(claw).toBeDefined();
    expect(claw?.role).toBe('audit');
    expect(claw?.present).toBe(true);
    expect(claw?.name).toBe('claw-protect');
  });

  it('reads the manifest description and type', () => {
    const roster = getAgentRoster({ UPLIFT_ROOT: root });
    const claw = roster.audit.find((a) => a.slug === 'Claw-Protect-main');
    expect(claw?.description).toBe('secret + dependency audit agent');
    expect(claw?.manifest).toBe('metadata.json');
  });

  it('reports Claw-Protect honestly absent when its directory is missing', () => {
    fs.rmSync(path.join(root, 'Draymond-Orchestrator', 'agents', 'Claw-Protect-main'), { recursive: true, force: true });
    const roster = getAgentRoster({ UPLIFT_ROOT: root });
    const claw = roster.audit.find((a) => a.slug === 'Claw-Protect-main');
    expect(claw).toBeDefined();
    expect(claw?.present).toBe(false);
  });

  it('respects the OPENHUB_AUDIT_AGENTS override', () => {
    const custom = path.join(root, 'custom-agent');
    fs.mkdirSync(custom, { recursive: true });
    const roster = getAgentRoster({ UPLIFT_ROOT: root, OPENHUB_AUDIT_AGENTS: custom });
    expect(roster.audit.map((a) => a.path)).toEqual([custom]);
  });
});
