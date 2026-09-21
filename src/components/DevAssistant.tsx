import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, X, Zap, Search, BookOpen, ListTodo, Play, Square, CheckCircle2,
  Loader2, FileText, Send, RefreshCw, Wrench, GitBranch,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { getAuthHeaders, getCsrfToken } from '../auth/AuthProvider';
import { useStore } from '../store';
import { driftTaskText, matchSkills } from '../lib/skillMatch';
import { useModelStore } from '../lib/modelStore';
import {
  auditAndRepair,
  addSshKey,
  addWebhook,
  askResearch,
  callMcpTool,
  controlService,
  dreamSummary,
  fleetSummary,
  generateFile,
  intelSummary,
  listMcpTools,
  listServices,
  listSshKeys,
  listTools,
  listWebhooks,
  pipelineStatus,
  pushProject,
  readProjectFile,
  refreshKnowledge,
  removeSshKey,
  removeWebhook,
  recourseAgendaSummary,
  recourseHeal,
  recourseRegistrySummary,
  recourseStatusSummary,
  recourseUpgradeSummary,
  reportHiccup,
  runAgent,
  runAudit,
  runPipeline,
  scanProjectFile,
  setToolStatus,
  snapshotSummary,
  startSupervisionRun,
  supervisionRuns,
  synergyRecall,
  testWebhook,
  triggerRepair,
  ufcCall,
  ufcTools,
  writeProjectFile,
} from '../lib/copilotActions';
import { axiomEditorChat, axiomEditorMentions } from '../ide/axiomEditorClient';
import { ContextMentions } from '../ide/MentionContext';
import { hasMentions, withContextBlock } from '../ide/contextMentions';
import { confirmGate } from './ConfirmGate';
import {
  AUTONOMY_MODES, getAutonomyMode, setAutonomyMode, gateRequired, prefersPlanGate,
  type AutonomyMode, type GateIntensity,
} from '../lib/autonomy';

/** How much friction each confirmed action deserves. */
const INTENSITY_BY_KIND: Record<string, GateIntensity> = {
  import: 'reversible', generate: 'reversible', 'ssh-add': 'reversible', 'webhook-add': 'reversible',
  tool: 'reversible', commit: 'reversible', pipeline: 'reversible', 'plan-mission': 'reversible',
  loop: 'destructive', repair: 'destructive', agent: 'destructive', mcp: 'destructive',
  service: 'destructive', 'webhook-test': 'destructive', 'webhook-remove': 'destructive',
  'ssh-remove': 'destructive', 'audit-repair': 'destructive', supervise: 'destructive',
};

interface Msg {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  confirm?: { kind: string; label: string; payload: string };
}

interface Todo {
  id: string;
  text: string;
  done: boolean;
}

interface KnowledgeEntry {
  kind: string;
  name: string;
  description: string;
  path: string;
}

const TODOS_PATH = '.openhub/todos.json';
let msgId = 0;
const nextMsgId = () => ++msgId;

const HELP = `I control this OpenHub node. Commands:
/ask <prompt> — stream a chat answer from Axiom (local or hosted tier)
/read <path> · /write <path> :: <content> · /scan <path>
/drift · /commit <msg> · /push · /unload
/loop <goal> · /stop · /loop-status
/pipeline <msg> · /pipeline-status [run]
/audit · /repair <signal> · /audit-repair
/services · /service <start|stop> <slug>
/tools · /tool <name> <on|off> · /mcp-tools · /mcp <tool> [json]
/agent <name> · /fleet · /intel · /research <q> · /reindex
/import <owner>/<repo> · /open <page>
/models · /model <axiom|review|default> [value]
/supervise <goal> · /runs · /ask <question>
/generate <path> :: <description> · /ufc-tools · /ufc <tool> [json] · /formats
/recourse · /recourse-registry · /recourse-agenda · /recourse-upgrade · /synergy <query> · /recourse-heal
/ssh-keys · /ssh-add <title> :: <key> · /ssh-remove <name>
/webhooks · /webhook-add <url> [events] · /webhook-test <id> · /webhook-remove <id>
/todo <text> · /plan <goal> · /todos
/visualize [synergy|loop|research|ecosystem|health] · /snapshot · /dream`;

function autoPlan(goal: string): string[] {
  return [
    `Explore: map the files involved in “${goal}”`,
    `Implement: smallest change that advances “${goal}”`,
    `Verify: run relevant checks and review the diff`,
    `Commit: summarize and push “${goal}”`,
  ];
}

const NAV_TARGETS: Record<string, string> = {
  command: '/',
  home: '/',
  workspace: '/workspace',
  fleet: '/fleet',
  services: '/fleet?tab=services',
  ecosystem: '/fleet?tab=ecosystem',
  tools: '/fleet?tab=ecosystem',
  tooling: '/fleet?tab=ecosystem',
  assurance: '/?tab=assurance',
  quality: '/?tab=assurance',
  audit: '/?tab=assurance&av=audit',
  repair: '/?tab=assurance&av=repair',
  pipelines: '/?tab=assurance&av=pipelines',
  autonomous: '/?tab=assurance&av=pipelines',
  readiness: '/?tab=assurance&av=readiness',
  settings: '/settings',
  integrations: '/settings?tab=integrations',
  business: '/settings?tab=business',
  repositories: '/?tab=repositories',
  github: '/?tab=repositories',
  repos: '/?tab=repositories',
  axiom: '/axiom',
  loops: '/axiom',
};

