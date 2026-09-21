import { Link, useSearchParams } from 'react-router-dom';
import { Activity, ShieldCheck, Wrench, FileCode, FolderGit2, ArrowUpRight, ShieldAlert, GitPullRequest } from 'lucide-react';
import { useStore } from '../store';
import { AutonomousPipelines } from './AutonomousPipelines';
import { AuditSuiteView } from './AuditSuiteView';
import { ReceiptsView } from './ReceiptsView';
import { RepairTeamView } from './RepairTeamView';
import { TestingReadiness } from './TestingReadiness';
import { VulnerabilityScannerView } from '../components/VulnerabilityScannerView';
import { CodeReviewPanel } from '../components/CodeReviewPanel';
import { cn } from '../lib/utils';

const TABS = [
  { id: 'pipelines', label: 'Pipelines', icon: Activity },
  { id: 'audit', label: 'Audit', icon: ShieldCheck },
  { id: 'vulns', label: 'Vulnerabilities', icon: ShieldAlert },
  { id: 'review', label: 'Code Review', icon: GitPullRequest },
  { id: 'receipts', label: 'Receipts', icon: FolderGit2 },
  { id: 'repair', label: 'Repair', icon: Wrench },
  { id: 'readiness', label: 'Readiness', icon: FileCode },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** Quality assurance: pipelines, audit, repair, and readiness — one loaded
 *  project, full scope across every section. */
export function AssuranceView() {
  const [searchParams] = useSearchParams();
  const rawTab = searchParams.get('av') ?? searchParams.get('tab') ?? 'audit';
  const tab: TabId = TABS.some((t) => t.id === rawTab) ? (rawTab as TabId) : 'audit';
  const { activeProject, activeProjectLoading } = useStore();

  return (
    <div className="flex-1 w-full max-w-6xl mx-auto flex flex-col gap-5 px-4 py-6">
      {/* Hero — single loaded project, full scope */}
      <section className="gradient-hero rounded-2xl p-6 relative overflow-hidden">
        <div className="absolute -right-8 -top-12 opacity-[0.12] pointer-events-none">
          <ShieldCheck className="w-56 h-56 text-blue-300" strokeWidth={1} />
        </div>
        <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-blue-300">
          <ShieldCheck className="w-4 h-4" /> Quality · Assurance
        </div>
        <h2 className="mt-2">Verify, fix, and ship <span className="text-info">one project.</span></h2>
        <p className="mt-1.5 max-w-xl text-sm text-gray-400">
          Pipelines, audit, repair, and readiness all resolve the same loaded project — no re-targeting between sections.
        </p>
        {activeProject ? (
          <Link to="/workspace" className="mt-4 inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-300 hover:bg-emerald-500/15">
            <FolderGit2 className="w-3.5 h-3.5" />
            <span className="truncate max-w-[260px]">{activeProject.repositoryName}</span>
            <ArrowUpRight className="w-3 h-3 shrink-0" />
          </Link>
        ) : (
          <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-bold text-amber-300">
            {activeProjectLoading ? 'Reading project context…' : 'No project loaded — audit, repair, and pipelines need one.'}
          </div>
        )}
      </section>

      {/* Section tabs */}
      <nav className="flex gap-0.5 overflow-x-auto border-b border-surface-overlay -mb-2" aria-label="Assurance">
        {TABS.map((t) => (
          <Link
            key={t.id}
            to={t.id === 'audit' ? '/assurance' : `/assurance?av=${t.id}`}
            className={cn('repo-tab', tab === t.id && 'active')}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === 'pipelines' ? (
        <AutonomousPipelines />
      ) : tab === 'vulns' ? (
        <VulnerabilityScannerView />
      ) : tab === 'review' ? (
        <CodeReviewPanel />
      ) : tab === 'receipts' ? (
        <ReceiptsView />
      ) : tab === 'repair' ? (
        <RepairTeamView />
      ) : tab === 'readiness' ? (
        <TestingReadiness />
      ) : (
        <AuditSuiteView />
      )}
    </div>
  );
}
