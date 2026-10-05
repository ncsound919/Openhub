import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { execFileSync } from 'child_process';
import { spawn } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { initializeDatabase, getDb } from './src/auth/db.js';
import { v4 as uuidv4 } from 'uuid';
import { AuthConfigurator, type BaseUser } from 'awesome-node-auth';
import { SQLiteUserStore, usernameFromEmail } from './src/auth/ana-user-store.js';
import { createScimRouter } from './src/auth/scim.js';
import {
  oidcConfig, discoverOidc, pkcePair, buildAuthorizeUrl, exchangeCode,
  verifyIdToken, fetchUserInfo, identityFromClaims, PendingSsoStore,
} from './src/auth/oidc.js';
import { fireWebhook, fireSingleWebhook } from './src/services/webhooks.js';
import {
  analyzeSystemAndFiles,
  detectTheaterAndMocks,
  generateTestScaffold,
  getDeployReadiness,
  executeTests,
} from './src/services/systemScanner.js';
import {
  askOllama,
  collectOutdatedDependencies,
  readGitHistory,
  readGitStatus,
  OLLAMA_MODEL,
  OLLAMA_URL,
} from './src/services/workspaceIntelligence.js';
import {
  getGitHubIntegration,
  saveGitHubIntegration,
  removeGitHubIntegration,
  verifyAndFetchGitHubProfile,
  fetchUserRepos,
  importGitHubRepo,
  pushSyncToGitHub,
  fetchGitHubIssues,
  createGitHubIssue,
  fetchGitHubPulls,
  fetchGitHubWorkflows,
  fetchGitHubWorkflowRuns,
  dispatchGitHubWorkflow,
  recordGitHubWebhookEvent,
  getGitHubWebhookEvents,
  setVaultAutoConnectSuppressed,
  isVaultAutoConnectSuppressed,
  getGitHubWebhookEventsForUser,
  isSafeName,
  encodeContentsPath,
} from './src/services/githubService.js';
import {
  provisionGitHubFromVault,
  probeVaultGitHubCredentials,
  isVaultOwner,
  VAULT_OWNER_ONLY_ERROR,
} from './src/services/githubVaultAuth.js';
import { setTokenKeyFallbackSecret } from './src/services/tokenCrypto.js';
import { resolveBin, hardenGitArgs, safeChildEnv } from './src/services/binResolve.js';
import { probeProviderHealth } from './src/services/providerHealth.js';
import { buildLineStarts, lineAtOffset } from './src/services/secretScan.js';
import { findSecrets } from './src/services/secretRules.js';
import { loadEcosystemContext, summarizeEcosystem } from './src/services/ecosystem.js';
import { recordAuditEvent } from './src/services/ecosystemMemory.js';
import { resolveSecret } from './src/services/keywire.js';
import { captureWebhookRawBody, verifyGitHubSignature } from './src/services/githubWebhookRaw.js';
import { redactSecrets } from './src/services/receipts.js';
import { createAiReviewRouter } from './src/routes/aiReview.js';
// NOTE: Business ops surface was removed in the Axiom-only consolidation.
// CRM and SEO are retained (real integration pending).
import { createChatCompletionsRouter } from './src/routes/chatCompletions.js';
import { createSeoRouter } from './src/routes/seo.js';
import { createCrmRouter } from './src/routes/crm.js';
import { createNtfyRouter } from './src/routes/ntfy.js';
import { createFleetKpisRouter } from './src/routes/fleetKpis.js';
import { createFleetAgentsRouter } from './src/routes/fleetAgents.js';
import { createGithubFleetRouter } from './src/routes/githubFleet.js';
import { createServicesLifecycleRouter } from './src/routes/servicesLifecycle.js';
import { createFleetCapabilitiesRouter } from './src/routes/fleetCapabilities.js';
import { createAxiomProxyRouter } from './src/routes/axiomProxy.js';
import { createReceiptsRouter } from './src/routes/receipts.js';
import { createClosedLoopRouter } from './src/routes/closedLoopRoutes.js';
import { createAuditRouter } from './src/routes/auditRoutes.js';
import { createInternalAuditRouter } from './src/routes/internalAuditRoutes.js';
import { createAuditCoreRouter } from './src/routes/auditCoreRoutes.js';
import { createTiersRouter } from './src/routes/tiersRoutes.js';
import { createRepairRouter } from './src/routes/repairRoutes.js';
import { createPipelineRouter } from './src/routes/pipelineRoutes.js';
import { startPipelineAutoScheduler } from './src/services/pipelineAuto.js';
import { createEcosystemKnowledgeRouter } from './src/routes/ecosystemKnowledgeRoutes.js';
import { createEcosystemRegistryRouter } from './src/routes/ecosystemRegistryRoutes.js';
import { createProjectContextRouter } from './src/routes/projectContext.js';
import { createWorkspaceToolsRouter } from './src/routes/workspaceTools.js';
import { createJevRouter } from './src/routes/jevRoutes.js';
import { createFleetInterconnectRouter } from './src/routes/fleetInterconnectRoutes.js';
import { createToolTeamsRouter } from './src/routes/toolTeamsRoutes.js';
import { createIntelligenceRouter } from './src/routes/intelligence.js';
import { createAgentRosterRouter } from './src/routes/agentRoster.js';
import { createSupervisorRouter } from './src/routes/supervisor.js';
import { createResearchRouter } from './src/routes/research.js';
import { createRecourseRouter } from './src/routes/recourse.js';
import { createOmniResearchRouter } from './src/routes/omniResearch.js';
import { createIncidentsRouter } from './src/routes/incidents.js';
import { createEcosystemRepairRouter } from './src/routes/ecosystemRepairRoutes.js';
import { createSystemSnapshotRouter } from './src/routes/systemSnapshot.js';
import { createSelfReportRouter } from './src/routes/selfReport.js';
import { createAlertsRouter } from './src/routes/alerts.js';
import { startAlertEngine } from './src/services/alertEngine.js';
import { createDreamRouter } from './src/routes/dream.js';
import { createInsightsRouter } from './src/routes/insights.js';
import { createSelfLearnRouter } from './src/routes/selflearn.js';
import { createAutonomyRouter } from './src/routes/autonomy.js';
import { createVulnerabilityRouter } from './src/routes/vulnerabilityRoutes.js';
import { createCodeReviewRouter } from './src/routes/codeReviewRoutes.js';
import { createApiStudioRouter } from './src/routes/apiStudioRoutes.js';
import { startAutonomy } from './src/services/autonomyLoop.js';
import { startDreamLoop } from './src/services/dreamState.js';
import { startSelfReportLoop, startOpenChatReportLoop } from './src/services/selfReport.js';
import { getActiveProject } from './src/services/projectContext.js';
import { syncFleetRepos } from './src/services/githubRepos.js';
import { isSubpath, hasDeniedSegment, browseRoots, isBrowsable } from './src/lib/pathGuard.js';
import { configuredOperatorRoles, isOperator, operatorGateWarning } from './src/lib/operator.js';

interface AuthUser {
  sub: string;
  email: string;
  username?: string;
  role?: string;
}

function getUser(req: express.Request): AuthUser {
  return req.user as unknown as AuthUser;
}

// A thrown error inside an async Express 4 handler becomes an unhandled
// rejection; on modern Node that is fatal, so one bad route could kill the
// process. Rejections are logged and the server keeps serving. An uncaught
// EXCEPTION, however, leaves the process in an undefined state, so it is
// logged and the process exits(1) for the supervisor to restart it
// (OPENHUB_EXIT_ON_UNCAUGHT=0 keeps the old log-and-continue behavior).
/** Redact known secret patterns before anything is logged: a stack can embed
 *  env values or credentials from the failing call. */
function redactForLog(value: unknown): string {
  const text = value instanceof Error ? (value.stack ?? value.message) : String(value);
  return redactSecrets(text);
}
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled promise rejection:', redactForLog(reason));
});
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', redactForLog(err));
  if (process.env.OPENHUB_EXIT_ON_UNCAUGHT !== '0') {
    process.exit(1);
  }
});

/** A role that is an operator under a CONFIGURED gate. With the gate unset
 *  (or `*`) nobody is distinguished, so owner-scoped data stays per-user. */
function isConfiguredOperator(role: string | undefined): boolean {
  const roles = configuredOperatorRoles();
  return roles.length > 0 && !roles.includes('*') && isOperator(role, roles);
}

/**
 * GitHub webhook replay protection: remember X-GitHub-Delivery ids for 24h
 * (at most 5000, oldest evicted first). A replayed signed delivery is
 * acknowledged but not recorded again.
 */
const WEBHOOK_DEDUPE_MAX = 5000;
const WEBHOOK_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const seenWebhookDeliveries = new Map<string, number>();
function isDuplicateDelivery(id: string, now = Date.now()): boolean {
  const at = seenWebhookDeliveries.get(id);
  if (at !== undefined && now - at < WEBHOOK_DEDUPE_TTL_MS) return true;
  seenWebhookDeliveries.delete(id);
  seenWebhookDeliveries.set(id, now);
  while (seenWebhookDeliveries.size > WEBHOOK_DEDUPE_MAX) {
    const oldest = seenWebhookDeliveries.keys().next().value;
    if (oldest === undefined) break;
    seenWebhookDeliveries.delete(oldest);
  }
  return false;
}

/** Reject GitHub owner/repo route params outside the safe name alphabet. */
function validGitHubRepoParams(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!isSafeName(req.params.owner) || !isSafeName(req.params.repo)) {
    return res.status(400).json({ error: 'Invalid owner or repository name' });
  }
  next();
}

