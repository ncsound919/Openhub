import React, { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { LoginPage } from './auth/LoginPage';
import { Layout } from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';

// Route-level code splitting (E2): every page is its own chunk, so the initial
// bundle no longer ships the heavy graph (three.js/visualize), Studio, audit
// tools, etc. Login + the Layout shell stay eager so the first paint is instant.
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const RepoLayout = lazy(() => import('./pages/RepoLayout').then((m) => ({ default: m.RepoLayout })));
const CodeView = lazy(() => import('./pages/CodeView').then((m) => ({ default: m.CodeView })));
const IssuesView = lazy(() => import('./pages/IssuesView').then((m) => ({ default: m.IssuesView })));
const PullsView = lazy(() => import('./pages/PullsView').then((m) => ({ default: m.PullsView })));
const ActionsView = lazy(() => import('./pages/ActionsView').then((m) => ({ default: m.ActionsView })));
const ProjectsView = lazy(() => import('./pages/ProjectsView').then((m) => ({ default: m.ProjectsView })));
const WikiView = lazy(() => import('./pages/WikiView').then((m) => ({ default: m.WikiView })));
const CommitsView = lazy(() => import('./pages/CommitsView').then((m) => ({ default: m.CommitsView })));
const ExtensionsView = lazy(() => import('./pages/ExtensionsView').then((m) => ({ default: m.ExtensionsView })));
const UserSettingsView = lazy(() => import('./pages/UserSettingsView').then((m) => ({ default: m.UserSettingsView })));
const SettingsView = lazy(() => import('./pages/SettingsView').then((m) => ({ default: m.SettingsView })));
const WorkspacePage = lazy(() => import('./ide/WorkspacePage').then((m) => ({ default: m.WorkspacePage })));
const StudioPage = lazy(() => import('./ide/StudioPage').then((m) => ({ default: m.StudioPage })));
const FleetPanel = lazy(() => import('./pages/FleetPanel').then((m) => ({ default: m.FleetPanel })));
const AxiomHarnessView = lazy(() => import('./pages/AxiomHarnessView').then((m) => ({ default: m.AxiomHarnessView })));
const AssuranceView = lazy(() => import('./pages/AssuranceView').then((m) => ({ default: m.AssuranceView })));
const GitHubIntegrationPage = lazy(() => import('./pages/GitHubIntegrationPage').then((m) => ({ default: m.GitHubIntegrationPage })));
const ActivityView = lazy(() => import('./pages/ActivityView').then((m) => ({ default: m.ActivityView })));
const InsightsView = lazy(() => import('./pages/InsightsView').then((m) => ({ default: m.InsightsView })));
const ReporterView = lazy(() => import('./pages/ReporterView').then((m) => ({ default: m.ReporterView })));
const CrmView = lazy(() => import('./pages/CrmView').then((m) => ({ default: m.CrmView })));
const ApiStudioView = lazy(() => import('./components/ApiStudioView').then((m) => ({ default: m.ApiStudioView })));
const ModelSelectionView = lazy(() => import('./pages/ModelSelectionView').then((m) => ({ default: m.ModelSelectionView })));
const AntagonistView = lazy(() => import('./pages/AntagonistView').then((m) => ({ default: m.AntagonistView })));

function RouteFallback() {
  return (
    <div role="status" aria-live="polite" className="flex min-h-[240px] flex-1 items-center justify-center">
      <div className="font-mono text-xs text-[var(--color-text-muted)]">Loading view…</div>
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <div data-loading="auth" className="min-h-screen flex items-center justify-center" style={{ background: 'var(--color-bg-base)' }}><div className="text-gray-400">Loading OpenHub…</div></div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--color-bg-base)' }}>
        <div className="text-gray-400 font-mono text-sm">Loading OpenHub…</div>
      </div>
    );
  }

  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
        <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
          <Route index element={<Dashboard />} />
          {/* Primary IA surfaces */}
          <Route path="projects" element={<GitHubIntegrationPage />} />
          <Route path="crm" element={<CrmView />} />
          <Route path="assurance" element={<AssuranceView />} />
          <Route path="activity" element={<ActivityView />} />
          <Route path="insights" element={<InsightsView />} />
          <Route path="reporter" element={<ReporterView />} />
          {/* Consolidated surfaces: old standalone routes redirect to their hub tab */}
          <Route path="registry" element={<Navigate to="/fleet?tab=ecosystem" replace />} />
          <Route path="integrations" element={<Navigate to="/settings?tab=integrations" replace />} />
          <Route path="github" element={<Navigate to="/projects" replace />} />
          <Route path="fleet" element={<FleetPanel />} />
          <Route path="axiom" element={<AxiomHarnessView />} />
          <Route path="antagonist" element={<AntagonistView />} />
          {/* Quality: pipelines + audit + repair + readiness live in assurance */}
          <Route path="autonomous" element={<Navigate to="/assurance?tab=pipelines" replace />} />
          <Route path="audit" element={<Navigate to="/assurance?tab=audit" replace />} />
          <Route path="repair" element={<Navigate to="/assurance?tab=repair" replace />} />
          <Route path="readiness" element={<Navigate to="/assurance?tab=readiness" replace />} />
          <Route path="api-studio" element={<ApiStudioView />} />
          <Route path="vulns" element={<Navigate to="/assurance?tab=vulns" replace />} />
          <Route path="review" element={<Navigate to="/assurance?tab=review" replace />} />
          <Route path="testing" element={<Navigate to="/assurance?tab=readiness" replace />} />
          <Route path="services" element={<Navigate to="/fleet?tab=services" replace />} />
          <Route path="ecosystem" element={<Navigate to="/fleet?tab=ecosystem" replace />} />
          <Route path="settings" element={<UserSettingsView />} />
          <Route path="models" element={<ModelSelectionView />} />
          <Route path="workspace" element={<WorkspacePage />} />
          <Route path="workspace/:owner/:repo" element={<WorkspacePage />} />
          <Route path="studio" element={<StudioPage />} />
          <Route path=":owner/:repo" element={<RepoLayout />}>
            <Route index element={<CodeView />} />
            <Route path="commits" element={<CommitsView />} />
            <Route path="issues" element={<IssuesView />} />
            <Route path="pulls" element={<PullsView />} />
            <Route path="actions" element={<ActionsView />} />
            <Route path="projects" element={<ProjectsView />} />
            <Route path="wiki" element={<WikiView />} />
            <Route path="extensions" element={<ExtensionsView />} />
            <Route path="settings" element={<SettingsView />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
