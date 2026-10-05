import { getRegistryEntry, resolveAuditDir } from './ecosystemRegistry.js';
import { executeAuditSuite, type AuditReport } from './auditSuite.js';
import { buildRepairBrief, renderRepairBrief, type RepairBrief } from './repairBrief.js';
import { reportIncident, recordIncidentDispatch, type IncidentSeverity, type IncidentSource } from './incidentBus.js';
import { startAxiomProjectLoop, getAxiomStatus } from './axiomClient.js';

/**
 * ecosystemRepair.ts — ecosystem-aware audit → repair dispatch.
 *
 * The flow the operator wants (locked 2026-09-22):
 *   Dev-Brain + Draymond report an issue with a TOOL id → OpenHub resolves the
 *   tool's PRELOADED local folder from the ecosystem registry → audits it →
 *   builds a prioritized repair brief → dispatches the fix to Axiom with the
 *   SAME targetDir, so Axiom/opencode never has to rescan the full codebase.
 *
 * Honesty contract:
 *   - The local folder comes from the registry's `auditDir` (preloaded), not a
 *     user-selected project — this is what makes it "ecosystem aware".
 *   - The audit is real (executeAuditSuite); a pass means no repair dispatch.
 *   - If the tool has no preloaded folder, or Axiom is down, the result reports
 *     the honest failure and the incident stays queued/visible.
 *   - Never fabricates a repair or a verdict.
 */

export type EcosystemRepairReportSource = Extract<IncidentSource, 'dev-brain' | 'draymond' | 'ecosystem' | 'system'>;

export interface EcosystemRepairInput {
  toolId: string;
  source: EcosystemRepairReportSource;
  severity: IncidentSeverity;
  kind: string;
  detail: string;
  /** Optional override for the audit depth (default: quick — targeted at the
   *  reported issue, not a full-tree rescan). */
  preset?: 'quick' | 'standard' | 'deep' | 'release';
  /** Optional explicit goal for the Axiom loop (defaults to the brief's goal). */
  goalOverride?: string;
  dedupKey?: string;
}

export interface EcosystemRepairResult {
  ok: boolean;
  toolId: string;
  toolName: string | null;
  folderResolved: string | null;
  audit: AuditReport | null;
  brief: RepairBrief | null;
  axiom: { reachable: boolean; loopId?: string; error?: string } | null;
  incident: { id: string; severity: IncidentSeverity; source: IncidentSource };
  dispatch: 'none-pass' | 'axiom-dispatched' | 'unavailable-folder' | 'axiom-down' | 'error';
  message: string;
}

/** Resolve a registered ecosystem tool to its preloaded local folder. */
export function resolveToolFolder(toolId: string): { entry: ReturnType<typeof getRegistryEntry>; dir: string | null } {
  const entry = getRegistryEntry(toolId);
  if (!entry) return { entry: null, dir: null };
  return { entry, dir: resolveAuditDir(entry) };
}

/**
 * Run the full ecosystem-aware repair flow for a reported tool issue.
 * Never throws — returns an honest result and records an incident either way.
 */
