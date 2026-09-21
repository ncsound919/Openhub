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
  `);

  migrateUsersTable(db);

  console.log('[DB] Database initialized at', dbPath());
}

/** Additive, idempotent column migrations (SQLite has no ADD COLUMN IF NOT
 *  EXISTS). `active` supports SCIM deprovisioning; default 1 keeps existing
 *  users enabled. */
function migrateUsersTable(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  const has = (name: string) => cols.some((c) => c.name === name);
  if (!has('active')) db.exec('ALTER TABLE users ADD COLUMN active INTEGER DEFAULT 1');
  if (!has('updated_by')) db.exec('ALTER TABLE users ADD COLUMN updated_by TEXT');
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
