import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Bot, Loader2, Plus, Send, ShieldCheck, User } from 'lucide-react';
import { getAuthHeaders } from '../auth/AuthProvider';
import { cn } from '../lib/utils';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

interface ToolCall {
  tool: string;
  ok: boolean;
  summary: string;
  at: string;
}

interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

interface Approval {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  status: 'pending' | 'allowed' | 'denied' | 'executed' | 'failed';
  createdAt: number;
  reason?: string | null;
}

const SUGGESTIONS = [
  'What is down right now?',
  'What ran overnight and did anything fail?',
  'Show the failing crons and their schedules.',
  'Summarise ecosystem telemetry for the last 24 hours.',
];

function messageTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ChatView() {
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [tools, setTools] = useState<ToolCall[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [deciding, setDeciding] = useState<string>('');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string>('Connecting…');
  const [tier, setTier] = useState<string>('');
  const [error, setError] = useState<string>('');
  const esRef = useRef<EventSource | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const loadSession = useCallback(async (id: string) => {
    const res = await fetch(`/api/harness/sessions/${id}`, {
      credentials: 'include',
      headers: getAuthHeaders(),
    });
    const body = (await res.json()) as {
      ok?: boolean;
      session?: Session;
      messages?: Message[];
      toolCalls?: Array<{ tool: string; status: string; result: { summary?: string; at?: string } }>;
      approvals?: Approval[];
      error?: string;
    };
    if (!res.ok || !body.ok || !body.session) throw new Error(body.error || `HTTP ${res.status}`);
    setSession(body.session);
    setMessages(body.messages ?? []);
    setTools(
      (body.toolCalls ?? []).map((call) => ({
        tool: call.tool,
        ok: call.status === 'ok',
        summary: call.result?.summary ?? '',
        at: call.result?.at ?? '',
      })),
    );
    setApprovals(body.approvals ?? []);
    setStatus('Ready');
  }, []);

  const ensureSession = useCallback(async (): Promise<string> => {
    setError('');
    const listed = await fetch('/api/harness/sessions', {
      credentials: 'include',
      headers: getAuthHeaders(),
    });
    const body = (await listed.json()) as { sessions?: Session[]; error?: string };
    if (!listed.ok) throw new Error(body.error || `HTTP ${listed.status}`);
    const first = body.sessions?.[0];
    if (first) return first.id;

    const created = await fetch('/api/harness/sessions', {
      method: 'POST',
      credentials: 'include',
      headers: { ...getAuthHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const createdBody = (await created.json()) as { session?: Session; error?: string };
    if (!created.ok || !createdBody.session) throw new Error(createdBody.error || `HTTP ${created.status}`);
    return createdBody.session.id;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const id = await ensureSession();
        if (cancelled) return;
        await loadSession(id);
      } catch (e) {
        if (!cancelled) {
          setStatus('Unavailable');
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ensureSession, loadSession]);

  useEffect(() => {
    if (!session) return;
    esRef.current?.close();
    const es = new EventSource(`/api/harness/sessions/${session.id}/events`);
    esRef.current = es;
    es.addEventListener('ready', () => setStatus('Ready'));
    es.addEventListener('turn.started', () => setStatus('Working…'));
    es.addEventListener('tool.started', (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { tool: string; at: string };
      setStatus(`Running ${data.tool}…`);
      setTools((prev) => [
        { tool: data.tool, ok: true, summary: 'running…', at: data.at },
        ...prev.filter((t) => !(t.tool === data.tool && t.summary === 'running…')),
      ].slice(0, 12));
    });
    es.addEventListener('tool.result', (event) => {
      const data = JSON.parse((event as MessageEvent).data) as ToolCall;
      setTools((prev) => [
        { tool: data.tool, ok: data.ok, summary: data.summary, at: data.at },
        ...prev.filter((t) => !(t.tool === data.tool && t.summary === 'running…')),
      ].slice(0, 12));
    });
    es.addEventListener('approval.required', (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { approval: Approval };
      setApprovals((prev) => [data.approval, ...prev.filter((a) => a.id !== data.approval.id)]);
      setStatus('Waiting for approval');
    });
    es.addEventListener('approval.resolved', (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { approval: Approval };
      setApprovals((prev) => prev.map((a) => (a.id === data.approval.id ? data.approval : a)));
      setStatus('Ready');
    });
    es.addEventListener('assistant.final', (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { text: string; tier?: string };
      setTier(data.tier ?? '');
      setStatus('Ready');
    });
    es.addEventListener('error', (event) => {
      const raw = (event as MessageEvent).data;
      if (!raw) return;
      try {
        const data = JSON.parse(raw) as { message?: string };
        setError(data.message ?? 'Harness error');
      } catch {
        setError('Harness error');
      }
      setStatus('Error');
    });
    return () => {
      es.close();
      esRef.current = null;
    };
  }, [session?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, tools.length]);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || sending || !session) return;
    setSending(true);
    setError('');
    setStatus('Working…');
    setInput('');
    const optimistic: Message = {
      id: `local-${Date.now()}`,
      role: 'user',
      content,
      createdAt: Date.now(),
    };
    setMessages((prev) => [...prev, optimistic]);
    try {
      const res = await fetch(`/api/harness/sessions/${session.id}/message`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        text?: string;
        tier?: string;
        messages?: Message[];
        toolCalls?: ToolCall[];
        approvals?: Approval[];
        approval?: Approval | null;
        error?: string;
      };
      if (body.messages) setMessages(body.messages);
      if (body.toolCalls) setTools((prev) => [...body.toolCalls!, ...prev].slice(0, 12));
      if (body.approvals) setApprovals(body.approvals);
      if (body.tier) setTier(body.tier);
      if (!res.ok || !body.ok) setError(body.error || body.text || `HTTP ${res.status}`);
      setStatus(body.approval ? 'Waiting for approval' : 'Ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('Error');
    } finally {
      setSending(false);
    }
  };

  const decide = async (id: string, allow: boolean) => {
    if (deciding) return;
    setDeciding(id);
    setError('');
    try {
      const res = await fetch(`/api/harness/approvals/${id}`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ allow }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; text?: string };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (session) await loadSession(session.id);
      setStatus('Ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeciding('');
    }
  };

  const newChat = async () => {
    try {
      const created = await fetch('/api/harness/sessions', {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = (await created.json()) as { session?: Session; error?: string };
      if (!created.ok || !body.session) throw new Error(body.error || `HTTP ${created.status}`);
      setMessages([]);
      setTools([]);
      setTier('');
      setSession(body.session);
      setStatus('Ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex-1 w-full max-w-4xl mx-auto flex flex-col gap-4 px-4 py-6 min-h-[calc(100dvh-4rem)]">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
            <Bot className="w-5 h-5 text-[var(--color-accent)]" />
            Operator chat
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            Fleet, telemetry and crons through the harness. Read-only in this phase.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tier ? (
            <span className="text-[10px] font-mono uppercase tracking-wide px-2 py-1 rounded border border-surface-overlay text-[var(--color-text-muted)]">
              {tier}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void newChat()}
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-surface-overlay hover:bg-surface-overlay/50"
          >
            <Plus className="w-3.5 h-3.5" /> New
          </button>
        </div>
      </header>

      {error ? (
        <div role="alert" className="text-sm border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 rounded px-3 py-2">
          {error}
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto rounded-lg border border-surface-overlay bg-surface/40 p-4 flex flex-col gap-4">
        {messages.length === 0 ? (
          <div className="m-auto max-w-md text-center flex flex-col gap-3">
            <ShieldCheck className="w-8 h-8 mx-auto text-[var(--color-accent)]" />
            <p className="text-sm text-[var(--color-text-secondary)]">
              Ask about the fleet, what ran overnight, or which cron is failing. The harness calls the
              control plane and shows the evidence.
            </p>
            <div className="grid gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  className="text-left text-xs px-3 py-2 rounded border border-surface-overlay hover:bg-surface-overlay/50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={cn('flex gap-3', message.role === 'user' ? 'justify-end' : 'justify-start')}
            >
              {message.role === 'assistant' ? (
                <span className="mt-1 w-6 h-6 rounded-full bg-[var(--color-accent)]/15 text-[var(--color-accent)] flex items-center justify-center shrink-0">
                  <Bot className="w-3.5 h-3.5" />
                </span>
              ) : null}
              <div
                className={cn(
                  'max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap',
                  message.role === 'user'
                    ? 'bg-[var(--color-accent)] text-white'
                    : 'bg-surface border border-surface-overlay text-[var(--color-text-primary)]',
                )}
              >
                {message.content}
                <div className="mt-1 text-[10px] opacity-60 font-mono">{messageTime(message.createdAt)}</div>
              </div>
              {message.role === 'user' ? (
                <span className="mt-1 w-6 h-6 rounded-full bg-surface-overlay flex items-center justify-center shrink-0">
                  <User className="w-3.5 h-3.5" />
                </span>
              ) : null}
            </div>
          ))
        )}
        {sending ? (
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> {status}
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>

      {approvals.some((a) => a.status === 'pending') ? (
        <section aria-label="Approvals" className="flex flex-col gap-2">
          {approvals
            .filter((a) => a.status === 'pending')
            .map((approval) => (
              <div
                key={approval.id}
                role="group"
                aria-label={`Approval for ${approval.tool}`}
                className="rounded-lg border border-[var(--color-warning)]/50 bg-[var(--color-warning)]/10 p-3"
              >
                <div className="flex items-center gap-2 text-xs font-medium text-[var(--color-warning)]">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Approval needed · <span className="font-mono">{approval.tool}</span>
                </div>
                <pre className="mt-2 max-h-32 overflow-auto rounded bg-black/20 p-2 font-mono text-[10px] text-[var(--color-text-secondary)]">
                  {JSON.stringify(approval.args, null, 2)}
                </pre>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void decide(approval.id, true)}
                    disabled={Boolean(deciding)}
                    className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  >
                    {deciding === approval.id ? 'Working…' : 'Allow'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void decide(approval.id, false)}
                    disabled={Boolean(deciding)}
                    className="rounded border border-surface-overlay px-3 py-1.5 text-xs disabled:opacity-50"
                  >
                    Deny
                  </button>
                </div>
                <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">
                  Nothing runs until you allow it. Writes are executed server-side and logged.
                </p>
              </div>
            ))}
        </section>
      ) : null}

      {tools.length > 0 ? (
        <section aria-label="Tool activity" className="rounded-lg border border-surface-overlay bg-surface/30 p-3">
          <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wide text-[var(--color-text-muted)] mb-2">
            <Activity className="w-3 h-3" /> Tool activity
          </div>
          <ul className="flex flex-col gap-1.5">
            {tools.map((tool, index) => (
              <li key={`${tool.tool}-${tool.at}-${index}`} className="flex items-start gap-2 text-xs">
                <span
                  className={cn(
                    'mt-1 w-1.5 h-1.5 rounded-full shrink-0',
                    tool.summary === 'running…'
                      ? 'bg-[var(--color-warning)] animate-pulse'
                      : tool.ok
                        ? 'bg-green-500'
                        : 'bg-red-500',
                  )}
                />
                <span className="font-mono text-[var(--color-text-secondary)] shrink-0">{tool.tool}</span>
                <span className="text-[var(--color-text-muted)] break-words">{tool.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
      >
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send(input);
            }
          }}
          rows={2}
          placeholder="Ask the operator agent…"
          aria-label="Message"
          className="flex-1 resize-none rounded-lg border border-surface-overlay bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-2.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Send
        </button>
      </form>
      <p className="text-[10px] text-[var(--color-text-muted)] font-mono">
        {status} · tools are allowlisted and read-only · no shell
      </p>
    </div>
  );
}