interface PaginatedResult<T> {
  data: T[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

function paginate<T>(items: T[], page: number, limit: number): PaginatedResult<T> {
  const total = items.length;
  const totalPages = Math.ceil(total / limit) || 1;
  const start = (page - 1) * limit;
  const end = start + limit;
  const data = items.slice(start, end);
  return { data, pagination: { total, page, limit, totalPages } };
}

function getPaginationParams(req: express.Request): { page: number; limit: number } {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
  return { page, limit };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPOS_ROOT = process.env.OPENHUB_REPOS_ROOT
  || path.join(os.homedir(), 'Documents', 'openhub', 'repos');

/** Largest file the repo-contents API will read into memory or accept on write. */
const MAX_CONTENTS_BYTES = Number(process.env.OPENHUB_MAX_FILE_BYTES) > 0
  ? Number(process.env.OPENHUB_MAX_FILE_BYTES)
  : 5 * 1024 * 1024;

// Axiom is the single execution engine. The legacy Python `vibeserve` MCP
// bridge, the UFC-MCP converter bridge, and the in-process orchestrator that
// spoke to them were removed in the Axiom-only consolidation.

const MAX_TERMINAL_SESSIONS = 4;

/**
 * Environment variables never handed to the interactive terminal.
 *
 * The shell below inherits the server's environment, which holds the JWT
 * signing keys, the model-gateway credentials and every integration token. A
 * `printenv` in the terminal panel dumped all of them, and anything the shell
 * launches inherits them too. Names are matched case-insensitively against
 * these patterns.
 */
const TERMINAL_ENV_DENYLIST = [
  /SECRET/i, /TOKEN/i, /_KEY$/i, /^.*API_KEY/i, /PASSWORD/i, /PASSWD/i,
  /CREDENTIAL/i, /PRIVATE/i, /SESSION/i, /^AWS_/i, /^GH_/i, /^GITHUB_/i,
  /^OPENAI_/i, /^ANTHROPIC_/i, /^GEMINI_/i, /^GOOGLE_/i, /^NPM_TOKEN/i,
];

/** The server environment minus anything that looks like a credential. */
function sanitizedTerminalEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (TERMINAL_ENV_DENYLIST.some((re) => re.test(key))) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Real shell bridge over WebSocket. Token-gated; the shell STARTS in the active
 * project but is not confined to it — a `cd /` reaches the whole filesystem as
 * the server user. Treat access to this socket as equivalent to a local shell
 * account, and do not expose OpenHub to untrusted users while it is enabled.
 * Set OPENHUB_DISABLE_TERMINAL=1 to leave the socket unmounted.
 */
/** Read one cookie value from a raw Cookie header (no cookie-parser dependency). */
function readCookie(header: string | undefined, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

function attachTerminalSocket(
  httpServer: import('http').Server,
  accessTokenSecret: string,
  userStore: SQLiteUserStore,
  allowedOrigins: ReadonlySet<string>,
): void {
  // Cross-site WebSocket hijacking guard: a browser attaches the auth cookie
  // to a WS upgrade from ANY site, so the Origin must be one CORS allows (or
  // this server's own host). Non-browser clients send no Origin.
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws/terminal',
    verifyClient: (info, cb) => {
      const origin = info.origin || info.req.headers.origin;
      if (!origin || allowedOrigins.has(origin)) return cb(true);
      let sameHost = false;
      try {
        sameHost = new URL(origin).host === info.req.headers.host;
      } catch { /* malformed origin */ }
      if (sameHost) return cb(true);
      console.warn('[Server] Terminal upgrade rejected: origin not allowed');
      cb(false, 403, 'Forbidden origin');
    },
  });
  let active = 0;

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    // Browser auth is the HttpOnly accessToken cookie sent on the upgrade
    // request. `?token=` stays as a fallback for non-browser clients, but the
    // web app no longer puts a token in the URL (it leaked into access logs).
    const token = readCookie(req.headers.cookie, 'accessToken') || url.searchParams.get('token') || '';
    if (active >= MAX_TERMINAL_SESSIONS) {
      ws.close(4001, 'Too many terminal sessions');
      return;
    }
    let userId: string | undefined;
    try {
      const payload = jwt.verify(token, accessTokenSecret, { algorithms: ['HS256'] }) as { sub?: unknown };
      userId = typeof payload.sub === 'string' ? payload.sub : undefined;
    } catch {
      ws.close(4001, 'Unauthorized');
      return;
    }
    if (!userId) {
      ws.close(4001, 'Unauthorized');
      return;
    }
    if ((await userStore.isActive(userId)) !== true) {
      ws.close(4001, 'Unauthorized');
      return;
    }
    // Shell is the highest-risk surface. When the operator gate is configured,
    // the role on the (possibly stale) token is not enough — read the user
    // record, which SCIM/SSO keep authoritative.
    const opRoles = configuredOperatorRoles();
    if (opRoles.length > 0) {
      const actor = await userStore.findById(userId);
      if (!isOperator(actor?.role, opRoles)) {
        ws.close(4003, 'Forbidden');
        return;
      }
    }
    const project = getActiveProject(userId);
    if (!project) {
      ws.close(4001, 'No active project');
      return;
    }
    if (!fs.existsSync(project.path) || !fs.statSync(project.path).isDirectory()) {
      ws.close(4001, 'Project directory missing');
      return;
    }

    active++;
    console.log(`[Server] Terminal session started in ${project.path}`);
    const shell = process.platform === 'win32' ? 'cmd.exe' : process.env.SHELL || 'bash';
    const child = spawn(shell, [], {
      cwd: project.path,
      env: { ...sanitizedTerminalEnv(), PROMPT: 'openhub> ', PS1: 'openhub> ' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const send = (chunk: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk.toString());
    };
    child.stdout?.on('data', send);
    child.stderr?.on('data', send);
    child.on('close', (code) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(`\r\n[terminal exited: ${code ?? '?'}]\r\n`);
        ws.close();
      }
    });

    ws.on('message', (data) => {
      const text = data.toString();
      if (text === '\u0003') {
        // Ctrl-C: forward a break to the child.
        child.kill('SIGINT');
        return;
      }
      if (child.stdin.writable) child.stdin.write(text);
    });
    ws.on('close', () => {
      active = Math.max(0, active - 1);
      try {
        child.kill();
      } catch { /* already gone */ }
    });
  });

  console.log('[Server] Terminal WebSocket mounted at /ws/terminal (shell access — credentials filtered from env)');
}

interface FallbackSecrets {
  access: string;
  refresh: string;
}

/** Load persistent fallback signing keys, creating them only if missing/corrupt. */
function resolveFallbackSecrets(): FallbackSecrets {
  const dir = process.env.OPENHUB_KEY_DIR || path.join(os.homedir(), '.openhub');
  const file = path.join(dir, 'emergency-keys.json');

  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (
        parsed &&
        typeof parsed.access === 'string' &&
        typeof parsed.refresh === 'string' &&
        parsed.access.length >= 32 &&
        parsed.refresh.length >= 32
      ) {
        console.warn('[Server] WARNING: using file-based fallback signing keys (ACCESS_TOKEN_SECRET / REFRESH_TOKEN_SECRET not set).');
        return { access: parsed.access, refresh: parsed.refresh };
      }
      console.warn('[Server] WARNING: fallback key file corrupt or too short; regenerating:', file);
    }
  } catch (err: any) {
    console.warn('[Server] WARNING: could not read fallback key file; regenerating:', err.message);
  }

  fs.mkdirSync(dir, { recursive: true });
  const keys: FallbackSecrets = {
    access: crypto.randomBytes(48).toString('hex'),
    refresh: crypto.randomBytes(48).toString('hex'),
  };
  fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  console.warn(`[Server] WARNING: generated persistent fallback signing keys at ${file}. Set ACCESS_TOKEN_SECRET / REFRESH_TOKEN_SECRET in production.`);
  return keys;
}

