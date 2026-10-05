import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
  ShieldCheck,
  Server,
  Terminal,
  Cpu,
  Database,
  Radio,
  Sparkles,
  Search,
  Filter,
  Layers,
  ChevronRight,
  Info,
} from 'lucide-react';
import { cn } from '../lib/utils';
import type { BridgeProbeResult, FleetCapabilitiesSnapshot } from '../services/capabilityProbe';

const CATEGORY_ICONS: Record<string, React.ElementType> = {
  core: Cpu,
  audit: ShieldCheck,
  repair: Activity,
  llm: Sparkles,
  memory: Database,
  queue: Radio,
};

const CATEGORIES = ['all', 'core', 'audit', 'repair', 'llm', 'memory', 'queue'] as const;
const STATUS_OPTIONS = ['all', 'online', 'degraded', 'offline'] as const;

export function CapabilityGrid() {
  const [snapshot, setSnapshot] = useState<FleetCapabilitiesSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Filters & selection
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [inspectedBridge, setInspectedBridge] = useState<BridgeProbeResult | null>(null);

  const fetchCapabilities = async (forceRefresh = false) => {
    if (forceRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const url = forceRefresh ? '/api/fleet/capabilities?refresh=1' : '/api/fleet/capabilities';
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSnapshot(data);
      if (inspectedBridge) {
        const updated = (data.bridges as BridgeProbeResult[]).find((b) => b.slug === inspectedBridge.slug);
        if (updated) setInspectedBridge(updated);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to probe fleet capabilities');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchCapabilities();
  }, []);

  const filteredBridges = useMemo(() => {
    if (!snapshot?.bridges) return [];
    return snapshot.bridges.filter((b) => {
      if (selectedCategory !== 'all' && b.category !== selectedCategory) return false;
      if (selectedStatus !== 'all' && b.status !== selectedStatus) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesName = b.name.toLowerCase().includes(q);
        const matchesSlug = b.slug.toLowerCase().includes(q);
        const matchesOps = b.operations.some((op) => op.id.toLowerCase().includes(q) || op.description.toLowerCase().includes(q));
        const matchesEndpoint = (b.endpoint || '').toLowerCase().includes(q);
        if (!matchesName && !matchesSlug && !matchesOps && !matchesEndpoint) return false;
      }
      return true;
    });
  }, [snapshot, selectedCategory, selectedStatus, searchQuery]);

  return (
    <div className="space-y-6">
      {/* Overview header & summary chips */}
      <div className="bg-surface-raised border border-border-muted rounded-xl p-5 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Server className="w-5 h-5 text-blue-400" />
              <h3 className="text-base font-bold text-gray-100">Fleet Capability Cockpit</h3>
              <span className="text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded font-mono font-bold">
                FHIR / MCP Schema
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              Active capability grid across all declared fleet bridges. Every row reflects an honest probe linked to an immutable evidence receipt.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => fetchCapabilities(true)}
              disabled={loading || refreshing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-surface-base border border-border-muted hover:bg-surface-overlay text-gray-200 transition-colors shadow-sm"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
              {refreshing ? 'Probing Fleet…' : 'Sweep Probe'}
            </button>
          </div>
        </div>

        {snapshot && (
          <div className="mt-4 pt-4 border-t border-border-muted grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs font-mono">
            <div
              onClick={() => setSelectedStatus(selectedStatus === 'online' ? 'all' : 'online')}
              className={cn(
                'flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors border',
                selectedStatus === 'online' ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-surface-base border-transparent hover:border-border-muted',
              )}
            >
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
              <div>
                <span className="text-[10px] text-gray-400 uppercase tracking-wider block font-sans">Online</span>
                <span className="text-emerald-400 font-bold">{snapshot.summary?.online ?? 0}</span>
              </div>
            </div>

            <div
              onClick={() => setSelectedStatus(selectedStatus === 'degraded' ? 'all' : 'degraded')}
              className={cn(
                'flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors border',
                selectedStatus === 'degraded' ? 'bg-amber-500/10 border-amber-500/30' : 'bg-surface-base border-transparent hover:border-border-muted',
              )}
            >
              <div className="w-2.5 h-2.5 rounded-full bg-amber-500" />
              <div>
                <span className="text-[10px] text-gray-400 uppercase tracking-wider block font-sans">Degraded</span>
                <span className="text-amber-400 font-bold">{snapshot.summary?.degraded ?? 0}</span>
              </div>
            </div>

            <div
              onClick={() => setSelectedStatus(selectedStatus === 'offline' ? 'all' : 'offline')}
              className={cn(
                'flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors border',
                selectedStatus === 'offline' ? 'bg-red-500/10 border-red-500/30' : 'bg-surface-base border-transparent hover:border-border-muted',
              )}
            >
              <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
              <div>
                <span className="text-[10px] text-gray-400 uppercase tracking-wider block font-sans">Offline</span>
                <span className="text-red-400 font-bold">{snapshot.summary?.offline ?? 0}</span>
              </div>
            </div>

            <div className="p-2">
              <span className="text-[10px] text-gray-400 uppercase tracking-wider block font-sans">Last Sweep</span>
              <span className="text-gray-300 text-[11px]">
                {snapshot.probedAt ? new Date(snapshot.probedAt).toLocaleTimeString() : '—'} {snapshot.cached ? '(cached)' : '(live)'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Filter and Search Toolbar */}
      <div className="bg-surface-base border border-border-muted rounded-xl p-3 flex flex-col md:flex-row items-center justify-between gap-3">
        {/* Search */}
        <div className="relative w-full md:w-72">
          <Search className="w-3.5 h-3.5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search bridges, operations..."
            className="w-full pl-8 pr-3 py-1.5 bg-surface-raised border border-border-muted rounded-lg text-xs font-mono text-gray-200 placeholder:text-gray-500 focus:outline-none focus:border-blue-500/50"
          />
        </div>

        {/* Category Pills */}
        <div className="flex flex-wrap items-center gap-1.5 w-full md:w-auto overflow-x-auto">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={cn(
                'px-2.5 py-1 rounded-lg text-[11px] font-semibold uppercase tracking-wider transition-colors',
                selectedCategory === cat
                  ? 'bg-blue-500 text-white shadow-sm'
                  : 'bg-surface-raised text-gray-400 hover:text-gray-200 border border-border-muted',
              )}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Capability Grid Table */}
      <div className="bg-surface-base border border-border-muted rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-surface-raised border-b border-border-muted text-gray-400 text-[10px] uppercase font-semibold">
              <tr>
                <th className="py-3 px-4">Bridge</th>
                <th className="py-3 px-4">Category</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Endpoint / Transport</th>
                <th className="py-3 px-4">Operations</th>
                <th className="py-3 px-4">Latency</th>
                <th className="py-3 px-4 text-right">Evidence Receipt</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-muted/50 font-sans">
              {loading && !snapshot ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-gray-500">
                    Probing fleet capabilities...
                  </td>
                </tr>
              ) : filteredBridges.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-gray-500 font-mono">
                    No bridges matched criteria. Try changing filters or search terms.
                  </td>
                </tr>
              ) : (
                filteredBridges.map((bridge) => {
                  const Icon = (CATEGORY_ICONS[bridge.category] || Server) as React.FC<{ className?: string }>;
                  return (
                    <tr
                      key={bridge.slug}
                      onClick={() => setInspectedBridge(bridge)}
                      className="hover:bg-surface-raised/60 cursor-pointer transition-colors"
                    >
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2.5">
                          <div className="p-1.5 rounded-lg bg-surface-raised border border-border-muted text-gray-300">
                            <Icon className="w-4 h-4" />
                          </div>
                          <div>
                            <div className="font-bold text-gray-100 flex items-center gap-1.5">
                              {bridge.name}
                              {bridge.version && (
                                <span className="text-[10px] font-mono font-normal text-gray-400">
                                  v{bridge.version}
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] font-mono text-gray-500">{bridge.slug}</div>
                          </div>
                        </div>
                      </td>

                      <td className="py-3 px-4">
                        <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-surface-raised text-gray-300 border border-border-muted">
                          {bridge.category}
                        </span>
                      </td>

                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase',
                              bridge.status === 'online' && 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
                              bridge.status === 'degraded' && 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
                              bridge.status === 'offline' && 'bg-red-500/10 text-red-400 border border-red-500/20',
                            )}
                          >
                            {bridge.status === 'online' && <CheckCircle2 className="w-3 h-3" />}
                            {bridge.status === 'degraded' && <AlertTriangle className="w-3 h-3" />}
                            {bridge.status === 'offline' && <XCircle className="w-3 h-3" />}
                            {bridge.status}
                          </span>
                          {bridge.reason && (
                            <span className="text-[10px] text-gray-500 truncate max-w-[140px]" title={bridge.reason}>
                              ({bridge.reason})
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="py-3 px-4 font-mono text-[11px] text-gray-400 max-w-xs truncate">
                        {bridge.endpoint || bridge.transport}
                      </td>

                      <td className="py-3 px-4">
                        <div className="flex flex-wrap gap-1 max-w-xs">
                          {bridge.operations.slice(0, 3).map((op) => (
                            <span
                              key={op.id}
                              className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-raised text-blue-300 border border-border-muted"
                              title={op.description}
                            >
                              {op.id}
                            </span>
                          ))}
                          {bridge.operations.length > 3 && (
                            <span className="text-[10px] font-mono text-gray-500">
                              +{bridge.operations.length - 3}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="py-3 px-4 font-mono text-gray-400 text-[11px]">
                        {bridge.latencyMs}ms
                      </td>

                      <td className="py-3 px-4 text-right">
                        {bridge.lastReceiptId ? (
                          <Link
                            to={`/assurance?av=receipts&runId=${bridge.lastReceiptId}`}
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 font-mono font-semibold"
                          >
                            {bridge.lastReceiptId.slice(0, 10)}…
                            <ExternalLink className="w-3 h-3" />
                          </Link>
                        ) : (
                          <span className="text-gray-500 font-mono text-[11px]">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Inspected Bridge Detail Drawer / Modal */}
      {inspectedBridge && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-surface-raised border border-border-muted rounded-xl max-w-2xl w-full p-6 space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-border-muted pb-3">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-lg bg-surface-base border border-border-muted text-blue-400">
                  <Server className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-base font-bold text-gray-100 flex items-center gap-2">
                    {inspectedBridge.name}
                    <span className="text-xs font-mono text-gray-400">({inspectedBridge.slug})</span>
                  </h4>
                  <div className="text-xs text-gray-400 mt-0.5">
                    Category: <span className="text-gray-200 font-bold uppercase">{inspectedBridge.category}</span> · Transport: <span className="font-mono text-gray-300">{inspectedBridge.transport}</span>
                  </div>
                </div>
              </div>
              <button
                onClick={() => setInspectedBridge(null)}
                className="text-gray-400 hover:text-gray-200 p-1"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs font-mono bg-surface-base p-3 rounded-lg border border-border-muted">
              <div>
                <span className="text-[10px] text-gray-400 uppercase font-sans block">Health Status</span>
                <span className={cn(
                  'font-bold uppercase',
                  inspectedBridge.status === 'online' && 'text-emerald-400',
                  inspectedBridge.status === 'degraded' && 'text-amber-400',
                  inspectedBridge.status === 'offline' && 'text-red-400',
                )}>
                  {inspectedBridge.status} {inspectedBridge.reason && `(${inspectedBridge.reason})`}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-gray-400 uppercase font-sans block">Probe Latency</span>
                <span className="text-gray-200">{inspectedBridge.latencyMs}ms</span>
              </div>
              <div>
                <span className="text-[10px] text-gray-400 uppercase font-sans block">Endpoint / Port</span>
                <span className="text-gray-300 truncate block">{inspectedBridge.endpoint || inspectedBridge.transport}</span>
              </div>
              <div>
                <span className="text-[10px] text-gray-400 uppercase font-sans block">Declared Version</span>
                <span className="text-gray-300">{inspectedBridge.version || 'Unversioned / Dynamic'}</span>
              </div>
            </div>

            {/* Supported Operations */}
            <div className="space-y-2">
              <span className="text-xs font-bold text-gray-300 uppercase font-sans block">
                Supported Operations ({inspectedBridge.operations.length})
              </span>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {inspectedBridge.operations.map((op) => (
                  <div
                    key={op.id}
                    className="p-2.5 rounded-lg bg-surface-base border border-border-muted text-xs space-y-0.5"
                  >
                    <div className="font-mono font-bold text-blue-400 flex items-center justify-between">
                      <span>{op.id}</span>
                    </div>
                    <p className="text-gray-400 text-[11px]">{op.description}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Evidence Link */}
            {inspectedBridge.lastReceiptId && (
              <div className="pt-2 border-t border-border-muted flex items-center justify-between">
                <span className="text-xs text-gray-400">Backed by cryptographic evidence receipt:</span>
                <Link
                  to={`/assurance?av=receipts&runId=${inspectedBridge.lastReceiptId}`}
                  className="inline-flex items-center gap-1 text-xs font-mono font-bold text-blue-400 hover:text-blue-300"
                >
                  View Receipt #{inspectedBridge.lastReceiptId.slice(0, 12)}…
                  <ExternalLink className="w-3.5 h-3.5" />
                </Link>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
