/**
 * Tondo Research Assist — TypeScript client.
 *
 * Used by OpenHub when its own diagnosis is inconclusive. The contract is the
 * same one the Kotlin client parses: tondo/design/research-assist.md.
 *
 * Copy into an app with `node scripts/sync-clients.mjs`; edit this canonical
 * file, never the copy.
 */

export interface TondoResearchConfig {
  baseUrl: string;
  appId: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface TondoEvidence {
  id: string;
  title: string;
  text: string;
  url?: string;
}

export interface TondoFinding {
  claim: string;
  support: string;
  confidence: number;
  kind: 'fact' | 'mechanism' | 'contradiction' | 'resolution' | 'risk' | 'gap' | string;
}

export interface TondoAction {
  step: string;
  why: string;
  risk: 'low' | 'medium' | 'high' | string;
}

export interface TondoCitation {
  evidenceId: string;
  title: string;
  url?: string;
}

export interface TondoResearchInput {
  operation: string;
  question: string;
  symptom?: string;
  context?: string;
  evidence?: TondoEvidence[];
  dataClass?: 'aggregate' | 'internal' | 'commercial' | 'phi';
  maxFindings?: number;
}

export interface TondoMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TondoReasonResult {
  content: string;
  lane?: string;
  model?: string;
  deep: boolean;
  usage: { input: number; output: number };
}

export interface TondoResearchResult {
  requestId?: string;
  app: string;
  service: string;
  operation: string;
  question: string;
  status: 'resolved' | 'assisted' | 'insufficient' | string;
  summary: string;
  findings: TondoFinding[];
  actions: TondoAction[];
  unresolved: string[];
  citations: TondoCitation[];
  escalate: boolean;
  lane?: string;
  model?: string;
  adapter?: string;
  latencyMs: number;
  usage?: { input: number; output: number };
  overlay?: Record<string, unknown>;
}

export class TondoResearchError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 0, code = 'tondo_error') {
    super(message);
    this.name = 'TondoResearchError';
    this.status = status;
    this.code = code;
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

export function createTondoResearch(config: TondoResearchConfig) {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const timeoutMs = config.timeoutMs ?? 60_000;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!fetchImpl) throw new TondoResearchError('fetch is not available', 0, 'no_fetch');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(joinUrl(baseUrl, path), {
        ...init,
        headers: {
          accept: 'application/json',
          'x-tondo-app': config.appId,
          authorization: `Bearer ${config.token}`,
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: controller.signal,
      });
      const text = await response.text();
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        throw new TondoResearchError('Tondo returned non-JSON', response.status, 'invalid_json');
      }
      if (!response.ok) {
        const code = body?.error ?? 'tondo_error';
        const detail = body?.detail ? `: ${body.detail}` : '';
        throw new TondoResearchError(`${code}${detail}`, response.status, code);
      }
      return body as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    config: { baseUrl, appId: config.appId, hasToken: Boolean(config.token) },

    health() {
      return request<Record<string, unknown>>('/health', { method: 'GET' });
    },

    assist(input: TondoResearchInput) {
      if (!config.baseUrl || !config.token) {
        throw new TondoResearchError('Tondo research is not configured', 0, 'not_configured');
      }
      if (!input.question?.trim()) {
        throw new TondoResearchError('question is required', 0, 'question_required');
      }
      return request<TondoResearchResult>('/v1/research/assist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          app: config.appId,
          operation: input.operation,
          question: input.question,
          ...(input.symptom ? { symptom: input.symptom } : {}),
          ...(input.context ? { context: input.context } : {}),
          data_class: input.dataClass ?? 'internal',
          max_findings: Math.max(1, Math.min(6, input.maxFindings ?? 4)),
          ...(input.evidence?.length ? { evidence: input.evidence } : {}),
        }),
      });
    },

    /** One model turn for an app that owns its own retrieval loop. */
    reason(
      messages: TondoMessage[],
      options: { maxTokens?: number; deep?: boolean; temperature?: number } = {},
    ) {
      if (!config.baseUrl || !config.token) {
        throw new TondoResearchError('Tondo research is not configured', 0, 'not_configured');
      }
      if (!messages.length) throw new TondoResearchError('messages are required', 0, 'messages_required');
      return request<TondoReasonResult>('/v1/research/reason', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages,
          deep: options.deep === true,
          maxTokens: Math.max(128, Math.min(1_600, options.maxTokens ?? 700)),
          temperature: Math.max(0, Math.min(1, options.temperature ?? 0.2)),
        }),
      });
    },
  };
}

export type TondoResearch = ReturnType<typeof createTondoResearch>;

/** A concise rendering for a log line or agent message. */
export function describeTondoResearch(result: TondoResearchResult): string {
  const lines = [`Tondo ${result.status}: ${result.summary}`];
  for (const finding of result.findings) {
    lines.push(
      `• ${finding.claim} [${finding.support}, ${Math.round(finding.confidence * 100)}%]`,
    );
  }
  for (const action of result.actions) {
    lines.push(`→ ${action.step} (${action.risk} risk)`);
  }
  if (result.unresolved.length) lines.push(`Still open: ${result.unresolved.join('; ')}`);
  return lines.join('\n');
}
