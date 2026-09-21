import {
  IUserStore,
  BaseUser,
  AuthError,
} from 'awesome-node-auth';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db.js';

interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string | null;
  avatar_url: string | null;
  first_name: string | null;
  last_name: string | null;
  email_verified: number;
  role: string | null;
  login_provider: string | null;
  provider_account_id: string | null;
  refresh_token: string | null;
  refresh_expires: string | null;
  totp_secret: string | null;
  is_totp_enabled: number;
  is_email_verified: number;
  magic_link_token: string | null;
  magic_link_expires: string | null;
  reset_token: string | null;
  reset_expires: string | null;
  sms_code: string | null;
  sms_expires: string | null;
  phone_number: string | null;
  require_2fa: number;
  last_login: string | null;
  created_at: string;
  updated_at: string;
}

function rowToBaseUser(row: UserRow): BaseUser & { username?: string } {
  return {
    id: row.id,
    email: row.email,
    password: row.password_hash || undefined,
    username: row.username,
    firstName: row.first_name,
    lastName: row.last_name,
    role: row.role || undefined,
    loginProvider: row.login_provider || undefined,
    providerAccountId: row.provider_account_id || undefined,
    refreshToken: row.refresh_token || undefined,
    refreshTokenExpiry: row.refresh_expires ? new Date(row.refresh_expires) : undefined,
    totpSecret: row.totp_secret || undefined,
    isTotpEnabled: row.is_totp_enabled === 1,
    isEmailVerified: row.is_email_verified === 1,
    magicLinkToken: row.magic_link_token || undefined,
    magicLinkTokenExpiry: row.magic_link_expires ? new Date(row.magic_link_expires) : undefined,
    resetToken: row.reset_token || undefined,
    resetTokenExpiry: row.reset_expires ? new Date(row.reset_expires) : undefined,
    smsCode: row.sms_code || undefined,
    smsCodeExpiry: row.sms_expires ? new Date(row.sms_expires) : undefined,
    phoneNumber: row.phone_number || undefined,
    require2FA: row.require_2fa === 1,
    lastLogin: row.last_login ? new Date(row.last_login) : undefined,
  };
}

export class SQLiteUserStore implements IUserStore {
  async findByEmail(email: string): Promise<BaseUser | null> {
    const db = getDb();
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
    return row ? rowToBaseUser(row) : null;
  }

  async findByUsername(username: string): Promise<BaseUser | null> {
    const db = getDb();
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
    return row ? rowToBaseUser(row) : null;
  }

  async findById(id: string): Promise<BaseUser | null> {
    const db = getDb();
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? rowToBaseUser(row) : null;
  }

  async create(data: Partial<BaseUser> & { username?: string }): Promise<BaseUser> {
    if (!data.email) {
      throw new AuthError('Email is required to create a user', 'EMAIL_REQUIRED', 400);
    }
    const db = getDb();
    const username = (data as any).username || data.email.split('@')[0];

    // Duplicate accounts must surface as a clean 409 the client can show —
    // NOT as a raw UNIQUE constraint that the auth router turns into a 500.
    const emailTaken = db.prepare('SELECT id FROM users WHERE email = ?').get(data.email);
    if (emailTaken) {
      throw new AuthError('An account with this email already exists. Sign in instead.', 'EMAIL_EXISTS', 409);
    }
    const usernameTaken = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (usernameTaken) {
      throw new AuthError('That username is already taken.', 'USERNAME_TAKEN', 409);
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    try {
      db.prepare(`
        INSERT INTO users (
          id, username, email, password_hash,
          first_name, last_name, role, login_provider, provider_account_id,
          email_verified, is_totp_enabled, is_email_verified,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 1, ?, ?)
      `).run(
        id,
        username,
        data.email,
        data.password || null,
        data.firstName || null,
        data.lastName || null,
        data.role || null,
        data.loginProvider || 'local',
        data.providerAccountId || null,
        now,
        now
      );
    } catch (err: any) {
      // Race safety: the pre-checks above are not atomic; a concurrent
      // insert can still trip the UNIQUE constraint.
      if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new AuthError('An account with this email or username already exists.', 'ACCOUNT_EXISTS', 409);
      }
      throw err;
    }

    return {
      id,
      email: data.email,
      password: data.password,
      username,
      firstName: data.firstName,
      lastName: data.lastName,
      role: data.role,
      loginProvider: data.loginProvider || 'local',
      providerAccountId: data.providerAccountId,
      isEmailVerified: true,
      lastLogin: new Date(now),
    } as BaseUser & { username: string };
  }

  async updateRefreshToken(userId: string, token: string | null, expiry: Date | null): Promise<void> {
    const db = getDb();
    db.prepare(`
      UPDATE users SET refresh_token = ?, refresh_expires = ?, updated_at = ?
      WHERE id = ?
    `).run(token, expiry?.toISOString() || null, new Date().toISOString(), userId);
  }

