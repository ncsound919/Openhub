import { randomUUID } from 'crypto';
import { getDb } from '../auth/db';
import type { ApprovalRecord, ApprovalStatus } from './types';

/**
 * Phase 1 persistence. Additive tables in OpenHub's existing SQLite; no second
 * database. If the schema is missing it is created on first use (idempotent).
 */

let ensured = false;

function ensure(): void {
  if (ensured) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS harness_sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS harness_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_harness_messages_session
      ON harness_messages(session_id, created_at);
    CREATE TABLE IF NOT EXISTS harness_tool_calls (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      args_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_harness_tool_calls_session
      ON harness_tool_calls(session_id, started_at);
    CREATE TABLE IF NOT EXISTS harness_approvals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      args_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      reason TEXT,
      result_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_harness_approvals_session
      ON harness_approvals(session_id, created_at);
  `);
  ensured = true;
}

export interface SessionRow {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface MessageRow {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export interface ToolCallRow {
  id: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  status: string;
  startedAt: number;
  finishedAt: number;
}

export function createSession(title?: string): SessionRow {
  ensure();
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  const clean = (title ?? '').trim() || `Operator chat ${new Date(now).toLocaleString()}`;
  db.prepare('INSERT INTO harness_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    id,
    clean,
    now,
    now,
  );
  return { id, title: clean, createdAt: now, updatedAt: now };
}

export function listSessions(limit = 20): SessionRow[] {
  ensure();
  const rows = getDb()
    .prepare('SELECT id, title, created_at, updated_at FROM harness_sessions ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as Array<{ id: string; title: string; created_at: number; updated_at: number }>;
  return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }));
}

export function getSession(id: string): SessionRow | null {
  ensure();
  const row = getDb()
    .prepare('SELECT id, title, created_at, updated_at FROM harness_sessions WHERE id = ?')
    .get(id) as { id: string; title: string; created_at: number; updated_at: number } | undefined;
  return row ? { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

export function touchSession(id: string): void {
  ensure();
  getDb().prepare('UPDATE harness_sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id);
}

export function addMessage(sessionId: string, role: 'user' | 'assistant', content: string): MessageRow {
  ensure();
  const db = getDb();
  const row: MessageRow = {
    id: randomUUID(),
    sessionId,
    role,
    content,
    createdAt: Date.now(),
  };
  db.prepare('INSERT INTO harness_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(
    row.id,
    row.sessionId,
    row.role,
    row.content,
    row.createdAt,
  );
  touchSession(sessionId);
  return row;
}

export function listMessages(sessionId: string, limit = 30): MessageRow[] {
  ensure();
  const rows = getDb()
    .prepare(
      'SELECT id, session_id, role, content, created_at FROM harness_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(sessionId, limit) as Array<{
    id: string;
    session_id: string;
    role: 'user' | 'assistant';
    content: string;
    created_at: number;
  }>;
  return rows
    .map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
    }))
    .reverse();
}

export function addToolCall(
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
  result: ToolCallRow['result'],
  status: string,
  startedAt: number,
  finishedAt: number,
): ToolCallRow {
  ensure();
  const row: ToolCallRow = {
    id: randomUUID(),
    sessionId,
    tool,
    args,
    result,
    status,
    startedAt,
    finishedAt,
  };
  getDb()
    .prepare(
      'INSERT INTO harness_tool_calls (id, session_id, tool, args_json, result_json, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      row.id,
      row.sessionId,
      row.tool,
      JSON.stringify(row.args),
      JSON.stringify(row.result),
      row.status,
      row.startedAt,
      row.finishedAt,
    );
  return row;
}

export function listToolCalls(sessionId: string, limit = 30): ToolCallRow[] {
  ensure();
  const rows = getDb()
    .prepare(
      'SELECT id, session_id, tool, args_json, result_json, status, started_at, finished_at FROM harness_tool_calls WHERE session_id = ? ORDER BY started_at DESC LIMIT ?',
    )
    .all(sessionId, limit) as Array<{
    id: string;
    session_id: string;
    tool: string;
    args_json: string;
    result_json: string;
    status: string;
    started_at: number;
    finished_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    tool: r.tool,
    args: JSON.parse(r.args_json) as Record<string, unknown>,
    result: JSON.parse(r.result_json) as Record<string, unknown>,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }));
}

export function createApproval(
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
): ApprovalRecord {
  ensure();
  const row: ApprovalRecord = {
    id: randomUUID(),
    sessionId,
    tool,
    args,
    status: 'pending',
    createdAt: Date.now(),
    decidedAt: null,
    reason: null,
    result: null,
  };
  getDb()
    .prepare(
      'INSERT INTO harness_approvals (id, session_id, tool, args_json, status, created_at, decided_at, reason, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(row.id, row.sessionId, row.tool, JSON.stringify(row.args), row.status, row.createdAt, null, null, null);
  return row;
}

export function getApproval(id: string): ApprovalRecord | null {
  ensure();
  const r = getDb()
    .prepare(
      'SELECT id, session_id, tool, args_json, status, created_at, decided_at, reason, result_json FROM harness_approvals WHERE id = ?',
    )
    .get(id) as
    | {
        id: string;
        session_id: string;
        tool: string;
        args_json: string;
        status: ApprovalStatus;
        created_at: number;
        decided_at: number | null;
        reason: string | null;
        result_json: string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    id: r.id,
    sessionId: r.session_id,
    tool: r.tool,
    args: JSON.parse(r.args_json) as Record<string, unknown>,
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    reason: r.reason,
    result: r.result_json ? (JSON.parse(r.result_json) as Record<string, unknown>) : null,
  };
}

export function listApprovals(sessionId: string, limit = 30): ApprovalRecord[] {
  ensure();
  const rows = getDb()
    .prepare(
      'SELECT id FROM harness_approvals WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(sessionId, limit) as Array<{ id: string }>;
  return rows.map((r) => getApproval(r.id)).filter((r): r is ApprovalRecord => r !== null);
}

export function decideApproval(
  id: string,
  status: ApprovalStatus,
  reason: string | null = null,
  result: Record<string, unknown> | null = null,
): ApprovalRecord | null {
  ensure();
  getDb()
    .prepare(
      'UPDATE harness_approvals SET status = ?, decided_at = ?, reason = ?, result_json = ? WHERE id = ?',
    )
    .run(status, Date.now(), reason, result ? JSON.stringify(result) : null, id);
  return getApproval(id);
}
