import {
  FolderCode,
  LayoutDashboard,
  Newspaper,
  Settings,
  Terminal,
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

/**
 * Single source of truth for the workspace IA. Sidebar and ⌘K share this.
 *
 * Kept deliberately small. Adversary, auditing, API Studio, insights, activity
 * and CRM are NOT top-level destinations — the adversary and audit run inside
 * the autonomous pipeline, insights/activity are tabs of Reporter, and the rest
 * are reachable from Settings → Advanced. A navigation bar is not a feature
 * list; every entry here must be something you do regularly.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Build',
    items: [
      { to: '/', label: 'Command', icon: LayoutDashboard, end: true, keywords: ['status', 'home', 'dashboard', 'control', 'console', 'run', 'projects', 'repositories'] },
      { to: '/workspace', label: 'Workspace', icon: Terminal, keywords: ['code', 'editor', 'terminal', 'drift', 'agent', 'files', 'axiom'] },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/reporter', label: 'Reporter', icon: Newspaper, keywords: ['insights', 'activity', 'recourse', 'trends', 'self-report', 'findings', 'discoveries', 'tips'] },
      { to: '/settings', label: 'Settings', icon: Settings, keywords: ['preferences', 'account', 'integrations', 'keys', 'advanced', 'labs', 'fleet', 'models'] },
    ],
  },
];

export const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

export const BREADCRUMBS: Record<string, string> = {
  '/': 'Command',
  '/workspace': 'Workspace',
  '/reporter': 'Reporter',
  '/settings': 'Settings',
  // Retained for deep links into the surfaces that no longer sit in the rail.
  '/projects': 'Projects',
  '/fleet': 'Fleet',
  '/assurance': 'Assurance',
  '/axiom': 'Loops',
  '/insights': 'Insights',
  '/activity': 'Activity',
  '/antagonist': 'Adversary',
  '/api-studio': 'API Studio',
  '/crm': 'CRM',
};

/** Icons referenced by dynamic nav entries. */
export { FolderCode };
