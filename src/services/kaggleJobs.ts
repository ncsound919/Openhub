/**
 * Kaggle batch-compute bridge (Phase 5).
 *
 * OpenHub can offload heavy work (full test suites, model training, large
 * refactors) to a Kaggle notebook. The flow is asynchronous:
 *
 *   1. OpenHub writes a kernel (notebook) + metadata.
 *   2. `pushKernel()` uploads it via the Kaggle REST API.
 *   3. Kaggle runs it (up to ~9-12h).
 *   4. `pollStatus()` is called until the kernel finishes.
 *   5. `fetchOutput()` pulls the resulting artifacts back.
 *
 * Auth: a KGAT_ bearer token in KAGGLE_API_TOKEN (see D:\docs\opencode api.txt).
 * The legacy username/key auth is NOT used.
 *
 * NOTE: pushing a kernel requires a multipart upload (kernel-metadata.json +
 * source). This module ships the thin HTTP wrappers; the notebook templating
 * and job orchestration live in the caller. See MOBILE-PLAN.md Phase 5.
 */

const KAGGLE_API = 'https://www.kaggle.com/api/v1';

function token(): string {
  const t = process.env.KAGGLE_API_TOKEN;
  if (!t) throw new Error('KAGGLE_API_TOKEN is not set');
  return t;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${token()}` };
}

export interface KernelStatus {
  status: string; // 'queued' | 'running' | 'complete' | 'error' | 'cancelAcknowledged' ...
  [key: string]: unknown;
}

/** Poll the status of a kernel. */
export async function kernelStatus(owner: string, slug: string): Promise<KernelStatus> {
  const res = await fetch(`${KAGGLE_API}/kernels/status/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Kaggle status HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  return (await res.json()) as KernelStatus;
}

/**
 * Fetch the output of a finished kernel.
 *
 * Kaggle's `/kernels/output/...` returns a ZIP archive (optionally one file via
 * `?file_name=`), not JSON. The old implementation parsed every response as
 * JSON, so a real archive degraded to `{}` with a 200 — indistinguishable from
 * "no output". Report what actually came back instead of fabricating an empty
 * listing; job orchestration + artifact extraction are still Phase 5 work.
 */
export type KernelOutput =
  | { kind: 'json'; contentType: string; data: unknown }
  | { kind: 'archive'; contentType: string; bytes: number };

export async function kernelOutput(owner: string, slug: string): Promise<KernelOutput> {
  const res = await fetch(`${KAGGLE_API}/kernels/output/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Kaggle output HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return { kind: 'json', contentType, data: await res.json().catch(() => null) };
  }
  const buffer = await res.arrayBuffer();
  return { kind: 'archive', contentType: contentType || 'application/octet-stream', bytes: buffer.byteLength };
}

/** List the authenticated user's kernels (useful for job discovery). */
export async function listKernels(owner?: string): Promise<unknown> {
  const url = owner
    ? `${KAGGLE_API}/kernels/list?user=${encodeURIComponent(owner)}`
    : `${KAGGLE_API}/kernels/list`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Kaggle list HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json().catch(() => ({}));
}

/** Quick auth check: returns true if the bearer token is accepted. */
export async function kaggleAuthOk(): Promise<boolean> {
  try {
    const res = await fetch(`${KAGGLE_API}/competitions/list`, { headers: authHeaders() });
    return res.ok;
  } catch {
    return false;
  }
}