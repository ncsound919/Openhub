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
  quickAccess: (email?: string) => Promise<boolean>;
  logout: () => Promise<void>;
  getCsrfToken: () => string;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  isLoading: true,
  login: async () => ({ success: false }),
  signup: async () => ({ success: false }),
  quickAccess: async () => false,
  logout: async () => {},
  getCsrfToken: () => '',
});

export function useAuth() {
  return useContext(AuthContext);
}

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem('openhub_token');
  } catch {
    return null;
  }
}

export function getAuthHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extraHeaders };
  const token = getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchUser = useCallback(async (explicitToken?: string): Promise<boolean> => {
    const token = explicitToken || getAuthToken();
    try {
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const res = await fetch('/api/auth/me', {
        headers,
        credentials: 'include',
      });

      if (res.ok) {
        const data = await res.json();
        const profile = data.user ?? data;
        setUser({
          id: profile.id || profile.sub,
          email: profile.email,
          username: profile.username || profile.email?.split('@')[0] || 'User',
          role: profile.role,
        });
        return true;
      }

      // If token expired or rejected, attempt refresh
      const refreshToken = localStorage.getItem('openhub_refresh_token');
      if (refreshToken) {
        try {
          const refreshRes = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Auth-Strategy': 'bearer',
            },
            credentials: 'include',
            body: JSON.stringify({ refreshToken }),
          });
          if (refreshRes.ok) {
            const refreshData = await refreshRes.json();
            if (refreshData.accessToken) {
              localStorage.setItem('openhub_token', refreshData.accessToken);
              if (refreshData.refreshToken) {
                localStorage.setItem('openhub_refresh_token', refreshData.refreshToken);
              }
              const retryRes = await fetch('/api/auth/me', {
                headers: { Authorization: `Bearer ${refreshData.accessToken}` },
                credentials: 'include',
              });
              if (retryRes.ok) {
                const retryData = await retryRes.json();
                const profile = retryData.user ?? retryData;
                setUser({
                  id: profile.id || profile.sub,
                  email: profile.email,
                  username: profile.username || profile.email?.split('@')[0] || 'User',
                  role: profile.role,
                });
                return true;
              }
            }
          }
        } catch {
          // ignore refresh error
        }
      }

      localStorage.removeItem('openhub_token');
      localStorage.removeItem('openhub_refresh_token');
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
    fetchUser();
  }, [fetchUser]);

  const login = async (email: string, password: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Strategy': 'bearer',
        },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        return { success: false, error: data.error || 'Invalid credentials' };
      }

      if (data.accessToken) {
        localStorage.setItem('openhub_token', data.accessToken);
      }
      if (data.refreshToken) {
        localStorage.setItem('openhub_refresh_token', data.refreshToken);
      }

      const verified = await fetchUser(data.accessToken);
      return { success: verified };
    } catch (err: any) {
      return { success: false, error: err.message || 'Connection failed' };
    }
  };

  const signup = async (email: string, password: string, username?: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Strategy': 'bearer',
        },
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

  const quickAccess = async (targetEmail?: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/auth/quick-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: targetEmail }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (data.accessToken) {
        localStorage.setItem('openhub_token', data.accessToken);
      }
      if (data.refreshToken) {
        localStorage.setItem('openhub_refresh_token', data.refreshToken);
      }
      return await fetchUser(data.accessToken);
    } catch {
      return false;
    }
  };

  const logout = async () => {
    try {
      const token = getAuthToken();
      const headers: Record<string, string> = { 'X-CSRF-Token': getCsrfToken() };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers,
        credentials: 'include',
      });
    } catch {
      // ignore
    }
    localStorage.removeItem('openhub_token');
    localStorage.removeItem('openhub_refresh_token');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, isLoading, login, signup, quickAccess, logout, getCsrfToken }}>
      {children}
    </AuthContext.Provider>
  );
}
