import React, { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { Github } from 'lucide-react';

export function LoginPage() {
  const { user, login, signup, quickAccess } = useAuth();
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

  const handleQuickLogin = async (targetEmail: string) => {
    setError('');
    setLoading(true);
    try {
      const ok = await quickAccess(targetEmail);
      if (ok) {
        navigate('/');
        return;
      }
      // Fallback to standard login
      const fallback = await login(targetEmail, 'password123');
      if (fallback.success) {
        navigate('/');
      } else {
        setError('Quick access failed. Please try logging in manually.');
      }
    } catch {
      setError('Connection failed. Please check backend.');
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
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#0A0C10' }}>
      <div className="w-full max-w-md p-8 space-y-6">
        <div className="text-center">
          <div className="flex items-center justify-center gap-3 mb-4">
            <Github className="w-10 h-10 text-blue-500" />
            <h1 className="text-3xl font-black tracking-tighter text-white uppercase">OpenHub</h1>
          </div>
          <p className="text-gray-500 text-sm font-mono uppercase tracking-widest">
            Local Developer Infrastructure
          </p>
        </div>

        <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-6 space-y-4">
          <div className="flex border-b border-[#30363d]">
            <button
              onClick={() => setMode('login')}
              className={`flex-1 pb-3 text-sm font-bold transition-colors ${
                mode === 'login'
                  ? 'text-blue-500 border-b-2 border-blue-500'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              Sign In
            </button>
            <button
              onClick={() => setMode('signup')}
              className={`flex-1 pb-3 text-sm font-bold transition-colors ${
                mode === 'signup'
                  ? 'text-blue-500 border-b-2 border-blue-500'
                  : 'text-gray-500 hover:text-gray-300'
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
                className="w-full bg-[#0A0C10] border border-[#30363d] rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
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
                  className="w-full bg-[#0A0C10] border border-[#30363d] rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
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
                className="w-full bg-[#0A0C10] border border-[#30363d] rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
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

          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-[#30363d]" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-[#161b22] px-2 text-gray-500 font-mono">1-Click Quick Access</span>
            </div>
          </div>

          <div className="space-y-2">
            <button
              type="button"
              onClick={() => handleQuickLogin('dev@openhub.local')}
              disabled={loading}
              className="w-full bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] hover:border-gray-500 text-gray-200 rounded px-4 py-2 text-sm font-medium transition-colors flex items-center justify-between"
            >
              <span className="flex items-center gap-2">
                <span className="text-amber-400">⚡</span>
                <span>Demo Developer</span>
              </span>
              <span className="text-[11px] text-gray-400 font-mono">dev@openhub.local</span>
            </button>

            <button
              type="button"
              onClick={() => handleQuickLogin('tap4500@gmail.com')}
              disabled={loading}
              className="w-full bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] hover:border-gray-500 text-gray-200 rounded px-4 py-2 text-sm font-medium transition-colors flex items-center justify-between"
            >
              <span className="flex items-center gap-2">
                <span className="text-blue-400">⚡</span>
                <span>Admin User</span>
              </span>
              <span className="text-[11px] text-gray-400 font-mono">tap4500@gmail.com</span>
            </button>
          </div>
          <p className="text-[11px] text-gray-500 text-center font-mono pt-1">
            Default Password: <span className="text-gray-400">password123</span>
          </p>
        </div>

        <p className="text-center text-[10px] text-gray-600 font-mono uppercase">
          OpenHub v2.0 — Autonomous Developer Orchestration OS
        </p>
      </div>
    </div>
  );
}
