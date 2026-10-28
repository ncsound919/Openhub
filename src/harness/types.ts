/**
 * The harness contracts. Deliberately small: one action envelope, one tool
 * descriptor, one app manifest. Everything the model can do is a registered
 * tool; there is no shell and no generic fetch.
 */

export type ToolRisk = 'read' | 'write' | 'destructive' | 'external';

/** MCP-style hints. Advisory only — `risk` below is authoritative. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: ToolAnnotations;
  risk: ToolRisk;
  /** Write tools carry a caller-supplied key so a retry cannot double-apply. */
  idempotent?: boolean;
  /** Write tools must be able to report what they would do without doing it. */
  dryRun?: boolean;
}

export interface AppManifest {
  id: string;
  name: string;
  kind: 'android' | 'service' | 'web' | 'data';
  role: string;
  capabilities: string[];
  tools: string[];
  health: string | null;
  dataClass: 'aggregate' | 'public' | 'private';
}

export interface ToolResult {
  ok: boolean;
  tool: string;
  summary: string;
  data?: unknown;
  error?: string;
  at: string;
}

export interface HarnessAction {
  type: 'tool' | 'final' | 'ask' | 'plan';
  say: string;
  tool: string | null;
  args: {
    service: string | null;
    window: string | null;
    limit: number | null;
    job: string | null;
    title: string | null;
    /** Newline-separated plan steps. A string keeps constrained decoding simple. */
    steps: string | null;
    budget_usd: number | null;
  };
  plan: {
    title: string;
    steps: string[];
  } | null;
}

export interface HarnessToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  result: ToolResult;
  startedAt: string;
  finishedAt: string;
}

export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'executed' | 'failed';

export interface ApprovalRecord {
  id: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: number;
  decidedAt: number | null;
  reason: string | null;
  result: Record<string, unknown> | null;
}