export async function runEcosystemRepair(input: EcosystemRepairInput): Promise<EcosystemRepairResult> {
  const { toolId, source, severity, kind, detail } = input;

  // 1. Record the incident first so it is visible even if the pipeline fails.
  const incidentRes = await reportIncident({
    source,
    kind,
    severity,
    detail,
    dedupKey: input.dedupKey ?? `ecosystem-repair:${toolId}:${kind}`,
  });
  const incident = incidentRes.incident;

  // 2. Resolve the tool's preloaded local folder.
  const { entry, dir } = resolveToolFolder(toolId);
  if (!entry || !dir) {
    return {
      ok: false,
      toolId,
      toolName: entry?.name ?? null,
      folderResolved: null,
      audit: null,
      brief: null,
      axiom: null,
      incident: { id: incident.id, severity, source },
      dispatch: 'unavailable-folder',
      message: `No preloaded local folder for "${toolId}" in the ecosystem registry. Load the tool into OpenHub first.`,
    };
  }

  // 3. Audit the preloaded folder (quick preset by default — issue-targeted).
  let audit: AuditReport;
  try {
    audit = await executeAuditSuite({ targetDir: dir, preset: input.preset ?? 'quick' });
  } catch (err) {
    return {
      ok: false,
      toolId,
      toolName: entry.name,
      folderResolved: dir,
      audit: null,
      brief: null,
      axiom: null,
      incident: { id: incident.id, severity, source },
      dispatch: 'error',
      message: `Audit failed for ${toolId}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 4. Build the repair brief from the audit's real findings.
  const brief = buildRepairBrief(audit);

  // 5. Pass = no repair needed.
  if (audit.overallStatus === 'pass') {
    return {
      ok: true,
      toolId,
      toolName: entry.name,
      folderResolved: dir,
      audit,
      brief,
      axiom: null,
      incident: { id: incident.id, severity, source },
      dispatch: 'none-pass',
      message: `Audit passed for ${toolId} (${audit.grade}); no repair dispatched.`,
    };
  }

  // 6. Fail/warn → dispatch the fix to Axiom with the preloaded targetDir.
  const goal = input.goalOverride || brief.goal || `Repair audit findings in ${toolId}`;
  const briefText = renderRepairBrief(brief, { maxChars: 6000 });
  // The brief MUST travel WITH the goal. Axiom's loop only ever sees `goal`, so
  // rendering the brief into the HTTP response alone left the loop fixing a
  // ~70-char objective with an empty "findings below" (the 2026-09-24 D- run:
  // Axiom invented revenue-engine circuit-breakers instead of the real lint /
  // secret / dependency findings). Append it so the implementer sees each one.
  const goalWithBrief = `${goal}\n\n${briefText}`;

  try {
    const status = await getAxiomStatus();
    if (!status || status.ok === false) {
      recordIncidentDispatch(incident.id, false, 'axiom-down: Axiom unreachable for ecosystem repair');
      return {
        ok: false,
        toolId,
        toolName: entry.name,
        folderResolved: dir,
        audit,
        brief,
        axiom: { reachable: false },
        incident: { id: incident.id, severity, source },
        dispatch: 'axiom-down',
        message: `Audit found issues in ${toolId} but Axiom is unreachable. Incident ${incident.id} queued; repair not dispatched.`,
      };
    }
    const loop = await startAxiomProjectLoop({
      goal: goalWithBrief,
      targetDir: dir, // preloaded — Axiom does NOT rescan the whole codebase.
      modelRoute: 'auto',
      maxIterations: 8,
    });
    const loopId = loop?.id ?? loop?.loopId ?? '';
    // The ecosystem-repair path dispatches to Axiom directly, so the incident's
    // dispatched flag is owned here (the bus only auto-queues a Draymond triage
    // for high/critical). Without this a low/medium incident stayed
    // `dispatched:false` even though a real repair had been dispatched.
    recordIncidentDispatch(incident.id, Boolean(loop?.ok ?? loopId), loopId ? `axiom-dispatched ${loopId}` : 'axiom-dispatched');
    return {
      ok: Boolean(loop?.ok ?? loop?.id),
      toolId,
      toolName: entry.name,
      folderResolved: dir,
      audit,
      brief,
      axiom: { reachable: true, loopId: loopId || undefined },
      incident: { id: incident.id, severity, source },
      dispatch: 'axiom-dispatched',
      message: `Dispatched ${brief.items.length} fix(es) for ${toolId} to Axiom (targetDir preloaded).\n\n${briefText.slice(0, 2000)}`,
    };
  } catch (err) {
    recordIncidentDispatch(incident.id, false, `axiom-down: ${err instanceof Error ? err.message : String(err)}`);
    return {
      ok: false,
      toolId,
      toolName: entry.name,
      folderResolved: dir,
      audit,
      brief,
      axiom: { reachable: false, error: err instanceof Error ? err.message : String(err) },
      incident: { id: incident.id, severity, source },
      dispatch: 'axiom-down',
      message: `Audit found issues in ${toolId} but Axiom dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}