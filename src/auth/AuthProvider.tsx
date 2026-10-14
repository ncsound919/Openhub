import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

export interface UserProfile {
  id: string;
  email: string;
  username: string;
  role?: string;
  sub?: string;
}

interface AuthContextType {
  user: UserProfile | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  signup: (email: string, password: string, username?: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  getCsrfToken: () => string;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  isLoading: true,
  login: async () => ({ success: false }),
  signup: async () => ({ success: false }),
  logout: async () => {},
  getCsrfToken: () => '',
});

export function useAuth() {
  return useContext(AuthContext);
}

/**
 * Browser auth is cookie-first: the server sets HttpOnly `accessToken` /
 * `refreshToken` cookies (SameSite=Lax) and the client holds **no** tokens. This
 * is the same mode the e2e API flow already uses (the server only returns tokens
 * in the JSON body when the request carries `X-Auth-Strategy: bearer`).
 *
 * Kept for call-site compatibility; always null now that tokens are not exposed
 * to JavaScript.
 */
export function getAuthToken(): string | null {
  return null;
}

/**
 * Cookie auth means state-changing requests must carry the CSRF double-submit
 * header (the server enforces it for the cookie strategy). This helper adds it
 * so callers only have to pass their own headers; it is harmless on GETs.
 */
export function getAuthHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extraHeaders };
  const csrf = getCsrfToken();
  if (csrf && !('X-CSRF-Token' in headers)) headers['X-CSRF-Token'] = csrf;
  return headers;
}

export function getCsrfToken(): string {
  const get = (name: string) =>
    document.cookie
      .split('; ')
      .find((row) => row.startsWith(`${name}=`))
      ?.split('=')[1] ?? '';
  return get('__Host-csrf-token') || get('__Secure-csrf-token') || get('csrf-token');
}

/** Remove tokens persisted by the pre-cookie build so an XSS payload can't
 *  harvest a stale, long-lived refresh token. */
function purgeLegacyTokens(): void {
  try {
    localStorage.removeItem('openhub_token');
    localStorage.removeItem('openhub_refresh_token');
  } catch {
    /* private mode / storage disabled */
  }
}

function readProfile(data: Record<string, unknown>): UserProfile {
  const id = (data.id as string) || (data.sub as string) || '';
  const email = (data.email as string) || '';
  return {
    id,
    email,
    username: (data.username as string) || (email ? email.split('@')[0] : 'User'),
    role: data.role as string | undefined,
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchUser = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setUser(readProfile(data.user ?? data));
        return true;
      }
      // Access cookie expired or missing — rotate it via the refresh cookie
      // (the endpoint reads the HttpOnly refresh cookie, no body token needed).
      const refreshRes = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        credentials: 'include',
      });
      if (refreshRes.ok) {
        const retryRes = await fetch('/api/auth/me', { credentials: 'include' });
        if (retryRes.ok) {
          const retryData = await retryRes.json();
          setUser(readProfile(retryData.user ?? retryData));
          return true;
        }
      }
      setUser(null);
      return false;
    } catch {
      setUser(null);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    purgeLegacyTokens();
    void fetchUser();
  }, [fetchUser]);

  const login = async (email: string, password: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        return { success: false, error: data.error || 'Invalid credentials' };
      }

      const verified = await fetchUser();
      return { success: verified };
    } catch (err: any) {
      return { success: false, error: err.message || 'Connection failed' };
    }
  };

  const signup = async (email: string, password: string, username?: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, username }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        return { success: false, error: data.error || 'Registration failed' };
      }

      return await login(email, password);
    } catch (err: any) {
      return { success: false, error: err.message || 'Connection failed' };
    }
  };

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        credentials: 'include',
      });
    } catch {
      // ignore
    }
    purgeLegacyTokens();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, isLoading, login, signup, logout, getCsrfToken }}>
      {children}
    </AuthContext.Provider>
  );
}
