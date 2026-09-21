import React, { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useStore } from '../store';
import { Key, Shield, User, Globe, Bell, Mail, Plus, Trash2, CheckCircle2, AlertTriangle, Fingerprint, Lock, ShieldCheck, Terminal, Cpu, Clock, Bot, PlusCircle, UploadCloud, Plug, Loader2, FlaskConical, ArrowRight } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { getAuthHeaders, getCsrfToken } from '../auth/AuthProvider';
import { IntegrationsHub } from './IntegrationsHub';
import { ModelSelectionView } from './ModelSelectionView';
import { EditorSettingsPanel } from '../components/EditorSettingsPanel';

const VALID_TABS = ['profile', 'ssh-keys', 'security', 'emails', 'notifications', 'models', 'integrations', 'editor', 'advanced'];

/** Surfaces deliberately kept out of the main rail. They still exist for
 *  power users and deep links, but they are not part of the daily flow. */
const ADVANCED_LINKS: Array<{ to: string; label: string; note: string }> = [
  { to: '/fleet', label: 'Fleet', note: 'Agents, services, ecosystem, tools, registry (telemetry + controls)' },
  { to: '/projects', label: 'Projects & GitHub', note: 'Repositories, Actions/CI, Issues, Pulls, webhooks' },
  { to: '/assurance', label: 'Assurance', note: 'Audit reports, pipelines, repair history, readiness' },
  { to: '/axiom', label: 'Loops', note: 'Manual Axiom loop control and loop history' },
  { to: '/antagonist', label: 'Adversary', note: 'Mutation testing and opportunity prospecting' },
  { to: '/api-studio', label: 'API Studio', note: 'Discover, mock and exercise HTTP endpoints' },
  { to: '/insights', label: 'Insights (standalone)', note: 'Also available as a Reporter tab' },
  { to: '/activity', label: 'Activity (standalone)', note: 'Also available as a Reporter tab' },
  { to: '/crm', label: 'CRM', note: 'Business contacts and deals' },
];

