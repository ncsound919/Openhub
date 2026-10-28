import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import type { ProviderHealth } from './providerHealth.js';
import { kaggleAuthOk, listKernels } from './kaggleJobs.js';

/**
 * Live health for the three cloud lanes the phone workflow depends on:
 * AWS (STS identity), Cloudflare (API token + R2 S3 API) and Kaggle (bearer
 * token + kernel list).
 *
 * Nothing here is synthesized: a lane with no credential reports
 * `configured: false, up: null` and does no network I/O, so an unconfigured
 * install (and every unit test) stays offline. When credentials exist, each
 * probe is bounded by a timeout and reports the real error on failure.
 *
 * Credential resolution is the standard AWS SDK chain, so the lanes work both
 * from `~/.aws/credentials` profiles (laptop) and from env vars (Termux).
 */

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const DEFAULT_TIMEOUT_MS = 6000;

export interface CloudProbeDeps {
  /** Send an STS command. Defaults to a real STSClient. */
  stsSend?: (region: string, profile: string | undefined, timeoutMs: number) => Promise<{ Arn?: string; Account?: string; UserId?: string }>;
  /** Send an R2 ListBuckets command. Defaults to a real S3Client aimed at the R2 endpoint. */
  s3ListBuckets?: (opts: {
    region: string;
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    timeoutMs: number;
  }) => Promise<Array<{ Name?: string }>>;
  fetchImpl?: typeof fetch;
  kaggleAuth?: () => Promise<boolean>;
  kaggleList?: () => Promise<unknown>;
  timeoutMs?: number;
}

function defaultDeps(): Required<Omit<CloudProbeDeps, 'timeoutMs'>> & { timeoutMs: number } {
  return {
    stsSend: async (region, profile, timeoutMs) => {
      const client = new STSClient({ region, ...(profile ? { profile } : {}) });
      return client.send(new GetCallerIdentityCommand({}), { abortSignal: AbortSignal.timeout(timeoutMs) });
    },
    s3ListBuckets: async ({ region, endpoint, accessKeyId, secretAccessKey, timeoutMs }) => {
      const client = new S3Client({
        region,
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true,
      });
      const out = await client.send(new ListBucketsCommand({}), { abortSignal: AbortSignal.timeout(timeoutMs) });
      return Array.isArray(out.Buckets) ? out.Buckets : [];
    },
    fetchImpl: fetch,
    kaggleAuth: kaggleAuthOk,
    kaggleList: () => listKernels(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

function awsConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.AWS_PROFILE
    || env.AWS_ACCESS_KEY_ID
    || env.AWS_WEB_IDENTITY_TOKEN_FILE
    || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
    || env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
  );
}

async function probeAws(env: NodeJS.ProcessEnv, deps: ReturnType<typeof defaultDeps>): Promise<ProviderHealth> {
  const base = { id: 'aws', name: 'AWS', category: 'cloud', requires: 'AWS_PROFILE or AWS_ACCESS_KEY_ID' };
  if (!awsConfigured(env)) {
    return { ...base, configured: false, up: null, detail: 'no AWS credentials on this device' };
  }
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1';
  const profile = env.AWS_PROFILE;
  try {
    const identity = await deps.stsSend(region, profile, deps.timeoutMs);
    const arn = identity.Arn ?? '';
    const label = arn ? arn.split('/').slice(-1)[0] : (identity.UserId ?? 'unknown');
    return {
      ...base,
      configured: true,
      up: true,
      detail: `${label} · ${identity.Account ?? '?'} · ${region}`,
    };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, configured: true, up: false, detail: `${name ?? 'error'}: ${message}`.slice(0, 220) };
  }
}

function cloudflareConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID)
    || (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY),
  );
}

async function probeCloudflare(env: NodeJS.ProcessEnv, deps: ReturnType<typeof defaultDeps>): Promise<ProviderHealth> {
  const base = { id: 'cloudflare', name: 'Cloudflare / R2', category: 'cloud', requires: 'CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID or R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY' };
  if (!cloudflareConfigured(env)) {
    return { ...base, configured: false, up: null, detail: 'no Cloudflare or R2 credentials on this device' };
  }

  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const r2Endpoint = env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');
  const r2Keys = env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY;

  const tokenProbe = apiToken
    ? deps.fetchImpl(`${CLOUDFLARE_API}/user/tokens/verify`, {
        headers: { Authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(deps.timeoutMs),
      })
        .then(async (res) => ({ ok: res.ok, status: res.status }))
        .catch((err: unknown) => ({ ok: false, status: null as number | null, error: err instanceof Error ? err.message : String(err) }))
    : Promise.resolve(null);

  const r2Probe = r2Keys && r2Endpoint
    ? deps.s3ListBuckets({
        region: 'auto',
        endpoint: r2Endpoint,
        accessKeyId: env.R2_ACCESS_KEY_ID as string,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
        timeoutMs: deps.timeoutMs,
      })
        .then((buckets) => ({ ok: true as const, buckets }))
        .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }))
    : Promise.resolve(null);

  const [token, r2] = await Promise.all([tokenProbe, r2Probe]);

  const parts: string[] = [];
  if (r2) {
    parts.push(r2.ok ? `R2 ok · ${r2.buckets.length} bucket${r2.buckets.length === 1 ? '' : 's'}` : `R2 failed: ${r2.error}`.slice(0, 120));
  } else {
    parts.push('R2 keys not set');
  }
  if (token) {
    parts.push(token.ok ? 'API token ok' : `API token rejected (HTTP ${token.status ?? 'no response'})`);
  } else {
    parts.push('API token not set');
  }

  const up = Boolean((r2 && r2.ok) || (token && token.ok));
  return { ...base, configured: true, up, detail: parts.join(' · ').slice(0, 220) };
}

async function probeKaggle(env: NodeJS.ProcessEnv, deps: ReturnType<typeof defaultDeps>): Promise<ProviderHealth> {
  const base = { id: 'kaggle', name: 'Kaggle', category: 'cloud', requires: 'KAGGLE_API_TOKEN' };
  if (!env.KAGGLE_API_TOKEN) {
    return { ...base, configured: false, up: null, detail: 'no Kaggle token on this device' };
  }
  try {
    const authenticated = await deps.kaggleAuth();
    if (!authenticated) {
      return { ...base, configured: true, up: false, detail: 'token rejected by Kaggle (401)' };
    }
    const list = await deps.kaggleList();
    const count = Array.isArray(list) ? list.length : null;
    return {
      ...base,
      configured: true,
      up: true,
      detail: count === null ? 'token accepted' : `token accepted · ${count} kernel${count === 1 ? '' : 's'} visible`,
    };
  } catch (err) {
    return {
      ...base,
      configured: true,
      up: false,
      detail: (err instanceof Error ? err.message : String(err)).slice(0, 220),
    };
  }
}

/** Probe every configured cloud lane. Unconfigured lanes do no network I/O. */
export async function probeCloudProviders(
  env: NodeJS.ProcessEnv = process.env,
  overrides: CloudProbeDeps = {},
): Promise<ProviderHealth[]> {
  const deps = { ...defaultDeps(), ...overrides };
  return Promise.all([probeAws(env, deps), probeCloudflare(env, deps), probeKaggle(env, deps)]);
}
