import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Github,
  GitBranch,
  Star,
  GitFork,
  Download,
  ExternalLink,
  RefreshCw,
  CheckCircle,
  XCircle,
  Clock,
  AlertCircle,
  Play,
  Terminal,
  Shield,
  Search,
  Filter,
  ArrowRight,
  Plus,
  Send,
  Radio,
  Layers,
  FileCode,
  Lock,
  Globe,
  Check,
  Zap,
} from 'lucide-react';
import { getAuthHeaders } from '../auth/AuthProvider';
import { useStore } from '../store';

interface GitHubProfile {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  email: string | null;
  bio: string | null;
  public_repos: number;
  total_private_repos?: number;
  html_url: string;
}

interface GitHubRepoItem {
  id: number;
  name: string;
  full_name: string;
  owner: {
    login: string;
    avatar_url: string;
  };
  private: boolean;
  html_url: string;
  description: string | null;
  fork: boolean;
  default_branch: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  updated_at: string;
  pushed_at: string;
  is_imported?: boolean;
  local_repo_id?: string;
}

interface WorkflowRunItem {
  id: number;
  name: string;
  head_branch: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  actor: {
    login: string;
    avatar_url: string;
  };
  head_commit: {
    message: string;
  };
}

interface WebhookEventItem {
  id: string;
  event_type: string;
  repo_full_name: string;
  sender: string;
  action: string;
  summary: string;
  payload: string;
  created_at: string;
}

