import fs from 'fs';
import express from 'express';
import { exec, execSync } from 'child_process';
import { loadFleetCatalog } from '../services/fleetCatalog';

/**
 * Fleet catalog browse + agent dispatch (capability #3).
 *
 *   GET  /ecosystem/agents?kind=&search=  → catalog snapshot with filters
 *   POST /ecosystem/agents/:name/run      → REAL gsd dispatch
 *
 * Both routes run behind `deps.authMiddleware` (`router.use`), the same
 * express middleware the rest of OpenHub uses (`auth.middleware()` in
 * server.ts); the auth user is read from `(req as any).user`, attached at
 * runtime by that middleware.
 *
 * Dispatch rules (binding): a dispatch is only ever attempted when a real
 * executable is mapped — `OPENHUB_GSD_CLI` if set, otherwise `gsd` resolved
 * via `where`/`which`. No executable → explicit HTTP 501, never a fake
 * dispatch. When mapped, `gsd <name> <repoPath>` runs through
 * `child_process.exec` (60s timeout) and the real output/duration is returned.
 */

/** Client/agent names are slugs from the catalog: alphanumeric + . _ - */
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Dispatch hard timeout (ms), per the gsd protocol. */
const DISPATCH_TIMEOUT_MS = 60_000;

/** Cap captured dispatch output so responses stay bounded. */
const MAX_OUTPUT_CHARS = 4000;

/**
 * Resolve the gsd dispatch executable, or null when none is mapped. An
 * explicitly configured OPENHUB_GSD_CLI is trusted as the operator's mapping;
 * otherwise the `gsd` binary is looked up on PATH via `where` (Windows) /
 * `which` (POSIX). Real lookup only — never a fabricated executable.
 */
export function resolveGsdCli(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.OPENHUB_GSD_CLI?.trim();
  if (explicit) return explicit;
  try {
    execSync(process.platform === 'win32' ? 'where gsd' : 'which gsd', { stdio: 'ignore' });
    return 'gsd';
  } catch {
    return null;
  }
}

/** Quote a single argument for the shell (cmd.exe / POSIX sh) exec runs. */
function quoteArg(arg: string): string {
  return arg.length === 0 ? '""' : `"${arg}"`;
}

interface GsdRunResult {
  ok: boolean;
  output: string;
  error: string | null;
  exitCode: number | null;
}

/** Run the dispatch command, capturing output; resolves, never rejects. */
function runGsd(command: string): Promise<GsdRunResult> {
  return new Promise((resolve) => {
    exec(
      command,
      { timeout: DISPATCH_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const output = `${String(stdout)}\n${String(stderr)}`.trim().slice(-MAX_OUTPUT_CHARS);
        if (error) {
          const code = (error as { code?: number | string }).code;
          resolve({
            ok: false,
            output,
            error: error.message || 'gsd dispatch failed',
            exitCode: typeof code === 'number' ? code : null,
          });
          return;
        }
        resolve({ ok: true, output, error: null, exitCode: null });
      },
    );
  });
}

/**
 * Auth-gated fleet catalog + dispatch router. Mount at `/api` (integrator:
 * server.ts), which yields `GET /api/ecosystem/agents` and
 * `POST /api/ecosystem/agents/:name/run`.
 */
export function createFleetAgentsRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  router.get('/ecosystem/agents', (req, res) => {
    try {
      const catalog = loadFleetCatalog();
      const requestedKind =
        typeof req.query.kind === 'string' ? req.query.kind.trim().toLowerCase() : '';
      const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';

      // Known kinds = union of Totals keys and asset kinds; an unknown kind is
      // an explicit client error, never a silent empty result.
      const knownKinds = new Set<string>([
        ...Object.keys(catalog.totals),
        ...catalog.assets.map((a) => a.kind),
      ]);
      if (requestedKind && !knownKinds.has(requestedKind)) {
        return res.status(400).json({ error: `Unknown agent kind "${requestedKind}"` });
      }

      const assets = catalog.assets.filter((a) => {
        if (requestedKind && a.kind !== requestedKind) return false;
        if (search) {
          const haystack = `${a.name} ${a.description} ${a.path ?? ''}`.toLowerCase();
          if (!haystack.includes(search)) return false;
        }
        return true;
      });

      res.json({
        path: catalog.path,
        source: catalog.source,
        totals: catalog.totals,
        ...(catalog.error !== undefined ? { error: catalog.error } : {}),
        assets,
        count: assets.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message || 'Failed to load fleet catalog' });
    }
  });

  router.post('/ecosystem/agents/:name/run', async (req, res) => {
    const start = Date.now();
    const name = String(req.params.name ?? '');
    try {
      // Reject anything outside the catalog's slug vocabulary before it can
      // reach a shell (defense against command injection via :name).
      if (!AGENT_NAME_PATTERN.test(name)) {
        return res.status(400).json({ error: `Invalid agent name "${name}"` });
      }

      const cli = resolveGsdCli();
      if (!cli) {
        return res.status(501).json({
          error: `No executable mapped for agent "${name}"; dispatch not implemented`,
        });
      }

      const body = (req.body ?? {}) as { repoPath?: unknown };
      const repoPath =
        typeof body.repoPath === 'string' && body.repoPath.trim() !== '' ? body.repoPath.trim() : null;

      if (repoPath !== null) {
        // Guard shell metacharacters that cmd.exe / sh evaluate even inside
        // quotes; explicit 400 instead of a silent mangled dispatch.
        if (/["%$`]/.test(repoPath)) {
          return res.status(400).json({
            error: `repoPath contains characters unsafe for shell dispatch: "${repoPath}"`,
          });
        }
        if (!fs.existsSync(repoPath)) {
          return res.status(400).json({ error: `repoPath does not exist: "${repoPath}"` });
        }
      }

      const command =
        repoPath === null
          ? `${quoteArg(cli)} ${quoteArg(name)}`
          : `${quoteArg(cli)} ${quoteArg(name)} ${quoteArg(repoPath)}`;
      const result = await runGsd(command);
      const durationMs = Date.now() - start;

      if (!result.ok) {
        return res.status(500).json({
          ok: false,
          name,
          error: result.error,
          output: result.output,
          durationMs,
          ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
        });
      }

      res.json({ ok: true, name, output: result.output, durationMs });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        ok: false,
        name,
        error: message || 'Agent dispatch failed',
        durationMs: Date.now() - start,
      });
    }
  });

  return router;
}