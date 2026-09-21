import {
  Activity,
  Crosshair,
  FolderCode,
  Github,
  LayoutDashboard,
  Newspaper,
  Radar,
  Radio,
  Settings,
  ShieldCheck,
  Terminal,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  /** end: only active on the exact path (vs prefix match). */
  end?: boolean;
  /** Extra search terms for the command palette. */
  keywords?: string[];
};

export type NavGroup = { label: string; items: NavItem[] };

/** Single source of truth for the workspace IA. Sidebar and ⌘K share this. */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Business',
    items: [
      { to: '/crm', label: 'CRM', icon: Users, keywords: ['contacts', 'deals', 'pipeline', 'leads', 'sales', 'forecast', 'actions'] },
    ],
  },
  {
    label: 'Build',
    items: [
      { to: '/', label: 'Command', icon: LayoutDashboard, end: true, keywords: ['status', 'home', 'dashboard'] },
      { to: '/workspace', label: 'Workspace', icon: Terminal, keywords: ['code', 'editor', 'terminal', 'drift'] },
      { to: '/projects', label: 'Projects', icon: Github, keywords: ['repositories', 'repos', 'import', 'github', 'local folder'] },
      { to: '/api-studio', label: 'API Studio', icon: Radio, keywords: ['postman', 'mock', 'api', 'rest', 'swagger', 'openapi', 'contract'] },
    ],
  },
  {
    label: 'Autonomy',
    items: [
      { to: '/axiom', label: 'Loops', icon: Zap, keywords: ['axiom', 'loop console', 'missions', 'agents'] },
      { to: '/antagonist', label: 'Adversary', icon: Crosshair, keywords: ['antagonist', 'prospector', 'mutation', 'verification strength', 'opportunities', 'self-directed'] },
      { to: '/assurance', label: 'Assurance', icon: ShieldCheck, keywords: ['pipelines', 'audit', 'repair', 'readiness', 'tests'] },
      { to: '/fleet', label: 'Fleet', icon: Radar, keywords: ['agents', 'services', 'ecosystem', 'tools', 'registry'] },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/insights', label: 'Insights', icon: TrendingUp, keywords: ['telemetry', 'trends', 'recourse', 'synergy', 'self-learning', 'learning'] },
      { to: '/reporter', label: 'Reporter', icon: Newspaper, keywords: ['recourse', 'self-report', 'article', 'dispatch', 'narrative', 'writing'] },
      { to: '/activity', label: 'Activity', icon: Activity, keywords: ['feed', 'incidents', 'events', 'log'] },
      { to: '/settings', label: 'Settings', icon: Settings, keywords: ['preferences', 'account', 'integrations', 'keys'] },
    ],
  },
];

export const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

export const BREADCRUMBS: Record<string, string> = {
  '/': 'Command',
  '/crm': 'CRM',
  '/workspace': 'Workspace',
  '/projects': 'Projects',
  '/axiom': 'Loops',
  '/antagonist': 'Adversary',
  '/assurance': 'Assurance',
  '/fleet': 'Fleet',
  '/insights': 'Insights',
  '/reporter': 'Reporter',
  '/activity': 'Activity',
  '/settings': 'Settings',
};

/** Icons referenced by dynamic nav entries. */
export { FolderCode };