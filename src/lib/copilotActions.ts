import { getAuthHeaders, getCsrfToken } from '../auth/AuthProvider';
import type { ActiveProject } from '../store';

export interface Ctx {
  project: ActiveProject | null;
}

type H = Record<string, string>;

const h = (extra?: H): H => getAuthHeaders(extra);
const mut = (extra?: H): H => getAuthHeaders({ ...(extra ?? {}), 'X-CSRF-Token': getCsrfToken() });

async function json(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function needProject(ctx: Ctx): string | null {
  return ctx.project ? null : 'Load a project first — this acts on the active project.';
}
/** Record a copilot mutation in the audit trail (best effort, never blocks). */
export async function logCopilotAction(ctx: Ctx, action: string, details: string): Promise<void> {
  try {
    await fetch('/api/audit-logs', {
      method: 'POST',
      credentials: 'include',
      headers: mut({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ action: `copilot:${action}`, details, repoId: ctx.project?.repoId ?? '' }),
    });
  } catch { /* audit trail must not break control */ }
}

/** Report a hiccup to the incident bus (fire-and-forget; auto-dispatches repair per prefs). */
export async function reportHiccup(
  kind: string,
  detail: string,
  severity: 'low' | 'medium' | 'high' = 'low',
): Promise<void> {
  try {
    await fetch('/api/incidents/report', {
      method: 'POST',
      credentials: 'include',
      headers: mut({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ source: 'copilot', kind, severity, detail: detail.slice(0, 1000) }),
    });
  } catch { /* incident bus must not break the task */ }
}

export async function readProjectFile(ctx: Ctx, filePath: string): Promise<string> {
  const missing = needProject(ctx);
  if (missing) return missing;
  try {
    const res = await fetch(`/api/project/active/contents?path=${encodeURIComponent(filePath)}`, {
      credentials: 'include',
      headers: h(),
    });
    const data = await json(res);
    if (data?.type === 'file') {
      const content: string = data.content || '';
      return content.length > 1500 ? `${content.slice(0, 1500)}\n… (${content.length} chars total)` : content || '(empty file)';
    }
    if (data?.type === 'dir' || Array.isArray(data?.entries)) {
      const names = (data.entries ?? []).map((e: { name: string; type: string }) => `${e.type === 'dir' ? '▸' : '·'} ${e.name}`);
      return `Directory ${filePath || 'root'}:\n${names.slice(0, 40).join('\n') || '(empty)'}`;
    }
    return `Couldn't open ${filePath}: ${data?.error || 'not found'}.`;
  } catch {
    return `Couldn't open ${filePath} — request failed.`;
  }
}

export async function writeProjectFile(ctx: Ctx, filePath: string, content: string): Promise<string> {
  const missing = needProject(ctx);
  if (missing) return missing;
  try {
    const res = await fetch('/api/project/active/contents', {
      method: 'PUT',
      credentials: 'include',
      headers: mut({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path: filePath, content }),
    });
    const data = await json(res);
    if (!res.ok) return `Write failed: ${data?.error || `HTTP ${res.status}`}.`;
    await logCopilotAction(ctx, 'write', `${filePath} (${content.length} chars)`);
    return `Wrote ${filePath} (${data?.bytes ?? content.length} bytes).`;
  } catch {
    return `Write to ${filePath} failed — request error.`;
  }
}

export async function pushProject(ctx: Ctx): Promise<string> {
  const missing = needProject(ctx);
  if (missing) return missing;
  try {
    const res = await fetch('/api/project/active/git/push', {
      method: 'POST',
      credentials: 'include',
      headers: mut(),
    });
    const data = await json(res);
    if (!res.ok || !data?.ok) return `Push failed: ${data?.error || `HTTP ${res.status}`}.`;
    await logCopilotAction(ctx, 'push', ctx.project?.repositoryName ?? '');
    return `Pushed ${ctx.project?.repositoryName} to origin.`;
  } catch {
    return 'Push request failed.';
  }
}

export async function scanProjectFile(ctx: Ctx, filePath: string): Promise<string> {
  const missing = needProject(ctx);
  if (missing) return missing;
  try {
    const res = await fetch(`/api/project/active/contents?path=${encodeURIComponent(filePath)}`, {
      credentials: 'include',
      headers: h(),
    });
    const data = await json(res);
    if (data?.type !== 'file') return `Can't scan ${filePath}: not a file.`;
    const scan = await fetch('/api/scan', {
      method: 'POST',
      credentials: 'include',
      headers: mut({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ content: data.content || '', fileName: filePath.split('/').pop() ?? filePath }),
    });
    const result = await json(scan);
    const findings = Array.isArray(result?.findings) ? result.findings : [];
    if (findings.length === 0) return `${filePath}: no findings.`;
    const bySev: Record<string, number> = {};
    for (const f of findings) bySev[String(f.severity ?? 'unknown')] = (bySev[String(f.severity ?? 'unknown')] ?? 0) + 1;
    const top = findings.slice(0, 5).map((f: { severity?: string; title?: string }) => `• [${f.severity ?? '?'}] ${f.title ?? 'finding'}`).join('\n');
    return `${filePath}: ${findings.length} finding${findings.length === 1 ? '' : 's'} (${Object.entries(bySev).map(([k, v]) => `${v} ${k}`).join(', ')}):\n${top}`;
  } catch {
    return `Scan of ${filePath} failed.`;
  }
}

export async function runPipeline(ctx: Ctx, message: string): Promise<string> {
  const missing = needProject(ctx);
  if (missing) return missing;
  try {
    const res = await fetch('/api/axiom/project/run', {
      method: 'POST',
      credentials: 'include',
      headers: mut({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ goal: message || 'Run the project verification loop' }),
    });
    const data = await json(res);
    const loopId = data?.data?.id;
    if (!loopId) return `Axiom loop failed to start: ${data?.error || 'unknown error'}.`;
    await logCopilotAction(ctx, 'pipeline', `${message} (loop ${loopId})`);
    return `Axiom loop started (${String(loopId).slice(0, 8)}). Ask for /pipeline-status ${loopId} to follow it.`;
  } catch {
    return 'Axiom loop request failed.';
  }
}

export async function pipelineStatus(runId: string): Promise<string> {
  try {
    const res = await fetch(`/api/axiom/project/status/${encodeURIComponent(runId)}`, { credentials: 'include', headers: h() });
    const data = await json(res);
    const loop = data?.data;
    if (!loop) return 'No Axiom loop status returned.';
    const iterations = Array.isArray(loop.iterations) ? loop.iterations : [];
    const latest = iterations.length ? iterations[iterations.length - 1] : null;
    const stages = Array.isArray(latest?.stages)
      ? latest.stages.map((s: { label?: string; name?: string; status?: string }) => `${s.label ?? s.name ?? '?'}: ${s.status ?? '?'}`).join(', ')
      : 'no stage detail yet';
    return `Axiom loop ${String(runId).slice(0, 8)} — ${loop.status ?? 'unknown'} (iteration ${loop.iteration ?? 0}/${loop.maxIterations ?? '?'}). ${stages}`;
  } catch {
    return 'Axiom loop status request failed.';
  }
}

export async function listServices(): Promise<string> {
  try {
    const res = await fetch('/api/lifecycle/services', { credentials: 'include', headers: h() });
    const data = await json(res);
    const items = Array.isArray(data) ? data : data?.services ?? data?.data ?? [];
    if (!Array.isArray(items) || items.length === 0) return 'No on-demand services registered.';
    return items.slice(0, 15).map((s: { slug?: string; name?: string; status?: string }) => `• ${s.slug ?? s.name ?? '?'} — ${s.status ?? 'unknown'}`).join('\n');
  } catch {
    return 'Service list request failed.';
  }
}

export async function controlService(ctx: Ctx, slug: string, action: 'start' | 'stop'): Promise<string> {
  try {
    const res = await fetch(`/api/lifecycle/services/${encodeURIComponent(slug)}/${action}`, {
      method: 'POST',
      credentials: 'include',
      headers: mut(),
    });
    const data = await json(res);
    if (!res.ok) return `Service ${action} failed: ${data?.error || `HTTP ${res.status}`}.`;
    await logCopilotAction(ctx, `service-${action}`, slug);
    return `Service ${slug}: ${action} requested.`;
  } catch {
    return `Service ${action} request failed.`;
  }
}

export async function listTools(): Promise<string> {
  try {
    const res = await fetch('/api/registry', { credentials: 'include', headers: h() });
    const data = await json(res);
    const items = Array.isArray(data) ? data : data?.data ?? [];
    if (!Array.isArray(items) || items.length === 0) return 'Registry is empty.';
    return items.slice(0, 15).map((t: { id?: string; name?: string; type?: string; status?: string }) => `• ${t.name ?? t.id} [${t.type ?? '?'}] — ${t.status ?? '?'}`).join('\n');
  } catch {
    return 'Registry request failed.';
  }
}

export async function setToolStatus(ctx: Ctx, name: string, status: 'active' | 'inactive'): Promise<string> {
  try {
    const res = await fetch('/api/registry', { credentials: 'include', headers: h() });
    const data = await json(res);
    const items: Array<{ id: string; name: string }> = Array.isArray(data) ? data : data?.data ?? [];
    const hit = items.find((t) => t.name?.toLowerCase().includes(name.toLowerCase()));
    if (!hit) return `No tool matching “${name}”.`;
    const patch = await fetch(`/api/registry/${hit.id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: mut({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ status }),
    });
    if (!patch.ok) return `Couldn't update ${hit.name}.`;
    await logCopilotAction(ctx, 'tool', `${hit.name} → ${status}`);
    return `${hit.name} is now ${status}.`;
  } catch {
    return 'Tool update failed.';
  }
}

export async function fleetSummary(): Promise<string> {
  try {
    const [kpisRes, agentsRes] = await Promise.all([
      fetch('/api/ecosystem/kpis', { credentials: 'include' }),
      fetch('/api/ecosystem/agents', { credentials: 'include' }),
    ]);
    const kpis = await json(kpisRes);
    const agents = await json(agentsRes);
    const agentCount = Array.isArray(agents) ? agents.length : agents?.count ?? agents?.agents?.length ?? 0;
    const goals = Array.isArray(kpis?.goals) ? kpis.goals.length : 0;
    const revenue = kpis?.treasury?.revenueUSD != null ? `$${kpis.treasury.revenueUSD}` : 'n/a';
    return `Fleet: ${agentCount} agents · ${goals} goals · revenue ${revenue} · source ${kpis?.source ?? 'unknown'}.`;
  } catch {
    return 'Fleet summary request failed.';
  }
}

export async function runAudit(ctx: Ctx): Promise<string> {
  const missing = needProject(ctx);
  if (missing) return missing;
  try {
    const res = await fetch('/api/audit/run', {
      method: 'POST',
      credentials: 'include',
      headers: mut({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({}),
    });
    const data = await json(res);
    if (!res.ok || !data?.ok) return `Audit failed: ${data?.error || `HTTP ${res.status}`}.`;
    const report = data.report;
    const results = Array.isArray(report?.results) ? report.results : [];
    const fails = results.filter((r: { error?: string }) => r.error).length;
    await logCopilotAction(ctx, 'audit', `verdict ${report?.overallStatus ?? '?'}`);
    return `Audit verdict: ${report?.overallStatus ?? 'unknown'} — ${results.length} checks, ${fails} failing. See the Audit page for detail.`;
  } catch {
    return 'Audit request failed.';
  }
}

export async function triggerRepair(ctx: Ctx, signal: string): Promise<string> {
  const missing = needProject(ctx);
  if (missing) return missing;
  try {
    const res = await fetch('/api/repair/trigger', {
      method: 'POST',
      credentials: 'include',
      headers: mut({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ signal, detail: signal, kind: 'job' }),
    });
    const data = await json(res);
    if (!res.ok || !data?.ok) return `Repair dispatch failed: ${data?.error || `HTTP ${res.status}`}.`;
    await logCopilotAction(ctx, 'repair', signal);
    return 'Repair triage dispatched. Follow it on the Repair page.';
  } catch {
    return 'Repair dispatch failed.';
  }
}

export async function auditAndRepair(ctx: Ctx): Promise<string> {
  const missing = needProject(ctx);
  if (missing) return missing;
  try {
    const res = await fetch('/api/repair/audit-and-repair', {
      method: 'POST',
      credentials: 'include',
      headers: mut({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({}),
    });
    const data = await json(res);
    if (!res.ok || !data?.ok) return `Audit+repair failed: ${data?.error || `HTTP ${res.status}`}.`;
    await logCopilotAction(ctx, 'audit-repair', data.message ?? '');
    return data.message ?? `Audit ${data.audit?.overallStatus ?? 'done'}.`;
  } catch {
    return 'Audit+repair request failed.';
  }
}

export async function runAgent(ctx: Ctx, name: string): Promise<string> {
  try {
    const res = await fetch(`/api/ecosystem/agents/${encodeURIComponent(name)}/run`, {
      method: 'POST',
      credentials: 'include',
      headers: mut({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(ctx.project ? { repoPath: ctx.project.path } : {}),
    });
    const data = await json(res);
    if (res.status === 501) return `Agent “${name}” has no executable mapped — dispatch not implemented server-side.`;
    if (!res.ok) return `Agent run failed: ${data?.error || `HTTP ${res.status}`}.`;
    await logCopilotAction(ctx, 'agent-run', name);
    return `Agent “${name}” dispatched.`;
  } catch {
    return 'Agent dispatch failed.';
  }
}

// The vibeserve MCP bridge was retired in the Axiom-only consolidation. These
// copilot actions remain as honest no-ops until the Axiom-native equivalents
// are wired (Axiom exposes its own tools via /api/axiom/*).
export async function listMcpTools(): Promise<string> {
  return 'The legacy MCP tool bridge was retired. Axiom is the single engine — use the Loops and Assurance surfaces.';
}

export async function callMcpTool(_ctx: Ctx, tool: string, _argsText?: string): Promise<string> {
  return `MCP tool bridge retired; “${tool}” is not available. Use the Axiom engine instead.`;
}

export async function refreshKnowledge(): Promise<string> {
  try {
    const res = await fetch('/api/ecosystem/knowledge/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: mut(),
    });
    const data = await json(res);
    if (!res.ok) return `Re-index failed: ${data?.error || `HTTP ${res.status}`}.`;
    return 'Knowledge re-index requested.';
  } catch {
    return 'Re-index request failed.';
  }
}

/** Ecosystem intel awareness: sources, totals, catalog, agents, and role roster. */
export async function intelSummary(): Promise<string> {
  try {
    const [knowRes, agentsRes, rosterRes] = await Promise.all([
      fetch('/api/ecosystem/knowledge?limit=1', { credentials: 'include', headers: h() }),
      fetch('/api/ecosystem/agents', { credentials: 'include', headers: h() }),
      fetch('/api/agents/roster', { credentials: 'include', headers: h() }),
    ]);
    const know = await json(knowRes);
    const agents = await json(agentsRes);
    const roster = await json(rosterRes);
    const lines: string[] = [];
    const sources = Array.isArray(know?.sources) ? know.sources : [];
    if (sources.length > 0) {
      lines.push(`Intel sources (${sources.length}):`);
      for (const s of sources.slice(0, 8)) {
        lines.push(`• ${s.label ?? s.root} — ${s.entries ?? 0} entries`);
      }
    } else if (know?.root) {
      lines.push(`Source: ${know.root}`);
    } else {
      lines.push('No intel sources configured (OPENHUB_ECOSYSTEM_ROOTS).');
    }
    const totals = know?.totals && typeof know.totals === 'object' ? know.totals : {};
    const totalEntries = Object.values(totals as Record<string, number>).reduce((a, b) => a + (Number(b) || 0), 0);
    lines.push(`Index: ${totalEntries} entries${know?.live === false ? ' (index empty)' : ''}.`);
    const agentCount = Array.isArray(agents) ? agents.length : agents?.count ?? 0;
    if (agentCount > 0) lines.push(`Fleet catalog: ${agentCount} agents${agents?.path ? ` (${String(agents.path).split(/[/\\]/).pop()})` : ''}.`);
    else if (agents?.error) lines.push('Fleet catalog: not found.');
    if (roster?.ok !== false && (Array.isArray(roster?.audit) || Array.isArray(roster?.research))) {
      const audit = Array.isArray(roster.audit) ? roster.audit : [];
      const research = Array.isArray(roster.research) ? roster.research : [];
      lines.push(`Audit backends (${audit.length}): ${audit.map((a: { name?: string; present?: boolean }) => `${a.name ?? '?'}${a.present ? '' : ' (offline)'}`).join(', ') || 'none'}.`);
      lines.push(`Research backends (${research.length}): ${research.map((r: { name?: string; present?: boolean }) => `${r.name ?? '?'}${r.present ? '' : ' (offline)'}`).join(', ') || 'none'}.`);
    }
    return lines.join('\n');
  } catch {
    return 'Intel summary request failed.';
  }
}

interface SshKey {
  id: string;
  title: string;
  public_key?: string;
  key?: string;
  created_at?: string;
}

async function fetchSshKeys(): Promise<SshKey[]> {
  const res = await fetch('/api/settings/ssh-keys', { credentials: 'include', headers: h() });
  const data = await json(res);
  return Array.isArray(data) ? data : [];
}

export async function listSshKeys(): Promise<string> {
  try {
    const keys = await fetchSshKeys();
    if (keys.length === 0) return 'No SSH keys registered. Add one with /ssh-add <title> :: <public key>.';
    return keys.map((k) => `• ${k.title} (${String(k.id).slice(0, 8)})`).join('\n');
  } catch {
    return 'SSH key list request failed.';
  }
}

export async function addSshKey(ctx: Ctx, title: string, key: string): Promise<string> {
  try {
    const res = await fetch('/api/settings/ssh-keys', {
      method: 'POST',
      credentials: 'include',
      headers: mut({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ title, key }),
    });
    const data = await json(res);
    if (!res.ok) return `Couldn't add key: ${data?.error || `HTTP ${res.status}`}.`;
    await logCopilotAction(ctx, 'ssh-add', title);
    return `SSH key “${title}” registered.`;
  } catch {
    return 'SSH key request failed.';
  }
}

export async function removeSshKey(ctx: Ctx, query: string): Promise<string> {
  try {
    const keys = await fetchSshKeys();
    const q = query.toLowerCase();
    const hit = keys.find((k) => k.id.toLowerCase().startsWith(q) || k.title.toLowerCase().includes(q));
    if (!hit) return `No SSH key matching “${query}”.`;
    const res = await fetch(`/api/settings/ssh-keys/${hit.id}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: mut(),
    });
    if (!res.ok) return `Couldn't remove ${hit.title}.`;
    await logCopilotAction(ctx, 'ssh-remove', hit.title);
    return `SSH key “${hit.title}” removed.`;
  } catch {
    return 'SSH key removal failed.';
  }
}

interface Webhook {
  id: string;
  url: string;
  events?: string;
  active?: number;
}

async function fetchWebhooks(): Promise<Webhook[]> {
  const res = await fetch('/api/webhooks', { credentials: 'include', headers: h() });
  const data = await json(res);
  return Array.isArray(data) ? data : [];
}

function resolveWebhook(hooks: Webhook[], query: string): Webhook | undefined {
  const q = query.toLowerCase();
  return hooks.find((w) => w.id.toLowerCase().startsWith(q) || w.url.toLowerCase().includes(q));
}

export async function listWebhooks(): Promise<string> {
  try {
    const hooks = await fetchWebhooks();
    if (hooks.length === 0) return 'No webhooks registered. Add one with /webhook-add <url> [events].';
    return hooks.map((w) => `• ${w.url} (${String(w.id).slice(0, 8)}${w.active === 0 ? ', paused' : ''})`).join('\n');
  } catch {
    return 'Webhook list request failed.';
  }
}

export async function addWebhook(ctx: Ctx, url: string, eventsText: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return 'Webhook URL must start with http(s)://.';
  try {
    const events = eventsText ? eventsText.split(/[,\s]+/).filter(Boolean) : ['*'];
    const res = await fetch('/api/webhooks', {
      method: 'POST',
      credentials: 'include',
      headers: mut({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ url, events }),
    });
    const data = await json(res);
    if (!res.ok) return `Couldn't add webhook: ${data?.error || `HTTP ${res.status}`}.`;
    await logCopilotAction(ctx, 'webhook-add', url);
    return `Webhook registered for ${url} (events: ${events.join(', ')}).`;
  } catch {
    return 'Webhook request failed.';
  }
}

export async function testWebhook(ctx: Ctx, query: string): Promise<string> {
  try {
    const hooks = await fetchWebhooks();
    const hit = resolveWebhook(hooks, query);
    if (!hit) return `No webhook matching “${query}”.`;
    const res = await fetch(`/api/webhooks/${hit.id}/test`, {
      method: 'POST',
      credentials: 'include',
      headers: mut(),
    });
    const data = await json(res);
    if (!res.ok) return `Test ping failed: ${data?.error || `HTTP ${res.status}`}.`;
    await logCopilotAction(ctx, 'webhook-test', hit.url);
    return `Test ping fired for ${hit.url}.`;
  } catch {
    return 'Webhook test failed.';
  }
}

export async function removeWebhook(ctx: Ctx, query: string): Promise<string> {
  try {
    const hooks = await fetchWebhooks();
    const hit = resolveWebhook(hooks, query);
    if (!hit) return `No webhook matching “${query}”.`;
    const res = await fetch(`/api/webhooks/${hit.id}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: mut(),
    });
    if (!res.ok) return `Couldn't remove webhook for ${hit.url}.`;
    await logCopilotAction(ctx, 'webhook-remove', hit.url);
    return `Webhook for ${hit.url} removed.`;
  } catch {
    return 'Webhook removal failed.';
  }
}

/** Route a question to the research engines (AgentBrowser, OmniResearch, BookBridge). */
export async function askResearch(ctx: Ctx, query: string): Promise<string> {
  try {
    const res = await fetch('/api/research/ask', {
      method: 'POST',
      credentials: 'include',
      headers: mut({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ query }),
    });
    const data = await json(res);
    if (!res.ok || !data?.ok) {
      void reportHiccup('research-failed', `Research ask failed: ${data?.error || res.status} (q: ${query.slice(0, 120)}).`, 'low');
      return `Research request failed: ${data?.error || `HTTP ${res.status}`}.`;
    }
    await logCopilotAction(ctx, 'research-ask', query.slice(0, 200));
    const backends = Array.isArray(data.backends) ? data.backends : [];
    const lines = backends.map((b: { name?: string; reachable?: boolean; note?: string }) =>
      `• ${b.name ?? '?'}: ${b.reachable ? 'reachable' : `offline (${b.note ?? 'no endpoint'})`}`,
    );
    return `Research: ${data.note}\n${lines.join('\n')}`;
  } catch {
    return 'Research request failed.';
  }
}

/** Start a supervised loop → audit → repair run. */
export async function startSupervisionRun(ctx: Ctx, goal: string): Promise<string> {
  const missing = needProject(ctx);
  if (missing) return missing;
  try {
    const res = await fetch('/api/supervise/start', {
      method: 'POST',
      credentials: 'include',
      headers: mut({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ goal }),
    });
    const data = await json(res);
    if (!res.ok || !data?.ok) return `Supervision failed: ${data?.error || `HTTP ${res.status}`}.`;
    const run = data.run;
    await logCopilotAction(ctx, 'supervise', `${goal.slice(0, 120)} (run ${run?.id?.slice(0, 8) ?? '?'})`);
    const skills = Array.isArray(run?.skills) ? run.skills.map((s: { name?: string }) => s.name).join(', ') : '';
    return `Supervised run started (${run?.id?.slice(0, 8)}). Loop → audit → repair, with best skills${skills ? `: ${skills}` : ''}. Track it in Assurance → Pipelines.`;
  } catch {
    return 'Supervision request failed.';
  }
}

/** List the supervised-run ledger. */
export async function supervisionRuns(): Promise<string> {
  try {
    const res = await fetch('/api/supervise/runs', { credentials: 'include', headers: h() });
    const data = await json(res);
    const runs = Array.isArray(data?.runs) ? data.runs : [];
    if (runs.length === 0) return 'No supervised runs yet — start one with /supervise <goal>.';
    return runs.slice(0, 10).map((r: { status?: string; goal?: string; iteration?: number; maxIterations?: number; id?: string }) =>
      `• [${r.status ?? '?'}] ${r.goal ?? 'no goal'} (iter ${r.iteration ?? 0}/${r.maxIterations ?? 8}) ${String(r.id ?? '').slice(0, 8)}`,
    ).join('\n');
  } catch {
    return 'Supervision ledger request failed.';
  }
}

/** Generate a file of any text type and write it into the active project. */
export async function generateFile(ctx: Ctx, filePath: string, _description: string): Promise<string> {
  const missing = needProject(ctx);
  if (missing) return missing;
  return `File generation via the legacy MCP bridge was retired. Use the Axiom editor (Workspace) to generate ${filePath}.`;
}

/** List UFC-MCP tools (Universal File Converter). */
export async function ufcTools(): Promise<string> {
  return 'The UFC file-converter bridge was retired in the Axiom-only consolidation.';
}

/** Call a UFC-MCP tool (convert_*, get_supported_formats, batch_convert). */
export async function ufcCall(tool: string, _argsText?: string): Promise<string> {
  return `UFC tool bridge retired; “${tool}” is not available.`;
}

/** Recourse self-learning status + synergy map (via the OpenHub proxy). */
export async function recourseStatusSummary(): Promise<string> {
  try {
    const [status, synergy] = await Promise.all([
      fetch('/api/recourse/status', { credentials: 'include', headers: h() }).then(json),
      fetch('/api/recourse/synergy/map', { credentials: 'include', headers: h() }).then(json),
    ]);
    const lines: string[] = [];
    if (status?.available) {
      const s = status.data ?? {};
      lines.push(`Recourse: ${s.status ?? s.state ?? 'online'}`);
      if (s.message) lines.push(`  ${String(s.message).slice(0, 160)}`);
    }
    if (synergy?.available) {
      const m = synergy.data ?? {};
      const domains = Array.isArray(m?.domains) ? m.domains : Array.isArray(m) ? m : [];
      lines.push(`Synergy map: ${Array.isArray(domains) ? domains.length : '?'} domain(s)`);
    }
    if (!status?.available && !synergy?.available) {
      return 'Recourse offline — start it on :3050 (RECOURSE_URL) to enable self-learning + synergy mapping.';
    }
    return lines.join('\n');
  } catch {
    return 'Recourse request failed.';
  }
}

/** Semantic recall from Recourse self-learning memory. */
export async function synergyRecall(query: string): Promise<string> {
  try {
    const res = await fetch(`/api/recourse/memory/recall?q=${encodeURIComponent(query)}`, {
      credentials: 'include',
      headers: h(),
    });
    const data = await json(res);
    if (!data?.available) return `Recourse memory unavailable: ${data?.error || 'offline'}.`;
    const items: unknown[] = Array.isArray(data.data?.hits) ? data.data.hits
      : Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.data?.results) ? data.data.results : Array.isArray(data.data?.matches) ? data.data.matches : [];
    if (items.length === 0) return `No recalled memory for “${query}”.`;
    return items.slice(0, 6).map((it: any) => {
      const text = typeof it?.text === 'string' ? it.text : typeof it?.content === 'string' ? it.content : JSON.stringify(it);
      return `• ${text.slice(0, 200)}`;
    }).join('\n');
  } catch {
    return 'Recourse recall request failed.';
  }
}

/** Recourse gene registry summary: promoted/self-hosted tools and health. */
export async function recourseRegistrySummary(): Promise<string> {
  try {
    const res = await fetch('/api/recourse/registry', { credentials: 'include', headers: h() });
    const data = await json(res);
    if (!data?.available) return `Recourse registry unavailable: ${data?.error || 'offline'}.`;
    const d = data.data ?? {};
    const list: any[] = Array.isArray(d.registry) ? d.registry : Array.isArray(d) ? d : [];
    if (list.length === 0) return 'Recourse registry empty.';
    const lines = [`Recourse registry: ${list.length} tool(s)`];
    for (const t of list.slice(0, 10)) {
      const versions: any[] = Array.isArray(t.versions) ? t.versions : [];
      const cur = versions.find((v) => v.version === t.currentVersion) ?? versions[versions.length - 1] ?? {};
      const selfHosted = typeof t.entrypoint === 'string' && t.entrypoint.includes('.selfhosted/');
      lines.push(`• ${t.name} [${t.domain}] ${t.currentVersion ?? '—'} score=${cur.score ?? '—'}${selfHosted ? ' · self-hosted' : ''} · ${t.healthStatus ?? 'unknown'}`);
    }
    return lines.join('\n');
  } catch {
    return 'Recourse registry request failed.';
  }
}

/** What Recourse intends to self-develop next. */
export async function recourseAgendaSummary(): Promise<string> {
  try {
    const res = await fetch('/api/recourse/agenda', { credentials: 'include', headers: h() });
    const data = await json(res);
    if (!data?.available) return `Recourse agenda unavailable: ${data?.error || 'offline'}.`;
    const d = data.data ?? {};
    const items: any[] = Array.isArray(d.items) ? d.items : Array.isArray(d.agenda) ? d.agenda : Array.isArray(d) ? d : [];
    if (items.length === 0) return 'Recourse agenda empty.';
    return ['Recourse agenda:'].concat(items.slice(0, 8).map((it: any) => {
      const title = it?.title ?? it?.goal ?? it?.summary ?? JSON.stringify(it);
      const priority = it?.priority ?? it?.score;
      return `• ${String(title).slice(0, 180)}${priority !== undefined ? ` (${priority})` : ''}`;
    })).join('\n');
  } catch {
    return 'Recourse agenda request failed.';
  }
}

/** Recourse upgrade delta: how the system differs from its boot baseline. */
export async function recourseUpgradeSummary(): Promise<string> {
  try {
    const res = await fetch('/api/recourse/upgrade-report', { credentials: 'include', headers: h() });
    const data = await json(res);
    if (!data?.available) return `Recourse upgrade report unavailable: ${data?.error || 'offline'}.`;
    const d = data.data?.diff ?? data.data ?? {};
    const bits: string[] = [];
    if (Array.isArray(d.addedTools)) bits.push(`+${d.addedTools.length} tools`);
    if (Array.isArray(d.upgradedTools)) bits.push(`↑${d.upgradedTools.length} upgraded`);
    if (Array.isArray(d.removedTools)) bits.push(`-${d.removedTools.length} removed`);
    if (d.benchmarkSolvedDelta !== undefined) bits.push(`benchmark Δ${d.benchmarkSolvedDelta}`);
    if (d.selfhostedDelta !== undefined) bits.push(`self-hosted Δ${d.selfhostedDelta}`);
    return bits.length ? `Recourse upgrade delta: ${bits.join(' · ')}` : 'Recourse upgrade report has no delta.';
  } catch {
    return 'Recourse upgrade report request failed.';
  }
}


/** Self-healing repair scan via Recourse (guarded; requires RECOURSE_API_SECRET). */
export async function recourseHeal(ctx: Ctx): Promise<string> {
  const missing = needProject(ctx);
  if (missing) return missing;
  try {
    const res = await fetch('/api/recourse/repair/scan-heal', {
      method: 'POST',
      credentials: 'include',
      headers: mut({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ targetDir: ctx.project!.path }),
    });
    const data = await json(res);
    if (!data?.available) return `Recourse heal unavailable: ${data?.error || 'offline / no RECOURSE_API_SECRET'}.`;
    await logCopilotAction(ctx, 'recourse-heal', ctx.project!.path);
    const text = JSON.stringify(data.data);
    return text.length > 1200 ? `${text.slice(0, 1200)}\n… (truncated)` : text;
  } catch {
    return 'Recourse heal request failed.';
  }
}

/** Dream state: how every repo is tracked and graded. */
export async function dreamSummary(): Promise<string> {
  try {
    const res = await fetch('/api/dream', { credentials: 'include', headers: h() });
    const data = await json(res);
    if (!data?.ok) return 'Dream state unavailable.';
    const s = data.summary ?? {};
    const entries: any[] = data.entries ?? [];
    if (entries.length === 0) return 'Dream state empty — no repos tracked yet.';
    const lines = [`Dream: ${s.graded ?? 0}/${s.total ?? 0} graded · ${s.healthy ?? 0} healthy · ${s.attention ?? 0} attention · ${s.critical ?? 0} critical`];
    for (const e of entries.slice(0, 8)) {
      lines.push(`• ${e.name}: ${e.grade ?? '—'} (${e.score ?? 'unscored'}) · ${e.status} · ${e.development}`);
    }
    return lines.join('\n');
  } catch {
    return 'Dream state request failed.';
  }
}

/** One-line-per-section summary of the shared system snapshot. */
export async function snapshotSummary(): Promise<string> {  try {
    const res = await fetch('/api/system/snapshot', { credentials: 'include', headers: h() });
    const data = await json(res);
    const s = data?.snapshot;
    if (!data?.ok || !s) return 'Snapshot unavailable.';
    const lines: string[] = [];
    lines.push(`project: ${(s.project as any)?.ok ? (s.project as any).repositoryName : 'none'}`);
    const d = s.drift as any;
    lines.push(`drift: ${d?.ok ? `${d.ahead ?? 0}↑ ${d.behind ?? 0}↓ · ${d.uncommitted ?? 0} uncommitted` : 'n/a'}`);
    lines.push(`audit: ${(s.audit as any)?.ok ? (s.audit as any).verdict : 'none recorded'}`);
    const r = s.runs as any;
    lines.push(`runs: ${r?.ok ? `${r.total ?? 0} total · ${r.active ?? 0} active` : 'n/a'}`);
    const e = s.ecosystem as any;
    lines.push(`ecosystem: ${e?.ok ? `${e.entries ?? 0} entries` : 'empty'}`);
    const i = s.incidents as any;
    lines.push(`incidents: ${i?.ok ? `${(i.recent ?? []).length} recent` : 'n/a'}`);
    lines.push(`recourse: ${(s.recourse as any)?.summary ?? 'offline'}`);
    return lines.join('\n');
  } catch {
    return 'Snapshot request failed.';
  }
}
