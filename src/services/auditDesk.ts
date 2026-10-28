/**
 * Android Audit Desk client (generated; edit shared/audit-desk/auditDesk.ts).
 *
 * Talks to the loopback audit desk. Every call fails open: an app feature must
 * keep working when the desk is not running.
 */
export type AuditFinding = {
  rule: string; severity: string; category?: string; title?: string;
  file?: string; line?: number; message?: string; hint?: string;
  tier?: string; sources?: string[]; baselined?: boolean;
};

export type AuditTask = {
  id: string; priority: string; rule: string; severity: string;
  file: string; line: number; fix: string; acceptance: string[];
  parallel_safe: boolean;
};

export type AuditStatus = { ok: boolean; degraded?: boolean; reason?: string };

export function createAuditDesk(options?: { baseUrl?: string; timeoutMs?: number }) {
  const envUrl = (globalThis as any)?.process?.env?.EXPO_PUBLIC_AUDIT_DESK_URL;
  const baseUrl = (options?.baseUrl ?? envUrl ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
  const timeoutMs = options?.timeoutMs ?? 15000;

  async function call<T>(path: string, init?: any): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch { return null; } finally { clearTimeout(timer); }
  }

  return {
    baseUrl,
    async status(): Promise<AuditStatus> {
      const r = await call<{ ok?: boolean }>('/api/health');
      return r?.ok ? { ok: true } : { ok: false, degraded: true, reason: 'audit desk unreachable' };
    },
    async profiles() { return call<{ profiles: unknown[] }>('/api/profiles'); },
    async report(id: number) { return call<Record<string, unknown>>(`/api/report?id=${id}`); },
    async agentTasks(id: number) {
      return call<{ tasks: AuditTask[] }>(`/api/report?id=${id}&format=agent-json`);
    },
    async markdown(id: number) {
      try {
        const res = await fetch(`${baseUrl}/api/report?id=${id}&format=agent-md`);
        return res.ok ? await res.text() : null;
      } catch { return null; }
    },
    async sarif(id: number) {
      return call<Record<string, unknown>>(`/api/report?id=${id}&format=sarif`);
    },
    async integrations() {
      return call<Record<string, unknown>>('/api/integrations');
    },
    async auditSource(file: Blob, appName = 'upload', version = '') {
      const form = new FormData();
      form.append('file', file, 'upload.zip');
      form.append('app_name', appName);
      form.append('version', version);
      return call<Record<string, unknown>>('/api/audit', { method: 'POST', body: form });
    },
  };
}