async function startServer() {
  initializeDatabase();

  const envAccess = process.env.ACCESS_TOKEN_SECRET;
  const envRefresh = process.env.REFRESH_TOKEN_SECRET;
  const fallback = (envAccess && envRefresh) ? undefined : resolveFallbackSecrets();
  const ACCESS_TOKEN_SECRET = envAccess || fallback?.access;
  const REFRESH_TOKEN_SECRET = envRefresh || fallback?.refresh;
  if (!ACCESS_TOKEN_SECRET || !REFRESH_TOKEN_SECRET) {
    throw new Error('Failed to resolve JWT signing secrets (both env and fallback file missing).');
  }
  // Stored GitHub tokens are encrypted with OPENHUB_TOKEN_KEY, or a key
  // derived from this secret when that is unset (see tokenCrypto.ts).
  setTokenKeyFallbackSecret(ACCESS_TOKEN_SECRET);

  const userStore = new SQLiteUserStore();
  const authConfig = {
    accessTokenSecret: ACCESS_TOKEN_SECRET,
    refreshTokenSecret: REFRESH_TOKEN_SECRET,
    accessTokenExpiresIn: '15m',
    refreshTokenExpiresIn: '7d',
    apiPrefix: '/api/auth',
    cookieOptions: {
      sameSite: 'lax' as const,
      // Cookies must not ride cleartext HTTP. Opt in when serving over TLS
      // (or behind a TLS-terminating proxy); the app is loopback by default.
      secure: process.env.OPENHUB_SECURE_COOKIES === '1',
    },
    csrf: { enabled: true },
    emailVerificationMode: 'none' as const,
    buildTokenPayload: (user: BaseUser) => {
      return {
        // Prefer the stored username column so token identity matches the
        // `owner_name` used in repo URLs (firstName is display-only).
        username: (user as unknown as { username?: string }).username || user.firstName || user.email?.split('@')[0] || 'user',
        avatarUrl: null,
      };
    },
  };
  const auth = new AuthConfigurator(authConfig, userStore);

  const app = express();
  // Only trust X-Forwarded-* when the operator says a real proxy sits in front;
  // otherwise a spoofed header forges req.ip (which IP-based logic depends on).
  app.set('trust proxy', process.env.OPENHUB_TRUST_PROXY === '1' ? 1 : false);
  const PORT = parseInt(process.env.PORT || '3000', 10);
  // Bind loopback by default. OpenHub is a local control plane; exposing it on
  // 0.0.0.0 puts auth cookies and the repo/browse surface on the LAN. Operators
  // that genuinely front it with a reverse proxy set OPENHUB_HOST=0.0.0.0.
  const HOST = process.env.OPENHUB_HOST || '127.0.0.1';

  app.use(helmet({
    // CSP is off by default only when explicitly opted out. The policy keeps
    // scripts/style same-origin (Monaco + Vite need inline/eval) and blocks
    // object embeds and cross-origin framing.
    contentSecurityPolicy: process.env.OPENHUB_CSP === '0' ? false : {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:', 'http:', 'https:'],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    // Framing is same-origin only. It was disabled entirely, which let any site
    // frame OpenHub and clickjack an authenticated session; the in-app preview
    // that needed framing is same-origin, so it still works.
    frameguard: process.env.OPENHUB_ALLOW_FRAMING === '1' ? false : { action: 'sameorigin' },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
  }));

  // The `verify` hook stashes the raw bytes for the GitHub webhook path so its
  // HMAC can be checked. It must live on THIS global parser: body-parser
  // short-circuits on `req._body`, so a route-level parser's verify never runs.
  app.use(express.json({ limit: '50mb', verify: captureWebhookRawBody }));

  // CORS for local development and iframe preview. Credentialed cross-origin
  // access is restricted to an explicit allowlist; same-origin and non-browser
  // requests fall back to a non-credentialed wildcard.
  const allowedOrigins = new Set(
    (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:5173,http://127.0.0.1:3000,http://127.0.0.1:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Vary', 'Origin');
    } else if (!origin) {
      res.header('Access-Control-Allow-Origin', '*');
    }
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token, X-Auth-Strategy, X-Requested-With');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // ===================== AUTH ROUTES =====================

  // Self-registration is opt-in. It is allowed only when explicitly enabled, or
  // as a first-run bootstrap while the user store is still empty. Login, refresh,
  // SSO and SCIM are unaffected.
  //
  // The catch arm used to answer 403 'registration is disabled' for ANY error,
  // which made a broken user store indistinguishable from a policy decision: a
  // missing `users` table and a store that already has rows both produced the same
  // 403 with no diagnostic. It is now 500 with the underlying message, because a
  // database failure is an operator problem and must not be reported as "you are
  // not allowed". A genuinely disabled store still returns 403. This is the
  // distinction 2026-10-04-commands-that-report-success-while-doing-nothing
  // demands: a refusal must name its real cause.
  app.use('/api/auth', (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.method !== 'POST' || !/^\/register\/?$/i.test(req.path)) return next();
    if (process.env.OPENHUB_ALLOW_REGISTRATION === '1') return next();
    userStore.countUsers()
      .then((count) => {
        if (count === 0) return next();
        return res.status(403).json({ error: 'registration is disabled' });
      })
      .catch((err: unknown) => {
        console.error('[Auth] countUsers failed while gating registration:', err);
        return res.status(500).json({
          error: 'registration gate could not evaluate the user store',
          detail: err instanceof Error ? err.message : String(err),
        });
      });
  });

  app.use('/api/auth', auth.router({
    onRegister: async (data: any) => {
      const hashedPassword = await auth.passwordService.hash(String(data.password));
      return userStore.create({
        email: String(data.email),
        password: hashedPassword,
        username: data.username ? String(data.username) : undefined,
        firstName: data.firstName ? String(data.firstName) : undefined,
        lastName: data.lastName ? String(data.lastName) : undefined,
      });
    },
  }));

  // ===================== SCIM PROVISIONING =====================
  // IdP-driven user provisioning. Bearer-gated by SCIM_BEARER_TOKEN and 503s
  // when that token is unset (never falls open). Optional seat cap.
  const maxSeatsRaw = Number(process.env.OPENHUB_MAX_SEATS);
  app.use(createScimRouter({
    store: userStore,
    maxSeats: Number.isFinite(maxSeatsRaw) && maxSeatsRaw > 0 ? maxSeatsRaw : null,
  }));

  // ===================== SSO (OIDC) =====================
  // Enabled only when OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET are configured.
  const sso = oidcConfig(process.env);
  const pendingSso = new PendingSsoStore();
  if (sso) {
    app.get('/api/auth/sso/start', async (req, res) => {
      try {
        const disc = await discoverOidc(sso);
        const state = crypto.randomBytes(16).toString('base64url');
        const nonce = crypto.randomBytes(16).toString('base64url');
        const { verifier, challenge } = pkcePair();
        const rawReturn = typeof req.query.returnTo === 'string' ? req.query.returnTo : '';
        const returnTo = rawReturn.startsWith('/') && !rawReturn.startsWith('//') ? rawReturn : '/';
        pendingSso.put(state, { nonce, verifier, returnTo });
        res.redirect(buildAuthorizeUrl(sso, disc, { state, nonce, codeChallenge: challenge }));
      } catch (err) {
        console.error('[sso] start failed:', err instanceof Error ? err.message : err);
        res.redirect('/login?sso_error=start_failed');
      }
    });

    app.get('/api/auth/sso/callback', async (req, res) => {
      try {
        const code = typeof req.query.code === 'string' ? req.query.code : '';
        const state = typeof req.query.state === 'string' ? req.query.state : '';
        const pending = pendingSso.take(state);
        if (!code || !pending) return res.redirect('/login?sso_error=invalid_state');
        const disc = await discoverOidc(sso);
        const tokens = await exchangeCode(sso, disc, code, pending.verifier);
        if (!tokens.id_token) return res.redirect('/login?sso_error=no_id_token');
        const claims = await verifyIdToken(tokens.id_token, sso, disc, pending.nonce);
        // userinfo can carry group claims the id_token omits; merge but keep the
        // verified id_token claims authoritative for identity.
        const info = tokens.access_token ? await fetchUserInfo(disc, tokens.access_token) : {};
        const identity = identityFromClaims({ ...info, ...claims }, sso);

        let user = await userStore.findByProviderAccount('oidc', identity.sub);
        if (!user) {
          const byEmail = await userStore.findByEmail(identity.email);
          if (byEmail) {
            // Linking by email hands the IdP identity an existing local
            // account, so the IdP must assert the address is verified.
            if (!identity.emailVerified) {
              return res.redirect('/login?sso_error=email_unverified');
            }
            await userStore.linkProvider(byEmail.id, 'oidc', identity.sub, identity.role);
            user = await userStore.findById(byEmail.id);
          } else {
            user = await userStore.create({
              email: identity.email,
              password: crypto.randomBytes(24).toString('hex'),
              username: usernameFromEmail(identity.email),
              firstName: identity.name,
              role: identity.role,
              loginProvider: 'oidc',
              providerAccountId: identity.sub,
            });
          }
        }
        if (!user) return res.redirect('/login?sso_error=user_resolution_failed');
        // Re-sync role on every login so IdP group changes take effect.
        await userStore.updateRole(user.id, identity.role, 'sso');
        await userStore.updateLastLogin(user.id);

        const pair = auth.tokenService.generateTokenPair(
          { sub: user.id, email: user.email, role: identity.role, loginProvider: 'oidc', isEmailVerified: true },
          authConfig,
        );
        auth.tokenService.setTokenCookies(res, pair, authConfig);
        auth.tokenService.initCsrfToken(res, authConfig);
        const returnTo = pending.returnTo && pending.returnTo.startsWith('/') && !pending.returnTo.startsWith('//') ? pending.returnTo : '/';
        res.redirect(returnTo);
      } catch (err) {
        console.error('[sso] callback failed:', err instanceof Error ? err.message : err);
        res.redirect('/login?sso_error=callback_failed');
      }
    });
  }

  // /api/auth/me is handled by auth.router()

  // Legacy logout - use auth's /auth/logout instead

  // ===================== SSH KEYS =====================

  app.get('/api/settings/ssh-keys', auth.middleware(), (req, res) => {
    const db = getDb();
    const keys = db.prepare(
      'SELECT id, title, public_key, fingerprint, created_at FROM ssh_keys WHERE user_id = ? ORDER BY created_at DESC'
    ).all(getUser(req).sub);
    res.json(keys);
  });

  app.post('/api/settings/ssh-keys', auth.middleware(), (req, res) => {
    const db = getDb();

    const { title, key } = req.body;
    if (!title || !key) return res.status(400).json({ error: 'Title and key required' });

    const id = uuidv4();
    const newKey = { id, user_id: getUser(req).sub, title, public_key: key, fingerprint: null, created_at: new Date().toISOString() };

    db.prepare(
      'INSERT INTO ssh_keys (id, user_id, title, public_key, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, getUser(req).sub, title, key, newKey.created_at);

    res.json(newKey);
  });

  app.delete('/api/settings/ssh-keys/:id', auth.middleware(), (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM ssh_keys WHERE id = ? AND user_id = ?').run(req.params.id, getUser(req).sub);
    res.json({ success: true });
  });

  // ===================== PROFILE / AVATAR / PASSWORD / EMAIL / NOTIFICATIONS =====================

  app.get('/api/settings/profile', auth.middleware(), (req, res) => {
    const db = getDb();
    // `role` and `active` were missing from both the SELECT and the response, so
    // this route reported `role: undefined` for every user while /api/auth/me
    // reported the real value. Any UI gating on the profile response therefore
    // saw a user with no role and hid the owner-only affordances, which reads as
    // "the buttons are broken" rather than "the field is missing". The role is
    // read from the user row, which is authoritative, not from the token.
    const row = db.prepare(
      'SELECT id, username, email, avatar_url, first_name, last_name, role, active FROM users WHERE id = ?',
    ).get(getUser(req).sub) as any;
    if (!row) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: row.id,
      username: row.username,
      email: row.email,
      avatarUrl: row.avatar_url,
      firstName: row.first_name,
      lastName: row.last_name,
      role: row.role ?? null,
      active: row.active !== 0,
    });
  });

  // Avatar upload as a base64 data URL (capped at 2MB). Stored directly on the user row.
  app.post('/api/settings/avatar', auth.middleware(), (req, res) => {
    const db = getDb();
    const dataUrl = (req.body as { dataUrl?: unknown } | undefined)?.dataUrl;
    if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(dataUrl)) {
      return res.status(400).json({ error: 'A base64 data URL of a PNG/JPEG/WebP/GIF image is required' });
    }
    if (dataUrl.length > 2_800_000) {
      return res.status(413).json({ error: 'Avatar too large (max ~2MB)' });
    }
    db.prepare('UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?').run(dataUrl, new Date().toISOString(), getUser(req).sub);
    res.json({ avatarUrl: dataUrl });
  });

  app.post('/api/settings/email', auth.middleware(), (req, res) => {
    const db = getDb();
    const email = (req.body as { email?: unknown } | undefined)?.email;
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    const taken = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, getUser(req).sub);
    if (taken) return res.status(409).json({ error: 'That email is already in use' });
    db.prepare('UPDATE users SET email = ?, updated_at = ? WHERE id = ?').run(email, new Date().toISOString(), getUser(req).sub);
    res.json({ email });
  });

  app.post('/api/settings/password', auth.middleware(), async (req, res) => {
    const db = getDb();
    const userId = getUser(req)?.sub;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const { current, next } = (req.body ?? {}) as { current?: unknown; next?: unknown };
    if (typeof next !== 'string' || next.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string | null } | undefined;
    if (!row) return res.status(404).json({ error: 'User not found' });
    if (row.password_hash) {
      const bcrypt = await import('bcryptjs');
      const ok = typeof current === 'string' && bcrypt.default.compareSync(current, row.password_hash);
      if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const bcrypt = await import('bcryptjs');
    const hash = bcrypt.default.hashSync(next, 10);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, new Date().toISOString(), userId);
    res.json({ success: true });
  });

  app.get('/api/settings/notifications', auth.middleware(), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT prefs FROM notification_prefs WHERE user_id = ?').get(getUser(req).sub) as { prefs: string } | undefined;
    let prefs: Record<string, boolean> = {};
    try { prefs = row ? JSON.parse(row.prefs) : {}; } catch { prefs = {}; }
    res.json({ prefs });
  });

  app.put('/api/settings/notifications', auth.middleware(), (req, res) => {
    const db = getDb();
    const prefs = (req.body ?? {}) as Record<string, unknown>;
    const clean: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(prefs)) {
      if (typeof v === 'boolean') clean[k] = v;
    }
    const now = new Date().toISOString();
    db.prepare('INSERT OR REPLACE INTO notification_prefs (user_id, prefs, updated_at) VALUES (?, ?, ?)')
      .run(getUser(req).sub, JSON.stringify(clean), now);
    res.json({ prefs: clean });
  });

  // ===================== REPOSITORIES =====================

  app.get('/api/repos', auth.middleware(), (req, res) => {
    const db = getDb();
    const { page, limit } = getPaginationParams(req);
    // LEFT JOIN the observed status so the list carries a live health column
    // instead of the UI having to fetch every repo's status one request at a
    // time. A repo that has never been observed comes back with
    // health='unobserved' rather than NULL, so a client cannot mistake
    // "not yet measured" for "clean".
    const repos = db.prepare(`
      SELECT r.*, u.username as owner_name,
             COALESCE(s.health, 'unobserved')      AS status_health,
             COALESCE(s.health_reason, 'never observed') AS status_reason,
             s.branch        AS status_branch,
             s.head_sha      AS status_head_sha,
             s.dirty_count   AS status_dirty_count,
             s.has_remote    AS status_has_remote,
             s.observed_at   AS status_observed_at
      FROM repositories r
      JOIN users u ON r.owner_id = u.id
      LEFT JOIN repo_status s ON s.repo_id = r.id
      WHERE r.owner_id = ?
      ORDER BY r.updated_at DESC
    `).all(getUser(req).sub);
    res.json(paginate(repos, page, limit));
  });

  // ===================== REPO STATUS LEDGER (current state + change history) =====================
  // The ledger is written by repo-status-ledger.mjs, which is the only writer:
  // it owns the "did a watched field actually change" decision so an unchanged
  // tree appends nothing. These routes are read-only on purpose -- a POST here
  // would let a caller claim a healthy repo it never measured.

  // Current observed state for every repo the caller owns, with the most recent
  // change per repo. Scoped by owner_id exactly like /api/repos above; a repo id
  // belonging to another account must not be readable by guessing the id.
  app.get('/api/repos/status', auth.middleware(), (req, res) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT r.id AS repo_id, r.name, r.full_path,
             COALESCE(s.health, 'unobserved') AS health,
             COALESCE(s.health_reason, 'never observed') AS reason,
             s.branch, s.head_sha, s.dirty_count, s.has_remote, s.remote_url,
             s.last_commit_at, s.observed_at
      FROM repositories r
      LEFT JOIN repo_status s ON s.repo_id = r.id
      WHERE r.owner_id = ?
      ORDER BY CASE COALESCE(s.health, 'unobserved')
                 WHEN 'at-risk' THEN 0 WHEN 'dirty' THEN 1 WHEN 'ok' THEN 2
                 WHEN 'unbacked-up' THEN 3 WHEN 'unreadable' THEN 4 ELSE 5 END,
               COALESCE(s.dirty_count, 0) DESC
    `).all(getUser(req).sub) as { observed_at?: string | null }[];

    const counts = db.prepare(`
      SELECT COALESCE(s.health, 'unobserved') AS health, COUNT(*) AS n
      FROM repositories r
      LEFT JOIN repo_status s ON s.repo_id = r.id
      WHERE r.owner_id = ?
      GROUP BY COALESCE(s.health, 'unobserved')
    `).all(getUser(req).sub) as { health: string; n: number }[];
    const byHealth: Record<string, number> = {};
    for (const c of counts) byHealth[c.health] = c.n;

    res.json({ repos: rows, byHealth, observedAt: rows[0]?.observed_at ?? null });
  });

  // Change history for one repo. 404 rather than 403 when the repo is not the
  // caller's, so an id probe cannot confirm the existence of another account's
  // repository.
  app.get('/api/repos/:id/status', auth.middleware(), (req, res) => {
    const db = getDb();
    const owned = db.prepare('SELECT id FROM repositories WHERE id = ? AND owner_id = ?')
      .get(req.params.id, getUser(req).sub);
    if (!owned) return res.status(404).json({ error: 'Repository not found' });

    const current = db.prepare('SELECT * FROM repo_status WHERE repo_id = ?').get(req.params.id) ?? null;
    const { limit } = getPaginationParams(req);
    const events = db.prepare(
      'SELECT id, observed_at, field, old_value, new_value, note FROM repo_status_events WHERE repo_id = ? ORDER BY id DESC LIMIT ?',
    ).all(req.params.id, limit);
    res.json({ current, events });
  });

  app.post('/api/repos', auth.middleware(), (req, res) => {
    const db = getDb();

    const { description, isPrivate } = req.body;
    // Reject anything that is not a plain basename: a `..` or separator would
    // let `path.join` escape REPOS_ROOT and `git init` an arbitrary directory.
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'Repository name required' });
    if (name.length > 100) return res.status(400).json({ error: 'Repository name too long (max 100)' });
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
      return res.status(400).json({ error: 'Repository name may only contain letters, numbers, dot, dash and underscore' });
    }

    const id = uuidv4();
    const user = req.user as unknown as AuthUser;
    const ownerName = user.username ?? user.email?.split('@')[0] ?? 'user';
    // The username becomes a directory under REPOS_ROOT: refuse separators
    // and dot segments, and assert containment.
    //
    // \u0000 in the pattern is the thing being rejected, not an accident. A NUL
    // in a path segment truncates the name in every C-level syscall on Windows,
    // so a validated username can become a different directory on disk. There
    // is no way to write "reject NUL" without the control character in the
    // regex, which is why the rule is disabled here rather than the check.
    // eslint-disable-next-line no-control-regex
    if (!ownerName || ownerName === '.' || ownerName === '..' || /[\\/\u0000]/.test(ownerName)) {
      return res.status(400).json({ error: 'Your username cannot be used as a repository directory' });
    }
    const ownerDir = path.join(REPOS_ROOT, ownerName);
    if (!path.resolve(ownerDir).startsWith(path.resolve(REPOS_ROOT) + path.sep)) {
      return res.status(400).json({ error: 'Invalid repository path' });
    }
    const fullPath = path.join(ownerDir, name);

    // Defence in depth: the name is already a validated basename, but assert the
    // resolved path is still contained under the owner directory.
    const resolvedOwner = path.resolve(ownerDir);
    const resolvedFull = path.resolve(fullPath);
    if (resolvedFull !== path.join(resolvedOwner, name) || !resolvedFull.startsWith(resolvedOwner + path.sep)) {
      return res.status(400).json({ error: 'Invalid repository path' });
    }

    if (fs.existsSync(fullPath)) {
      return res.status(409).json({ error: 'Repository already exists' });
    }

    fs.mkdirSync(fullPath, { recursive: true });

    try {
      execFileSync(resolveBin('git', fullPath), hardenGitArgs(['init']), { cwd: fullPath, stdio: 'ignore', env: safeChildEnv(), windowsHide: true });
    } catch {
      console.warn(`[Repo] git init failed for ${fullPath} — git may not be installed`);
    }

    db.prepare(`
      INSERT INTO repositories (id, owner_id, name, description, full_path, is_private)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, getUser(req).sub, name, description || '', fullPath, isPrivate ? 1 : 0);

    const repo = {
      id,
      owner_id: getUser(req).sub,
      owner_name: getUser(req).username,
      name,
      description: description || '',
      full_path: fullPath,
      is_private: isPrivate ? 1 : 0,
      default_branch: 'main',
      language: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    fireWebhook(getUser(req).sub, 'repo.created', { repo: { id, name, description, isPrivate } }).catch(() => {});

    res.json(repo);
  });

  // Register an existing local folder as a repository so it can become the
  // active project. The folder is used in place — nothing is copied or moved.
  app.post('/api/repos/import-local', auth.middleware(), (req, res) => {
    const db = getDb();
    const rawPath = (req.body as { path?: unknown } | undefined)?.path;
    const rawName = (req.body as { name?: unknown } | undefined)?.name;
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      return res.status(400).json({ error: 'A local folder path is required' });
    }
    const resolved = path.resolve(rawPath.trim());
    // Any logged-in account could previously register ANY directory on the host
    // — /etc, another user's home, the server's own config — as a repository,
    // which then became readable through the repo APIs.
    const roots = browseRoots();
    if (!isBrowsable(resolved, roots)) {
      return res.status(403).json({
        error: 'That folder is outside the allowed roots',
        allowedRoots: roots,
      });
    }
    try {
      if (!fs.statSync(resolved).isDirectory()) throw new Error('not a directory');
    } catch {
      return res.status(400).json({ error: 'Path must exist and be a directory on this machine' });
    }

    const userId = getUser(req).sub;
    const existing = db.prepare(`
      SELECT r.*, u.username as owner_name
      FROM repositories r
      JOIN users u ON r.owner_id = u.id
      WHERE r.full_path = ? AND r.owner_id = ?
    `).get(resolved, userId) as Record<string, unknown> | undefined;
    if (existing) return res.json({ ...existing, imported: false });

    const name = typeof rawName === 'string' && rawName.trim() !== ''
      ? rawName.trim().slice(0, 120)
      : path.basename(resolved) || 'local-project';
    const id = uuidv4();
    const now = new Date().toISOString();
    try {
      db.prepare(`
        INSERT INTO repositories (id, owner_id, name, description, full_path, is_private, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, userId, name, 'Local folder import', resolved, 1, now, now);
    } catch {
      return res.status(409).json({ error: 'That folder is already registered' });
    }
    fireWebhook(userId, 'repo.created', { repo: { id, name, local: true } }).catch(() => {});
    res.json({
      id, owner_id: userId, owner_name: getUser(req).username, name,
      description: 'Local folder import', full_path: resolved, is_private: 1,
      default_branch: 'main', language: '', created_at: now, updated_at: now, imported: true,
    });
  });

  // Server-side directory browser for the local-folder picker. Auth-gated,
  // directories only, never follows a file. Drive list on Windows when empty.
  app.get('/api/browse', auth.middleware(), (req, res) => {
    const requested = typeof req.query.dir === 'string' ? req.query.dir : '';
    // Confined to the configured roots (default: the server user's home). The
    // Windows drive listing is gone with it: enumerating every volume is not
    // something a repo picker needs, and it handed every account a map of the
    // machine.
    const roots = browseRoots();
    try {
      if (!requested) {
        const entries = roots.flatMap((root) => {
          try {
            return fs.statSync(root).isDirectory()
              ? [{ name: path.basename(root) || root, path: root }]
              : [];
          } catch {
            return [];
          }
        });
        // One root behaves as before: open straight into it.
        if (roots.length === 1 && entries.length === 1) {
          return res.json({ dir: roots[0], parent: null, entries: listDirs(roots[0]) });
        }
        return res.json({ dir: null, parent: null, entries });
      }
      const dir = path.resolve(requested);
      if (!isBrowsable(dir, roots)) {
        return res.status(403).json({ error: 'That location is outside the allowed roots', allowedRoots: roots });
      }
      if (!fs.statSync(dir).isDirectory()) {
        return res.status(404).json({ error: 'Not a directory' });
      }
      // `parent` is only offered while it stays inside an allowed root, so the
      // UI cannot walk itself out one click at a time.
      const parent = path.dirname(dir);
      const parentOk = parent !== dir && isBrowsable(parent, roots);
      return res.json({ dir, parent: parentOk ? parent : null, entries: listDirs(dir) });
    } catch {
      return res.status(400).json({ error: 'Cannot browse that location' });
    }

    function listDirs(dir: string): { name: string; path: string }[] {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => {
          try {
            return entry.isDirectory();
          } catch {
            return false;
          }
        })
        .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }))
        .filter((entry) => isBrowsable(entry.path, roots))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 500);
    }
  });

  app.get('/api/repos/:owner/:repoName/contents', auth.middleware(), (req, res) => {
    const { owner, repoName } = req.params;
    const userId = getUser(req).sub;
    // Cross-tenant guard: resolve the repo row by full_path AND owner_id
    // (same pattern as /api/repos/import-local). URL params alone must never
    // grant access to another user's repo directory.
    const repoRow = getDb().prepare(
      'SELECT * FROM repositories WHERE full_path = ? AND owner_id = ?'
    ).get(path.join(REPOS_ROOT, owner, repoName), userId) as Record<string, unknown> | undefined;
    if (!repoRow) {
      return res.status(404).json({ error: 'Repository not found' });
    }
    const repoPath = String(repoRow.full_path);

    if (!fs.existsSync(repoPath)) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    const subPath = typeof req.query.path === 'string' ? req.query.path : '';
    const fullPath = path.join(repoPath, subPath);

    if (!isSubpath(repoPath, fullPath)) {
      return res.status(403).json({ error: 'Path traversal denied' });
    }
    // `.git` is not repo content: `.git/config` carries the remote URL and the
    // push token embedded in it.
    if (hasDeniedSegment(subPath, repoPath)) {
      return res.status(403).json({ error: 'Access to .git is denied' });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Path not found' });
    }

    const stat = fs.statSync(fullPath);
    if (stat.isFile()) {
      // Read with a cap. This handler returned the whole file as a UTF-8 string
      // with no size check, so one `git clone` of a repo holding a large binary
      // was an out-of-memory kill of the server from an ordinary file click.
      if (stat.size > MAX_CONTENTS_BYTES) {
        return res.status(413).json({
          error: 'File too large to display',
          size: stat.size,
          limit: MAX_CONTENTS_BYTES,
        });
      }
      const content = fs.readFileSync(fullPath, 'utf-8');
      const ext = path.extname(fullPath).slice(1) || 'text';
      return res.json({ type: 'file', name: path.basename(fullPath), path: subPath, content, size: stat.size, language: ext });
    }

    const entries = fs.readdirSync(fullPath, { withFileTypes: true });
    const items = entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : 'file',
      path: subPath ? `${subPath}/${entry.name}` : entry.name,
      size: entry.isFile() ? fs.statSync(path.join(fullPath, entry.name)).size : 0,
    }));
    res.json({ type: 'dir', path: subPath, entries: items });
  });

  app.put('/api/repos/:owner/:repoName/contents', auth.middleware(), (req, res) => {
    const { owner, repoName } = req.params;
    const { path: filePath, content, message } = req.body;
    const userId = getUser(req).sub;
    // Cross-tenant guard: resolve the repo row by full_path AND owner_id
    // before touching disk, and never push with another user's token.
    const repoRow = getDb().prepare(
      'SELECT * FROM repositories WHERE full_path = ? AND owner_id = ?'
    ).get(path.join(REPOS_ROOT, owner, repoName), userId) as Record<string, unknown> | undefined;
    if (!repoRow) {
      return res.status(404).json({ error: 'Repository not found' });
    }
    const repoPath = String(repoRow.full_path);

    // Validate BEFORE building the path: `path.join` throws a TypeError on a
    // non-string, so a JSON body with `"path": {}` produced a 500 out of a
    // request that should have been a 400.
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      return res.status(400).json({ error: 'File path required' });
    }
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'File content must be a string' });
    }

    const fullPath = path.join(repoPath, filePath);

    if (!isSubpath(repoPath, fullPath)) {
      return res.status(403).json({ error: 'Path traversal denied' });
    }
    // Writing under `.git` is code execution, not an edit: a dropped
    // `.git/hooks/post-commit` runs as the server the next time git touches
    // this repo, and `git init` / push-sync do exactly that.
    if (hasDeniedSegment(filePath, repoPath)) {
      return res.status(403).json({ error: 'Writes to .git are denied' });
    }
    if (Buffer.byteLength(content, 'utf-8') > MAX_CONTENTS_BYTES) {
      return res.status(413).json({ error: 'File too large', limit: MAX_CONTENTS_BYTES });
    }

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');

    // Attempt background sync to GitHub if this repo is linked
    try {
      const user = getUser(req);
      const integration = getGitHubIntegration(user.sub);
      if (integration) {
        pushSyncToGitHub(
          user.sub,
          owner,
          repoName,
          filePath,
          content,
          message || `Update ${filePath} via OpenHub`,
          integration.accessToken,
          REPOS_ROOT
        ).catch((e: any) => console.warn('[GitHub Auto-Sync warn]:', e.message));
      }
    } catch {}

    res.json({ success: true, path: filePath });
  });

  // ===================== DEEP GITHUB INTEGRATION =====================

  // OAuth `state` is the ONLY binding between the browser that started the flow
  // and the callback that persists the token. Previously it was the raw user id,
  // which any caller could forge: POST a valid `code` for their OWN GitHub
  // account with `state=<victim user id>` and the victim's OpenHub account is
  // bound to the attacker's GitHub token. Sign it with the OAuth client secret
  // so only this server can mint a state the callback will accept.
  const signOAuthState = (userId: string, secret: string): string => {
    const payload = `${userId}:${crypto.randomBytes(16).toString('hex')}`;
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sig}`;
  };
  const verifyOAuthState = (state: unknown, secret: string): string | null => {
    if (typeof state !== 'string' || !state.includes('.')) return null;
    const [enc, sig] = state.split('.');
    let payload: string;
    try {
      payload = Buffer.from(enc, 'base64url').toString('utf8');
    } catch {
      return null;
    }
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const a = Buffer.from(sig ?? '', 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const sep = payload.lastIndexOf(':');
    const userId = sep > 0 ? payload.slice(0, sep) : '';
    return userId || null;
  };

  // 1. OAuth URL Generation
  app.get('/api/github/auth-url', auth.middleware(), async (req, res) => {
    const [{ value: clientId }, { value: clientSecret }] = await Promise.all([
      resolveSecret('GITHUB_CLIENT_ID'),
      resolveSecret('GITHUB_CLIENT_SECRET'),
    ]);
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const redirectUri = `${appUrl}/api/github/callback`;

    if (!clientId || !clientSecret) {
      return res.json({
        configured: false,
        message: 'GITHUB_CLIENT_ID is not configured. Connect directly using a GitHub Personal Access Token (PAT).',
        redirectUri,
      });
    }

    const state = signOAuthState(getUser(req).sub, clientSecret);
    const scopes = 'repo,read:user,user:email,workflow,admin:repo_hook';
    const authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(state)}`;
    res.json({ configured: true, url: authUrl, redirectUri });
  });

  // 2. OAuth Callback
  app.get(['/api/github/callback', '/api/github/callback/'], async (req, res) => {
    const { code, state } = req.query;
    if (!code) {
      return res.status(400).send('OAuth callback missing authorization code');
    }

    try {
      const [{ value: clientId }, { value: clientSecret }] = await Promise.all([
        resolveSecret('GITHUB_CLIENT_ID'),
        resolveSecret('GITHUB_CLIENT_SECRET'),
      ]);
      if (!clientId || !clientSecret) {
        throw new Error('GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET not configured');
      }

      // Verify BEFORE spending the code: an unsigned/forged state must not mint
      // a token binding.
      const targetUserId = verifyOAuthState(state, clientSecret);
      if (!targetUserId) {
        return res.status(400).send('OAuth callback rejected: invalid or missing state');
      }

      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
        }),
      });

      const tokenData = await tokenRes.json();
      if (tokenData.error) {
        throw new Error(tokenData.error_description || tokenData.error);
      }

      const accessToken = tokenData.access_token;
      const profile = await verifyAndFetchGitHubProfile(accessToken);
      saveGitHubIntegration(targetUserId, accessToken, profile, tokenData.scope);

      // postMessage only to this app's own origin, never '*'.
      let appOrigin: string;
      try {
        appOrigin = new URL(process.env.APP_URL || `${req.protocol}://${req.get('host')}`).origin;
      } catch {
        appOrigin = `${req.protocol}://${req.get('host')}`;
      }
      const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

      res.send(`
        <!DOCTYPE html>
        <html>
          <head><title>GitHub Connected</title></head>
          <body style="font-family:sans-serif;text-align:center;padding:40px;background:#0A0C10;color:#fff;">
            <h2 style="color:#58a6ff;">GitHub Connected Successfully!</h2>
            <p>Authenticated as @${profile.login}. You may close this window.</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'GITHUB_AUTH_SUCCESS', user: ${scriptJson(profile.login)} }, ${scriptJson(appOrigin)});
                setTimeout(() => window.close(), 1000);
              } else {
                window.location.href = '/';
              }
            </script>
          </body>
        </html>
      `);
    } catch (err: any) {
      res.status(500).send(`GitHub OAuth failed: ${err.message}`);
    }
  });

  // 3. Connect via Personal Access Token (PAT)
  app.post('/api/github/pat-connect', auth.middleware(), async (req, res) => {
    const { token } = req.body;
    if (!token || typeof token !== 'string' || !token.trim()) {
      return res.status(400).json({ error: 'GitHub Personal Access Token is required' });
    }
    try {
      const user = getUser(req);
      const profile = await verifyAndFetchGitHubProfile(token.trim());
      saveGitHubIntegration(user.sub, token.trim(), profile, 'pat-access');
      res.json({ success: true, user: profile });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to authenticate token with GitHub' });
    }
  });

  // 4. Connection Status — self-healing. A stored token that no longer
  //    verifies (revoked/expired) is refreshed from the Keywire vault; with no
  //    stored token at all, the vault credential is provisioned automatically so
  //    the IDE opens already authenticated. An explicit disconnect suppresses
  //    auto-provisioning until the operator reconnects.
  app.get('/api/github/status', auth.middleware(), async (req, res) => {
    const user = getUser(req);
    const integration = getGitHubIntegration(user.sub);

    if (integration) {
      try {
        const profile = await verifyAndFetchGitHubProfile(integration.accessToken);
        return res.json({
          connected: true,
          user: profile,
          scope: integration.scope,
          updatedAt: integration.updatedAt,
          source: integration.scope === 'keywire-vault' ? 'keywire-vault' : 'manual',
        });
      } catch {
        /* stored token is dead — fall through to a vault refresh */
      }
    }

    // The vault token belongs to the operator: only the owner account
    // (OPENHUB_OWNER_USER_ID, else the first-created user) may receive it.
    if (isVaultOwner(user.sub) && !isVaultAutoConnectSuppressed(user.sub)) {
      const provisioned = await provisionGitHubFromVault(user.sub);
      if (provisioned.connected && provisioned.user) {
        return res.json({
          connected: true,
          user: provisioned.user,
          scope: provisioned.scope,
          source: 'keywire-vault',
          key: provisioned.key,
          updatedAt: new Date().toISOString(),
        });
      }
      if (!integration) {
        return res.json({ connected: false, vaultAutoConnect: true, error: provisioned.error });
      }
    }

    res.json({
      connected: false,
      error: 'Token expired or revoked. Please reconnect your GitHub account.',
    });
  });

  // 4b. Explicit vault (re)connect — clears any disconnect suppression.
  app.post('/api/github/vault-connect', auth.middleware(), async (req, res) => {
    const user = getUser(req);
    if (!isVaultOwner(user.sub)) {
      return res.status(403).json({ success: false, error: VAULT_OWNER_ONLY_ERROR });
    }
    setVaultAutoConnectSuppressed(user.sub, false);
    const provisioned = await provisionGitHubFromVault(user.sub);
    if (!provisioned.connected) {
      return res.status(502).json({ success: false, error: provisioned.error || 'Vault GitHub credential unavailable' });
    }
    res.json({ success: true, user: provisioned.user, key: provisioned.key, source: provisioned.source, scope: provisioned.scope });
  });

  // 4c. Vault GitHub credential health — one real API check per candidate key,
  //     so a stale/revoked PAT is surfaced instead of failing silently later.
  app.get('/api/github/vault/credentials', auth.middleware(), async (_req, res) => {
    const credentials = await probeVaultGitHubCredentials();
    res.json({ credentials, checkedAt: new Date().toISOString() });
  });

  // 4d. Provider health for the Integrations surface. Replaces the removed
  //     `/api/business/integrations` with live probes — vault reachability,
  //     per-credential GitHub checks, and real HTTP probes of fleet services.
  app.get('/api/integrations/providers', auth.middleware(), async (_req, res) => {
    res.json(await probeProviderHealth());
  });

  // 5. Disconnect GitHub — also suppresses vault auto-connect so the next
  //    status check does not immediately sign the operator back in.
  app.post('/api/github/disconnect', auth.middleware(), (req, res) => {
    const user = getUser(req);
    removeGitHubIntegration(user.sub);
    setVaultAutoConnectSuppressed(user.sub, true);
    res.json({ success: true });
  });

  // 6. List User's GitHub Repositories
  app.get('/api/github/repos', auth.middleware(), async (req, res) => {
    const user = getUser(req);
    const integration = getGitHubIntegration(user.sub);
    if (!integration) {
      return res.status(401).json({ error: 'GitHub account is not connected' });
    }
    try {
      const repos = await fetchUserRepos(integration.accessToken, user.sub);
      res.json({ repos });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch repositories from GitHub' });
    }
  });

  // 7. Import GitHub Repository into OpenHub
  app.post('/api/github/import', auth.middleware(), async (req, res) => {
    const user = getUser(req);
    const integration = getGitHubIntegration(user.sub);
    if (!integration) {
      return res.status(401).json({ error: 'GitHub account is not connected' });
    }
    const { owner, repo } = req.body;
    if (!owner || !repo) {
      return res.status(400).json({ error: 'Owner and repository name required' });
    }
    if (!isSafeName(owner) || !isSafeName(repo)) {
      return res.status(400).json({ error: 'Owner and repository name may only contain letters, numbers, dot, dash and underscore' });
    }
    try {
      const imported = await importGitHubRepo(
        user.sub,
        user.username || 'developer',
        owner,
        repo,
        integration.accessToken,
        REPOS_ROOT
      );
      res.json({ success: true, repo: imported });
    } catch (err: any) {
      console.error('[GitHub Import Error]', err);
      res.status(500).json({ error: err.message || 'Import failed' });
    }
  });

  // 8. Push File Sync to GitHub
  app.post('/api/github/push-sync', auth.middleware(), async (req, res) => {
    const user = getUser(req);
    const integration = getGitHubIntegration(user.sub);
    if (!integration) {
      return res.status(401).json({ error: 'GitHub account is not connected' });
    }
    const { repoName, path: filePath, content, message } = req.body;
    if (!repoName || !filePath) {
      return res.status(400).json({ error: 'repoName and filePath required' });
    }
    try {
      encodeContentsPath(filePath);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
    try {
      const result = await pushSyncToGitHub(
        user.sub,
        user.username || 'developer',
        repoName,
        filePath,
        content || '',
        message || `Update ${filePath} from OpenHub`,
        integration.accessToken,
        REPOS_ROOT
      );
      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Push sync failed' });
    }
  });

  // 9. GitHub Issues
  app.get('/api/github/repos/:owner/:repo/issues', auth.middleware(), validGitHubRepoParams, async (req, res) => {
    const user = getUser(req);
    const integration = getGitHubIntegration(user.sub);
    if (!integration) return res.status(401).json({ error: 'GitHub not connected' });
    try {
      const issues = await fetchGitHubIssues(integration.accessToken, req.params.owner, req.params.repo);
      res.json({ issues });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/github/repos/:owner/:repo/issues', auth.middleware(), validGitHubRepoParams, async (req, res) => {
    const user = getUser(req);
    const integration = getGitHubIntegration(user.sub);
    if (!integration) return res.status(401).json({ error: 'GitHub not connected' });
    const { title, body } = req.body;
    if (!title) return res.status(400).json({ error: 'Issue title is required' });
    try {
      const issue = await createGitHubIssue(integration.accessToken, req.params.owner, req.params.repo, title, body || '');
      res.json({ success: true, issue });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 10. GitHub Pull Requests
  app.get('/api/github/repos/:owner/:repo/pulls', auth.middleware(), validGitHubRepoParams, async (req, res) => {
    const user = getUser(req);
    const integration = getGitHubIntegration(user.sub);
    if (!integration) return res.status(401).json({ error: 'GitHub not connected' });
    try {
      const pulls = await fetchGitHubPulls(integration.accessToken, req.params.owner, req.params.repo);
      res.json({ pulls });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 11. GitHub Actions & Workflows
  app.get('/api/github/repos/:owner/:repo/actions/workflows', auth.middleware(), validGitHubRepoParams, async (req, res) => {
    const user = getUser(req);
    const integration = getGitHubIntegration(user.sub);
    if (!integration) return res.status(401).json({ error: 'GitHub not connected' });
    try {
      const data = await fetchGitHubWorkflows(integration.accessToken, req.params.owner, req.params.repo);
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/github/repos/:owner/:repo/actions/runs', auth.middleware(), validGitHubRepoParams, async (req, res) => {
    const user = getUser(req);
    const integration = getGitHubIntegration(user.sub);
    if (!integration) return res.status(401).json({ error: 'GitHub not connected' });
    try {
      const data = await fetchGitHubWorkflowRuns(integration.accessToken, req.params.owner, req.params.repo);
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/github/repos/:owner/:repo/actions/workflows/:workflowId/dispatches', auth.middleware(), validGitHubRepoParams, async (req, res) => {
    const user = getUser(req);
    const integration = getGitHubIntegration(user.sub);
    if (!integration) return res.status(401).json({ error: 'GitHub not connected' });
    const { ref, inputs } = req.body;
    try {
      await dispatchGitHubWorkflow(integration.accessToken, req.params.owner, req.params.repo, req.params.workflowId, ref, inputs);
      res.json({ success: true, message: 'Workflow dispatched successfully' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 12. GitHub Webhook Receiver — HMAC-verified and fail-closed.
  //     Raw bytes are captured by the global express.json() `verify` hook
  //     (captureWebhookRawBody); a route-level parser would be a no-op because
  //     body-parser short-circuits on `req._body`. The signature is checked
  //     against those raw bytes before the payload is trusted or persisted.
  app.post('/api/github/webhook', (req, res) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      return res.status(503).json({ error: 'GitHub webhook secret not configured (set GITHUB_WEBHOOK_SECRET)' });
    }
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const signature = String(req.headers['x-hub-signature-256'] || '');
    if (!verifyGitHubSignature(raw, secret, signature)) {
      console.warn('[GitHub Webhook] rejected: bad or missing x-hub-signature-256');
      return res.status(401).json({ error: 'invalid signature' });
    }

    // Replay protection: a captured signed delivery must not be re-ingested.
    const deliveryId = String(req.headers['x-github-delivery'] || '');
    if (deliveryId && isDuplicateDelivery(deliveryId)) {
      return res.json({ status: 'duplicate', deliveryId });
    }

    const event = (req.headers['x-github-event'] as string) || 'ping';
    const payload = req.body;

    const recorded = recordGitHubWebhookEvent(event, payload, true);
    console.log(`[GitHub Webhook] Received ${event}:`, recorded.summary);

    // Broadcast to OpenHub audit logs
    const db = getDb();
    try {
      db.prepare(`
        INSERT INTO audit_logs (id, user_id, action, details, created_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `).run(
        uuidv4(),
        'system-github',
        `github.${event}`,
        JSON.stringify({ repo: payload?.repository?.full_name, sender: payload?.sender?.login, action: payload?.action })
      );
    } catch {}

    res.json({ status: 'ok', recorded });
  });

  // 13. GitHub Webhook Events (real, signature-verified ingestion only)
  app.get('/api/github/webhook/events', auth.middleware(), (req, res) => {
    // Events are ingested tenant-agnostically; list only the caller's linked
    // repos. Operators (configured gate) and the owner account see all.
    const user = getUser(req);
    const events = isConfiguredOperator(user.role) || isVaultOwner(user.sub)
      ? getGitHubWebhookEvents(50)
      : getGitHubWebhookEventsForUser(user.sub, 50);
    res.json({ events });
  });

  // ===================== FILE WATCH / SCAN =====================

  app.post('/api/scan', auth.middleware(), (req, res) => {
    const { content, fileName } = req.body;
    // `content` was passed straight to RegExp.exec; a non-string body coerced
    // to "[object Object]" and scanned that instead of erroring.
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be a string' });
    }
    if (content.length > MAX_CONTENTS_BYTES) {
      return res.status(413).json({ error: 'content too large', limit: MAX_CONTENTS_BYTES });
    }

    const findings: any[] = [];
    // Offset -> line, the same way scanRepoForSecrets does it. The old
    // `lines.findIndex(l => l.includes(match[0]))` blamed EVERY occurrence of a
    // secret on the first line that contained it, and re-scanned the whole file
    // per match, so a large file was quadratic.
    const lineStarts = buildLineStarts(content);

    for (const hit of findSecrets(content)) {
      const lineNum = lineAtOffset(lineStarts, hit.index);
      findings.push({
        id: uuidv4(),
        type: 'Secret',
        severity: 'CRITICAL',
        title: `Detected ${hit.name}`,
        file: typeof fileName === 'string' ? fileName : '',
        line: lineNum || 0,
        description: `A potential ${hit.name} was found in source code.`,
        status: 'open',
      });
    }

    res.json({ findings });
  });

  // ===================== PIPELINE / ACTIONS =====================
  // The in-process CI pipeline (secret scan + tsc + tests) was removed in the
  // Axiom-only consolidation. Verification now runs through Axiom's project
  // loop (`/api/axiom/project/*`), which owns the deterministic gates.

  // ===================== AUDIT LOGS =====================

  app.get('/api/audit-logs', auth.middleware(), (req, res) => {
    const db = getDb();
    const { page, limit } = getPaginationParams(req);
    const logs = db.prepare(`
      SELECT al.*, u.username as user_name
      FROM audit_logs al
      JOIN users u ON al.user_id = u.id
      WHERE al.user_id = ?
      ORDER BY al.created_at DESC
    `).all(getUser(req).sub);
    res.json(paginate(logs, page, limit));
  });

  app.post('/api/audit-logs', auth.middleware(), (req, res) => {
    const db = getDb();

    const { action, details, repoId } = req.body;

    const id = uuidv4();
    db.prepare(
      'INSERT INTO audit_logs (id, user_id, repo_id, action, details, ip) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, getUser(req).sub, repoId || null, action, details || '', req.ip);

    // Dual-write to the fleet brain (append-only recaps) so fleet agents see
    // OpenHub activity per MEMORY.md. No-op with explicit error when no .draymond.
    recordAuditEvent({ userId: getUser(req).sub, action: String(action || 'unknown'), details: details || '', repoId: repoId || undefined });

    res.json({ id, user_id: getUser(req).sub, action, details, created_at: new Date().toISOString() });
  });

  // ===================== REGISTRY =====================

  app.get('/api/registry', auth.middleware(), (req, res) => {
    const db = getDb();
    const { page, limit } = getPaginationParams(req);
    const items = db.prepare('SELECT * FROM registry_items ORDER BY created_at DESC').all();
    res.json(paginate(items, page, limit));
  });

  app.post('/api/registry', auth.middleware(), (req, res) => {
    const db = getDb();

    const { name, type, description, author, version, config } = req.body;

    const id = uuidv4();
    db.prepare(`
      INSERT INTO registry_items (id, name, type, description, status, author, version, config, owner_id)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(id, name, type || 'cli', description || '', author || getUser(req).username, version || '0.1.0', JSON.stringify(config || {}), getUser(req).sub);

    const item = db.prepare('SELECT * FROM registry_items WHERE id = ?').get(id);
    res.json(item);
  });

  app.patch('/api/registry/:id', auth.middleware(), (req, res) => {
    const db = getDb();
    const { status, config } = req.body;

    // Ownership: an item with owner_id is editable by its owner (or an
    // operator under a configured gate). Legacy rows (no owner_id) are
    // editable by a configured operator, or, with the gate unset, by their
    // recorded author (or anyone when no author was recorded).
    const existing = db.prepare('SELECT owner_id, author FROM registry_items WHERE id = ?').get(req.params.id) as
      { owner_id: string | null; author: string | null } | undefined;
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const actor = getUser(req);
    const gated = configuredOperatorRoles().filter((r) => r !== '*').length > 0;
    const allowed = isConfiguredOperator(actor.role)
      || (existing.owner_id
        ? existing.owner_id === actor.sub
        : !gated && (!existing.author || existing.author === actor.username));
    if (!allowed) return res.status(403).json({ error: 'You can only edit registry items you created' });

    if (status) db.prepare('UPDATE registry_items SET status = ? WHERE id = ?').run(status, req.params.id);
    if (config) db.prepare('UPDATE registry_items SET config = ? WHERE id = ?').run(JSON.stringify(config), req.params.id);

    const item = db.prepare('SELECT * FROM registry_items WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  });

  // ===================== WEBHOOKS =====================

  app.get('/api/webhooks', auth.middleware(), (req, res) => {
    const db = getDb();
    const hooks = db.prepare('SELECT * FROM webhooks WHERE user_id = ? ORDER BY created_at DESC').all(getUser(req).sub);
    res.json(hooks);
  });

  app.post('/api/webhooks', auth.middleware(), (req, res) => {
    const db = getDb();
    const { url, secret, events } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    const id = uuidv4();
    db.prepare(`
      INSERT INTO webhooks (id, user_id, url, secret, events, active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(id, getUser(req).sub, url, secret || null, JSON.stringify(events || ['*']));

    const hook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
    res.json(hook);
  });

  app.delete('/api/webhooks/:id', auth.middleware(), (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM webhooks WHERE id = ? AND user_id = ?').run(req.params.id, getUser(req).sub);
    res.json({ success: true });
  });

  app.post('/api/webhooks/:id/test', auth.middleware(), async (req, res) => {
    const db = getDb();
    const hook = db.prepare('SELECT * FROM webhooks WHERE id = ? AND user_id = ?').get(req.params.id, getUser(req).sub) as any;
    if (!hook) return res.status(404).json({ error: 'Webhook not found' });

    try {
      await fireSingleWebhook(hook, 'webhook.test', { message: 'Test webhook from OpenHub', hookId: hook.id });
      res.json({ success: true, message: 'Test webhook fired', hookId: hook.id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===================== WORKSPACE TESTING & READINESS =====================

  app.get('/api/workspace/deploy-readiness', auth.middleware(), async (_req, res) => {
    try {
      const readiness = await getDeployReadiness();
      res.json(readiness);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/workspace/theater-scan', auth.middleware(), (_req, res) => {
    try {
      const scan = detectTheaterAndMocks();
      res.json(scan);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/workspace/test/candidates', auth.middleware(), (_req, res) => {
    try {
      const analysis = analyzeSystemAndFiles();
      res.json({
        candidates: analysis.untestedCandidates,
        breakdown: analysis.fileBreakdown,
        total: analysis.filesAnalyzed,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/workspace/system-analysis', auth.middleware(), (_req, res) => {
    try {
      const analysis = analyzeSystemAndFiles();
      res.json(analysis);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Workspace Intelligence ────────────────────────────────────────────────
  // These four back src/pages/WorkspaceIntelligence.tsx. The page was written
  // and never mounted, and every one of these endpoints was missing; each fetch
  // sat behind an `if (res.ok)` guard, so the page rendered an empty shell and
  // tests/endpointCoverage.test.ts reported five unmatched frontend calls.
  //
  // The directory is the server's own cwd, matching every other /api/workspace
  // route here. It is deliberately NOT a request parameter: a `?dir=` would be a
  // path-traversal primitive reading another user's checkout.
  //
  // Each handler distinguishes "nothing to report" from "could not look", and
  // says which. The page renders `[]` as "all clean", so returning an empty
  // result for an unexamined target would be a false green.
  app.get('/api/workspace/git/status', auth.middleware(), async (_req, res) => {
    try {
      const result = await readGitStatus(process.cwd());
      // 503 rather than 200 with an empty list: the caller asked a question that
      // could not be answered, and a 200 would render as a clean working tree.
      if (!result.available) {
        return res.status(503).json({ error: result.error ?? 'git state unavailable', status: [], available: false });
      }
      res.json({ status: result.status, branch: result.branch, head: result.head, available: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/workspace/git/history', auth.middleware(), async (req, res) => {
    try {
      const raw = Number(req.query.limit);
      const limit = Number.isFinite(raw) && raw > 0 ? raw : undefined;
      const result = await readGitHistory(process.cwd(), limit);
      if (!result.available) {
        return res.status(503).json({ error: result.error ?? 'git history unavailable', history: [], available: false });
      }
      res.json({ history: result.history, available: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/workspace/deps/outdated', auth.middleware(), async (_req, res) => {
    try {
      const result = await collectOutdatedDependencies(process.cwd());
      // No manifest and no runner is 200 — "this project has no dependencies"
      // is a real answer. A manifest that exists but whose manager failed is
      // 503, because `{}` would render as "all dependencies up to date".
      if (result.runners.length === 0 && result.manifests.length > 0) {
        return res.status(503).json({
          error: `manifest present (${result.manifests.join(', ')}) but no package manager answered`,
          reasons: result.errors,
          outdated: {},
          available: false,
        });
      }
      res.json({
        outdated: result.outdated,
        runners: result.runners,
        manifests: result.manifests,
        available: true,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/workspace/ollama/chat', auth.middleware(), async (req, res) => {
    try {
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : '';
      if (!prompt.trim()) {
        return res.status(400).json({ error: 'prompt is required' });
      }
      const result = await askOllama(prompt);
      if (!result.ok) {
        // 503 with the reason. Ollama being absent is the normal case for a
        // developer who has not installed it, not a server fault — but it is
        // still "could not answer", and the page needs to say which.
        return res.status(503).json({ error: result.reason, endpoint: OLLAMA_URL, model: OLLAMA_MODEL });
      }
      res.json({ response: result.response, model: result.model });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/workspace/test/generate', auth.middleware(), (req, res) => {
    const { file } = req.body;
    if (!file || typeof file !== 'string') return res.status(400).json({ error: 'File path required' });
    // The scaffold is confined to the caller's active project (and written
    // into its tests/), never OpenHub's own tree.
    const project = getActiveProject(getUser(req).sub);
    if (!project) return res.status(409).json({ error: 'Load a project before generating tests' });

    try {
      const result = generateTestScaffold(file, project.path);
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/workspace/test', auth.middleware(), async (req, res) => {
    try {
      const project = getActiveProject(getUser(req).sub);
      const output = await executeTests(project?.path);
      res.json({ output, timestamp: new Date().toISOString() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===================== HEALTH =====================

  app.get('/api/health', async (_req, res) => {
    // Axiom is the single execution engine: probe it so health reflects the
    // real downstream dependency. Never report "ok" for a dependency we
    // did not actually reach — surface degraded explicitly.
    let axiom: { reachable: boolean; status?: unknown; error?: string } = { reachable: false };
    try {
      const { getAxiomStatus } = await import('./src/services/axiomClient.js');
      const status = await getAxiomStatus();
      axiom = { reachable: true, status };
    } catch (err: any) {
      axiom = { reachable: false, error: err?.message || 'Axiom unreachable' };
    }
    res.json({
      status: axiom.reachable ? 'ok' : 'degraded',
      engine: 'axiom',
      axiom,
      timestamp: new Date().toISOString(),
    });
  });

  // ===================== ECOSYSTEM AWARENESS =====================

  // Fleet context for OpenHub + Axiom: ecosystem layer files, fleet catalog,
  // and .draymond brain-state inventory. Auth-gated; read-only.
  app.get('/api/ecosystem/context', auth.middleware(), (_req, res) => {
    try {
      const context = loadEcosystemContext();
      res.json(context);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load ecosystem context' });
    }
  });

  // ===================== INTERNAL MACHINE-TO-MACHINE SURFACE ====================
  // MUST be mounted BEFORE the first session-authed /api router below.
  //
  // Every /api router here calls `router.use(auth.middleware())` at the top of
  // its own router, and they are chained with app.use('/api', ...). Express runs
  // them in registration order, so the FIRST router's auth middleware is
  // effectively a global guard for all of /api: it rejects an unauthenticated
  // request with 403 and never calls next(), so any router mounted after it is
  // unreachable without a valid session JWT. That is why this surface has to be
  // registered here rather than beside the other audit routes.
  //
  // It guards itself with OPENHUB_INTERNAL_SECRET and is fail-closed when that
  // is unset — see src/routes/internalAuditRoutes.ts.
  app.use('/api', createInternalAuditRouter());

  // ===================== FLEET ROUTES (capabilities #3/#4/#5) =====================

  // Catalog browse + agent dispatch, Mission Control KPIs, and server-side AI
  // review — all auth-gated, mounted under /api.
  app.use('/api', createFleetAgentsRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createFleetKpisRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createAiReviewRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createSeoRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createCrmRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createGithubFleetRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createServicesLifecycleRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createFleetCapabilitiesRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createAxiomProxyRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createReceiptsRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createClosedLoopRouter({ authMiddleware: auth.middleware() }));
  // Machine-to-machine audit surface for Recourse's autopilot loop. Gated on
// OPENHUB_INTERNAL_SECRET (fail-closed when unset), NOT on a user session: a
// scheduled caller has no session and no active project, which is why it could
// not use /api/audit/run. See src/routes/internalAuditRoutes.ts.
// Machine-to-machine audit surface for Recourse's autopilot loop. Gated on
// OPENHUB_INTERNAL_SECRET (fail-closed when unset), NOT on a user session: a
// scheduled caller has no session and no active project, which is why it could
// not use /api/audit/run. Registered above, ahead of the session-authed /api
// routers, because the first of those effectively guards all of /api.
app.use('/api', createAuditRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createAuditCoreRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createTiersRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createRepairRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createPipelineRouter({ authMiddleware: auth.middleware() }));
  // Unattended Autopilot scheduler (Auto autonomy mode). Cheap when disabled;
  // fail-closed on the fleet kill switch. See services/pipelineAuto.ts.
  startPipelineAutoScheduler();
  app.use('/api', createEcosystemKnowledgeRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createEcosystemRegistryRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createProjectContextRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createWorkspaceToolsRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createIntelligenceRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createAgentRosterRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createSupervisorRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createResearchRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createRecourseRouter({ authMiddleware: auth.middleware() }));
  // Full OmniResearch capability proxy (research, harvest, DAG, MCP, marketing).
  app.use('/api', createOmniResearchRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createIncidentsRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createAlertsRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createEcosystemRepairRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createSystemSnapshotRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createSelfReportRouter({ authMiddleware: auth.middleware() }));
  app.use('/api', createDreamRouter({ authMiddleware: auth.middleware() }));
  // Unified telemetry, trends/insights, and the Recourse self-learning bridge.
  app.use('/api', createInsightsRouter({ authMiddleware: auth.middleware() }));
  // Autonomy heartbeat: self-awareness snapshot streamed to the UI.
  app.use('/api', createAutonomyRouter({ authMiddleware: auth.middleware() }));
  // Self-learning + Recourse-powered self-development.
  app.use('/api', createSelfLearnRouter({ authMiddleware: auth.middleware() }));

  // Developer Supertools: Snyk, CodeRabbit, and Postman replacements
  app.use('/api/vulns', createVulnerabilityRouter({ authMiddleware: auth.middleware() }));
  app.use('/api/review', createCodeReviewRouter({ authMiddleware: auth.middleware() }));
  app.use('/api/studio', createApiStudioRouter({ authMiddleware: auth.middleware() }));
  // Jev (System One) coding-decisions: review / repair / audit / workspace.
  // Vercel gateway primary, LocalJev fallback — see src/services/jevClient.ts.
  app.use('/api', createJevRouter({ authMiddleware: auth.middleware() }));
  // Fleet interconnect — OpenHub as the primary console: route decisions to
  // Axiom/Draymond/Recourse/Dev-Brain, feed outcomes into Recourse's learning.
  app.use('/api', createFleetInterconnectRouter({ authMiddleware: auth.middleware() }));
  // Tool teams — job type → minimal team set, per-team busy guard.
  app.use('/api', createToolTeamsRouter({ authMiddleware: auth.middleware() }));

  // ===================== LOCAL CHANNEL (ntfy-compatible) =====================
  // Open-Chat subscribes here (host `http://127.0.0.1:<port>/ntfy`); Draymond,
  // Hermes, and the deterministic report scheduler publish here.
  app.use('/ntfy', createNtfyRouter());

  // ===================== BOT CHAT (OpenAI-compatible) =====================
  // Open-Chat's generic HTTP protocol posts to /v1/chat/completions with a
  // static Bearer token (OPENHUB_CHAT_TOKEN). Mounted at the ROOT, not under
  // /api, so it bypasses the browser cookie+CSRF auth that a phone bot can't do.
  app.use('/', createChatCompletionsRouter());

  // ===================== VITE / STATIC =====================

  // Dev middleware only on an EXPLICIT development env: it serves source and
  // the project tree without auth, so an unset NODE_ENV must not enable it.
  if (process.env.NODE_ENV === 'development') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    if (!fs.existsSync(path.join(distPath, 'index.html'))) {
      console.warn('[Server] dist/ build not found. Run the build, or set NODE_ENV=development for the Vite dev server.');
    }
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Last-resort error handler (4 args so Express recognizes it). Without this,
  // a thrown async handler never produces a response and the socket hangs.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[Server] Route error:', redactForLog(err));
    if (res.headersSent) return;
    res.status(500).json({ error: 'Internal server error' });
  });

  // Background GitHub fleet repo sync: keep ncsound919 + tap919 state current.
  const runFleetSync = () => syncFleetRepos()
    .then((r) => console.log(`[Server] GitHub fleet sync: ${r.total} repos (${r.accounts.map((a) => `${a.owner}=${a.count}${a.error ? '!' : ''}`).join(', ')})`))
    .catch((e: any) => console.warn('[Server] GitHub fleet sync failed:', e?.message ?? e));
  runFleetSync();
  const fleetSyncTimer = setInterval(runFleetSync, 5 * 60 * 1000);
  if (typeof fleetSyncTimer.unref === 'function') fleetSyncTimer.unref();

  const httpServer = app.listen(PORT, HOST, () => {
    console.log(`[Server] OpenHub running on http://${HOST}:${PORT}`);
    if (HOST === '0.0.0.0') {
      console.warn('[Server] OPENHUB_HOST=0.0.0.0 — OpenHub is reachable from the network. Ensure it is behind an authenticated reverse proxy with TLS.');
    }
    console.log(`[Server] Repos root: ${REPOS_ROOT}`);
    console.log(`[Server] ${summarizeEcosystem(loadEcosystemContext())}`);
  });
  // Node's defaults are 300s requestTimeout / 60s headersTimeout. The audit
  // suite spawns many tools and legitimately runs longer than that on a real
  // repo (a first Aetherdesk run was killed at ~309s by the default
  // requestTimeout, surfacing to the caller as a bare "fetch failed" with the
  // server still healthy — a confusing failure with no server-side log).
  //
  // TRADEOFF, stated plainly: raising these lengthens how long a half-sent
  // request can occupy a socket, which is what the defaults protect against.
  // That exposure is why they are raised for the whole listener rather than
  // being tightened per-route: the audit surface is loopback/secret-gated, and
  // a genuine long-audit caller has no other way to be served. A caller that
  // must not block should use the async report + /api/audit/:id pattern
  // instead of holding a socket open.
  httpServer.requestTimeout = Number(process.env.OPENHUB_REQUEST_TIMEOUT_MS) || 45 * 60 * 1000;
  httpServer.headersTimeout = Number(process.env.OPENHUB_HEADERS_TIMEOUT_MS) || 60 * 1000;
  httpServer.setTimeout(Number(process.env.OPENHUB_SOCKET_TIMEOUT_MS) || 45 * 60 * 1000);

  const gateWarning = operatorGateWarning();
  if (gateWarning) console.warn(gateWarning);
  try {
    if (process.env.OPENHUB_DISABLE_TERMINAL === '1') {
      console.log('[Server] Terminal WebSocket disabled (OPENHUB_DISABLE_TERMINAL=1)');
    } else {
      attachTerminalSocket(httpServer, ACCESS_TOKEN_SECRET, userStore, allowedOrigins);
    }
  } catch (err: any) {
    console.warn('[Server] Terminal socket failed:', err?.message ?? err);
  }
}

startServer().then(() => {
  // Background "dream" monitor: analyze + grade every repo on an interval.
  startDreamLoop(Number(process.env.OPENHUB_DREAM_INTERVAL_MS || 120_000));
  // Autonomy heartbeat: probe services + recompute insights with no clicks.
  startAutonomy();
  // Self-report heartbeat: persist OpenHub's own status and push it to Recourse
  // memory so the autonomous system can wire into it (opt out with
  // OPENHUB_SELF_REPORT_INTERVAL_MS=0).
  if (process.env.OPENHUB_SELF_REPORT_INTERVAL_MS !== '0') {
    startSelfReportLoop();
  }
  // Hourly OpenHub self-report → Open-Chat (ntfy topic openhub-reports).
  if (process.env.OPENHUB_OPENCHAT_REPORT_ENABLED !== '0') {
    startOpenChatReportLoop();
  }
  // Security-alert bridge: tail Draymond's .draymond/security-alerts.jsonl and
  // report each envelope to the incident bus (webhooks + alerts channel).
  startAlertEngine();
});
