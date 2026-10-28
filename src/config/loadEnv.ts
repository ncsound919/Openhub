import { config } from 'dotenv';

/**
 * Environment loading for OpenHub.
 *
 * Imported for its side effect as the FIRST import of server.ts (ESM evaluates
 * imports in order, so this runs before any module that reads process.env at
 * module scope).
 *
 * Why not plain `dotenv/config`: dotenv never overrides a variable that already
 * exists, so a stale machine/user-level value silently masks the project's
 * configured one. That was a real failure — an old user-level GITHUB_TOKEN made
 * every GitHub call 401 while .env held a valid token, and the Integrations
 * panel reported the vault credential as revoked.
 *
 * Precedence:
 *   - Project `.env` wins over inherited machine/user environment (integrations
 *     are configured here).
 *   - A small set of runtime keys stays under the launcher's control, because
 *     scripts and deploys pin them immediately before start (`dev:test` sets
 *     PORT/WS_PORT/OPENHUB_DB_PATH, production sets NODE_ENV). Letting .env
 *     clobber those would silently move test and production servers.
 */

/** Keys scripts or deploys pin just before launching; never overridden by .env. */
const LAUNCHER_PINNED_KEYS = new Set([
  'PORT',
  'WS_PORT',
  'NODE_ENV',
  'OPENHUB_HOST',
  'OPENHUB_DB_PATH',
  'OPENHUB_TRUST_PROXY',
  // Scratch locations a test/smoke run points at its own copy of the workspace.
  'OPENHUB_REPOS_ROOT',
  'OPENHUB_ECOSYSTEM_ROOT',
  'OPENHUB_DRAYMOND_DIR',
]);

/** Variables present before .env was read — i.e. inherited from the machine. */
const inherited = { ...process.env };

// First pass: normal dotenv behaviour (fills anything not already set) and a
// parse of the file itself so the second pass can see every configured value.
const result = config({ quiet: true });
const fromEnvFile = result.parsed ?? {};

// Second pass: make the project config authoritative over stale inherited values.
for (const [key, value] of Object.entries(fromEnvFile)) {
  if (value === undefined) continue;
  if (LAUNCHER_PINNED_KEYS.has(key) && key in inherited) continue;
  process.env[key] = value;
}
