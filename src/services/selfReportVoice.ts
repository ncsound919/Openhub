import type { SelfReport } from './selfReport.js';
import {
  decideSystemOne,
  jevEnabled,
  type JevState,
  type JevQuestion,
  type JevResult,
  type JevSource,
} from './jevClient.js';

/**
 * selfReportVoice.ts — JEV-driven delivery framing for OpenHub's self-report.
 *
 * The self-report body is REAL telemetry (never fabricated). What JEV adds is
 * the DELIVERY VOICE: a choice over pre-authored framings that varies how the
 * report opens and closes, matched to the actual state (pass rate, incidents,
 * bridges). JEV returns a typed `choice` — it does not write prose.
 *
 * Honesty contract:
 *   - Numbers always come from the SelfReport; the framing only changes the
 *     words around them.
 *   - When JEV is offline/unreachable, a deterministic framing is picked from
 *     the same state so delivery still varies — no fabricated JEV source.
 *   - `source` on the result is 'vercel' | 'localjev' | 'deterministic' so a
 *     consumer can tell which one produced the framing.
 */

export type DeliverySource = 'vercel' | 'localjev' | 'deterministic';

export type DeliveryFraming = 'steady' | 'attentive' | 'heads-up' | 'all-clear' | 'degraded';

export interface DeliveryVoice {
  framing: DeliveryFraming;
  source: DeliverySource;
  opener: string;
  closer: string;
  headline: string;
}

interface FramingTemplate {
  headline: string;
  opener: string;
  closer: string;
}

const FRAMINGS: Record<DeliveryFraming, FramingTemplate> = {
  steady: {
    headline: 'OpenHub — running steady',
    opener: 'Everything on this box is being watched and mostly behaving.',
    closer: 'No drama here — just the fleet ticking along. I will shout if that changes.',
  },
  attentive: {
    headline: 'OpenHub — paying attention',
    opener: 'Quiet-ish, but I have my eyes on a few things worth mentioning.',
    closer: 'Keeping watch. Anything below is the part of the story you should read twice.',
  },
  'heads-up': {
    headline: 'OpenHub — a heads-up',
    opener: 'Things are mostly fine, but a couple of signals are worth your time.',
    closer: 'That is the short version. Dig into the sections below when you can.',
  },
  'all-clear': {
    headline: 'OpenHub — all clear',
    opener: 'Green across the board from where I sit.',
    closer: 'Nothing below needs you right now. Next report is on schedule.',
  },
  degraded: {
    headline: 'OpenHub — degraded, being handled',
    opener: 'A few subsystems are not fully green, and I am not going to paper over that.',
    closer: 'Being handled — but this one is honest bad news, not background noise.',
  },
};

/** Build the JEV state + a single choice question over delivery framings. */
export function deliveryAdvisory(report: SelfReport): { state: JevState; questions: Record<string, JevQuestion> } {
  const activity = report.activity.ok
    ? { total: report.activity.total, passRate: report.activity.passRate, bySeverity: report.activity.bySeverity }
    : null;
  const incidents = report.incidents.ok ? (report.incidents.recent as unknown[]).length : null;
  const runs = report.runs.ok ? { active: report.runs.active, total: report.runs.total } : null;
  const axiom = report.bridges.axiom.ok ? report.bridges.axiom.online : null;
  const recourse = report.bridges.recourse.ok ? report.bridges.recourse.available : null;
  const audit = report.audit.ok ? report.audit.verdict : null;

  const state: JevState = {
    action: 'self_report_delivery',
    activity,
    incidents,
    runs,
    bridges: { axiom, recourse },
    audit,
  };

  const questions: Record<string, JevQuestion> = {
    framing: {
      type: 'choice',
      instructions: 'Which delivery framing fits this self-report best?',
      criteria: {
        steady: 'Nominal load, few or no incidents, bridges up',
        attentive: 'Minor signals worth noting but nothing urgent',
        'heads-up': 'A couple of non-critical flags the operator should glance at',
        'all-clear': 'Everything green, nothing needs the operator',
        degraded: 'Real failures or down bridges — honest bad news',
      },
    },
  };

  return { state, questions };
}