export function DevAssistant({ embedded = false }: { embedded?: boolean } = {}) {
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'tasks' | 'research' | 'loops'>('tasks');
  const { activeProject, drift, driftState, refreshDrift, registryItems, fetchRegistryItems,
    selectActiveProject, unloadActiveProject, fetchRepositories } = useStore();

  const [msgs, setMsgs] = useState<Msg[]>([
    { id: nextMsgId(), role: 'assistant', text: 'Axiom is online. I act on this workspace — read files, run Axiom loops, audit and repair, research knowledge, and keep the todo list. Type /help for commands.' },
  ]);
  const [input, setInput] = useState('');
  const [autonomy, setAutonomy] = useState<AutonomyMode>(() => getAutonomyMode());
  const [autoTrigger, setAutoTrigger] = useState<'interval' | 'drift' | 'change' | 'reactive' | 'both'>('drift');
  const [busy, setBusy] = useState(false);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [todosLoadedFor, setTodosLoadedFor] = useState<string | null>(null);

  const [researchQuery, setResearchQuery] = useState('');
  const [researchKind, setResearchKind] = useState('');
  const [researchBusy, setResearchBusy] = useState(false);
  const [researchResults, setResearchResults] = useState<KnowledgeEntry[]>([]);
  const [researchNote, setResearchNote] = useState<string | null>(null);
  const [researchTotals, setResearchTotals] = useState<Record<string, number>>({});
  const [researchSources, setResearchSources] = useState<{ root: string; label: string; entries: number }[]>([]);
  const [researchBackends, setResearchBackends] = useState<{ slug: string; name: string; present: boolean; path: string }[]>([]);

  const [axiomOnline, setAxiomOnline] = useState<boolean | null>(null);
  const [loopGoal, setLoopGoal] = useState('');
  const [loopBusy, setLoopBusy] = useState(false);
  const [loopId, setLoopId] = useState<string | null>(() => localStorage.getItem('openhub.lastLoopId'));
  const [loopStatus, setLoopStatus] = useState<string | null>(null);
  const [lastPipelineRun, setLastPipelineRun] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputElRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const h = () => inputElRef.current?.focus();
    window.addEventListener('openhub:focus-ask', h);
    return () => window.removeEventListener('openhub:focus-ask', h);
  }, []);
  // Reflect the server-side Auto trigger (set here or in Settings → Automation).
  useEffect(() => {
    void fetch('/api/pipeline/auto', { credentials: 'include', headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((j) => { if (j?.auto?.trigger) setAutoTrigger(j.auto.trigger); })
      .catch(() => { /* offline */ });
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight });
  }, [msgs, isOpen]);

  // Any surface (the workspace command bar, quick actions) can hand a request
  // to the assistant by dispatching `openhub:ask` — no duplicated send pipeline.
  const sendRef = useRef<(raw?: string) => void>(() => {});
  useEffect(() => {
    sendRef.current = handleSend;
  });
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent<{ text?: unknown }>).detail?.text;
      if (typeof text === 'string' && text.trim()) void sendRef.current(text);
    };
    window.addEventListener('openhub:ask', handler as EventListener);
    return () => window.removeEventListener('openhub:ask', handler as EventListener);
  }, []);

  const checkAxiom = async () => {
    try {
      const res = await fetch('/api/axiom/status', { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      setAxiomOnline(json.ok && json.data?.status === 'ok');
    } catch {
      setAxiomOnline(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void checkAxiom();
      if (registryItems.length === 0) void fetchRegistryItems();
      if (activeProject && driftState === 'idle') void refreshDrift();
    }
  }, [isOpen, activeProject, driftState, refreshDrift, registryItems.length, fetchRegistryItems]);

  // ---- todos persisted inside the project so long-running work survives ----
  const persistTodos = async (next: Todo[]) => {
    setTodos(next);
    if (!activeProject) return;
    try {
      await fetch('/api/project/active/contents', {
        method: 'PUT',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }),
        body: JSON.stringify({ path: TODOS_PATH, content: JSON.stringify({ todos: next }, null, 2) }),
      });
    } catch { /* local state still holds them */ }
  };

  useEffect(() => {
    const key = activeProject?.path ?? null;
    if (!isOpen || key === todosLoadedFor) return;
    setTodosLoadedFor(key);
    if (!key) {
      setTodos([]);
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/project/active/contents?path=${encodeURIComponent(TODOS_PATH)}`, {
          credentials: 'include',
          headers: getAuthHeaders(),
        });
        const data = await res.json();
        if (data.type === 'file' && data.content) {
          const parsed = JSON.parse(data.content) as { todos?: Todo[] };
          setTodos(Array.isArray(parsed.todos) ? parsed.todos : []);
        } else {
          setTodos([]);
        }
      } catch {
        setTodos([]);
      }
    })();
  }, [isOpen, activeProject?.path, todosLoadedFor]);

  const toggleTodo = (id: string) => {
    void persistTodos(todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  };

  // ---- auto-matched skills for this project ----
  const suggestedSkills = useMemo(() => {
    const task = driftTaskText({
      repositoryName: activeProject?.repositoryName,
      ahead: drift?.ahead ?? 0,
      behind: drift?.behind ?? 0,
      uncommitted: drift?.uncommitted ?? 0,
      files: drift?.files ?? [],
    });
    if (!task.trim() || registryItems.length === 0) return [];
    return matchSkills(
      task,
      registryItems.map((t) => ({ id: t.id, name: t.name, description: t.description, kind: t.type })),
      4,
    );
  }, [activeProject?.repositoryName, drift, registryItems]);

  const say = (text: string, confirm?: Msg['confirm']) => {
    const id = nextMsgId();
    setMsgs((prev) => [...prev.slice(-60), { id, role: 'assistant', text }]);
    if (!confirm) return;
    // Confirmation gate: pop up (triaged by intensity) unless the autonomy mode
    // says this action may run freely.
    const intensity = INTENSITY_BY_KIND[confirm.kind] ?? 'destructive';
    if (!gateRequired(intensity)) {
      void runConfirm({ id, role: 'assistant', text, confirm });
      return;
    }
    void confirmGate({ title: confirm.label, detail: text, intensity, confirmLabel: confirm.label }).then((ok) => {
      if (ok) void runConfirm({ id, role: 'assistant', text, confirm });
      else say('Cancelled — no changes made.');
    });
  };

  // ---- real actions (control layer in lib/copilotActions) ----
  const ctx = { project: activeProject };

  const readFile = async (filePath: string) => {
    say(await readProjectFile(ctx, filePath));
  };

  const runResearch = async (query: string, kind: string = researchKind) => {
    setResearchBusy(true);
    setResearchNote(null);
    try {
      const params = new URLSearchParams();
      if (kind) params.set('kind', kind);
      if (query.trim()) params.set('search', query.trim());
      const res = await fetch(`/api/ecosystem/knowledge?${params.toString()}`, {
        credentials: 'include',
        headers: getAuthHeaders(),
      });
      const json = await res.json();
      const entries = (json.entries ?? []) as KnowledgeEntry[];
      setResearchResults(entries.slice(0, 30));
      setResearchTotals((json.totals ?? {}) as Record<string, number>);
      setResearchSources((json.sources ?? []) as { root: string; label: string; entries: number }[]);
      try {
        const rosterRes = await fetch('/api/agents/roster', { credentials: 'include', headers: getAuthHeaders() });
        const roster = await rosterRes.json();
        if (roster.ok && Array.isArray(roster.research)) {
          setResearchBackends(roster.research as { slug: string; name: string; present: boolean; path: string }[]);
        }
      } catch { /* research engines offline */ }
      const total = entries.length;
      setResearchNote(json.live ? `${total} result${total === 1 ? '' : 's'}` : 'Knowledge index not configured (OPENHUB_ECOSYSTEM_ROOTS).');
      setActiveTab('research');
      const kindLabel = kind ? ` [${kind}]` : '';
      say(entries.length ? `Research found ${entries.length} asset${entries.length === 1 ? '' : 's'}${kindLabel} for “${query}” — listed under Research.` : `Research found nothing for “${query}”${kindLabel}.`);
    } catch {
      setResearchNote('Research request failed.');
      say('Research request failed — is the server reachable?');
    } finally {
      setResearchBusy(false);
    }
  };

  const dispatchLoop = async (goal: string) => {
    if (!activeProject) {
      say('Load a project first — loops run against the active project.');
      return;
    }
    setLoopBusy(true);
    try {
      const res = await fetch('/api/axiom/project/run', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }),
        body: JSON.stringify({ goal, modelRoute: useModelStore.getState().routes.axiom || 'auto', maxIterations: 8 }),
      });
      const json = await res.json();
      if (json.ok && json.data?.id) {
        setLoopId(json.data.id);
        localStorage.setItem('openhub.lastLoopId', json.data.id);
        setLoopStatus('running');
        say(`Loop dispatched on ${activeProject.repositoryName} (id ${String(json.data.id).slice(0, 8)}). Track it under Loops.`);
      } else {
        say(`Loop failed to start: ${json.error || 'unknown error'}.`);
        void reportHiccup('loop-dispatch-failed', `Loop failed to start on ${activeProject.repositoryName}: ${json.error || 'unknown'}.`, 'medium');
      }
    } catch (err) {
      say(`Loop dispatch error: ${err instanceof Error ? err.message : 'request failed'}.`);
      void reportHiccup('loop-dispatch-error', `Loop dispatch error: ${err instanceof Error ? err.message : 'request failed'}.`, 'medium');
    } finally {
      setLoopBusy(false);
    }
  };

  const stopLoop = async () => {
    if (!loopId) {
      say('No loop to stop.');
      return;
    }
    try {
      await fetch(`/api/axiom/project/stop/${loopId}`, {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'X-CSRF-Token': getCsrfToken() }),
      });
      setLoopStatus('stopped');
      say('Stop signal sent to the loop.');
    } catch {
      say('Stop request failed.');
    }
  };

  const commitChanges = async (message: string) => {
    say(await commitProjectFile(message));
  };

  const commitProjectFile = async (message: string): Promise<string> => {
    if (!activeProject) return 'Load a project first.';
    try {
      const res = await fetch('/api/project/active/git/commit', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }),
        body: JSON.stringify({ message }),
      });
      const resJson = await res.json();
      if (resJson.ok) {
        void refreshDrift();
        return `Committed: “${message}”.`;
      }
      return `Commit failed: ${resJson.error || 'unknown error'}.`;
    } catch {
      return 'Commit request failed.';
    }
  };

  const importAndLoad = async (owner: string, repo: string) => {
    try {
      const res = await fetch('/api/github/import', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }),
        body: JSON.stringify({ owner, repo }),
      });
      const data = await res.json();
      if (!res.ok || !data?.repo?.id) {
        say(`Import failed: ${data?.error || `HTTP ${res.status}`}.`);
        return;
      }
      await fetchRepositories();
      if (activeProject && activeProject.repoId !== data.repo.id) await unloadActiveProject();
      const selected = await selectActiveProject(data.repo.id);
      say(selected.ok ? `Imported and loaded ${owner}/${repo}. Drift scan running.` : `Imported but couldn't load: ${selected.error}`);
    } catch {
      say('Import request failed.');
    }
  };

  const driftSummary = () => {
    if (!activeProject) return 'No project loaded.';
    if (driftState === 'ok' && drift) {
      if (!drift.hasUpstream) {
        return `${activeProject.repositoryName}: ${drift.uncommitted} uncommitted change${drift.uncommitted === 1 ? '' : 's'}; no upstream branch to compare against yet.`;
      }
      const total = drift.ahead + drift.behind + drift.uncommitted;
      return total === 0
        ? `${activeProject.repositoryName} is in sync with its last push.`
        : `${activeProject.repositoryName}: ${drift.ahead} ahead, ${drift.behind} behind, ${drift.uncommitted} uncommitted.${drift.stat ? ` ${drift.stat}.` : ''}`;
    }
    return driftState === 'scanning' ? 'Scanning drift…' : 'Drift unavailable for this project.';
  };

  // ---- intent router ----
  const handleSend = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || busy) return;
    setInput('');
    setMsgs((prev) => [...prev.slice(-60), { id: nextMsgId(), role: 'user', text }]);
    setBusy(true);
    try {
      const lower = text.toLowerCase();
      if (text === '/help' || lower === 'help') {
        say(HELP);
        return;
      }
      const slash = text.match(/^\/(\w+)\s*(.*)$/);
      const cmd = slash?.[1]?.toLowerCase();
      const arg = (slash?.[2] ?? '').trim();

      if (cmd === 'ask' && arg) {
        const id = nextMsgId();
        setMsgs((prev) => [...prev.slice(-60), { id, role: 'assistant', text: '' }]);
        const patch = (fn: (m: Msg) => Msg) => setMsgs((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
        try {
          // Resolve @file/@folder/@code/@docs/@git mentions into a context block
          // before asking, so a prompt can carry real repo context. Best-effort:
          // an unresolved or failed mention sends the raw question.
          let question = arg;
          if (hasMentions(arg) && activeProject?.path) {
            try {
              const m = await axiomEditorMentions({ dir: activeProject.path, text: arg });
              const block = (m.data as { block?: string } | undefined)?.block;
              if (block) question = withContextBlock(arg, block);
            } catch { /* send the raw question */ }
          }
          const history = msgs.slice(-8).map((m) => ({ role: m.role, content: m.text }));
          const r = await axiomEditorChat([...history, { role: 'user', content: question }], (delta) => {
            patch((m) => ({ ...m, text: m.text + delta }));
          });
          if (!r.text) patch((m) => ({ ...m, text: r.note ? `(${r.note})` : '(no response)' }));
          else if (r.tier) patch((m) => ({ ...m, text: `${m.text}\n\n— ${r.tier}${r.model ? `:${r.model}` : ''}` }));
        } catch (e) {
          patch((m) => ({ ...m, text: `stream failed: ${(e as Error).message}` }));
        }
        return;
      }
      if (cmd === 'read' && arg) {
        await readFile(arg.replace(/^["']|["']$/g, ''));
        return;
      }
      if (cmd === 'loop' && arg) {
        if (prefersPlanGate()) {
          say(`Plan-gate a mission for: “${arg}”? (it runs only after you approve the plan)`, { kind: 'plan-mission', label: 'Plan mission', payload: arg });
          return;
        }
        say(`Dispatch an Axiom loop for: “${arg}”?`, { kind: 'loop', label: 'Run loop', payload: arg });
        return;
      }
      if (cmd === 'loop-status') {
        if (!loopId) {
          say('No loop tracked yet — dispatch one with /loop <goal>.');
        } else {
          try {
            const res = await fetch(`/api/axiom/project/status/${loopId}`, { credentials: 'include', headers: getAuthHeaders() });
            const data = await res.json();
            setLoopStatus(data?.data?.status ?? null);
            say(`Loop ${loopId.slice(0, 8)}: ${JSON.stringify(data?.data ?? data).slice(0, 500)}`);
          } catch {
            say('Loop status request failed.');
          }
        }
        return;
      }
      if (cmd === 'stop') {
        await stopLoop();
        return;
      }
      if (cmd === 'write' && arg) {
        const sep = arg.indexOf('::');
        if (sep < 0) {
          say('Usage: /write <path> :: <content>');
          return;
        }
        const filePath = arg.slice(0, sep).trim();
        const content = arg.slice(sep + 2).trim();
        if (!filePath || !content) {
          say('Usage: /write <path> :: <content>');
          return;
        }
        say(`Write ${content.length} chars to ${filePath}? Preview:\n${content.slice(0, 400)}${content.length > 400 ? '\n…' : ''}`, {
          kind: 'write',
          label: 'Write file',
          payload: JSON.stringify({ filePath, content }),
        });
        return;
      }
      if (cmd === 'scan' && arg) {
        say(await scanProjectFile(ctx, arg.replace(/^["']|["']$/g, '')));
        return;
      }
      if (cmd === 'push') {
        say('Push the current branch to origin?', { kind: 'push', label: 'Push', payload: '' });
        return;
      }
      if (cmd === 'unload') {
        say(`Unload project ${activeProject?.repositoryName ?? ''}?`, { kind: 'unload', label: 'Unload', payload: '' });
        return;
      }
      if (cmd === 'pipeline' && arg) {
        say(`Trigger CI pipeline: “${arg}”?`, { kind: 'pipeline', label: 'Run pipeline', payload: arg });
        return;
      }
      if (cmd === 'pipeline-status') {
        const id = arg || lastPipelineRun;
        if (!id) {
          say('No pipeline run tracked — trigger one with /pipeline <message>.');
          return;
        }
        say(await pipelineStatus(id));
        return;
      }
      if (cmd === 'services') {
        say(await listServices());
        return;
      }
      if (cmd === 'service' && arg) {
        const m = arg.match(/^(start|stop)\s+(.+)$/i);
        if (!m) {
          say('Usage: /service <start|stop> <slug>');
          return;
        }
        say(`${m[1] === 'start' ? 'Start' : 'Stop'} service ${m[2]}?`, {
          kind: 'service',
          label: m[1] === 'start' ? 'Start service' : 'Stop service',
          payload: JSON.stringify({ slug: m[2], action: m[1].toLowerCase() }),
        });
        return;
      }
      if (cmd === 'tools') {
        say(await listTools());
        return;
      }
      if (cmd === 'tool' && arg) {
        const m = arg.match(/^(.+?)\s+(on|off|active|inactive|enable|disable)$/i);
        if (!m) {
          say('Usage: /tool <name> <on|off>');
          return;
        }
        const on = /^(on|active|enable)$/i.test(m[2]);
        say(`Set tool ${m[1]} ${on ? 'active' : 'inactive'}?`, {
          kind: 'tool',
          label: on ? 'Activate tool' : 'Deactivate tool',
          payload: JSON.stringify({ name: m[1], status: on ? 'active' : 'inactive' }),
        });
        return;
      }
      if (cmd === 'fleet') {
        say(await fleetSummary());
        return;
      }
      if (cmd === 'intel') {
        say(await intelSummary());
        return;
      }
      if (cmd === 'audit') {
        say('Running audit suite against the active project…');
        say(await runAudit(ctx));
        return;
      }
      if (cmd === 'audit-repair') {
        say('Audit, then repair only if it fails?', { kind: 'audit-repair', label: 'Audit + repair', payload: '' });
        return;
      }
      if (cmd === 'repair' && arg) {
        say(`Dispatch repair triage with signal: “${arg}”?`, { kind: 'repair', label: 'Dispatch repair', payload: arg });
        return;
      }
      if (cmd === 'agent' && arg) {
        say(`Dispatch fleet agent “${arg}” against the active project?`, { kind: 'agent', label: 'Run agent', payload: arg });
        return;
      }
      if (cmd === 'mcp-tools') {
        say(await listMcpTools());
        return;
      }
      if (cmd === 'mcp' && arg) {
        const space = arg.indexOf(' ');
        const tool = space < 0 ? arg : arg.slice(0, space);
        const argsText = space < 0 ? '' : arg.slice(space + 1);
        say(`Call MCP tool ${tool}${argsText ? ` with ${argsText.slice(0, 200)}` : ''}?`, {
          kind: 'mcp',
          label: 'Call MCP tool',
          payload: JSON.stringify({ tool, argsText }),
        });
        return;
      }
      if (cmd === 'reindex') {
        say(await refreshKnowledge());
        return;
      }
      if (cmd === 'import' && arg) {
        const m = arg.match(/^([\w.-]+)\/([\w.-]+)$/);
        if (!m) {
          say('Usage: /import <owner>/<repo>');
          return;
        }
        say(`Import GitHub repo ${m[1]}/${m[2]} and load it?`, {
          kind: 'import',
          label: 'Import + load',
          payload: JSON.stringify({ owner: m[1], repo: m[2] }),
        });
        return;
      }
      if (cmd === 'open' && arg) {
        const target = NAV_TARGETS[arg.toLowerCase()];
        if (!target) {
          say(`Unknown page “${arg}”. Try: workspace, assurance, fleet, settings, repositories, axiom.`);
          return;
        }
        navigate(target);
        say(`Opening ${arg}.`);
        return;
      }
      if (cmd === 'ssh-keys') {
        say(await listSshKeys());
        return;
      }
      if (cmd === 'ssh-add' && arg) {
        const sep = arg.indexOf('::');
        if (sep < 0) {
          say('Usage: /ssh-add <title> :: <public key>');
          return;
        }
        const title = arg.slice(0, sep).trim();
        const key = arg.slice(sep + 2).trim();
        if (!title || !key) {
          say('Usage: /ssh-add <title> :: <public key>');
          return;
        }
        say(`Register SSH key “${title}”?`, {
          kind: 'ssh-add',
          label: 'Register key',
          payload: JSON.stringify({ title, key }),
        });
        return;
      }
      if (cmd === 'ssh-remove' && arg) {
        say(`Remove SSH key matching “${arg}”?`, { kind: 'ssh-remove', label: 'Remove key', payload: arg });
        return;
      }
      if (cmd === 'webhooks') {
        say(await listWebhooks());
        return;
      }
      if (cmd === 'webhook-add' && arg) {
        const parts = arg.split(/\s+/);
        const url = parts[0] ?? '';
        const events = parts.slice(1).join(' ');
        if (!url) {
          say('Usage: /webhook-add <url> [events]');
          return;
        }
        say(`Register webhook for ${url}${events ? ` (events: ${events})` : ''}?`, {
          kind: 'webhook-add',
          label: 'Add webhook',
          payload: JSON.stringify({ url, events }),
        });
        return;
      }
      if (cmd === 'webhook-test' && arg) {
        say(`Fire a test ping for webhook matching “${arg}”?`, {
          kind: 'webhook-test',
          label: 'Fire test ping',
          payload: arg,
        });
        return;
      }
      if (cmd === 'webhook-remove' && arg) {
        say(`Delete webhook matching “${arg}”?`, { kind: 'webhook-remove', label: 'Delete webhook', payload: arg });
        return;
      }
      if (cmd === 'ask' && arg) {
        say(await askResearch(ctx, arg));
        return;
      }
      if (cmd === 'supervise' && arg) {
        say(`Start a supervised run (Axiom loop → audit → repair) for: “${arg}”?`, {
          kind: 'supervise',
          label: 'Supervise run',
          payload: arg,
        });
        return;
      }
      if (cmd === 'runs') {
        say(await supervisionRuns());
        return;
      }
      if (cmd === 'snapshot') {
        say(await snapshotSummary());
        return;
      }
      if (cmd === 'dream') {
        say(await dreamSummary());
        return;
      }
      if (cmd === 'visualize') {
        const views = ['synergy', 'loop', 'research', 'ecosystem', 'health'];
        const target = (arg || 'health').toLowerCase();
        if (!views.includes(target)) {
          say(`Unknown view “${arg}”. Try: ${views.join(', ')}.`);
          return;
        }
        window.dispatchEvent(new CustomEvent('openhub:visualize', { detail: target }));
        say(`Opening the ${target} visual.`);
        return;
      }
      if (cmd === 'generate' && arg) {
        const sep = arg.indexOf('::');
        if (sep < 0) {
          say('Usage: /generate <path> :: <description>');
          return;
        }
        const filePath = arg.slice(0, sep).trim();
        const description = arg.slice(sep + 2).trim();
        if (!filePath || !description) {
          say('Usage: /generate <path> :: <description>');
          return;
        }
        say(`Generate ${filePath} from: “${description}”?`, {
          kind: 'generate',
          label: 'Generate file',
          payload: JSON.stringify({ filePath, description }),
        });
        return;
      }
      if (cmd === 'ufc-tools') {
        say(await ufcTools());
        return;
      }
      if (cmd === 'formats') {
        say(await ufcCall('get_supported_formats', ''));
        return;
      }
      if (cmd === 'recourse') {
        say(await recourseStatusSummary());
        return;
      }
      if (cmd === 'recourse-registry') {
        say(await recourseRegistrySummary());
        return;
      }
      if (cmd === 'recourse-agenda') {
        say(await recourseAgendaSummary());
        return;
      }
      if (cmd === 'recourse-upgrade') {
        say(await recourseUpgradeSummary());
        return;
      }
      if (cmd === 'synergy' && arg) {
        say(await synergyRecall(arg));
        return;
      }
      if (cmd === 'recourse-heal') {
        say(`Run Recourse self-heal scan on ${activeProject?.repositoryName ?? 'the active project'}?`, {
          kind: 'recourse-heal',
          label: 'Run self-heal',
          payload: '',
        });
        return;
      }
      if (cmd === 'ufc' && arg) {
        const space = arg.indexOf(' ');
        const tool = space < 0 ? arg : arg.slice(0, space);
        const argsText = space < 0 ? '' : arg.slice(space + 1);
        say(`Call UFC-MCP ${tool}${argsText ? ` with ${argsText.slice(0, 200)}` : ''}?`, {
          kind: 'ufc',
          label: 'Run UFC tool',
          payload: JSON.stringify({ tool, argsText }),
        });
        return;
      }
      if (cmd === 'models') {
        const store = useModelStore.getState();
        if (!store.loaded) await store.fetchModels();
        const routes = store.routes;
        const lines = [
          `Gateway: ${store.gatewayUrl || 'unreachable'} · configured ${store.configuredModel || 'fleet-free'} · ${store.models.length} models.`,
          `Axiom loop: ${routes.axiom || 'auto'}`,
          `AI review: ${routes.review || store.configuredModel || 'fleet-free'}`,
          `Default: ${routes.default || store.configuredModel || 'fleet-free'}`,
        ];
        say(`Model routing:\n${lines.join('\n')}\nCycle with /model <axiom|review|default> or pin with /model <task> <value>.`);
        return;
      }
      if (cmd === 'model' && arg) {
        const parts = arg.split(/\s+/);
        const task = (parts[0] ?? '').toLowerCase() as 'axiom' | 'review' | 'default';
        if (!['axiom', 'review', 'default'].includes(task)) {
          say('Usage: /model <axiom|review|default> [value]');
          return;
        }
        const store = useModelStore.getState();
        if (parts[1]) {
          store.setRoute(task, parts[1]);
          say(`Pinned ${task} → ${parts[1]}.`);
        } else {
          store.cycleRoute(task);
          say(`Cycled ${task} → ${useModelStore.getState().routes[task]}.`);
        }
        return;
      }
      if (cmd === 'todo' && arg) {
        await persistTodos([...todos, { id: `${Date.now()}`, text: arg, done: false }]);
        say(`Todo added: “${arg}”.`);
        return;
      }
      if ((cmd === 'plan' && arg) || lower.startsWith('plan ')) {
        const goal = arg || text.slice(5).trim();
        const steps = autoPlan(goal);
        await persistTodos([...todos, ...steps.map((s, i) => ({ id: `${Date.now()}-${i}`, text: s, done: false }))]);
        say(`Planned “${goal}” as ${steps.length} steps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
        return;
      }
      if (cmd === 'research' && arg) {
        await runResearch(arg);
        return;
      }
      if (cmd === 'drift') {
        say(driftSummary());
        return;
      }
      if (cmd === 'commit' && arg) {
        say(`Commit all changes with message: “${arg}”?`, { kind: 'commit', label: 'Commit', payload: arg });
        return;
      }
      if (cmd === 'todos' || lower === 'todos' || lower === 'todo list') {
        say(todos.length ? todos.map((t, i) => `${t.done ? '✓' : `${i + 1}.`} ${t.text}`).join('\n') : 'Todo list is empty. Add one with /todo <text>.');
        return;
      }

      // Natural language fallbacks
      const pathHit = text.match(/[`"']?((?:[\w.-]+\/)+[\w.-]+|[a-zA-Z0-9_.-]+\.(ts|tsx|js|py|md|json|css|yml|yaml|sql|sh))[`"']?/);
      if (/\b(read|show|open|view|cat)\b/.test(lower) && pathHit) {
        await readFile(pathHit[1]);
        return;
      }
      if (/\b(run|start|dispatch|launch).*\b(loop|axiom|autonom)/.test(lower) || (/\bloop\b/.test(lower) && text.length > 12)) {
        const goal = text.replace(/^(please\s+)?(run|start|dispatch|launch)\b/i, '').replace(/\b(loop|axiom|autonomous(ly)?)\b/gi, '').trim() || text;
        say(`Dispatch an Axiom loop for: “${goal}”?`, { kind: 'loop', label: 'Run loop', payload: goal });
        return;
      }
      const serviceHit = lower.match(/\b(start|stop)\b.*\bservice\b\s+([\w-]+)|service\s+([\w-]+).*\b(start|stop)\b/);
      if (serviceHit) {
        const action = (serviceHit[1] ?? serviceHit[4] ?? '').toLowerCase() as 'start' | 'stop';
        const slug = serviceHit[2] ?? serviceHit[3] ?? '';
        if (slug && (action === 'start' || action === 'stop')) {
          say(`${action === 'start' ? 'Start' : 'Stop'} service ${slug}?`, {
            kind: 'service',
            label: action === 'start' ? 'Start service' : 'Stop service',
            payload: JSON.stringify({ slug, action }),
          });
          return;
        }
      }
      if (/\b(audit and repair|audit\+repair|fix (it|this|everything))\b/.test(lower)) {
        say('Audit, then repair only if it fails?', { kind: 'audit-repair', label: 'Audit + repair', payload: '' });
        return;
      }
      if (/\brun\b.*\baudit\b|\baudit\b.*\b(project|repo|code)\b/.test(lower)) {
        say('Running audit suite against the active project…');
        say(await runAudit(ctx));
        return;
      }
      if (/\b(scan|security check)\b/.test(lower) && pathHit) {
        say(await scanProjectFile(ctx, pathHit[1]));
        return;
      }
      if (/\b(import|clone)\b/.test(lower)) {
        const m = text.match(/([\w.-]+)\/([\w.-]+)/);
        if (m) {
          say(`Import GitHub repo ${m[1]}/${m[2]} and load it?`, {
            kind: 'import',
            label: 'Import + load',
            payload: JSON.stringify({ owner: m[1], repo: m[2] }),
          });
          return;
        }
      }
      const navHit = lower.match(/^(please\s+)?(open|go to|show|navigate to)\s+([\w+]+)/);
      if (navHit) {
        const target = NAV_TARGETS[navHit[3]];
        if (target) {
          navigate(target);
          say(`Opening ${navHit[3]}.`);
          return;
        }
      }
      if (/\b(drift|diff|behind|ahead|sync|status|uncommitted|different|compare)\b/.test(lower)) {
        say(driftSummary());
        return;
      }
      if (/\bpush\b/.test(lower) && !/\bpush-sync\b/.test(lower)) {
        say('Push the current branch to origin?', { kind: 'push', label: 'Push', payload: '' });
        return;
      }
      if (/\b(ssh key|ssh-key|ssh)\b/.test(lower)) {
        if (/\b(add|register|create|new)\b/.test(lower)) {
          say('Register a key with: /ssh-add <title> :: <public key>');
          return;
        }
        if (/\b(remove|delete|revoke|drop)\b/.test(lower)) {
          const m = lower.match(/(?:remove|delete|revoke|drop)(?:\s+(?:the|key))?\s+([\w-]+)/);
          if (m) {
            say(`Remove SSH key matching “${m[1]}”?`, { kind: 'ssh-remove', label: 'Remove key', payload: m[1] });
          } else {
            say(await listSshKeys());
          }
          return;
        }
        say(await listSshKeys());
        return;
      }
      if (/\bwebhook\b/.test(lower)) {
        if (/\b(add|register|create|new)\b/.test(lower)) {
          const m = text.match(/https?:\/\/[^\s]+/i);
          if (m) {
            say(`Register webhook for ${m[0]}?`, {
              kind: 'webhook-add',
              label: 'Add webhook',
              payload: JSON.stringify({ url: m[0], events: '' }),
            });
          } else {
            say('Add one with: /webhook-add <url> [events]');
          }
          return;
        }
        if (/\b(remove|delete|drop)\b/.test(lower)) {
          const m = text.match(/(?:remove|delete|drop)(?:\s+\w+)*\s+(https?:\/\/[^\s]+|[\w-]+)/i);
          say(`Delete webhook matching “${m?.[1] ?? '…'}”?`, {
            kind: 'webhook-remove',
            label: 'Delete webhook',
            payload: m?.[1] ?? '',
          });
          return;
        }
        if (/\btest\b/.test(lower)) {
          const m = text.match(/test(?:\s+\w+)*\s+(https?:\/\/[^\s]+|[\w-]+)/i);
          if (m) {
            say(`Fire a test ping for webhook matching “${m[1]}”?`, {
              kind: 'webhook-test',
              label: 'Fire test ping',
              payload: m[1],
            });
          } else {
            say(await listWebhooks());
          }
          return;
        }
        say(await listWebhooks());
        return;
      }
      if (/\b(research|search|find|docs|documentation|look up)\b/.test(lower)) {
        await runResearch(text.replace(/\b(research|search|find|docs|documentation|look up|for|about|me|please)\b/gi, '').trim() || text);
        return;
      }
      if (/\b(drift|diff|behind|ahead|sync|status|uncommitted|push)\b/.test(lower)) {
        say(driftSummary());
        return;
      }
      if (/\b(intel|awareness|sources|knowledge base|what do you know)\b/.test(lower)) {
        say(await intelSummary());
        return;
      }
      if (/\b(stuck|need help|help me|web search|search the web|look it up|find out how)\b/.test(lower) || lower.startsWith('ask ')) {
        const q = text.replace(/^(please\s+)?(ask|help me)\b/i, '').trim() || text;
        say(await askResearch(ctx, q));
        return;
      }
      if (/\b(plan|outline|steps|todo|break down)\b/.test(lower)) {
        const goal = text.replace(/\b(plan|outline|steps|todo(s)?|break down|for|me|please|:)\b/gi, '').trim() || 'current work';
        const steps = autoPlan(goal);
        await persistTodos([...todos, ...steps.map((s, i) => ({ id: `${Date.now()}-${i}`, text: s, done: false }))]);
        say(`Planned “${goal}” as ${steps.length} steps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
        return;
      }
      say(`I can act on that with a command. ${HELP}`);
    } finally {
      setBusy(false);
    }
  };

  const runConfirm = async (msg: Msg) => {
    const confirm = msg.confirm;
    if (!confirm) return;
    setMsgs((prev) => prev.map((m) => (m.id === msg.id ? { ...m, confirm: undefined } : m)));
    switch (confirm.kind) {
      case 'loop':
        await dispatchLoop(confirm.payload);
        break;
      case 'commit':
        await commitChanges(confirm.payload);
        break;
      case 'write': {
        try {
          const { filePath, content } = JSON.parse(confirm.payload) as { filePath: string; content: string };
          say(await writeProjectFile(ctx, filePath, content));
          void refreshDrift();
        } catch {
          say('Write failed — bad payload.');
        }
        break;
      }
      case 'push':
        say(await pushProject(ctx));
        void refreshDrift();
        break;
      case 'unload':
        await unloadActiveProject();
        say('Project unloaded.');
        break;
      case 'pipeline': {
        const message = await runPipeline(ctx, confirm.payload);
        const idMatch = message.match(/run ([0-9a-f-]{6,})/i);
        if (idMatch) setLastPipelineRun(idMatch[1]);
        say(message);
        break;
      }
      case 'service': {
        try {
          const { slug, action } = JSON.parse(confirm.payload) as { slug: string; action: 'start' | 'stop' };
          say(await controlService(ctx, slug, action));
        } catch {
          say('Service control failed — bad payload.');
        }
        break;
      }
      case 'tool': {
        try {
          const { name, status } = JSON.parse(confirm.payload) as { name: string; status: 'active' | 'inactive' };
          say(await setToolStatus(ctx, name, status));
          void fetchRegistryItems();
        } catch {
          say('Tool update failed — bad payload.');
        }
        break;
      }
      case 'plan-mission': {
        // Plan mode: park the agent's work as an approvable plan (nothing runs
        // until the operator approves it in Run status).
        try {
          const res = await fetch('/api/axiom/mission/run', {
            method: 'POST',
            credentials: 'include',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
            body: JSON.stringify({ goal: confirm.payload, planGate: true }),
          });
          const json = await res.json().catch(() => ({}));
          say(json?.ok
            ? `Mission ${json?.data?.id ?? ''} parked for approval — review the plan in Run status.`
            : `Could not plan the mission: ${json?.error ?? `HTTP ${res.status}`}`);
        } catch (e) {
          say(`Could not plan the mission: ${e instanceof Error ? e.message : 'request error'}`);
        }
        break;
      }
      case 'repair':
        say(await triggerRepair(ctx, confirm.payload));
        break;
      case 'audit-repair':
        say(await auditAndRepair(ctx));
        break;
      case 'agent':
        say(await runAgent(ctx, confirm.payload));
        break;
      case 'mcp': {
        try {
          const { tool, argsText } = JSON.parse(confirm.payload) as { tool: string; argsText: string };
          say(await callMcpTool(ctx, tool, argsText));
        } catch {
          say('MCP call failed — bad payload.');
        }
        break;
      }
      case 'import': {
        try {
          const { owner, repo } = JSON.parse(confirm.payload) as { owner: string; repo: string };
          await importAndLoad(owner, repo);
        } catch {
          say('Import failed — bad payload.');
        }
        break;
      }
      case 'ssh-add': {
        try {
          const { title, key } = JSON.parse(confirm.payload) as { title: string; key: string };
          say(await addSshKey(ctx, title, key));
        } catch {
          say('SSH key registration failed — bad payload.');
        }
        break;
      }
      case 'ssh-remove':
        say(await removeSshKey(ctx, confirm.payload));
        break;
      case 'webhook-add': {
        try {
          const { url, events } = JSON.parse(confirm.payload) as { url: string; events: string };
          say(await addWebhook(ctx, url, events));
        } catch {
          say('Webhook registration failed — bad payload.');
        }
        break;
      }
      case 'webhook-test':
        say(await testWebhook(ctx, confirm.payload));
        break;
      case 'webhook-remove':
        say(await removeWebhook(ctx, confirm.payload));
        break;
      case 'supervise':
        say(await startSupervisionRun(ctx, confirm.payload));
        break;
      case 'generate': {
        try {
          const { filePath, description } = JSON.parse(confirm.payload) as { filePath: string; description: string };
          say(await generateFile(ctx, filePath, description));
          void refreshDrift();
        } catch {
          say('File generation failed — bad payload.');
        }
        break;
      }
      case 'ufc': {
        try {
          const { tool, argsText } = JSON.parse(confirm.payload) as { tool: string; argsText: string };
          say(await ufcCall(tool, argsText));
        } catch {
          say('UFC call failed — bad payload.');
        }
        break;
      }
      case 'recourse-heal':
        say(await recourseHeal(ctx));
        break;
      default:
        say('Unknown action.');
    }
  };

  const openTodos = todos.filter((t) => !t.done).length;

  const panel = (
    <>
      <div className="p-6 bg-surface-raised border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-orange-500 rounded-sm">
            <Bot className="w-5 h-5 text-black" />
          </div>
          <div>
            <h2 className="text-[var(--color-text-primary)] text-xl mb-0 leading-none">OpenHub Co-Pilot</h2>
            <div className="text-[10px] text-gray-400 font-mono flex items-center mt-1">
              <span className={`w-1.5 h-1.5 rounded-full mr-2 animate-pulse ${axiomOnline ? 'bg-green-500' : 'bg-amber-500'}`} />
              {axiomOnline === null ? 'PROBING…' : axiomOnline ? 'AXIOM LINKED' : 'AXIOM OFFLINE'}
              {activeProject ? ` // ${activeProject.repositoryName}` : ' // NO PROJECT'}
            </div>
          </div>
        </div>
        {!embedded && (
          <button onClick={() => setIsOpen(false)} className="p-2 text-gray-400 hover:text-[var(--color-text-primary)] transition-colors">
            <X className="w-6 h-6" />
          </button>
        )}
      </div>

            <div className="flex divide-x divide-white/5 border-b border-white/10">
              {[
                { id: 'tasks', label: 'TASKS', icon: ListTodo },
                { id: 'research', label: 'RESEARCH', icon: BookOpen },
                { id: 'loops', label: 'LOOPS', icon: Zap },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as typeof activeTab)}
                  className={`flex-1 py-4 flex flex-col items-center justify-center transition-all ${
                    activeTab === tab.id ? 'bg-orange-500 text-black' : 'text-gray-400 hover:bg-white/5'
                  }`}
                >
                  <tab.icon className="w-4 h-4 mb-2" />
                  <span className="text-[10px] font-black tracking-widest uppercase">{tab.label}</span>
                </button>
              ))}
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-8">
              {activeTab === 'tasks' && (
                <div className="space-y-4">
                  {suggestedSkills.length > 0 && (
                    <div className="rounded-sm border border-blue-500/20 bg-blue-500/5 p-3">
                      <div className="flex items-center gap-1.5 text-[10px] font-black text-blue-300 uppercase tracking-widest">
                        <Wrench className="w-3 h-3" /> Auto-matched for this project
                      </div>
                      <div className="mt-2 space-y-1">
                        {suggestedSkills.map((s) => (
                          <div key={s.id} className="text-[11px] text-gray-400">
                            <span className="font-bold text-[var(--color-text-primary)]">{s.name}</span>
                            <span className="font-mono"> — {s.reason}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {msgs.map((m) => (
                    <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : undefined}>
                      <div
                        className={`max-w-[90%] p-3 rounded-sm border text-xs leading-relaxed whitespace-pre-wrap ${
                          m.role === 'user'
                            ? 'bg-blue-600/20 border-blue-500/30 text-[var(--color-text-primary)]'
                            : 'bg-white/5 border-white/5 text-gray-400 italic'
                        }`}
                      >
                        {m.text}
                        {m.confirm && (
                          <button
                            onClick={() => void runConfirm(m)}
                            className="mt-2 flex items-center gap-1.5 rounded bg-orange-500 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-black hover:bg-white not-italic"
                          >
                            <Play className="w-3 h-3" /> {m.confirm.label}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  {busy && (
                    <div className="flex items-center gap-2 text-[11px] font-mono text-gray-400">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> working…
                    </div>
                  )}

                  <div className="pt-2 border-t border-white/5">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-[10px] font-black text-gray-400 uppercase tracking-widest">
                        Project todos {openTodos > 0 && <span className="text-orange-400">· {openTodos} open</span>}
                      </div>
                      <span className="font-mono text-[11px] text-gray-400">saved in .openhub/todos.json</span>
                    </div>
                    {todos.length === 0 ? (
                      <p className="text-[11px] text-gray-400">No todos yet — say “plan” with a goal and I will outline the steps.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {todos.map((t) => (
                          <button
                            key={t.id}
                            onClick={() => toggleTodo(t.id)}
                            className="flex w-full items-start gap-2 rounded-sm border border-white/5 bg-black/20 px-2.5 py-1.5 text-left hover:border-orange-500/40"
                          >
                            {t.done ? (
                              <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-green-500" />
                            ) : (
                              <span className="mt-1 h-3 w-3 shrink-0 rounded-full border border-gray-400" />
                            )}
                            <span className={`text-[11px] ${t.done ? 'text-gray-400 line-through' : 'text-[var(--color-text-primary)]'}`}>{t.text}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'research' && (
                <div className="space-y-4">
                  <div className="relative">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                      type="text"
                      value={researchQuery}
                      onChange={(e) => setResearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void runResearch(researchQuery);
                      }}
                      placeholder="Search skills, agents, workflows…"
                      className="w-full bg-surface-raised border border-white/10 py-3 pl-12 pr-4 text-sm text-[var(--color-text-primary)] focus:border-orange-500 outline-none"
                    />
                  </div>

                  {/* Kind filter chips */}
                  <div className="flex flex-wrap gap-1.5">
                    {['', 'agent', 'skill', 'workflow', 'reference', 'template', 'rule', 'command'].map((k) => (
                      <button
                        key={k || 'all'}
                        onClick={() => {
                          setResearchKind(k);
                          void runResearch(researchQuery, k);
                        }}
                        className={`rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold uppercase transition ${
                          researchKind === k
                            ? 'border-orange-500/60 bg-orange-500/15 text-orange-300'
                            : 'border-white/10 text-gray-400 hover:text-[var(--color-text-primary)]'
                        }`}
                      >
                        {k || 'all'}
                        {researchTotals[k] !== undefined && k !== '' && (
                          <span className="ml-1 text-gray-400">{researchTotals[k]}</span>
                        )}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void runResearch(researchQuery)}
                      disabled={researchBusy}
                      className="flex-1 py-2 bg-orange-500/10 border border-orange-500/20 text-orange-500 text-[10px] font-black uppercase tracking-widest hover:bg-orange-500 hover:text-black transition-all disabled:opacity-40"
                    >
                      {researchBusy ? 'Searching…' : 'Search knowledge'}
                    </button>
                    <button
                      onClick={() => void refreshKnowledge().then((msg) => say(msg))}
                      title="Re-index all intel sources"
                      className="inline-flex items-center gap-1.5 rounded border border-white/10 px-2.5 py-2 text-[10px] font-black uppercase tracking-widest text-gray-400 hover:text-[var(--color-text-primary)]"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Intel sources */}
                  {researchSources.length > 0 && (
                    <div className="rounded-sm border border-white/5 bg-black/20 p-2.5">
                      <div className="text-[11px] font-black uppercase tracking-widest text-gray-400">Intel sources</div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {researchSources.map((s) => (
                          <span key={s.root} className="inline-flex items-center gap-1.5 rounded-full border border-border-muted px-2 py-0.5 text-[10px] text-gray-400" title={s.root}>
                            <span className="h-1 w-1 rounded-full bg-emerald-400" />
                            {s.label}
                            <span className="font-mono text-gray-400">{s.entries}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Research engines */}
                  {researchBackends.length > 0 && (
                    <div className="rounded-sm border border-white/5 bg-black/20 p-2.5">
                      <div className="text-[11px] font-black uppercase tracking-widest text-gray-400">Research engines</div>
                      <div className="mt-1.5 space-y-1">
                        {researchBackends.map((b) => (
                          <div key={b.slug} className="flex items-center gap-2 text-[10px] text-gray-400" title={b.path}>
                            <span className={`h-1.5 w-1.5 rounded-full ${b.present ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                            <span className="font-bold text-[var(--color-text-primary)]">{b.name}</span>
                            <span className="ml-auto font-mono">{b.present ? 'ready' : 'offline'}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {researchNote && <p className="font-mono text-[10px] text-gray-400">{researchNote}</p>}

                  <div className="space-y-3">
                    {researchResults.length === 0 && !researchBusy ? (
                      <p className="py-4 text-center text-[11px] text-gray-400">Type a query — I search agents, skills, workflows, rules, and docs across every intel source.</p>
                    ) : (
                      researchResults.map((r) => {
                        const source = r.path.includes('/') ? r.path.split('/')[0] : null;
                        return (
                          <div key={`${r.kind}-${r.name}-${r.path}`} className="rounded-sm border border-white/5 bg-black/20 p-3 hover:border-orange-500/40 transition-colors">
                            <div className="flex items-center gap-2">
                              <span className="rounded border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 font-mono text-[11px] uppercase text-blue-300">
                                {r.kind}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-sm font-bold text-[var(--color-text-primary)]">{r.name}</span>
                              {source && <span className="shrink-0 font-mono text-[11px] text-gray-400">{source}</span>}
                            </div>
                            {r.description && <p className="mt-1 text-[11px] text-gray-400 line-clamp-3">{r.description}</p>}
                            <p className="mt-1 truncate font-mono text-[10px] text-gray-400">{r.path}</p>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'loops' && (
                <div className="space-y-4">
                  <div className="industrial-card p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-[var(--color-text-primary)]">
                        <GitBranch className="w-4 h-4 text-emerald-400" /> Axiom daemon
                      </div>
                      <span className={`font-mono text-[10px] ${axiomOnline ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {axiomOnline === null ? 'probing…' : axiomOnline ? '● online' : '○ offline'}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-gray-400">
                      {activeProject ? `Runs against ${activeProject.repositoryName}.` : 'Load a project to run loops.'}
                    </p>
                    <textarea
                      value={loopGoal}
                      onChange={(e) => setLoopGoal(e.target.value)}
                      placeholder="Loop goal…"
                      rows={2}
                      className="mt-2 w-full rounded border border-white/10 bg-black/40 p-2 text-xs text-[var(--color-text-primary)] placeholder-gray-500 outline-none focus:border-orange-500 resize-none"
                    />
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => void dispatchLoop(loopGoal || `Advance ${activeProject?.repositoryName ?? 'project'}`)}
                        disabled={loopBusy || !activeProject}
                        className="flex flex-1 items-center justify-center gap-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white"
                      >
                        {loopBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                        Run loop
                      </button>
                      <button
                        onClick={() => void stopLoop()}
                        disabled={!loopId}
                        className="flex items-center justify-center gap-1.5 rounded border border-red-500/30 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-red-400 hover:bg-red-500/10 disabled:opacity-40"
                      >
                        <Square className="w-3.5 h-3.5" /> Stop
                      </button>
                    </div>
                    {loopId && (
                      <p className="mt-2 truncate font-mono text-[10px] text-gray-400">
                        last loop {loopId.slice(0, 8)} · {loopStatus ?? 'unknown'}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      void checkAxiom();
                      void refreshDrift();
                      if (loopId) {
                        void (async () => {
                          try {
                            const res = await fetch(`/api/axiom/project/status/${loopId}`, {
                              credentials: 'include',
                              headers: getAuthHeaders(),
                            });
                            const data = await res.json();
                            setLoopStatus(data?.data?.status ?? 'unknown');
                          } catch {
                            setLoopStatus('unreachable');
                          }
                        })();
                      }
                    }}
                    className="flex w-full items-center justify-center gap-1.5 py-2 text-[10px] font-black uppercase tracking-widest text-gray-400 hover:text-[var(--color-text-primary)]"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Refresh status
                  </button>
                  <div className="rounded-sm border border-white/5 bg-black/20 p-3 font-mono text-[10px] text-gray-400">
                    <FileText className="w-3.5 h-3.5 mb-1 text-gray-400" />
                    {driftSummary()}
                  </div>
                </div>
              )}
            </div>

            <div className="px-4 pt-2 bg-surface-raised border-t border-white/10">
              <ContextMentions projectPath={activeProject?.path ?? ''} text={input} />
            </div>
            <div className="p-4 bg-surface-raised border-t border-white/10 flex items-center space-x-2">
              <input
                ref={inputElRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSend();
                }}
                placeholder="Ask Axiom… (/help for commands, @file to attach context)"
                className="flex-1 bg-[var(--color-surface-base)] border border-[var(--color-border-muted)] p-3 text-xs text-[var(--color-text-primary)] outline-none focus:border-orange-500"
              />
              <button
                onClick={() => void handleSend()}
                disabled={busy}
                aria-label="Send message"
                className="p-3 bg-orange-500 text-black hover:bg-white transition-colors disabled:opacity-40"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </div>
    </>
  );

  if (embedded) {
    return (
      <div className="flex h-full w-full min-h-0 flex-col bg-surface-base">
        {/* Single Axiom surface: chat is the one input; these chips are
            shortcuts into the same pipeline, not separate tools. */}
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2">
          <Bot className="w-4 h-4 text-orange-400" />
          <span className="text-sm font-bold text-[var(--color-text-primary)]">Axiom</span>
          <span className="hidden xl:inline text-[10px] text-gray-500">chat · loops · audit · compose</span>
          <div className="ml-auto flex items-center gap-1">
            <label className="mr-1 flex items-center gap-1" title={AUTONOMY_MODES.find((m) => m.id === autonomy)?.hint}>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Autonomy</span>
              <select
                value={autonomy}
                onChange={(e) => {
                  const m = e.target.value as AutonomyMode;
                  setAutonomy(m);
                  setAutonomyMode(m);
                  // Auto mode runs the pipeline unattended on the server (interval
                  // based, kill-switch aware). Manual/Plan turn that off.
                  void fetch('/api/pipeline/auto', {
                    method: 'PUT',
                    credentials: 'include',
                    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                    body: JSON.stringify({ enabled: m === 'auto' }),
                  }).catch(() => { /* server sync is best-effort */ });
                }}
                className="rounded border border-white/10 bg-[var(--color-surface-base)] px-1.5 py-0.5 text-[10px] font-bold text-gray-300 outline-none focus:border-orange-500"
              >
                {AUTONOMY_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
            {autonomy === 'auto' && (
              <select
                value={autoTrigger}
                onChange={(e) => {
                  const t = e.target.value as 'interval' | 'drift' | 'change' | 'reactive' | 'both';
                  setAutoTrigger(t);
                  void fetch('/api/pipeline/auto', {
                    method: 'PUT',
                    credentials: 'include',
                    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                    body: JSON.stringify({ trigger: t }),
                  }).catch(() => { /* best-effort */ });
                }}
                title="What triggers an unattended run (full controls in Settings → Automation)"
                className="rounded border border-white/10 bg-[var(--color-surface-base)] px-1.5 py-0.5 text-[10px] font-bold text-gray-300 outline-none focus:border-orange-500"
              >
                <option value="change">On save</option>
                <option value="drift">On drift</option>
                <option value="reactive">Save or drift</option>
                <option value="interval">On timer</option>
                <option value="both">Everything</option>
              </select>
            )}
            <button
              type="button"
              onClick={() => void handleSend('/audit')}
              disabled={busy}
              className="rounded border border-white/10 px-2 py-0.5 text-[10px] font-semibold text-gray-400 hover:text-[var(--color-text-primary)] disabled:opacity-40"
              title="Run the audit team on the active project"
            >
              Audit
            </button>
            <button
              type="button"
              onClick={() => { setInput('/loop '); inputElRef.current?.focus(); }}
              className="rounded border border-white/10 px-2 py-0.5 text-[10px] font-semibold text-gray-400 hover:text-[var(--color-text-primary)]"
              title="Run an autonomous loop for a goal"
            >
              Loop
            </button>
            <button
              type="button"
              onClick={() => { setInput('/generate '); inputElRef.current?.focus(); }}
              className="rounded border border-white/10 px-2 py-0.5 text-[10px] font-semibold text-gray-400 hover:text-[var(--color-text-primary)]"
              title="Compose a file: /generate <path> :: <description>"
            >
              Compose
            </button>
            <button
              type="button"
              onClick={() => void handleSend('/help')}
              disabled={busy}
              className="rounded border border-white/10 px-2 py-0.5 text-[10px] font-semibold text-gray-400 hover:text-[var(--color-text-primary)] disabled:opacity-40"
            >
              Help
            </button>
          </div>
        </div>
        {panel}
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-8 right-8 z-[60] bg-orange-500 text-black p-4 rounded-sm shadow-[0_0_20px_rgba(215,96,39,0.5)] hover:scale-110 transition-all flex items-center group overflow-hidden"
      >
        <div className="absolute inset-0 bg-white/20 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-500" />
        <Bot className="w-6 h-6 mr-3" />
        <span className="font-display text-xl tracking-wider">Dev_CO-PILOT</span>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, x: 400 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 400 }}
            className="fixed inset-y-0 right-0 w-[450px] max-w-[92vw] z-[70] bg-surface-base border-l border-white/10 shadow-[-20px_0_40px_rgba(0,0,0,0.8)] flex flex-col"
          >
            {panel}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
