// One-shot: create (or reset) a local owner-role account for automation agents.
// Uses the server's own better-sqlite3 + bcryptjs, so it is safe while OpenHub runs.
// Credentials are written to data/agent-credentials.local.json (data/ is gitignored).
// Remove the account later with:  node scripts/create-agent-owner.mjs --delete
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.OPENHUB_DB_PATH || path.join(root, 'data', 'openhub.db');
const credPath = path.join(root, 'data', 'agent-credentials.local.json');
const email = 'claude-agent@openhub.local';
const username = 'claude-agent';

const db = new Database(dbPath);
db.pragma('busy_timeout = 5000');

if (process.argv.includes('--delete')) {
  const r = db.prepare('DELETE FROM users WHERE email = ?').run(email);
  try { fs.unlinkSync(credPath); } catch {}
  console.log(r.changes ? `deleted ${email}` : `${email} not found`);
  process.exit(0);
}

const password = 'Ag-' + crypto.randomBytes(18).toString('base64url') + '9!';
const hash = bcrypt.hashSync(password, 10);
const now = new Date().toISOString();
const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
if (existing) {
  db.prepare("UPDATE users SET password_hash = ?, role = 'owner', email_verified = 1, is_email_verified = 1, updated_at = ? WHERE id = ?")
    .run(hash, now, existing.id);
} else {
  db.prepare(`INSERT INTO users (id, username, email, password_hash, first_name, last_name, role, login_provider,
      provider_account_id, email_verified, is_totp_enabled, is_email_verified, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Claude', 'Agent', 'owner', 'local', NULL, 1, 0, 1, ?, ?)`)
    .run(crypto.randomUUID(), username, email, hash, now, now);
}
fs.mkdirSync(path.dirname(credPath), { recursive: true });
fs.writeFileSync(credPath, JSON.stringify({ email, password, role: 'owner', createdAt: now }, null, 2));
console.log(`${existing ? 'reset' : 'created'} owner account ${email}; credentials in ${credPath}`);
