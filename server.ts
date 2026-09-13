import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { spawn, type ChildProcess } from 'child_process';
import { execSync } from 'child_process';
import { initializeDatabase, getDb } from './src/auth/db.js';
import { v4 as uuidv4 } from 'uuid';
import { AuthConfigurator } from 'awesome-node-auth';
import { SQLiteUserStore } from './src/auth/ana-user-store.js';
import { fireWebhook } from './src/services/webhooks.js';
import {
  analyzeSystemAndFiles,
  detectTheaterAndMocks,
  generateTestScaffold,
  getDeployReadiness,
  executeTests,
} from './src/services/systemScanner.js';
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
} from './src/services/githubService.js';

interface AuthUser {
  sub: string;
  email: string;
  username?: string;
  role?: string;
}

function getUser(req: express.Request): AuthUser {
  return req.user as unknown as AuthUser;
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

let mcpProcess: ChildProcess | null = null;
let orchestratorWSS: any = null;

function launchMCP() {
  try {
    const pythonPath = process.platform === 'win32' ? 'python' : 'python3';
    console.log(`[Server] Launching MCP server: ${pythonPath} -m vibeserve`);

    mcpProcess = spawn(pythonPath, ['-m', 'vibeserve'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, PYTHONPATH: path.join(__dirname, 'vibeserve') },
    });

    mcpProcess.on('exit', (code) => {
      console.log(`[Server] MCP server exited with code ${code}`);
      mcpProcess = null;
    });

    mcpProcess.on('error', (err) => {
      console.error('[Server] Failed to start MCP server:', err.message);
      mcpProcess = null;
    });
  } catch (err: any) {
    console.warn('[Server] MCP server not available (Python not found?):', err.message);
  }
}

async function launchOrchestrator() {
  try {
    const { WSServer } = await import('./orchestrator/ws-server.js');
    const wsPort = parseInt(process.env.WS_PORT || '3001', 10);
    orchestratorWSS = new WSServer(wsPort);
    console.log(`[Server] Orchestrator WebSocket started on port ${wsPort}`);
  } catch (err: any) {
    console.warn('[Server] Orchestrator not available:', err.message);
  }
}