export function UserSettingsView() {
  const { currentUser, sshKeys, fetchSSHKeys, addSSHKey, deleteSSHKey } = useStore();
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(() => {
    const requested = searchParams.get('tab');
    return requested && VALID_TABS.includes(requested) ? requested : 'ssh-keys';
  });

  // Follow ?tab= navigation (e.g. redirects from /integrations, /business).
  useEffect(() => {
    const requested = searchParams.get('tab');
    if (requested && VALID_TABS.includes(requested)) setActiveTab(requested);
  }, [searchParams]);
  const [isAddingKey, setIsAddingKey] = useState(false);
  const [newKey, setNewKey] = useState({ title: '', key: '' });
  const [profile, setProfile] = useState<{ username: string; email: string; avatarUrl: string | null } | null>(null);
  const [emailValue, setEmailValue] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState<string | null>(null);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [notifPrefs, setNotifPrefs] = useState<Record<string, boolean>>({});
  const [avatarBusy, setAvatarBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchSSHKeys();
    (async () => {
      try {
        const res = await fetch('/api/settings/profile', { credentials: 'include', headers: getAuthHeaders() });
        const data = await res.json();
        if (data.id) {
          setProfile({ username: data.username, email: data.email, avatarUrl: data.avatarUrl });
          setEmailValue(data.email || '');
        }
      } catch { /* profile offline */ }
    })();
    (async () => {
      try {
        const res = await fetch('/api/settings/notifications', { credentials: 'include', headers: getAuthHeaders() });
        const data = await res.json();
        if (data.prefs) setNotifPrefs(data.prefs);
      } catch { /* notifications offline */ }
    })();
  }, []);

  const handleAddKey = async (e: React.FormEvent) => {
    e.preventDefault();
    await addSSHKey(newKey.title, newKey.key);
    setIsAddingKey(false);
    setNewKey({ title: '', key: '' });
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2_000_000) { setPwMsg(null); setEmailMsg('Avatar too large (max ~2MB).'); return; }
    setAvatarBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const res = await fetch('/api/settings/avatar', {
        method: 'POST', credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ dataUrl }),
      });
      const data = await res.json();
      if (res.ok && data.avatarUrl) setProfile((p) => (p ? { ...p, avatarUrl: data.avatarUrl } : p));
      else setEmailMsg(data.error || 'Avatar upload failed.');
    } catch { setEmailMsg('Avatar upload failed.'); }
    finally { setAvatarBusy(false); }
  };

  const handleEmailSave = async () => {
    setEmailBusy(true); setEmailMsg(null);
    try {
      const res = await fetch('/api/settings/email', {
        method: 'POST', credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ email: emailValue }),
      });
      const data = await res.json();
      if (res.ok) { setProfile((p) => (p ? { ...p, email: data.email } : p)); setEmailMsg('Email updated.'); }
      else setEmailMsg(data.error || 'Email update failed.');
    } catch { setEmailMsg('Email update failed.'); }
    finally { setEmailBusy(false); }
  };

  const handlePasswordSave = async () => {
    if (pw.next !== pw.confirm) { setPwMsg('New passwords do not match.'); return; }
    setPwBusy(true); setPwMsg(null);
    try {
      const res = await fetch('/api/settings/password', {
        method: 'POST', credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ current: pw.current, next: pw.next }),
      });
      const data = await res.json();
      if (res.ok) { setPw({ current: '', next: '', confirm: '' }); setPwMsg('Password updated.'); }
      else setPwMsg(data.error || 'Password update failed.');
    } catch { setPwMsg('Password update failed.'); }
    finally { setPwBusy(false); }
  };

  const toggleNotif = async (key: string) => {
    const next = { ...notifPrefs, [key]: !notifPrefs[key] };
    setNotifPrefs(next);
    try {
      await fetch('/api/settings/notifications', {
        method: 'PUT', credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify(next),
      });
    } catch { /* best effort */ }
  };

  const avatarSrc = profile?.avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(profile?.username || 'dev')}&background=1f6feb&color=fff`;

  return (
    <div className="max-w-6xl mx-auto flex flex-col gap-5 py-6 px-4">
      <section className="gradient-hero rounded-2xl p-6 relative overflow-hidden">
        <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-blue-300">
          <Shield className="w-4 h-4" /> Operator Console // Account
        </div>
        <h1 className="mt-2">User <span className="text-info">Settings.</span></h1>
        <p className="mt-2 max-w-xl text-sm text-gray-400">
          Identity, keys, and notification preferences for this OpenHub node.
        </p>
      </section>
      <div className="flex flex-col md:flex-row gap-5">
      {/* Sidebar */}
      <div className="w-full md:w-64 space-y-1 shrink-0">
        <div className="px-3 py-4 mb-4 flex items-center space-x-3 glass rounded-xl">
           <img src={avatarSrc} className="w-12 h-12 rounded-full border-2 border-blue-500 shadow-xl shadow-blue-500/20 object-cover" alt="" />
           <div className="overflow-hidden">
              <div className="text-[var(--color-text-primary)] text-sm font-black truncate">{profile?.username ?? currentUser.username}</div>
              <div className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">Local Admin</div>
           </div>
        </div>
        
        <button onClick={() => setActiveTab('profile')} className={`sidebar-link w-full ${activeTab === 'profile' ? 'active' : ''}`}>
          <User className="w-4 h-4 mr-3" /> Public Profile
        </button>
        <button onClick={() => setActiveTab('ssh-keys')} className={`sidebar-link w-full ${activeTab === 'ssh-keys' ? 'active' : ''}`}>
          <Key className="w-4 h-4 mr-3" /> SSH and GPG keys
        </button>
        <button onClick={() => setActiveTab('security')} className={`sidebar-link w-full ${activeTab === 'security' ? 'active' : ''}`}>
          <Shield className="w-4 h-4 mr-3" /> Password & Authentication
        </button>
        <button onClick={() => setActiveTab('emails')} className={`sidebar-link w-full ${activeTab === 'emails' ? 'active' : ''}`}>
          <Mail className="w-4 h-4 mr-3" /> Emails
        </button>
        <button onClick={() => setActiveTab('notifications')} className={`sidebar-link w-full ${activeTab === 'notifications' ? 'active' : ''}`}>
          <Bell className="w-4 h-4 mr-3" /> Notifications
        </button>
        <div className="sidebar-group-label mt-4 mb-1.5">Configuration</div>
        <button onClick={() => setActiveTab('models')} className={`sidebar-link w-full ${activeTab === 'models' ? 'active' : ''}`}>
          <Cpu className="w-4 h-4 mr-3" /> Models
        </button>
        <button onClick={() => setActiveTab('editor')} className={`sidebar-link w-full ${activeTab === 'editor' ? 'active' : ''}`}>
          <Terminal className="w-4 h-4 mr-3" /> Editor
        </button>
        <button onClick={() => setActiveTab('integrations')} className={`sidebar-link w-full ${activeTab === 'integrations' ? 'active' : ''}`}>
          <Plug className="w-4 h-4 mr-3" /> Integrations
        </button>
        <button onClick={() => setActiveTab('advanced')} className={`sidebar-link w-full ${activeTab === 'advanced' ? 'active' : ''}`}>
          <FlaskConical className="w-4 h-4 mr-3" /> Advanced
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 industrial-card overflow-hidden self-start min-h-[600px]">
        {activeTab === 'models' && <div className="p-8"><ModelSelectionView /></div>}
        {activeTab === 'editor' && <EditorSettingsPanel />}
        {activeTab === 'integrations' && <IntegrationsHub />}
        {activeTab === 'advanced' && (
          <div className="p-8 space-y-6 animate-in fade-in duration-300">
            <div className="border-b border-white/5 pb-6">
              <h2 className="text-2xl font-industrial text-[var(--color-text-primary)] tracking-tight">Advanced</h2>
              <p className="text-xs text-gray-400 font-bold uppercase tracking-widest mt-1">
                Power surfaces kept out of the main navigation. Adversary and auditing run automatically inside the Autopilot pipeline; these pages are for direct access.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {ADVANCED_LINKS.map((l) => (
                <Link
                  key={l.to}
                  to={l.to}
                  className="group flex items-center justify-between gap-3 rounded-md border border-border-muted bg-surface-overlay px-4 py-3 hover:border-orange-500/60 transition-colors"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-[var(--color-text-primary)]">{l.label}</span>
                    <span className="block truncate text-[11px] text-gray-400">{l.note}</span>
                  </span>
                  <ArrowRight className="w-4 h-4 shrink-0 text-gray-500 group-hover:text-orange-400" />
                </Link>
              ))}
            </div>
          </div>
        )}
        {activeTab === 'profile' && (
          <div className="p-8 space-y-8 animate-in fade-in duration-300">
            <div className="border-b border-white/5 pb-6">
              <h2 className="text-2xl font-industrial text-[var(--color-text-primary)] tracking-tight">Operator Profile</h2>
              <p className="text-xs text-gray-400 font-bold uppercase tracking-widest mt-1">Manage your identity across the OpenHub node network.</p>
            </div>

            <div className="flex flex-col md:flex-row gap-8">
              <div className="space-y-6 flex-1">
                <div className="grid grid-cols-1 gap-6">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 block">Common Name</label>
                    <input type="text" defaultValue={currentUser.username} className="w-full bg-surface-overlay border border-border-muted rounded-sm px-4 py-2 text-sm text-[var(--color-text-primary)] focus:border-orange-500 outline-none transition-colors" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 block">Email</label>
                    <input type="email" value={profile?.email ?? ''} readOnly className="w-full bg-black/40 border border-border-muted rounded-sm px-4 py-2 text-sm text-gray-400 font-mono" />
                    <p className="text-[11px] text-gray-400 font-bold uppercase tracking-tighter">Change your email in the Emails tab.</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 block">Directive / Bio</label>
                    <textarea placeholder="Specify operational directives..." className="w-full bg-surface-overlay border border-border-muted rounded-sm px-4 py-2 text-sm text-[var(--color-text-primary)] focus:border-orange-500 outline-none h-24 transition-colors" />
                  </div>
                </div>
                <button className="bg-white text-black font-black px-6 py-2 text-xs uppercase tracking-widest hover:bg-orange-500 transition-all shadow-lg">
                  Archive Profile
                </button>
              </div>

              <div className="w-full md:w-64 space-y-4">
                <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 block">Avatar</label>
                <div className="relative group overflow-hidden rounded-sm border border-border-muted p-1 bg-black/40">
                   <img src={avatarSrc} className="w-full aspect-square object-cover" alt="" />
                   <button
                     onClick={() => fileRef.current?.click()}
                     className="absolute inset-0 bg-orange-500/80 flex flex-col items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                   >
                      {avatarBusy ? <Loader2 className="w-8 h-8 text-black mb-2 animate-spin" /> : <UploadCloud className="w-8 h-8 text-black mb-2 animate-bounce" />}
                      <span className="text-black text-[10px] font-black uppercase tracking-widest">{avatarBusy ? 'Uploading…' : 'Upload Avatar'}</span>
                   </button>
                </div>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={handleAvatarUpload} className="hidden" />
                <p className="text-[11px] text-gray-400 font-mono text-center uppercase tracking-tighter">PNG · JPG · WEBP · GIF (≤2MB)</p>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'ssh-keys' && (
          <div className="p-8 space-y-10 animate-in fade-in duration-300">
            <div className="flex items-center justify-between border-b border-white/5 pb-6">
              <div>
                <h2 className="text-2xl font-industrial text-[var(--color-text-primary)] tracking-tight">SSH and GPG Architecture</h2>
                <p className="text-xs text-gray-400 font-bold uppercase tracking-widest mt-1">Authorized keys for secure Git transport and commit validation.</p>
              </div>
              <button 
                onClick={() => setIsAddingKey(true)}
                className="bg-orange-500 text-black px-6 py-2 font-black text-[10px] uppercase tracking-widest hover:bg-white transition-all shadow-lg flex items-center"
              >
                <Plus className="w-4 h-4 mr-2" /> Inject New Key
              </button>
            </div>

            {isAddingKey && (
              <div className="bg-black border border-border-muted rounded-sm p-6 animate-in zoom-in-95 duration-200">
                <form onSubmit={handleAddKey} className="space-y-6">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 block">Identifier</label>
                    <input 
                      required
                      value={newKey.title}
                      onChange={e => setNewKey({...newKey, title: e.target.value})}
                      placeholder="e.g. WORKSTATION-A1"
                      className="w-full bg-surface-overlay border border-border-muted rounded-sm px-4 py-2 text-sm text-[var(--color-text-primary)] focus:border-orange-500 outline-none"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 block">Key Data (Public)</label>
                    <textarea 
                      required
                      value={newKey.key}
                      onChange={e => setNewKey({...newKey, key: e.target.value})}
                      placeholder="Begins with 'ssh-rsa' or similar cryptographic prefix..."
                      className="w-full bg-surface-overlay border border-border-muted rounded-sm px-4 py-2 text-sm text-[var(--color-text-primary)] font-mono focus:border-orange-500 outline-none h-32"
                    />
                  </div>
                  <div className="flex gap-4">
                    <button type="submit" className="flex-1 bg-white text-black font-black py-2 text-xs uppercase tracking-widest hover:bg-orange-500 transition-all">Submit Access Ticket</button>
                    <button type="button" onClick={() => setIsAddingKey(false)} className="px-6 py-2 border border-border-muted text-xs font-black text-gray-400 uppercase tracking-widest hover:bg-white/5">Abort</button>
                  </div>
                </form>
              </div>
            )}

            <div className="space-y-4">
              {sshKeys.length === 0 ? (
                <div className="text-center py-16 bg-black/40 rounded-sm border-dashed border border-border-muted">
                   <Key className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                   <div className="text-gray-400 font-black uppercase tracking-widest text-xs">No keys detected in keystore</div>
                   <div className="text-[10px] text-gray-400 font-mono mt-2 uppercase tracking-tighter">Please provide a public key for Git authentication.</div>
                </div>
              ) : (
                sshKeys.map(key => (
                  <div key={key.id} className="group p-6 industrial-card hover:bg-white/5 transition-all flex items-start justify-between">
                    <div className="flex items-start space-x-5">
                      <div className="p-3 rounded-sm bg-surface-overlay border border-border-muted text-gray-400 group-hover:text-orange-500 transition-colors">
                        <Key className="w-6 h-6 border-b-2 border-transparent group-hover:border-orange-500 pb-1" />
                      </div>
                      <div>
                        <h4 className="text-[var(--color-text-primary)] font-industrial text-xl leading-tight">{key.title}</h4>
                        <div className="mt-2 flex items-center">
                           <span className="text-[10px] font-mono text-gray-400 break-all max-w-[400px] truncate block px-2 py-1 bg-black/60 border border-white/5 rounded-sm">{key.key}</span>
                        </div>
                        <div className="mt-3 text-[10px] text-gray-400 font-black uppercase tracking-widest flex items-center">
                           <Clock className="w-3 h-3 mr-2" /> Timestamp: {formatDistanceToNow(new Date(key.createdAt))} ago
                        </div>
                      </div>
                    </div>
                    <button 
                      onClick={() => deleteSSHKey(key.id)}
                      className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-500/10 rounded-sm transition-all border border-transparent hover:border-red-500/20"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="bg-blue-500/5 border border-blue-500/20 p-6 rounded-sm flex items-start space-x-4">
               <div className="p-2 bg-blue-500/10 rounded-sm text-blue-500 border border-blue-500/20">
                  <ShieldCheck className="w-5 h-5" />
               </div>
               <div>
                  <h4 className="text-xs font-black text-[var(--color-text-primary)] uppercase tracking-widest">Protocol Recommendation</h4>
                  <p className="text-[10px] text-blue-300/70 mt-1 font-bold uppercase tracking-tight leading-relaxed">Signature verification is disabled. We mandate GPG or SSH signing for all production deployments to enforce identity integrity.</p>
               </div>
            </div>
          </div>
        )}

        {/* Emails */}
        {activeTab === 'emails' && (
          <div className="p-8 space-y-6 animate-in fade-in duration-300">
            <div className="border-b border-white/5 pb-6">
              <h2 className="text-2xl font-industrial text-[var(--color-text-primary)] tracking-tight">Email</h2>
              <p className="text-xs text-gray-400 font-bold uppercase tracking-widest mt-1">The address used to sign in and receive notifications.</p>
            </div>
            <div className="max-w-md space-y-3">
              <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 block">Email address</label>
              <input
                type="email"
                value={emailValue}
                onChange={(e) => setEmailValue(e.target.value)}
                className="w-full bg-surface-overlay border border-border-muted rounded-sm px-4 py-2 text-sm text-[var(--color-text-primary)] focus:border-orange-500 outline-none"
              />
              <button
                onClick={() => void handleEmailSave()}
                disabled={emailBusy}
                className="bg-orange-500 text-black px-6 py-2 font-black text-[10px] uppercase tracking-widest hover:bg-white transition-all flex items-center disabled:opacity-50"
              >
                {emailBusy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Save email
              </button>
              {emailMsg && <p className="text-xs font-mono text-gray-400">{emailMsg}</p>}
            </div>
          </div>
        )}

        {/* Password */}
        {activeTab === 'security' && (
          <div className="p-8 space-y-6 animate-in fade-in duration-300">
            <div className="border-b border-white/5 pb-6">
              <h2 className="text-2xl font-industrial text-[var(--color-text-primary)] tracking-tight">Password</h2>
              <p className="text-xs text-gray-400 font-bold uppercase tracking-widest mt-1">Change the password for this account.</p>
            </div>
            <div className="max-w-md space-y-3">
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 block">Current password</label>
                <input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} className="w-full bg-surface-overlay border border-border-muted rounded-sm px-4 py-2 text-sm text-[var(--color-text-primary)] focus:border-orange-500 outline-none" />
              </div>
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 block">New password</label>
                <input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} className="w-full bg-surface-overlay border border-border-muted rounded-sm px-4 py-2 text-sm text-[var(--color-text-primary)] focus:border-orange-500 outline-none" />
              </div>
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 block">Confirm new password</label>
                <input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} className="w-full bg-surface-overlay border border-border-muted rounded-sm px-4 py-2 text-sm text-[var(--color-text-primary)] focus:border-orange-500 outline-none" />
              </div>
              <button
                onClick={() => void handlePasswordSave()}
                disabled={pwBusy || !pw.next || !pw.confirm}
                className="bg-orange-500 text-black px-6 py-2 font-black text-[10px] uppercase tracking-widest hover:bg-white transition-all flex items-center disabled:opacity-50"
              >
                {pwBusy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Update password
              </button>
              {pwMsg && <p className="text-xs font-mono text-gray-400">{pwMsg}</p>}
            </div>
          </div>
        )}

        {/* Notifications */}
        {activeTab === 'notifications' && (
          <div className="p-8 space-y-6 animate-in fade-in duration-300">
            <div className="border-b border-white/5 pb-6">
              <h2 className="text-2xl font-industrial text-[var(--color-text-primary)] tracking-tight">Notifications</h2>
              <p className="text-xs text-gray-400 font-bold uppercase tracking-widest mt-1">Choose which events notify you.</p>
            </div>
            <div className="max-w-lg space-y-2">
              {[
                ['runComplete', 'Supervised run finished'],
                ['runFailed', 'Supervised run failed'],
                ['auditFailed', 'Audit verdict failed'],
                ['incidentDispatched', 'Repair auto-dispatched'],
                ['researchAnswered', 'Research found answers'],
              ].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => void toggleNotif(key)}
                  className="flex w-full items-center justify-between rounded border border-border-muted bg-surface-base px-4 py-3 hover:border-orange-500/40"
                >
                  <span className="text-sm font-bold text-[var(--color-text-primary)]">{label}</span>
                  <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${notifPrefs[key] ? 'bg-emerald-500/70' : 'bg-border-muted'}`}>
                    <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${notifPrefs[key] ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