export function GitHubIntegrationPage() {
  const navigate = useNavigate();
  const { fetchRepositories } = useStore();

  // Status & Auth state
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [profile, setProfile] = useState<GitHubProfile | null>(null);
  const [patInput, setPatInput] = useState('');
  const [patLoading, setPatLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Active Tab
  const [activeTab, setActiveTab] = useState<'repos' | 'actions' | 'issues' | 'webhooks' | 'guide'>('repos');

  // Repositories state
  const [repos, setRepos] = useState<GitHubRepoItem[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [repoSearch, setRepoSearch] = useState('');
  const [repoFilter, setRepoFilter] = useState<'all' | 'public' | 'private' | 'imported'>('all');
  const [importingRepoId, setImportingRepoId] = useState<number | null>(null);

  // Actions & Runs state
  const [selectedRepoForActions, setSelectedRepoForActions] = useState<string>('');
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunItem[]>([]);
  const [actionsLoading, setActionsLoading] = useState(false);

  // Issues & Pulls state
  const [selectedRepoForIssues, setSelectedRepoForIssues] = useState<string>('');
  const [issues, setIssues] = useState<any[]>([]);
  const [pulls, setPulls] = useState<any[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [showNewIssueModal, setShowNewIssueModal] = useState(false);
  const [newIssueTitle, setNewIssueTitle] = useState('');
  const [newIssueBody, setNewIssueBody] = useState('');
  const [submittingIssue, setSubmittingIssue] = useState(false);

  // Webhooks state
  const [webhookEvents, setWebhookEvents] = useState<WebhookEventItem[]>([]);
  const [webhooksLoading, setWebhooksLoading] = useState(false);
  const [selectedPayload, setSelectedPayload] = useState<string | null>(null);
  const [simulatingWebhook, setSimulatingWebhook] = useState(false);

  // 1. Check connection status
  const checkStatus = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/github/status', {
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (data.connected && data.user) {
        setConnected(true);
        setProfile(data.user);
        setAuthError(null);
      } else {
        setConnected(false);
        setProfile(null);
        if (data.error) setAuthError(data.error);
      }
    } catch (err: any) {
      setConnected(false);
      setProfile(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkStatus();

    // Listen for OAuth popup completion
    const handleMessage = (e: MessageEvent) => {
      if (e.data && e.data.type === 'GITHUB_AUTH_SUCCESS') {
        setSuccessMessage(`Successfully connected to GitHub as @${e.data.user || 'user'}!`);
        checkStatus();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // 2. Fetch Repositories when connected
  const loadRepos = async () => {
    if (!connected) return;
    setReposLoading(true);
    try {
      const res = await fetch('/api/github/repos', {
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (data.repos) {
        setRepos(data.repos);
        if (data.repos.length > 0 && !selectedRepoForActions) {
          setSelectedRepoForActions(data.repos[0].full_name);
          setSelectedRepoForIssues(data.repos[0].full_name);
        }
      }
    } catch (err) {
      console.error('Failed to load GitHub repos:', err);
    } finally {
      setReposLoading(false);
    }
  };

  useEffect(() => {
    if (connected) {
      loadRepos();
    }
  }, [connected]);

  // 3. Connect via Personal Access Token (PAT)
  const handlePatConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!patInput.trim()) return;
    setPatLoading(true);
    setAuthError(null);
    try {
      const res = await fetch('/api/github/pat-connect', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token: patInput.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setSuccessMessage(`Connected to GitHub as @${data.user.login}!`);
        setConnected(true);
        setProfile(data.user);
        setPatInput('');
      } else {
        setAuthError(data.error || 'Failed to authenticate token with GitHub.');
      }
    } catch (err: any) {
      setAuthError(err.message || 'Connection failed.');
    } finally {
      setPatLoading(false);
    }
  };

  // 4. Connect via OAuth Popup
  const handleOAuthConnect = async () => {
    setAuthError(null);
    try {
      const res = await fetch('/api/github/auth-url', {
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (data.configured && data.url) {
        const width = 600;
        const height = 700;
        const left = window.screen.width / 2 - width / 2;
        const top = window.screen.height / 2 - height / 2;
        window.open(
          data.url,
          'GitHubAuthPopup',
          `width=${width},height=${height},top=${top},left=${left},status=yes,scrollbars=yes`
        );
      } else {
        setAuthError(data.message || 'GitHub OAuth App is not configured. Please use a Personal Access Token below.');
      }
    } catch (err: any) {
      setAuthError('Failed to initiate OAuth flow: ' + err.message);
    }
  };

  // 5. Disconnect GitHub
  const handleDisconnect = async () => {
    try {
      await fetch('/api/github/disconnect', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      setConnected(false);
      setProfile(null);
      setRepos([]);
      setSuccessMessage('Disconnected from GitHub.');
    } catch (err) {
      console.error(err);
    }
  };

  // 6. Import a GitHub Repository into OpenHub
  const handleImportRepo = async (repo: GitHubRepoItem) => {
    setImportingRepoId(repo.id);
    try {
      const res = await fetch('/api/github/import', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          owner: repo.owner.login,
          repo: repo.name,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setSuccessMessage(`Repository "${repo.name}" successfully imported into OpenHub!`);
        // Refresh local store and repo list
        await fetchRepositories();
        setRepos((prev) =>
          prev.map((r) =>
            r.id === repo.id
              ? { ...r, is_imported: true, local_repo_id: data.repo.id }
              : r
          )
        );
      } else {
        setAuthError(data.error || 'Failed to import repository.');
      }
    } catch (err: any) {
      setAuthError('Import error: ' + err.message);
    } finally {
      setImportingRepoId(null);
    }
  };

  // 7. Load Actions for selected repo
  const loadWorkflowRuns = async (repoFullName: string) => {
    if (!connected || !repoFullName) return;
    setActionsLoading(true);
    const [owner, repo] = repoFullName.split('/');
    try {
      const res = await fetch(`/api/github/repos/${owner}/${repo}/actions/runs`, {
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (data.workflow_runs) {
        setWorkflowRuns(data.workflow_runs);
      } else {
        setWorkflowRuns([]);
      }
    } catch (err) {
      console.error('Failed to load workflow runs:', err);
    } finally {
      setActionsLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'actions' && selectedRepoForActions) {
      loadWorkflowRuns(selectedRepoForActions);
    }
  }, [activeTab, selectedRepoForActions]);

  // 8. Load Issues & Pulls for selected repo
  const loadIssuesAndPulls = async (repoFullName: string) => {
    if (!connected || !repoFullName) return;
    setIssuesLoading(true);
    const [owner, repo] = repoFullName.split('/');
    try {
      const [issuesRes, pullsRes] = await Promise.all([
        fetch(`/api/github/repos/${owner}/${repo}/issues`, { headers: getAuthHeaders() }),
        fetch(`/api/github/repos/${owner}/${repo}/pulls`, { headers: getAuthHeaders() }),
      ]);
      const issuesData = await issuesRes.json();
      const pullsData = await pullsRes.json();

      if (Array.isArray(issuesData.issues)) {
        // filter out PRs that GitHub API puts in issues endpoint
        setIssues(issuesData.issues.filter((item: any) => !item.pull_request));
      } else {
        setIssues([]);
      }

      if (Array.isArray(pullsData.pulls)) {
        setPulls(pullsData.pulls);
      } else {
        setPulls([]);
      }
    } catch (err) {
      console.error('Failed to load issues/pulls:', err);
    } finally {
      setIssuesLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'issues' && selectedRepoForIssues) {
      loadIssuesAndPulls(selectedRepoForIssues);
    }
  }, [activeTab, selectedRepoForIssues]);

  // 9. Create Issue on GitHub
  const handleCreateIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newIssueTitle.trim() || !selectedRepoForIssues) return;
    setSubmittingIssue(true);
    const [owner, repo] = selectedRepoForIssues.split('/');
    try {
      const res = await fetch(`/api/github/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: newIssueTitle.trim(),
          body: newIssueBody.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setSuccessMessage(`Issue #${data.issue.number} created on GitHub!`);
        setShowNewIssueModal(false);
        setNewIssueTitle('');
        setNewIssueBody('');
        loadIssuesAndPulls(selectedRepoForIssues);
      } else {
        setAuthError(data.error || 'Failed to create issue.');
      }
    } catch (err: any) {
      setAuthError('Issue creation failed: ' + err.message);
    } finally {
      setSubmittingIssue(false);
    }
  };

  // 10. Load Webhooks Events
  const loadWebhookEvents = async () => {
    setWebhooksLoading(true);
    try {
      const res = await fetch('/api/github/webhook/events', {
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (data.events) {
        setWebhookEvents(data.events);
      }
    } catch (err) {
      console.error('Failed to load webhooks:', err);
    } finally {
      setWebhooksLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'webhooks') {
      loadWebhookEvents();
    }
  }, [activeTab]);

  // 11. Trigger Simulated Webhook Ping
  const handleSimulateWebhook = async (eventType: string = 'push') => {
    setSimulatingWebhook(true);
    try {
      const targetRepo = repos[0]?.full_name || 'openhub/autonomous-engine';
      const res = await fetch('/api/github/webhook/test-ping', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          event: eventType,
          repoFullName: targetRepo,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSuccessMessage(`Simulated GitHub "${eventType}" event received and processed!`);
        loadWebhookEvents();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSimulatingWebhook(false);
    }
  };

  // Filtered repositories
  const filteredRepos = repos.filter((r) => {
    const matchesSearch =
      r.name.toLowerCase().includes(repoSearch.toLowerCase()) ||
      (r.description && r.description.toLowerCase().includes(repoSearch.toLowerCase())) ||
      (r.language && r.language.toLowerCase().includes(repoSearch.toLowerCase()));

    if (!matchesSearch) return false;
    if (repoFilter === 'public') return !r.private;
    if (repoFilter === 'private') return r.private;
    if (repoFilter === 'imported') return Boolean(r.is_imported);
    return true;
  });

  return (
    <div className="flex-1 max-w-7xl mx-auto w-full flex flex-col gap-6 px-4 py-8 relative z-10 font-sans">
      {/* Industrial Breadcrumb & Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-4 border-b border-[#30363d]">
        <div>
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-widest text-blue-400 mb-1">
            <Github className="w-4 h-4" /> Ecosystem // GitHub Deep Integration
          </div>
          <h1 className="text-3xl font-industrial text-white tracking-wide">GitHub Autonomous Bridge</h1>
          <p className="text-gray-400 text-xs mt-1">
            Bi-directional sync, 1-click repository imports, real-time GitHub Actions CI/CD telemetry, and webhook orchestration.
          </p>
        </div>

        {connected && profile && (
          <div className="flex items-center gap-3 bg-[#161b22] border border-[#30363d] px-4 py-2 rounded-sm">
            <img
              src={profile.avatar_url}
              alt={profile.login}
              className="w-8 h-8 rounded-full border border-blue-500/40"
            />
            <div className="text-left">
              <div className="text-xs font-bold text-white flex items-center gap-1.5">
                <span>@{profile.login}</span>
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              </div>
              <div className="text-[10px] font-mono text-gray-400">
                {profile.public_repos} Public Repos
              </div>
            </div>
            <button
              onClick={handleDisconnect}
              className="ml-3 text-[10px] font-mono uppercase tracking-wider text-red-400 hover:text-red-300 transition-colors"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>

      {/* Notifications */}
      {successMessage && (
        <div className="p-3 bg-green-500/10 border border-green-500/30 text-green-400 text-xs rounded-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
            <span>{successMessage}</span>
          </div>
          <button
            onClick={() => setSuccessMessage(null)}
            className="text-gray-500 hover:text-white text-xs font-bold px-2"
          >
            ✕
          </button>
        </div>
      )}

      {authError && (
        <div className="p-3 bg-red-500/10 border border-red-500/30 text-red-400 text-xs rounded-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{authError}</span>
          </div>
          <button
            onClick={() => setAuthError(null)}
            className="text-gray-500 hover:text-white text-xs font-bold px-2"
          >
            ✕
          </button>
        </div>
      )}

      {/* Connection Section if NOT connected */}
      {!connected && !loading && (
        <div className="industrial-card p-6 bg-gradient-to-br from-[#161b22] to-[#0d1117] border border-[#30363d] rounded-sm">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
            <div>
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded bg-blue-500/10 border border-blue-500/20 text-blue-400 font-mono text-[10px] uppercase tracking-wider mb-4">
                <Shield className="w-3.5 h-3.5" /> Instant & Secure Sync
              </div>
              <h2 className="text-2xl font-industrial text-white mb-2">Connect Your GitHub Account</h2>
              <p className="text-gray-400 text-xs leading-relaxed mb-6">
                Link GitHub to enable 1-click cloning into your OpenHub Workspace, push commits directly from the web IDE, monitor GitHub Actions workflows, and triage issues.
              </p>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                <button
                  onClick={handleOAuthConnect}
                  className="flex items-center justify-center gap-2 bg-white text-black hover:bg-gray-200 px-5 py-2.5 rounded-sm font-bold text-xs uppercase tracking-wider transition-all shadow-md"
                >
                  <Github className="w-4 h-4" /> Connect with GitHub
                </button>
                <button
                  onClick={() => setActiveTab('guide')}
                  className="flex items-center justify-center gap-1.5 border border-[#30363d] text-gray-300 hover:text-white hover:bg-white/5 px-4 py-2.5 rounded-sm font-mono text-xs uppercase tracking-wider transition-all"
                >
                  Setup Guide & Keys
                </button>
              </div>
            </div>

            {/* Direct PAT connection */}
            <div className="bg-[#0A0C10] border border-[#30363d] p-5 rounded-sm">
              <h3 className="text-sm font-bold text-white mb-1 flex items-center gap-2">
                <Zap className="w-4 h-4 text-orange-400" /> Direct Token Connect (PAT)
              </h3>
              <p className="text-[11px] text-gray-400 mb-4">
                Fastest option — paste a GitHub Personal Access Token (`ghp_...` or fine-grained token) to connect instantly without registering an OAuth App.
              </p>
              <form onSubmit={handlePatConnect} className="space-y-3">
                <div>
                  <input
                    type="password"
                    value={patInput}
                    onChange={(e) => setPatInput(e.target.value)}
                    placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                    className="w-full bg-[#161b22] border border-[#30363d] px-3 py-2 text-xs font-mono text-white placeholder-gray-600 rounded-sm focus:outline-none focus:border-blue-500"
                  />
                  <div className="flex justify-between items-center text-[10px] text-gray-500 mt-1 font-mono">
                    <span>Required scopes: repo, read:user, workflow</span>
                    <a
                      href="https://github.com/settings/tokens/new?scopes=repo,read:user,workflow,admin:repo_hook"
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-400 hover:underline flex items-center gap-0.5"
                    >
                      Generate token <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={patLoading || !patInput.trim()}
                  className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-black font-bold text-xs uppercase tracking-wider py-2 rounded-sm transition-all flex items-center justify-center gap-2"
                >
                  {patLoading ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Check className="w-3.5 h-3.5" />
                  )}
                  {patLoading ? 'Verifying Token...' : 'Connect & Authorize'}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="flex border-b border-[#30363d] gap-2 overflow-x-auto">
        <button
          onClick={() => setActiveTab('repos')}
          className={`pb-3 px-4 text-xs font-mono uppercase tracking-wider transition-colors flex items-center gap-2 border-b-2 ${
            activeTab === 'repos'
              ? 'border-orange-500 text-orange-400 font-bold'
              : 'border-transparent text-gray-400 hover:text-white'
          }`}
        >
          <GitBranch className="w-3.5 h-3.5" /> Repositories ({repos.length})
        </button>
        <button
          onClick={() => setActiveTab('actions')}
          className={`pb-3 px-4 text-xs font-mono uppercase tracking-wider transition-colors flex items-center gap-2 border-b-2 ${
            activeTab === 'actions'
              ? 'border-orange-500 text-orange-400 font-bold'
              : 'border-transparent text-gray-400 hover:text-white'
          }`}
        >
          <Play className="w-3.5 h-3.5" /> GitHub Actions & CI/CD
        </button>
        <button
          onClick={() => setActiveTab('issues')}
          className={`pb-3 px-4 text-xs font-mono uppercase tracking-wider transition-colors flex items-center gap-2 border-b-2 ${
            activeTab === 'issues'
              ? 'border-orange-500 text-orange-400 font-bold'
              : 'border-transparent text-gray-400 hover:text-white'
          }`}
        >
          <AlertCircle className="w-3.5 h-3.5" /> Issues & Pulls
        </button>
        <button
          onClick={() => setActiveTab('webhooks')}
          className={`pb-3 px-4 text-xs font-mono uppercase tracking-wider transition-colors flex items-center gap-2 border-b-2 ${
            activeTab === 'webhooks'
              ? 'border-orange-500 text-orange-400 font-bold'
              : 'border-transparent text-gray-400 hover:text-white'
          }`}
        >
          <Radio className="w-3.5 h-3.5" /> Webhooks Stream
        </button>
        <button
          onClick={() => setActiveTab('guide')}
          className={`pb-3 px-4 text-xs font-mono uppercase tracking-wider transition-colors flex items-center gap-2 border-b-2 ${
            activeTab === 'guide'
              ? 'border-orange-500 text-orange-400 font-bold'
              : 'border-transparent text-gray-400 hover:text-white'
          }`}
        >
          <Shield className="w-3.5 h-3.5" /> Configuration Guide
        </button>
      </div>

      {/* ===================== TAB 1: REPOSITORIES ===================== */}
      {activeTab === 'repos' && (
        <div className="space-y-4">
          {/* Controls */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-[#161b22] border border-[#30363d] p-3 rounded-sm">
            <div className="flex items-center gap-2 flex-1">
              <Search className="w-4 h-4 text-gray-400 ml-1" />
              <input
                type="text"
                placeholder="Filter repositories by name, language, or topic..."
                value={repoSearch}
                onChange={(e) => setRepoSearch(e.target.value)}
                className="bg-transparent text-xs text-white placeholder-gray-500 focus:outline-none w-full font-mono"
              />
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <div className="flex bg-[#0A0C10] border border-[#30363d] p-0.5 rounded-sm text-[10px] font-mono">
                {(['all', 'public', 'private', 'imported'] as const).map((filter) => (
                  <button
                    key={filter}
                    onClick={() => setRepoFilter(filter)}
                    className={`px-2.5 py-1 uppercase rounded-sm ${
                      repoFilter === filter
                        ? 'bg-orange-500 text-black font-bold'
                        : 'text-gray-400 hover:text-white'
                    }`}
                  >
                    {filter}
                  </button>
                ))}
              </div>

              <button
                onClick={loadRepos}
                disabled={reposLoading || !connected}
                className="p-1.5 border border-[#30363d] hover:bg-white/5 rounded-sm text-gray-400 hover:text-white transition-colors"
                title="Refresh Repositories"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${reposLoading ? 'animate-spin text-orange-400' : ''}`} />
              </button>
            </div>
          </div>

          {/* Repositories Grid */}
          {reposLoading ? (
            <div className="p-12 text-center text-gray-400 font-mono text-xs flex flex-col items-center gap-3">
              <RefreshCw className="w-6 h-6 animate-spin text-orange-500" />
              <span>Fetching repositories from GitHub API...</span>
            </div>
          ) : filteredRepos.length === 0 ? (
            <div className="industrial-card p-12 text-center text-gray-400 rounded-sm">
              <Github className="w-10 h-10 mx-auto text-gray-600 mb-3" />
              <h3 className="text-white font-industrial text-lg mb-1">
                {!connected ? 'Connect GitHub to Browse Repositories' : 'No Repositories Found'}
              </h3>
              <p className="text-xs text-gray-500 max-w-md mx-auto">
                {!connected
                  ? 'Connect using OAuth or a Personal Access Token above to import and synchronize your repositories.'
                  : 'No repositories match your current filter or search criteria.'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredRepos.map((repo) => (
                <div
                  key={repo.id}
                  className="industrial-card p-5 bg-[#161b22] border border-[#30363d] hover:border-gray-600 transition-all rounded-sm flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <img
                          src={repo.owner.avatar_url}
                          alt={repo.owner.login}
                          className="w-5 h-5 rounded-full"
                        />
                        <a
                          href={repo.html_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm font-bold text-white hover:text-blue-400 flex items-center gap-1 transition-colors"
                        >
                          {repo.full_name}
                          <ExternalLink className="w-3 h-3 text-gray-500" />
                        </a>
                      </div>

                      <div className="flex items-center gap-1.5">
                        {repo.private ? (
                          <span className="flex items-center gap-1 text-[9px] font-mono uppercase bg-red-500/10 border border-red-500/20 text-red-400 px-1.5 py-0.5 rounded-sm">
                            <Lock className="w-2.5 h-2.5" /> Private
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-[9px] font-mono uppercase bg-green-500/10 border border-green-500/20 text-green-400 px-1.5 py-0.5 rounded-sm">
                            <Globe className="w-2.5 h-2.5" /> Public
                          </span>
                        )}

                        {repo.is_imported && (
                          <span className="text-[9px] font-mono uppercase bg-blue-500/15 border border-blue-500/30 text-blue-400 px-1.5 py-0.5 rounded-sm flex items-center gap-1">
                            <Check className="w-2.5 h-2.5" /> Synced
                          </span>
                        )}
                      </div>
                    </div>

                    <p className="text-gray-400 text-xs mt-2.5 line-clamp-2 min-h-[32px]">
                      {repo.description || 'No description provided.'}
                    </p>

                    <div className="flex flex-wrap items-center gap-3 mt-4 text-[11px] font-mono text-gray-400">
                      {repo.language && (
                        <span className="flex items-center gap-1 text-gray-300">
                          <span className="w-2 h-2 rounded-full bg-orange-400" />
                          {repo.language}
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <Star className="w-3 h-3 text-yellow-500/80" />
                        {repo.stargazers_count}
                      </span>
                      <span className="flex items-center gap-1">
                        <GitFork className="w-3 h-3 text-gray-500" />
                        {repo.forks_count}
                      </span>
                      <span className="text-gray-500 text-[10px]">
                        branch: <span className="text-gray-300">{repo.default_branch}</span>
                      </span>
                    </div>
                  </div>

                  {/* Actions footer */}
                  <div className="mt-5 pt-3 border-t border-[#30363d] flex items-center justify-between gap-2">
                    <span className="text-[10px] font-mono text-gray-500">
                      Updated {new Date(repo.updated_at).toLocaleDateString()}
                    </span>

                    {repo.is_imported ? (
                      <Link
                        to={`/workspace/${repo.owner.login}/${repo.name}`}
                        className="bg-purple-600 hover:bg-purple-700 text-white font-mono text-[10px] font-bold uppercase tracking-wider px-3 py-1.5 rounded-sm flex items-center gap-1.5 transition-colors"
                      >
                        <Terminal className="w-3 h-3" /> Open in Workspace
                      </Link>
                    ) : (
                      <button
                        onClick={() => handleImportRepo(repo)}
                        disabled={importingRepoId === repo.id}
                        className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-mono text-[10px] font-bold uppercase tracking-wider px-3 py-1.5 rounded-sm flex items-center gap-1.5 transition-colors"
                      >
                        {importingRepoId === repo.id ? (
                          <RefreshCw className="w-3 h-3 animate-spin" />
                        ) : (
                          <Download className="w-3 h-3" />
                        )}
                        {importingRepoId === repo.id ? 'Importing...' : 'Import to OpenHub'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ===================== TAB 2: GITHUB ACTIONS CI/CD ===================== */}
      {activeTab === 'actions' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-[#161b22] border border-[#30363d] p-3 rounded-sm">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-gray-400">Target Repository:</span>
              <select
                value={selectedRepoForActions}
                onChange={(e) => setSelectedRepoForActions(e.target.value)}
                className="bg-[#0A0C10] border border-[#30363d] text-white text-xs px-2.5 py-1.5 rounded-sm font-mono focus:outline-none focus:border-blue-500"
              >
                {repos.map((r) => (
                  <option key={r.id} value={r.full_name}>
                    {r.full_name}
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={() => loadWorkflowRuns(selectedRepoForActions)}
              disabled={actionsLoading}
              className="flex items-center gap-1.5 text-xs font-mono text-gray-300 hover:text-white border border-[#30363d] px-3 py-1.5 rounded-sm hover:bg-white/5 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${actionsLoading ? 'animate-spin text-orange-400' : ''}`} />
              Refresh Runs
            </button>
          </div>

          {actionsLoading ? (
            <div className="p-12 text-center text-gray-400 font-mono text-xs flex flex-col items-center gap-3">
              <RefreshCw className="w-6 h-6 animate-spin text-orange-500" />
              <span>Fetching GitHub Actions workflow runs...</span>
            </div>
          ) : workflowRuns.length === 0 ? (
            <div className="industrial-card p-8 text-center text-gray-400 rounded-sm">
              <Play className="w-8 h-8 mx-auto text-gray-600 mb-2" />
              <h3 className="text-white text-sm font-bold mb-1">No Workflow Runs Detected</h3>
              <p className="text-xs text-gray-500">
                {selectedRepoForActions
                  ? `No recent workflow executions found for ${selectedRepoForActions}.`
                  : 'Select a repository to inspect GitHub Actions CI runs.'}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {workflowRuns.map((run) => (
                <div
                  key={run.id}
                  className="industrial-card p-4 bg-[#161b22] border border-[#30363d] rounded-sm flex flex-col md:flex-row md:items-center justify-between gap-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5">
                      {run.conclusion === 'success' ? (
                        <CheckCircle className="w-4 h-4 text-green-400" />
                      ) : run.conclusion === 'failure' ? (
                        <XCircle className="w-4 h-4 text-red-400" />
                      ) : (
                        <Clock className="w-4 h-4 text-yellow-400 animate-spin" />
                      )}
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-white">{run.name}</span>
                        <span className="text-[10px] font-mono text-gray-400 bg-[#0A0C10] px-1.5 py-0.5 rounded border border-[#30363d]">
                          branch: {run.head_branch}
                        </span>
                        <span className="text-[10px] font-mono text-gray-500">
                          #{run.id}
                        </span>
                      </div>
                      <p className="text-xs text-gray-300 mt-1 font-mono">
                        {run.head_commit?.message || 'Workflow run'}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 text-xs font-mono shrink-0">
                    <div className="flex items-center gap-1.5 text-gray-400">
                      {run.actor?.avatar_url && (
                        <img
                          src={run.actor.avatar_url}
                          alt={run.actor.login}
                          className="w-4 h-4 rounded-full"
                        />
                      )}
                      <span>@{run.actor?.login}</span>
                    </div>

                    <span className="text-gray-500">
                      {new Date(run.created_at).toLocaleTimeString()}
                    </span>

                    <a
                      href={run.html_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-400 hover:text-blue-300 flex items-center gap-1 text-[11px]"
                    >
                      Logs <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ===================== TAB 3: ISSUES & PULL REQUESTS ===================== */}
      {activeTab === 'issues' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-[#161b22] border border-[#30363d] p-3 rounded-sm">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-gray-400">Repository:</span>
              <select
                value={selectedRepoForIssues}
                onChange={(e) => setSelectedRepoForIssues(e.target.value)}
                className="bg-[#0A0C10] border border-[#30363d] text-white text-xs px-2.5 py-1.5 rounded-sm font-mono focus:outline-none focus:border-blue-500"
              >
                {repos.map((r) => (
                  <option key={r.id} value={r.full_name}>
                    {r.full_name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowNewIssueModal(true)}
                className="bg-orange-500 hover:bg-orange-600 text-black font-mono font-bold text-xs uppercase tracking-wider px-3 py-1.5 rounded-sm flex items-center gap-1.5 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> New Issue on GitHub
              </button>
              <button
                onClick={() => loadIssuesAndPulls(selectedRepoForIssues)}
                disabled={issuesLoading}
                className="p-1.5 border border-[#30363d] hover:bg-white/5 rounded-sm text-gray-400 hover:text-white transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${issuesLoading ? 'animate-spin text-orange-400' : ''}`} />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Live Issues */}
            <div className="space-y-3">
              <h3 className="text-xs font-mono uppercase tracking-wider text-gray-400 flex items-center justify-between">
                <span>Active Issues ({issues.length})</span>
              </h3>
              {issuesLoading ? (
                <div className="p-8 text-center text-gray-500 font-mono text-xs">Loading issues...</div>
              ) : issues.length === 0 ? (
                <div className="industrial-card p-6 text-center text-gray-500 text-xs rounded-sm">
                  No issues found for this repository.
                </div>
              ) : (
                issues.map((issue) => (
                  <div
                    key={issue.id}
                    className="p-3 bg-[#161b22] border border-[#30363d] rounded-sm flex items-start justify-between gap-3"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-green-400 text-xs font-bold">#{issue.number}</span>
                        <a
                          href={issue.html_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs font-bold text-white hover:text-blue-400 transition-colors"
                        >
                          {issue.title}
                        </a>
                      </div>
                      <div className="text-[10px] font-mono text-gray-500 mt-1">
                        opened by @{issue.user?.login} • {new Date(issue.created_at).toLocaleDateString()}
                      </div>
                    </div>
                    <span className="text-[9px] font-mono uppercase px-2 py-0.5 rounded bg-green-500/10 border border-green-500/20 text-green-400">
                      {issue.state}
                    </span>
                  </div>
                ))
              )}
            </div>

            {/* Live Pull Requests */}
            <div className="space-y-3">
              <h3 className="text-xs font-mono uppercase tracking-wider text-gray-400 flex items-center justify-between">
                <span>Pull Requests ({pulls.length})</span>
              </h3>
              {issuesLoading ? (
                <div className="p-8 text-center text-gray-500 font-mono text-xs">Loading pull requests...</div>
              ) : pulls.length === 0 ? (
                <div className="industrial-card p-6 text-center text-gray-500 text-xs rounded-sm">
                  No pull requests found for this repository.
                </div>
              ) : (
                pulls.map((pr) => (
                  <div
                    key={pr.id}
                    className="p-3 bg-[#161b22] border border-[#30363d] rounded-sm flex items-start justify-between gap-3"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-purple-400 text-xs font-bold">#{pr.number}</span>
                        <a
                          href={pr.html_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs font-bold text-white hover:text-purple-400 transition-colors"
                        >
                          {pr.title}
                        </a>
                      </div>
                      <div className="text-[10px] font-mono text-gray-500 mt-1">
                        {pr.head.ref} → {pr.base.ref} by @{pr.user?.login}
                      </div>
                    </div>
                    <span className="text-[9px] font-mono uppercase px-2 py-0.5 rounded bg-purple-500/10 border border-purple-500/20 text-purple-400">
                      {pr.state}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* New Issue Modal */}
          {showNewIssueModal && (
            <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
              <div className="industrial-card bg-[#161b22] border border-[#30363d] max-w-lg w-full p-6 rounded-sm">
                <div className="flex items-center justify-between pb-3 border-b border-[#30363d] mb-4">
                  <h3 className="text-white font-industrial text-lg flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-orange-400" /> Create Issue on GitHub
                  </h3>
                  <button
                    onClick={() => setShowNewIssueModal(false)}
                    className="text-gray-400 hover:text-white text-sm"
                  >
                    ✕
                  </button>
                </div>

                <form onSubmit={handleCreateIssue} className="space-y-4">
                  <div>
                    <label className="text-[10px] font-mono uppercase text-gray-400 block mb-1">
                      Repository
                    </label>
                    <input
                      type="text"
                      disabled
                      value={selectedRepoForIssues}
                      className="w-full bg-[#0A0C10] border border-[#30363d] text-gray-400 px-3 py-2 text-xs font-mono rounded-sm"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] font-mono uppercase text-gray-400 block mb-1">
                      Issue Title
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Bug: Auth session expires unexpectedly"
                      value={newIssueTitle}
                      onChange={(e) => setNewIssueTitle(e.target.value)}
                      className="w-full bg-[#0A0C10] border border-[#30363d] text-white px-3 py-2 text-xs font-mono rounded-sm focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] font-mono uppercase text-gray-400 block mb-1">
                      Description / Reproduction Steps
                    </label>
                    <textarea
                      rows={4}
                      placeholder="Describe the issue or feature request in detail..."
                      value={newIssueBody}
                      onChange={(e) => setNewIssueBody(e.target.value)}
                      className="w-full bg-[#0A0C10] border border-[#30363d] text-white px-3 py-2 text-xs font-mono rounded-sm focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowNewIssueModal(false)}
                      className="px-4 py-2 border border-[#30363d] text-gray-400 hover:text-white text-xs font-mono rounded-sm"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={submittingIssue || !newIssueTitle.trim()}
                      className="px-4 py-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-black font-bold text-xs uppercase tracking-wider rounded-sm font-mono flex items-center gap-2"
                    >
                      {submittingIssue ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      {submittingIssue ? 'Submitting...' : 'Create on GitHub'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===================== TAB 4: WEBHOOKS STREAM ===================== */}
      {activeTab === 'webhooks' && (
        <div className="space-y-6">
          {/* Setup card */}
          <div className="industrial-card p-5 bg-[#161b22] border border-[#30363d] rounded-sm">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Radio className="w-4 h-4 text-green-400 animate-pulse" /> Live Webhook Receiver Endpoint
                </h3>
                <p className="text-xs text-gray-400 mt-1">
                  Add this webhook URL to your GitHub repository settings to receive real-time push events, CI triggers, and issue alerts.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <code className="bg-[#0A0C10] border border-[#30363d] px-3 py-1.5 text-xs font-mono text-green-400 rounded-sm select-all">
                    {window.location.origin}/api/github/webhook
                  </code>
                  <span className="text-[10px] font-mono text-gray-500">Content type: application/json</span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleSimulateWebhook('push')}
                  disabled={simulatingWebhook}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-mono text-xs px-3 py-2 rounded-sm font-bold uppercase tracking-wider flex items-center gap-1.5 transition-colors"
                >
                  <Send className="w-3.5 h-3.5" /> Simulate Push Webhook
                </button>
                <button
                  onClick={loadWebhookEvents}
                  className="p-2 border border-[#30363d] hover:bg-white/5 rounded-sm text-gray-400 hover:text-white"
                >
                  <RefreshCw className={`w-4 h-4 ${webhooksLoading ? 'animate-spin text-orange-400' : ''}`} />
                </button>
              </div>
            </div>
          </div>

          {/* Event stream table */}
          <div>
            <h3 className="text-xs font-mono uppercase tracking-wider text-gray-400 mb-3">
              Webhook Event Ingestion Log ({webhookEvents.length})
            </h3>
            {webhookEvents.length === 0 ? (
              <div className="industrial-card p-8 text-center text-gray-500 text-xs rounded-sm">
                No webhook events received yet. Click "Simulate Push Webhook" to test the pipeline!
              </div>
            ) : (
              <div className="space-y-2">
                {webhookEvents.map((evt) => (
                  <div
                    key={evt.id}
                    className="p-3 bg-[#161b22] border border-[#30363d] rounded-sm flex items-center justify-between text-xs font-mono"
                  >
                    <div className="flex items-center gap-3">
                      <span className="px-2 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[10px] font-bold uppercase">
                        {evt.event_type}
                      </span>
                      <span className="text-white font-bold">{evt.summary}</span>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className="text-gray-500 text-[10px]">
                        {new Date(evt.created_at).toLocaleTimeString()}
                      </span>
                      <button
                        onClick={() => setSelectedPayload(evt.payload)}
                        className="text-gray-400 hover:text-white text-[11px] underline"
                      >
                        Inspect Payload
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Payload Inspector Modal */}
          {selectedPayload && (
            <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
              <div className="industrial-card bg-[#161b22] border border-[#30363d] max-w-2xl w-full p-5 rounded-sm">
                <div className="flex items-center justify-between pb-3 border-b border-[#30363d] mb-3">
                  <h3 className="text-white text-sm font-bold font-mono">Webhook JSON Payload</h3>
                  <button
                    onClick={() => setSelectedPayload(null)}
                    className="text-gray-400 hover:text-white"
                  >
                    ✕
                  </button>
                </div>
                <pre className="bg-[#0A0C10] p-4 text-xs font-mono text-gray-300 overflow-auto max-h-96 rounded-sm border border-[#30363d]">
                  {JSON.stringify(JSON.parse(selectedPayload), null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===================== TAB 5: CONFIGURATION GUIDE ===================== */}
      {activeTab === 'guide' && (
        <div className="space-y-6">
          <div className="industrial-card p-6 bg-[#161b22] border border-[#30363d] rounded-sm">
            <h2 className="text-lg font-industrial text-white mb-4 flex items-center gap-2">
              <Shield className="w-5 h-5 text-orange-400" /> GitHub OAuth Application Setup
            </h2>
            <p className="text-xs text-gray-400 leading-relaxed mb-4">
              To enable 1-click OAuth login for all your organization developers, register an OAuth App in GitHub Developer Settings with the callback URL below.
            </p>

            <div className="space-y-4">
              <div className="bg-[#0A0C10] p-4 border border-[#30363d] rounded-sm">
                <div className="text-[10px] font-mono uppercase text-gray-500 mb-1">
                  1. Authorization Callback URL
                </div>
                <div className="flex items-center gap-2">
                  <code className="text-xs font-mono text-orange-400 select-all">
                    {window.location.origin}/api/github/callback
                  </code>
                </div>
              </div>

              <div className="bg-[#0A0C10] p-4 border border-[#30363d] rounded-sm">
                <div className="text-[10px] font-mono uppercase text-gray-500 mb-1">
                  2. Environment Variables (.env)
                </div>
                <pre className="text-xs font-mono text-gray-300">
{`GITHUB_CLIENT_ID=your_client_id_here
GITHUB_CLIENT_SECRET=your_client_secret_here
GITHUB_WEBHOOK_SECRET=your_optional_webhook_secret`}
                </pre>
              </div>

              <div className="bg-[#0A0C10] p-4 border border-[#30363d] rounded-sm">
                <div className="text-[10px] font-mono uppercase text-gray-500 mb-1">
                  3. Fine-Grained or Classic Personal Access Token
                </div>
                <p className="text-xs text-gray-400">
                  Prefer not to configure an OAuth App? You can simply create a Personal Access Token with <span className="text-white font-mono">repo</span>, <span className="text-white font-mono">read:user</span>, and <span className="text-white font-mono">workflow</span> permissions and paste it directly into OpenHub!
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