  async updateLastLogin(userId: string): Promise<void> {
    const db = getDb();
    db.prepare('UPDATE users SET last_login = ?, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), new Date().toISOString(), userId);
  }

  async updateResetToken(userId: string, token: string | null, expiry: Date | null): Promise<void> {
    const db = getDb();
    db.prepare(`
      UPDATE users SET reset_token = ?, reset_expires = ?, updated_at = ?
      WHERE id = ?
    `).run(token, expiry?.toISOString() || null, new Date().toISOString(), userId);
  }

  async updatePassword(userId: string, hashedPassword: string): Promise<void> {
    const db = getDb();
    db.prepare(`
      UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?
    `).run(hashedPassword, new Date().toISOString(), userId);
  }

  async updateTotpSecret(userId: string, secret: string | null): Promise<void> {
    const db = getDb();
    db.prepare(`
      UPDATE users SET totp_secret = ?, is_totp_enabled = ?, updated_at = ? WHERE id = ?
    `).run(secret, secret ? 1 : 0, new Date().toISOString(), userId);
  }

  async updateMagicLinkToken(userId: string, token: string | null, expiry: Date | null): Promise<void> {
    const db = getDb();
    db.prepare(`
      UPDATE users SET magic_link_token = ?, magic_link_expires = ?, updated_at = ?
      WHERE id = ?
    `).run(token, expiry?.toISOString() || null, new Date().toISOString(), userId);
  }

  async updateSmsCode(userId: string, code: string | null, expiry: Date | null): Promise<void> {
    const db = getDb();
    db.prepare(`
      UPDATE users SET sms_code = ?, sms_expires = ?, updated_at = ?
      WHERE id = ?
    `).run(code, expiry?.toISOString() || null, new Date().toISOString(), userId);
  }

  async findByResetToken(token: string): Promise<BaseUser | null> {
    const db = getDb();
    const row = db.prepare(
      "SELECT * FROM users WHERE reset_token = ? AND reset_expires > datetime('now')"
    ).get(token) as UserRow | undefined;
    return row ? rowToBaseUser(row) : null;
  }

  async findByMagicLinkToken(token: string): Promise<BaseUser | null> {
    const db = getDb();
    const row = db.prepare(
      "SELECT * FROM users WHERE magic_link_token = ? AND magic_link_expires > datetime('now')"
    ).get(token) as UserRow | undefined;
    return row ? rowToBaseUser(row) : null;
  }

  async findByProviderAccount(provider: string, providerAccountId: string): Promise<BaseUser | null> {
    const db = getDb();
    const row = db.prepare(
      'SELECT * FROM users WHERE login_provider = ? AND provider_account_id = ?'
    ).get(provider, providerAccountId) as UserRow | undefined;
    return row ? rowToBaseUser(row) : null;
  }

  async updateProfile(userId: string, data: { firstName?: string | null; lastName?: string | null }): Promise<void> {
    const db = getDb();
    db.prepare(`
      UPDATE users SET first_name = ?, last_name = ?, updated_at = ? WHERE id = ?
    `).run(data.firstName ?? null, data.lastName ?? null, new Date().toISOString(), userId);
  }

  async deleteUser(userId: string): Promise<void> {
    const db = getDb();
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  async findByPhoneNumber(phoneNumber: string): Promise<BaseUser | null> {
    const db = getDb();
    const row = db.prepare('SELECT * FROM users WHERE phone_number = ?').get(phoneNumber) as UserRow | undefined;
    return row ? rowToBaseUser(row) : null;
  }

  // --- Directory / provisioning (SCIM) --------------------------------------
  // These are the operations an IdP's SCIM client drives: list, set role, and
  // deprovision. They read/write only the columns that already model identity;
  // `active` was added by the additive migration in db.ts.

  async listUsers(limit = 100, offset = 0): Promise<Array<BaseUser & { active?: boolean; updatedBy?: string | null }>> {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM users ORDER BY created_at ASC LIMIT ? OFFSET ?').all(limit, offset) as UserRow[];
    return rows.map((r) => ({ ...rowToBaseUser(r), active: (r as unknown as { active?: number }).active !== 0, updatedBy: (r as unknown as { updated_by?: string }).updated_by ?? null }));
  }

  async countUsers(): Promise<number> {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    return row.n;
  }

  async countActiveUsers(): Promise<number> {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) AS n FROM users WHERE active IS NULL OR active = 1').get() as { n: number };
    return row.n;
  }

  async updateRole(userId: string, role: string | null, by?: string): Promise<boolean> {
    const db = getDb();
    const r = db.prepare('UPDATE users SET role = ?, updated_by = ?, updated_at = ? WHERE id = ?')
      .run(role, by ?? null, new Date().toISOString(), userId);
    return r.changes > 0;
  }

  /** Link a federated identity to an existing local account (email match on
   *  first SSO login), recording the provider subject for future lookups. */
  async linkProvider(userId: string, provider: string, accountId: string, role?: string | null): Promise<boolean> {
    const db = getDb();
    const r = db.prepare('UPDATE users SET login_provider = ?, provider_account_id = ?, role = COALESCE(?, role), updated_at = ? WHERE id = ?')
      .run(provider, accountId, role ?? null, new Date().toISOString(), userId);
    return r.changes > 0;
  }

  /** Deprovision / reactivate. Deactivation also clears the refresh token and
   *  drops sessions so an offboarded user cannot refresh back in. */
  async setActive(userId: string, active: boolean, by?: string): Promise<boolean> {
    const db = getDb();
    const r = db.prepare('UPDATE users SET active = ?, updated_by = ?, updated_at = ? WHERE id = ?')
      .run(active ? 1 : 0, by ?? null, new Date().toISOString(), userId);
    if (!active) {
      db.prepare('UPDATE users SET refresh_token = NULL, refresh_expires = NULL WHERE id = ?').run(userId);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
    return r.changes > 0;
  }

  async isActive(userId: string): Promise<boolean | null> {
    const db = getDb();
    const row = db.prepare('SELECT active FROM users WHERE id = ?').get(userId) as { active: number | null } | undefined;
    return row ? row.active !== 0 : null;
  }
}