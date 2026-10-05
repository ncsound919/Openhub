import React, { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { Github } from 'lucide-react';

export function LoginPage() {
  const { user, login, signup } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Redirect to dashboard if already authenticated
  if (user) {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (mode === 'login') {
        const res = await login(email.trim(), password);
        if (res.success) {
          navigate('/');
        } else {
          setError(res.error || 'Invalid email or password. If you do not have an account yet, please click "Create Account".');
        }
      } else {
        const res = await signup(email.trim(), password, username.trim() || email.split('@')[0]);
        if (res.success) {
          navigate('/');
        } else {
          setError(res.error || 'Email already exists or registration failed. Try signing in.');
        }
      }
    } catch {
      setError('Connection failed. Is the server running?');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateWithCurrentCreds = async () => {
    if (!email || !password) return;
    setError('');
    setLoading(true);
    try {
      const res = await signup(email.trim(), password, username.trim() || email.split('@')[0]);
      if (res.success) {
        navigate('/');
      } else {
        setError(res.error || 'Failed to create account.');
      }
    } catch {
      setError('Failed to create account.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--color-bg-base)' }}>
      <div className="w-full max-w-md p-8 space-y-6">
        <div className="text-center">
          <div className="flex items-center justify-center gap-3 mb-4">
            <Github className="w-10 h-10 text-blue-500" />
            <h1 className="text-3xl font-black tracking-tighter text-[var(--color-text-primary)] uppercase">OpenHub</h1>
          </div>
          <p className="text-gray-400 text-sm font-mono uppercase tracking-widest">
            Local Developer Infrastructure
          </p>
        </div>

        <div className="bg-surface-raised border border-border-muted rounded-lg p-6 space-y-4">
          <div className="flex border-b border-border-muted">
            <button
              onClick={() => setMode('login')}
              className={`flex-1 pb-3 text-sm font-bold transition-colors ${
                mode === 'login'
                  ? 'text-blue-500 border-b-2 border-blue-500'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Sign In
            </button>
            <button
              onClick={() => setMode('signup')}
              className={`flex-1 pb-3 text-sm font-bold transition-colors ${
                mode === 'signup'
                  ? 'text-blue-500 border-b-2 border-blue-500'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Create Account
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full bg-bg-base border border-border-muted rounded px-3 py-2 text-[var(--color-text-primary)] text-sm focus:border-blue-500 focus:outline-none"
                placeholder="dev@localhost"
              />
            </div>

            {mode === 'signup' && (
              <div>
                <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">
                  Username
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  className="w-full bg-bg-base border border-border-muted rounded px-3 py-2 text-[var(--color-text-primary)] text-sm focus:border-blue-500 focus:outline-none"
                  placeholder="developer"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full bg-bg-base border border-border-muted rounded px-3 py-2 text-[var(--color-text-primary)] text-sm focus:border-blue-500 focus:outline-none"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded p-3 text-xs space-y-2">
                <p className="text-red-400">{error}</p>
                {mode === 'login' && email && password && (
                  <button
                    type="button"
                    onClick={handleCreateWithCurrentCreds}
                    disabled={loading}
                    className="text-xs text-blue-400 hover:text-blue-300 underline font-medium block"
                  >
                    + Create account with {email} and sign in now
                  </button>
                )}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded px-4 py-2.5 text-sm font-bold transition-colors cursor-pointer"
            >
              {loading ? 'Authenticating...' : mode === 'login' ? 'Sign In' : 'Create Account & Sign In'}
            </button>
          </form>
        </div>

        <p className="text-center text-[10px] text-gray-400 font-mono uppercase">
          OpenHub v2.0 — Autonomous Developer Orchestration OS
        </p>
      </div>
    </div>
  );
}
