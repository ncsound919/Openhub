/**
 * Vitest global setup — make the suite hermetic against ambient configuration.
 *
 * The suite must pass the same way whether it is run from a bare shell (`npm
 * test`, no `.env` loaded) or as a child of the OpenHub server, which inherits
 * the server's `.env` (that is exactly what the audit's `local_qa` scorer and the
 * supervisor do). Several suites assert *default/unconfigured* behaviour —
 * "returns null when no API key is configured" — and the operator gate changes
 * behaviour when `OPENHUB_ADMIN_ROLES` is set. Inheriting the server's config
 * therefore flipped real assertions (18 tests failed) purely from ambient state.
 *
 * Tests that need a value set it themselves in `beforeAll`/`it`; those run after
 * this file. So the correct contract is: strip the app's runtime configuration
 * out of the environment before any test loads, and let each test opt in.
 *
 * Deliberately NOT stripped: `NODE_ENV`, `PATH`, and the vitest `test.env`
 * entries (`OPENHUB_DB_PATH`, `OPENHUB_RECEIPTS_DISABLE`) which are test infra.
 */

const AMBIENT_CONFIG_KEYS = [
  // Ecosystem / workspace roots
  'UPLIFT_ROOT',
  'OPENHUB_ECOSYSTEM_ROOT',
  'OPENHUB_ECOSYSTEM_ROOTS',
  'OPENHUB_DRAYMOND_DIR',
  'OPENHUB_BROWSE_ROOTS',
  'OPENHUB_REPOS_ROOT',
  'OPENHUB_EXTRA_REPO_ROOTS',
  'OPENHUB_SERVICE_ROOT',
  // Authz / lifecycle
  'OPENHUB_ADMIN_ROLES',
  'OPENHUB_ONDEMAND_SERVICES',
  'OPENHUB_INTERNAL_SECRET',
  'ACCESS_TOKEN_SECRET',
  'REFRESH_TOKEN_SECRET',
  // LLM routing
  'OPENHUB_LLM_BASE_URL',
  'OPENHUB_LLM_MODEL',
  'OPENHUB_LLM_KEY',
  'OPENHUB_LLM_FALLBACKS',
  'OPENHUB_LLM_FALLBACK_MODEL',
  'AUDIT_LLM_BASE_URL',
  'AUDIT_LLM_MODEL',
  'AUDIT_LLM_KEY',
  // Fleet peers + scorer endpoints/keys
  'RECOURSE_URL',
  'RECOURSE_API_SECRET',
  'REPORANK_URL',
  'REPORANK_API_KEY',
  'GRADER_URL',
  'GRADER_API_KEY',
  'CLAW_URL',
  'CLAW_PROTECT_SYSTEM_AGENT_KEY',
  'CODEGANG_URL',
  'CODEGANG_API_KEY',
  'DEEP_URL',
  'DEV_BRAIN_URL',
  'AXIOM_URL',
  'DRAYMOND_URL',
  'DRAYMOND_CRON_SECRET',
  'KEYWIRE_URL',
  'KEYWIRE_KEYS_FILE',
  'OMNI_RESEARCH_URL',
  // Channels
  'OPENHUB_CHAT_TOKEN',
  'OPENHUB_NTFY_TOKEN',
];

for (const key of AMBIENT_CONFIG_KEYS) {
  delete process.env[key];
}