async function startServer() {
  initializeDatabase();

  const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'openhub-dev-access-token-secret-min-32-chars';
  const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'openhub-dev-refresh-token-secret-min-32-chars';

  const userStore = new SQLiteUserStore();
  const auth = new AuthConfigurator({
    accessTokenSecret: ACCESS_TOKEN_SECRET,
    refreshTokenSecret: REFRESH_TOKEN_SECRET,
    accessTokenExpiresIn: '15m',
    refreshTokenExpiresIn: '7d',
    cookieOptions: {
      sameSite: 'lax',
    },
    csrf: { enabled: true },
    emailVerificationMode: 'none',
    buildTokenPayload: (user) => {
      return {
        username: user.firstName || user.email?.split('@')[0] || 'user',
        avatarUrl: null,
      };
    },
  }, userStore);

  const app = express();
  app.set('trust proxy', 1);
  const PORT = parseInt(process.env.PORT || '3000', 10);

  app.use(helmet({
    contentSecurityPolicy: false,
    frameguard: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
  }));

  app.use(express.json({ limit: '50mb' }));

  // CORS for local development and iframe preview
  app.use((_req, res, next) => {
    const origin = _req.headers.origin;
    if (origin) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
    } else {
      res.header('Access-Control-Allow-Origin', '*');
    }
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token, X-Auth-Strategy, X-Requested-With');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (_req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // Ensure default dev users exist for seamless testing
  const seedAccounts = [
    { email: 'dev@openhub.local', username: 'developer', firstName: 'OpenHub', lastName: 'Developer' },
    { email: 'tap4500@gmail.com', username: 'tap4500', firstName: 'OpenHub', lastName: 'Admin' },
  ];

  for (const account of seedAccounts) {
    try {
      const db = getDb();
      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(account.email);
      if (!existing) {
        const hash = await auth.passwordService.hash('password123');
        await userStore.create({
          email: account.email,
          password: hash,
          username: account.username,
          firstName: account.firstName,
          lastName: account.lastName,
        });
        console.log(`[Server] Seeded default account: ${account.email} / password123`);
      }
    } catch (err: any) {
      console.warn(`[Server] Note on seed for ${account.email}:`, err.message);
    }
  }

  // ===================== AUTH ROUTES =====================

  // Direct quick-access / demo login endpoint (guarantees instantaneous access in iframe)
  app.post('/api/auth/quick-access', async (req, res) => {
    try {
      const targetEmail = req.body?.email || 'dev@openhub.local';
      let user = await userStore.findByEmail(targetEmail);
      if (!user) {
        const hash = await auth.passwordService.hash('password123');
        user = await userStore.create({
          email: targetEmail,
          password: hash,
          username: targetEmail.split('@')[0],
          firstName: 'OpenHub',
          lastName: 'Developer',
        });
      }

      const payload = {
        sub: user.id,
        email: user.email,
        loginProvider: 'local',
        isEmailVerified: true,
        isTotpEnabled: false,
        username: (user as any).username || user.firstName || user.email.split('@')[0],
        avatarUrl: null,
      };

      const tokens = auth.tokenService.generateTokenPair(payload, (auth as any).config);
      const refreshExpiryMs = 7 * 24 * 60 * 60 * 1000;
      await userStore.updateRefreshToken(user.id, tokens.refreshToken, new Date(Date.now() + refreshExpiryMs));

      res.json({
        success: true,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: payload,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Quick access failed' });
    }
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

  // ===================== REPOSITORIES =====================

  app.get('/api/repos', auth.middleware(), (req, res) => {
    const db = getDb();
    const { page, limit } = getPaginationParams(req);
    const repos = db.prepare(`
      SELECT r.*, u.username as owner_name
      FROM repositories r
      JOIN users u ON r.owner_id = u.id
      WHERE r.owner_id = ?
      ORDER BY r.updated_at DESC
    `).all(getUser(req).sub);
    res.json(paginate(repos, page, limit));
  });

  app.post('/api/repos', auth.middleware(), (req, res) => {
    const db = getDb();

    const { name, description, isPrivate } = req.body;
    if (!name) return res.status(400).json({ error: 'Repository name required' });

    const id = uuidv4();
    const user = req.user as unknown as AuthUser;
    const ownerDir = path.join(REPOS_ROOT, user.username);
    const fullPath = path.join(ownerDir, name);

    if (fs.existsSync(fullPath)) {
      return res.status(409).json({ error: 'Repository already exists' });
    }

    fs.mkdirSync(fullPath, { recursive: true });

    try {
      execSync('git init', { cwd: fullPath, stdio: 'ignore' });
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

  app.get('/api/repos/:owner/:repoName/contents', (req, res) => {
    const { owner, repoName } = req.params;
    const repoPath = path.join(REPOS_ROOT, owner, repoName);

    if (!fs.existsSync(repoPath)) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    const subPath = req.query.path as string || '';
    const fullPath = path.join(repoPath, subPath);

    if (!fullPath.startsWith(repoPath)) {
      return res.status(403).json({ error: 'Path traversal denied' });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Path not found' });
    }

    const stat = fs.statSync(fullPath);
    if (stat.isFile()) {
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
    const repoPath = path.join(REPOS_ROOT, owner, repoName);
    const fullPath = path.join(repoPath, filePath);

    if (!fullPath.startsWith(repoPath)) {
      return res.status(403).json({ error: 'Path traversal denied' });
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

  // 1. OAuth URL Generation
  app.get('/api/github/auth-url', auth.middleware(), (req, res) => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const redirectUri = `${appUrl}/api/github/callback`;
    const state = getUser(req).sub;
    const scopes = 'repo,read:user,user:email,workflow,admin:repo_hook';

    if (!clientId) {
      return res.json({
        configured: false,
        message: 'GITHUB_CLIENT_ID is not configured. Connect directly using a GitHub Personal Access Token (PAT).',
        redirectUri,
      });
    }

    const authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(state)}`;
    res.json({ configured: true, url: authUrl, redirectUri });
  });

  // 2. OAuth Callback
  app.get(['/api/github/callback', '/api/github/callback/'], async (req, res) => {
    const { code, state: userId } = req.query;
    if (!code) {
      return res.status(400).send('OAuth callback missing authorization code');
    }

    try {
      const clientId = process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw new Error('GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET not configured');
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
      const targetUserId = (userId as string) || 'dev@openhub.local';
      saveGitHubIntegration(targetUserId, accessToken, profile, tokenData.scope);

      res.send(`
        <!DOCTYPE html>
        <html>
          <head><title>GitHub Connected</title></head>
          <body style="font-family:sans-serif;text-align:center;padding:40px;background:#0A0C10;color:#fff;">
            <h2 style="color:#58a6ff;">GitHub Connected Successfully!</h2>
            <p>Authenticated as @${profile.login}. You may close this window.</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'GITHUB_AUTH_SUCCESS', user: ${JSON.stringify(profile.login)} }, '*');
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

  // 4. Connection Status
  app.get('/api/github/status', auth.middleware(), async (req, res) => {
    const user = getUser(req);
    const integration = getGitHubIntegration(user.sub);
    if (!integration) {
      return res.json({ connected: false });
    }
    try {
      const profile = await verifyAndFetchGitHubProfile(integration.accessToken);
      res.json({
        connected: true,
        user: profile,
        scope: integration.scope,
        updatedAt: integration.updatedAt,
      });
    } catch {
      res.json({
        connected: false,
        error: 'Token expired or revoked. Please reconnect your GitHub account.',
      });
    }
  });

  // 5. Disconnect GitHub
  app.post('/api/github/disconnect', auth.middleware(), (req, res) => {
    const user = getUser(req);
    removeGitHubIntegration(user.sub);
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
  app.get('/api/github/repos/:owner/:repo/issues', auth.middleware(), async (req, res) => {
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

  app.post('/api/github/repos/:owner/:repo/issues', auth.middleware(), async (req, res) => {
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
  app.get('/api/github/repos/:owner/:repo/pulls', auth.middleware(), async (req, res) => {
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
  app.get('/api/github/repos/:owner/:repo/actions/workflows', auth.middleware(), async (req, res) => {
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

  app.get('/api/github/repos/:owner/:repo/actions/runs', auth.middleware(), async (req, res) => {
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

  app.post('/api/github/repos/:owner/:repo/actions/workflows/:workflowId/dispatches', auth.middleware(), async (req, res) => {
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

  // 12. GitHub Webhook Receiver
  app.post('/api/github/webhook', express.json({ type: '*/*' }), (req, res) => {
    const event = (req.headers['x-github-event'] as string) || 'ping';
    const payload = req.body;
    const signature = req.headers['x-hub-signature-256'] as string;

    const recorded = recordGitHubWebhookEvent(event, payload, Boolean(signature));
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

  // 13. GitHub Webhook Events & Simulator
  app.get('/api/github/webhook/events', auth.middleware(), (req, res) => {
    const events = getGitHubWebhookEvents(50);
    res.json({ events });
  });

  app.post('/api/github/webhook/test-ping', auth.middleware(), (req, res) => {
    const { event = 'push', repoFullName = 'openhub/core-engine' } = req.body;
    const user = getUser(req);
    const samplePayload = {
      action: 'created',
      repository: { full_name: repoFullName, html_url: `https://github.com/${repoFullName}` },
      sender: { login: user.username || 'developer', avatar_url: 'https://github.com/ghost.png' },
      pusher: { name: user.username || 'developer' },
      head_commit: {
        id: Math.random().toString(36).substring(2, 10),
        message: 'feat: deep integration simulation event',
        timestamp: new Date().toISOString(),
      },
    };

    const recorded = recordGitHubWebhookEvent(event, samplePayload, true);
    res.json({ success: true, event, recorded, payload: samplePayload });
  });

  // ===================== FILE WATCH / SCAN =====================

  app.post('/api/scan', auth.middleware(), (req, res) => {
    const { content, fileName } = req.body;
    const patterns = [
      { name: 'AWS Key', regex: /AKIA[0-9A-Z]{16}/g },
      { name: 'Generic Token', regex: /token:[a-zA-Z0-9-._~+/]{20,}/g },
      { name: 'Private Key', regex: /-----BEGIN RSA PRIVATE KEY-----/g },
      { name: 'Firebase Config', regex: /apiKey:\s*"[a-zA-Z0-9-_]{39}"/g },
      { name: 'GitHub Token', regex: /ghp_[a-zA-Z0-9]{36}/g },
    ];

    const findings: any[] = [];
    const lines = (content || '').split('\n');

    patterns.forEach((p) => {
      let match;
      while ((match = p.regex.exec(content)) !== null) {
        const lineNum = lines.findIndex((l) => l.includes(match![0])) + 1;
        findings.push({
          id: Math.random().toString(36).substring(2, 11),
          type: 'Secret',
          severity: 'CRITICAL',
          title: `Detected ${p.name}`,
          file: fileName,
          line: lineNum || 0,
          description: `A potential ${p.name} was found in source code.`,
          status: 'open',
        });
      }
    });

    res.json({ findings });
  });

  // ===================== PIPELINE / ACTIONS =====================

  let pipelineRuns: Record<string, any> = {};

  const FAST_PIPELINE = process.env.E2E_FAST_PIPELINE === '1';
  const STAGE_DELAYS = FAST_PIPELINE ? [0.5, 1.0, 1.5, 2.0] : [8, 20, 30, 35];

  app.post('/api/pipeline/run', auth.middleware(), async (req, res) => {
    const { repoId, commitMessage, workflow } = req.body;
    const runId = `run-${Math.random().toString(36).substring(2, 11)}`;

    pipelineRuns[runId] = {
      id: runId,
      repoId,
      workflowName: workflow?.name || 'Dynamic CI Pipeline',
      status: 'running',
      startTime: Date.now(),
      commitMessage: commitMessage || 'Local push',
      author: req.user as unknown as AuthUser,
      createdAt: new Date().toISOString(),
      stages: [
        { id: 's1', name: 'Checkout', status: 'success', duration: '0.5s' },
        { id: 's2', name: 'Secret Scan', status: 'success', duration: '1.2s' },
        { id: 's3', name: 'Lint & Typecheck', status: 'running' },
        { id: 's4', name: 'AI Code Review', status: 'pending' },
        { id: 's5', name: 'Build', status: 'pending' },
        { id: 's6', name: 'Artifact Signing', status: 'pending' },
      ],
      gates: [
        { id: 'g1', name: 'Code Coverage', status: 'passed', value: '--', threshold: '> 80%' },
        { id: 'g2', name: 'Critical CVEs', status: 'passed', value: '0', threshold: '0' },
        { id: 'g3', name: 'Bundle Size', status: 'passed', value: '--', threshold: '< 1MB' },
      ],
      findings: [],
    };

    if (orchestratorWSS) {
      orchestratorWSS.broadcast({
        type: 'PIPELINE_EVENT',
        phase: 'init',
        status: 'started',
        data: { runId, repoId, commitMessage },
      });
    }

    const keys = Object.keys(pipelineRuns);
    if (keys.length > 50) {
      const oldest = keys.reduce((a, b) => pipelineRuns[a].startTime < pipelineRuns[b].startTime ? a : b);
      delete pipelineRuns[oldest];
    }

    res.json({ runId });
  });

  app.get('/api/pipeline/status/:runId', auth.middleware(), (req, res) => {
    const run = pipelineRuns[req.params.runId];
    if (!run) return res.status(404).json({ error: 'Pipeline run not found' });

    const elapsed = (Date.now() - run.startTime) / 1000;
    const stages = run.stages;

    if (elapsed > STAGE_DELAYS[0] && stages[2].status === 'running') {
      stages[2].status = 'success';
      stages[2].duration = FAST_PIPELINE ? '0.4s' : '8.2s';
      stages[3].status = 'running';
    }
    if (elapsed > STAGE_DELAYS[1] && stages[3].status === 'running') {
      stages[3].status = 'success';
      stages[3].duration = FAST_PIPELINE ? '0.4s' : '14.1s';
      stages[4].status = 'running';
    }
    if (elapsed > STAGE_DELAYS[2] && stages[4].status === 'running') {
      stages[4].status = 'success';
      stages[4].duration = FAST_PIPELINE ? '0.4s' : '4.5s';
      stages[5].status = 'running';
    }
    if (elapsed > STAGE_DELAYS[3] && stages[5].status === 'running') {
      stages[5].status = 'success';
      stages[5].duration = FAST_PIPELINE ? '0.3s' : '1.1s';
      run.status = 'success';

      if (run.author?.sub) {
        fireWebhook(run.author.sub, 'pipeline.completed', {
          runId: run.id,
          repoId: run.repoId,
          status: 'success',
          duration: elapsed + 's',
        }).catch(() => {});
      }
    }

    res.json(run);
  });

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
      INSERT INTO registry_items (id, name, type, description, status, author, version, config)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(id, name, type || 'cli', description || '', author || getUser(req).username, version || '0.1.0', JSON.stringify(config || {}));

    const item = db.prepare('SELECT * FROM registry_items WHERE id = ?').get(id);
    res.json(item);
  });

  app.patch('/api/registry/:id', auth.middleware(), (req, res) => {
    const db = getDb();
    const { status, config } = req.body;

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
      await fireWebhook(getUser(req).sub, 'webhook.test', { message: 'Test webhook from OpenHub' });
      res.json({ success: true, message: 'Test webhook fired' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===================== WORKSPACE TESTING & READINESS =====================

  app.get('/api/workspace/deploy-readiness', async (_req, res) => {
    try {
      const readiness = await getDeployReadiness();
      res.json(readiness);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/workspace/theater-scan', (_req, res) => {
    try {
      const scan = detectTheaterAndMocks();
      res.json(scan);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/workspace/test/candidates', (_req, res) => {
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

  app.get('/api/workspace/system-analysis', (_req, res) => {
    try {
      const analysis = analyzeSystemAndFiles();
      res.json(analysis);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/workspace/test/generate', (req, res) => {
    const { file } = req.body;
    if (!file) return res.status(400).json({ error: 'File path required' });

    try {
      const result = generateTestScaffold(file);
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/workspace/test', (_req, res) => {
    try {
      const output = executeTests();
      res.json({ output, timestamp: new Date().toISOString() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===================== MCP PROXY =====================

  const mcpPending = new Map<string, (data: any) => void>();

  if (mcpProcess?.stdout) {
    const rl = (await import('readline')).createInterface({ input: mcpProcess.stdout! });
    rl.on('line', (line: string) => {
      try {
        const response = JSON.parse(line);
        if (response.id !== undefined) {
          const resolve = mcpPending.get(String(response.id));
          if (resolve) {
            mcpPending.delete(String(response.id));
            resolve(response.result || response.error || response);
          }
        }
      } catch { /* partial line */ }
    });
  }

  app.post('/api/mcp/:tool', auth.middleware(), async (req, res) => {
    if (!mcpProcess || !mcpProcess.stdin) {
      return res.status(503).json({ error: 'MCP server not running' });
    }

    try {
      const requestId = String(Date.now()) + Math.random().toString(36).substring(2, 7);
      const request = {
        jsonrpc: '2.0',
        method: 'call_tool',
        params: { name: req.params.tool, arguments: req.body },
        id: requestId,
      };

      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          mcpPending.delete(requestId);
          reject(new Error('MCP call timed out'));
        }, 120000);

        mcpPending.set(requestId, (data: any) => {
          clearTimeout(timer);
          resolve(data);
        });

        try {
          mcpProcess!.stdin!.write(JSON.stringify(request) + '\n');
        } catch (e) {
          clearTimeout(timer);
          mcpPending.delete(requestId);
          reject(e);
        }
      });

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'MCP call failed' });
    }
  });

  // ===================== HEALTH =====================

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      mcp: mcpProcess?.pid ? 'running' : 'stopped',
      orchestrator: orchestratorWSS ? 'running' : 'stopped',
      timestamp: new Date().toISOString(),
    });
  });

  // ===================== VITE / STATIC =====================

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] OpenHub running on http://localhost:${PORT}`);
    console.log(`[Server] Repos root: ${REPOS_ROOT}`);
  });
}

startServer().then(() => {
  launchMCP();
  launchOrchestrator();
});