/** Pick a deterministic framing from real state when JEV is unavailable. */
export function deterministicFraming(report: SelfReport): DeliveryFraming {
  const passRate = report.activity.ok ? report.activity.passRate : null;
  const incidents = report.incidents.ok ? (report.incidents.recent as unknown[]).length : 0;
  const axiom = report.bridges.axiom.ok ? report.bridges.axiom.online : false;
  const recourse = report.bridges.recourse.ok ? report.bridges.recourse.available : false;

  if (incidents >= 3 || (passRate !== null && passRate < 0.6) || !axiom || !recourse) return 'degraded';
  if (incidents >= 1 || (passRate !== null && passRate < 0.9)) return 'heads-up';
  if (passRate !== null && passRate >= 0.98 && incidents === 0) return 'all-clear';
  if (incidents === 0 && passRate === null) return 'steady';
  return 'attentive';
}

function parseJevFraming(result: JevResult): DeliveryFraming | null {
  const answer = result.answers?.framing;
  if (answer && answer.type === 'choice') {
    const f = answer.choice as DeliveryFraming;
    if (f in FRAMINGS) return f;
  }
  return null;
}

/** Build the delivery voice for a report. Never throws. */
export async function buildDeliveryVoice(report: SelfReport): Promise<DeliveryVoice> {
  const fallback = (framing: DeliveryFraming, source: DeliverySource): DeliveryVoice => {
    const t = FRAMINGS[framing];
    return { framing, source, opener: t.opener, closer: t.closer, headline: t.headline };
  };

  if (!jevEnabled()) return fallback(deterministicFraming(report), 'deterministic');

  try {
    const { state, questions } = deliveryAdvisory(report);
    const result = await decideSystemOne({ state, questions });
    if (!result.ok) return fallback(deterministicFraming(report), 'deterministic');
    const framing = parseJevFraming(result);
    if (!framing) return fallback(deterministicFraming(report), 'deterministic');
    const src: DeliverySource = result.source === 'offline' ? 'deterministic' : result.source;
    return fallback(framing, src);
  } catch {
    return fallback(deterministicFraming(report), 'deterministic');
  }
}

/** Facts-only body (unchanged numbers, no voice). */
export function selfReportFacts(report: SelfReport): string {
  const identity = report.identity.ok
    ? `${report.identity.name} v${report.identity.version} (up ${Math.floor((report.identity.uptimeSec ?? 0) / 60)}m)`
    : 'openhub (identity unavailable)';
  const activity = report.activity.ok
    ? `${report.activity.total} events, pass ${report.activity.passRate == null ? 'n/a' : `${Math.round(report.activity.passRate * 100)}%`}`
    : 'activity unavailable';
  const incidents = report.incidents.ok ? `${report.incidents.recent.length} recent incident(s)` : 'incidents n/a';
  const runs = report.runs.ok ? `${report.runs.active}/${report.runs.total} active run(s)` : 'runs n/a';
  const bridges = `axiom:${report.bridges.axiom.ok && report.bridges.axiom.online ? 'up' : 'down'} | recourse:${report.bridges.recourse.ok && report.bridges.recourse.available ? 'up' : 'down'}`;
  const audit = report.audit.ok ? ` | audit:${report.audit.verdict}` : '';
  return `${identity}\nactivity: ${activity} | incidents: ${incidents} | runs: ${runs}\nbridges: ${bridges}${audit}`;
}

/** Humanized, varied, JEV-framed self-report message. Numbers stay factual. */
export async function humanizedSelfReport(report: SelfReport): Promise<{ text: string; voice: DeliveryVoice }> {
  const voice = await buildDeliveryVoice(report);
  const facts = selfReportFacts(report);
  return {
    text: `${voice.headline}\n${voice.opener}\n\n${facts}\n\n${voice.closer}\n\n(source: ${voice.source})`,
    voice,
  };
}