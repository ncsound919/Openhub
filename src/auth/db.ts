import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolve the DB path, honoring an env override (used by tests for hermetic DBs). */
function dbPath(): string {
  return process.env.OPENHUB_DB_PATH || path.join(__dirname, '..', '..', 'data', 'openhub.db');
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const pathToDb = dbPath();
    const dir = path.dirname(pathToDb);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(pathToDb);
    db.pragma('journal_mode = WAL');
    // Without this, any second process holding the same file -- the repo status
    // ledger, which runs on a cron -- makes writes fail immediately with
    // "database is locked" instead of waiting. That surfaced as an unhandled
    // rejection that killed the server, which looks like a crash in the sampler
    // but is the opposite: the sampler was fine and the server was the victim.
    db.pragma('busy_timeout = 10000');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export function initializeDatabase() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      avatar_url TEXT,
      first_name TEXT,
      last_name TEXT,
      email_verified INTEGER DEFAULT 0,
      role TEXT,
      login_provider TEXT DEFAULT 'local',
      provider_account_id TEXT,
      refresh_token TEXT,
      refresh_expires TEXT,
      totp_secret TEXT,
      is_totp_enabled INTEGER DEFAULT 0,
      is_email_verified INTEGER DEFAULT 0,
      magic_link_token TEXT,
      magic_link_expires TEXT,
      reset_token TEXT,
      reset_expires TEXT,
      sms_code TEXT,
      sms_expires TEXT,
      phone_number TEXT,
      require_2fa INTEGER DEFAULT 0,
      last_login TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ssh_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      public_key TEXT NOT NULL,
      fingerprint TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      full_path TEXT NOT NULL UNIQUE,
      is_private INTEGER DEFAULT 0,
      default_branch TEXT DEFAULT 'main',
      language TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      repo_id TEXT,
      action TEXT NOT NULL,
      details TEXT,
      ip TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS registry_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'cli',
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      author TEXT DEFAULT '',
      version TEXT DEFAULT '0.1.0',
      config TEXT,
      last_run TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mcp_tool_config (
      id TEXT PRIMARY KEY,
      tool_name TEXT UNIQUE NOT NULL,
      enabled INTEGER DEFAULT 1,
      config TEXT DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pipeline_presets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      steps TEXT NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT,
      events TEXT NOT NULL DEFAULT '[]',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS github_integrations (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL,
      access_token TEXT NOT NULL,
      token_type TEXT DEFAULT 'bearer',
      scope TEXT,
      github_username TEXT,
      github_id TEXT,
      github_avatar TEXT,
      github_email TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS github_synced_repos (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      local_repo_id TEXT,
      github_repo_id INTEGER,
      github_full_name TEXT NOT NULL,
      github_owner TEXT NOT NULL,
      github_name TEXT NOT NULL,
      default_branch TEXT DEFAULT 'main',
      last_synced_at TEXT,
      sync_status TEXT DEFAULT 'synced',
      auto_sync INTEGER DEFAULT 1,
      webhook_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS github_webhook_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      repo_full_name TEXT,
      sender TEXT,
      action TEXT,
      summary TEXT,
      payload TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS github_repo_index (
      full_name TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'public',
      archived INTEGER NOT NULL DEFAULT 0,
      fork INTEGER NOT NULL DEFAULT 0,
      pushed_at TEXT,
      updated_at TEXT,
      description TEXT,
      language TEXT,
      default_branch TEXT,
      open_issues INTEGER NOT NULL DEFAULT 0,
      stargazers INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS notification_prefs (
      user_id TEXT PRIMARY KEY,
      prefs TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dream_state (
      repo_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'unanalyzed',
      purpose TEXT NOT NULL DEFAULT '',
      development TEXT NOT NULL DEFAULT 'inactive',
      grade TEXT,
      score REAL,
      findings INTEGER DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '',
      last_analyzed_at TEXT,
      FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    -- Observed state of each repo at a point in time. One row per repo, overwritten
    -- in place, so it always answers "what is it right now". history lives in
    -- repo_status_events below. health is derived by the observer, never asserted by
    -- the caller, and health_reason is stored alongside it so a row can never say
    -- "at-risk" without carrying the count that made it at-risk.
    CREATE TABLE IF NOT EXISTS repo_status (
      repo_id TEXT PRIMARY KEY,
      branch TEXT,
      head_sha TEXT,
      dirty_count INTEGER,
      has_remote INTEGER NOT NULL DEFAULT 0,
      remote_url TEXT,
      last_commit_at TEXT,
      subject TEXT,
      health TEXT NOT NULL DEFAULT 'unobserved',
      health_reason TEXT NOT NULL DEFAULT 'never observed',
      observed_at TEXT NOT NULL,
      FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    -- Append-only. A row is written only when a WATCHED field actually changed, so an
    -- unchanged tree appends nothing and the table stays a real change log rather
    -- than a heartbeat that records every run as a diff.
    CREATE TABLE IF NOT EXISTS repo_status_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      note TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
    );
  `);

  // Every hot lookup below was a full table scan.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_user      ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires   ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_ssh_keys_user      ON ssh_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_repositories_owner ON repositories(owner_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_user    ON audit_logs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_synced_repos_user  ON github_synced_repos(user_id);
    CREATE INDEX IF NOT EXISTS idx_webhooks_user      ON webhooks(user_id);
    CREATE INDEX IF NOT EXISTS idx_repo_status_health ON repo_status(health);
    CREATE INDEX IF NOT EXISTS idx_repo_events_repo   ON repo_status_events(repo_id, id DESC);
  `);

  migrateUsersTable(db);
  migrateRepoStatusTables(db);

  console.log('[DB] Database initialized at', dbPath());
}

/** The status ledger was first created by repo-status-ledger.mjs, which picked
 *  its own column names. `CREATE TABLE IF NOT EXISTS` is then a no-op against
 *  that legacy shape, so the canonical columns have to be added by hand or the
 *  read routes fail with "no such column" on any database that already has the
 *  ledger. Legacy duplicates (full_path/name, last_commit_subj, at) are kept:
 *  dropping them would discard the only rows the ledger has.
 *
 *  This is the whole class of bug in one function -- a schema created outside
 *  the migration file means the migration file's version of it is never
 *  exercised, so nothing notices the two disagree. */
function migrateRepoStatusTables(db: Database.Database): void {
  const cols = (t: string) => db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>;
  const has = (t: string, name: string) => cols(t).some((c) => c.name === name);
  const add = (t: string, name: string, decl: string) => {
    if (!has(t, name)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${name} ${decl}`);
  };

  add('repo_status', 'branch', 'TEXT');
  add('repo_status', 'head_sha', 'TEXT');
  add('repo_status', 'dirty_count', 'INTEGER');
  add('repo_status', 'has_remote', 'INTEGER NOT NULL DEFAULT 0');
  add('repo_status', 'remote_url', 'TEXT');
  add('repo_status', 'last_commit_at', 'TEXT');
  add('repo_status', 'subject', 'TEXT');
  add('repo_status', 'health', "TEXT NOT NULL DEFAULT 'unobserved'");
  add('repo_status', 'health_reason', "TEXT NOT NULL DEFAULT 'never observed'");
  add('repo_status', 'observed_at', 'TEXT');
  // Backfill from the legacy columns so a migrated row keeps its measurement
  // instead of reporting "unobserved" until the next sample. Guarded on the
  // legacy column, not on the new one: `subject` was just added above, so
  // testing it here is always true and the backfill never runs.
  if (has('repo_status', 'last_commit_subj')) {
    db.exec('UPDATE repo_status SET subject = last_commit_subj WHERE subject IS NULL');
  }
  db.exec("UPDATE repo_status SET observed_at = datetime('now') WHERE observed_at IS NULL");

  add('repo_status_events', 'observed_at', 'TEXT');
  add('repo_status_events', 'field', "TEXT NOT NULL DEFAULT ''");
  add('repo_status_events', 'old_value', 'TEXT');
  add('repo_status_events', 'new_value', 'TEXT');
  add('repo_status_events', 'note', "TEXT NOT NULL DEFAULT ''");
  if (has('repo_status_events', 'at')) {
    db.exec('UPDATE repo_status_events SET observed_at = at WHERE observed_at IS NULL');
  }
  db.exec("UPDATE repo_status_events SET observed_at = datetime('now') WHERE observed_at IS NULL");

  // health NOT NULL DEFAULT keeps a row readable; a null health would break the
  // UI's bucketing, which treats anything not in {ok,dirty,at-risk,unbacked-up,
  // unreadable} as unobserved.
  db.exec("UPDATE repo_status SET health = 'unobserved' WHERE health IS NULL OR health = ''");
  db.exec("UPDATE repo_status SET health_reason = 'never observed' WHERE health_reason IS NULL OR health_reason = ''");
}

/** Additive, idempotent column migrations (SQLite has no ADD COLUMN IF NOT
 *  EXISTS). `active` supports SCIM deprovisioning; default 1 keeps existing
 *  users enabled. */
function migrateUsersTable(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  const has = (name: string) => cols.some((c) => c.name === name);
  if (!has('active')) db.exec('ALTER TABLE users ADD COLUMN active INTEGER DEFAULT 1');
  if (!has('updated_by')) db.exec('ALTER TABLE users ADD COLUMN updated_by TEXT');

  // Registry items are owner-scoped for edits (audit 2026-09-23). Legacy rows
  // keep owner_id NULL; see PATCH /api/registry/:id for how those are treated.
  const regCols = db.prepare('PRAGMA table_info(registry_items)').all() as Array<{ name: string }>;
  if (!regCols.some((c) => c.name === 'owner_id')) db.exec('ALTER TABLE registry_items ADD COLUMN owner_id TEXT');
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
