import React, { Suspense, lazy } from 'react';
import { Navigate } from 'react-router-dom';
import { useIsMobile } from '../lib/useIsMobile';

const Dashboard = lazy(() => import('../pages/Dashboard').then((m) => ({ default: m.Dashboard })));

export function MobileHomeRedirect() {
  const isMobile = useIsMobile();
  if (isMobile) return <Navigate to="/editor" replace />;
  return (
    <Suspense fallback={<div className="flex min-h-[240px] flex-1 items-center justify-center"><div className="font-mono text-xs text-[var(--color-text-muted)]">Loading view…</div></div>}>
      <Dashboard />
    </Suspense>
  );
}