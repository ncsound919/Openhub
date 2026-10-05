import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { getCsrfToken } from '../auth/AuthProvider';
import {
  ShieldCheck,
  ShieldAlert,
  Hash,
  Terminal,
  Clock,
  Search,
  Anchor,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
  ChevronRight,
  Filter,
  Copy,
  Check,
  Cpu,
  Layers,
} from 'lucide-react';
import { cn } from '../lib/utils';

export interface ReceiptItem {
  id: string;
  digest: string;
  seq: number;
  prevHash: string;
  chainHash: string;
  kind: 'command' | 'probe' | 'bridge' | 'decision';
  command: string;
  tool?: string;
  cwd?: string;
  target?: string;
  scorer?: string;
  runId?: string;
  label?: string;
  status: 'passed' | 'failed' | 'timeout' | 'skipped' | 'unavailable';
  exitCode: number | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  outputBytes: number;
  outputDigest: string;
  outputTail: string;
}

export interface ChainStatus {
  head: { seq: number; chainHash: string };
  anchor: { seq: number; chainHash: string; at: string } | null;
  verification: { valid: boolean; checked: number; reason?: string; brokenAt?: number };
}

const KINDS = ['all', 'command', 'probe', 'decision'] as const;

export function ReceiptsView({ initialRunId }: { initialRunId?: string }) {
  const [receipts, setReceipts] = useState<ReceiptItem[]>([]);
  const [chain, setChain] = useState<ChainStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedReceipt, setSelectedReceipt] = useState<ReceiptItem | null>(null);

  // Filters
  const [runIdFilter, setRunIdFilter] = useState(initialRunId ?? '');
  const [scorerFilter, setScorerFilter] = useState('');
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [includeProbes, setIncludeProbes] = useState(false);
  const [isAnchoring, setIsAnchoring] = useState(false);
  const [anchorSuccess, setAnchorSuccess] = useState(false);

  // Copy feedback
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Per-receipt live verification results
  const [receiptVerifications, setReceiptVerifications] = useState<Record<string, { valid: boolean; loading: boolean }>>({});

  const verifyReceiptById = useCallback(async (id: string) => {
    setReceiptVerifications((prev) => ({ ...prev, [id]: { valid: false, loading: true } }));
    try {
      const res = await fetch(`/api/receipts/${id}/verify`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setReceiptVerifications((prev) => ({ ...prev, [id]: { valid: data.verification?.valid ?? false, loading: false } }));
      } else {
        setReceiptVerifications((prev) => ({ ...prev, [id]: { valid: false, loading: false } }));
      }
    } catch {
      setReceiptVerifications((prev) => ({ ...prev, [id]: { valid: false, loading: false } }));
    }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const chainRes = await fetch('/api/receipts/verify-chain', { credentials: 'include' });
      if (chainRes.ok) {
        const chainData = await chainRes.json();
        setChain(chainData);
      }

      const params = new URLSearchParams();
      if (runIdFilter.trim()) params.set('runId', runIdFilter.trim());
      if (scorerFilter.trim()) params.set('scorer', scorerFilter.trim());
      if (includeProbes || kindFilter === 'probe') params.set('includeProbes', '1');
      params.set('limit', '150');

      const receiptsRes = await fetch(`/api/receipts?${params.toString()}`, { credentials: 'include' });
      if (receiptsRes.ok) {
        const data = await receiptsRes.json();
        setReceipts(data.receipts || []);
      } else {
        setError('Failed to load receipts list');
      }
    } catch (err: any) {
      setError(err.message || 'Error fetching receipts');
    } finally {
      setLoading(false);
    }
  }, [runIdFilter, scorerFilter, includeProbes, kindFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleAnchor = async () => {
    setIsAnchoring(true);
    try {
      const res = await fetch('/api/receipts/anchor', {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': getCsrfToken() },
      });
      if (res.ok) {
        setAnchorSuccess(true);
        setTimeout(() => setAnchorSuccess(false), 3000);
        await loadData();
      }
    } finally {
      setIsAnchoring(false);
    }
  };

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const filteredReceipts = useMemo(() => {
    return receipts.filter((r) => {
      if (kindFilter !== 'all' && r.kind !== kindFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesCmd = r.command.toLowerCase().includes(q);
        const matchesId = r.id.toLowerCase().includes(q);
        const matchesScorer = (r.scorer || '').toLowerCase().includes(q);
        const matchesRun = (r.runId || '').toLowerCase().includes(q);
        if (!matchesCmd && !matchesId && !matchesScorer && !matchesRun) return false;
      }
      return true;
    });
  }, [receipts, kindFilter, searchQuery]);

  return (
    <div className="space-y-6">
      {/* Chain Status & Visual Proof Card */}
      <div className="bg-surface-raised border border-border-muted rounded-xl p-5 shadow-sm space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center space-x-3">
            <div
              className={cn(
                'w-10 h-10 rounded-lg flex items-center justify-center',
                chain?.verification?.valid
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  : 'bg-red-500/10 text-red-400 border border-red-500/20',
              )}
            >
              {chain?.verification?.valid ? (
                <ShieldCheck className="w-6 h-6" />
              ) : (
                <ShieldAlert className="w-6 h-6" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-gray-100">
                  Evidence Spine Cryptographic Chain
                </h3>
                <span
                  className={cn(
                    'text-[10px] font-mono px-2 py-0.5 rounded-full font-bold uppercase tracking-wide',
                    chain?.verification?.valid
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'bg-red-500/20 text-red-300',
                  )}
                >
                  {chain?.verification?.valid ? 'Verified & Tamper-Evident' : 'Chain Integrity Broken'}
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">
                Append-only HMAC hash chain with external head anchoring. Guards against delete, reorder, and end-truncation attacks.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleAnchor}
              disabled={isAnchoring}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors shadow-sm',
                anchorSuccess
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                  : 'bg-surface-base border-border-muted hover:bg-surface-overlay text-gray-200',
              )}
              title="Anchor current head to external storage to catch end-truncation"
            >
              {anchorSuccess ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Anchor className="w-3.5 h-3.5 text-blue-400" />}
              {isAnchoring ? 'Anchoring…' : anchorSuccess ? 'Anchored!' : 'Anchor Head'}
            </button>
            <button
              onClick={loadData}
              disabled={loading}
              className="p-1.5 rounded-lg bg-surface-base border border-border-muted text-gray-400 hover:text-gray-200"
              title="Refresh receipts and verify chain"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            </button>
          </div>
        </div>

        {/* Visual Chain Progression Bar */}
        {chain && (
          <div className="pt-3 border-t border-border-muted grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs font-mono">
            <div className="bg-surface-base p-3 rounded-lg border border-border-muted">
              <span className="text-[10px] text-gray-500 uppercase block font-sans">Chain Length</span>
              <span className="text-gray-200 font-bold text-sm">{chain.verification?.checked ?? 0} receipts</span>
            </div>

            <div className="bg-surface-base p-3 rounded-lg border border-border-muted">
              <span className="text-[10px] text-gray-500 uppercase block font-sans">Chain Head Seq</span>
              <span className="text-blue-400 font-bold text-sm">#{chain.head?.seq ?? 0}</span>
            </div>

            <div className="bg-surface-base p-3 rounded-lg border border-border-muted">
              <span className="text-[10px] text-gray-500 uppercase block font-sans">Head Hash</span>
              <span className="text-gray-300 text-[11px] truncate block" title={chain.head?.chainHash}>
                {chain.head?.chainHash ? `${chain.head.chainHash.slice(0, 14)}…` : 'Genesis'}
              </span>
            </div>

            <div className="bg-surface-base p-3 rounded-lg border border-border-muted">
              <span className="text-[10px] text-gray-500 uppercase block font-sans">External Anchor</span>
              {chain.anchor ? (
                <span className="text-emerald-400 font-bold text-[11px]">
                  Seq #{chain.anchor.seq} ({chain.anchor.at ? new Date(chain.anchor.at).toLocaleTimeString() : 'anchored'})
                </span>
              ) : (
                <span className="text-amber-400 text-[11px]">Unanchored head</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Filter and Search Toolbar */}
      <div className="bg-surface-base border border-border-muted rounded-xl p-3 flex flex-col md:flex-row items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
          {/* Search */}
          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search commands, run ID..."
              className="w-full pl-8 pr-3 py-1.5 bg-surface-raised border border-border-muted rounded-lg text-xs font-mono text-gray-200 placeholder:text-gray-500 focus:outline-none focus:border-blue-500/50"
            />
          </div>

          {/* Kind Filter Pills */}
          <div className="flex items-center gap-1 overflow-x-auto">
            {KINDS.map((k) => (
              <button
                key={k}
                onClick={() => setKindFilter(k)}
                className={cn(
                  'px-2.5 py-1 rounded-lg text-[11px] font-semibold uppercase tracking-wider transition-colors',
                  kindFilter === k
                    ? 'bg-blue-500 text-white shadow-sm'
                    : 'bg-surface-raised text-gray-400 hover:text-gray-200 border border-border-muted',
                )}
              >
                {k}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 w-full md:w-auto justify-end">
          <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeProbes}
              onChange={(e) => setIncludeProbes(e.target.checked)}
              className="accent-blue-500 rounded"
            />
            Include Fleet Probes
          </label>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-gray-400 hover:text-gray-200">✕</button>
        </div>
      )}

      {/* Receipts Table */}
      <div className="bg-surface-base border border-border-muted rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-surface-raised border-b border-border-muted text-gray-400 text-[10px] uppercase font-semibold">
              <tr>
                <th className="py-3 px-4">Seq</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Kind</th>
                <th className="py-3 px-4">Command / Operation</th>
                <th className="py-3 px-4">Scorer / Run</th>
                <th className="py-3 px-4">Duration</th>
                <th className="py-3 px-4 text-right">Integrity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-muted/50 font-mono">
              {loading && receipts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-gray-500 font-sans">
                    Loading cryptographic receipts…
                  </td>
                </tr>
              ) : filteredReceipts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-gray-500 font-sans">
                    No receipts matched query or filter.
                  </td>
                </tr>
              ) : (
                filteredReceipts.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => {
                      setSelectedReceipt(r);
                      if (!receiptVerifications[r.id]) verifyReceiptById(r.id);
                    }}
                    className="hover:bg-surface-raised/60 cursor-pointer transition-colors"
                  >
                    <td className="py-2.5 px-4 font-bold text-gray-400">#{r.seq}</td>
                    <td className="py-2.5 px-4">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase',
                          r.status === 'passed' && 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
                          r.status === 'failed' && 'bg-red-500/10 text-red-400 border border-red-500/20',
                          r.status === 'timeout' && 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
                        )}
                      >
                        {r.status === 'passed' && <CheckCircle2 className="w-3 h-3" />}
                        {r.status === 'failed' && <XCircle className="w-3 h-3" />}
                        {r.status === 'timeout' && <Clock className="w-3 h-3" />}
                        {r.status}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-gray-400 font-sans text-[11px] uppercase">{r.kind}</td>
                    <td className="py-2.5 px-4 font-bold text-gray-200 max-w-xs truncate">
                      {r.command}
                    </td>
                    <td className="py-2.5 px-4 text-gray-400 text-[11px]">
                      {r.scorer ? <span className="text-blue-400 font-bold">{r.scorer}</span> : '—'}
                      {r.runId && <span className="block text-[10px] text-gray-500 truncate max-w-[120px]">{r.runId}</span>}
                    </td>
                    <td className="py-2.5 px-4 text-gray-400 font-sans text-[11px]">{r.durationMs}ms</td>
                    <td className="py-2.5 px-4 text-right">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          verifyReceiptById(r.id);
                        }}
                        disabled={receiptVerifications[r.id]?.loading}
                        className="text-blue-400 hover:text-blue-300 font-sans text-[11px] font-semibold inline-flex items-center gap-1 disabled:opacity-50"
                      >
                        {receiptVerifications[r.id]?.loading ? (
                          <RefreshCw className="w-3 h-3 animate-spin" />
                        ) : receiptVerifications[r.id] !== undefined ? (
                          receiptVerifications[r.id].valid ? (
                            <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                          ) : (
                            <XCircle className="w-3 h-3 text-red-400" />
                          )
                        ) : (
                          <ChevronRight className="w-3 h-3" />
                        )}
                        {receiptVerifications[r.id]?.loading
                          ? 'Verifying…'
                          : receiptVerifications[r.id] !== undefined
                          ? receiptVerifications[r.id].valid
                            ? 'Verified'
                            : 'Tampered!'
                          : 'Verify'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Selected Receipt Detail Modal / Drawer */}
      {selectedReceipt && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-surface-raised border border-border-muted rounded-xl max-w-2xl w-full p-6 space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-border-muted pb-3">
              <div>
                <h4 className="text-base font-bold text-gray-100 flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-blue-400" />
                  Receipt #{selectedReceipt.seq} · {selectedReceipt.id}
                </h4>
                <div className="text-xs text-gray-400 mt-0.5">
                  Executed at {new Date(selectedReceipt.startedAt).toLocaleString()} ({selectedReceipt.durationMs}ms)
                </div>
              </div>
              <button
                onClick={() => setSelectedReceipt(null)}
                className="text-gray-400 hover:text-gray-200 p-1"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs font-mono bg-surface-base p-3 rounded-lg border border-border-muted">
              <div>
                <span className="text-[10px] text-gray-400 uppercase font-sans block">Command</span>
                <span className="text-gray-100 font-bold">{selectedReceipt.command}</span>
              </div>
              <div>
                <span className="text-[10px] text-gray-400 uppercase font-sans block">Exit Code</span>
                <span className={selectedReceipt.exitCode === 0 ? 'text-emerald-400' : 'text-red-400'}>
                  {selectedReceipt.exitCode !== null ? selectedReceipt.exitCode : 'None (timeout/sig)'}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-gray-400 uppercase font-sans block">Working Directory</span>
                <span className="text-gray-300 truncate block">{selectedReceipt.cwd || 'default'}</span>
              </div>
              <div>
                <span className="text-[10px] text-gray-400 uppercase font-sans block">Tagged Scorer / Run</span>
                <span className="text-blue-300">{selectedReceipt.scorer || 'none'}</span>
                {selectedReceipt.runId && <span className="text-gray-500 block text-[10px]">{selectedReceipt.runId}</span>}
              </div>
            </div>

            {/* Cryptographic Integrity Details */}
            <div className="space-y-2 bg-surface-base p-3 rounded-lg border border-border-muted text-xs font-mono">
              <div className="flex items-center justify-between pb-1 border-b border-border-muted/50">
                <span className="text-[10px] font-sans font-bold text-gray-300 uppercase">Cryptographic Hashes</span>
                {receiptVerifications[selectedReceipt.id] === undefined ? (
                  <button
                    onClick={() => verifyReceiptById(selectedReceipt.id)}
                    className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 text-[10px] font-sans font-bold"
                  >
                    <ShieldCheck className="w-3 h-3" /> Verify Digest
                  </button>
                ) : receiptVerifications[selectedReceipt.id].loading ? (
                  <span className="inline-flex items-center gap-1 text-gray-400 text-[10px] font-sans font-bold">
                    <RefreshCw className="w-3 h-3 animate-spin" /> Verifying…
                  </span>
                ) : receiptVerifications[selectedReceipt.id].valid ? (
                  <span className="inline-flex items-center gap-1 text-emerald-400 text-[10px] font-sans font-bold">
                    <CheckCircle2 className="w-3 h-3" /> Digest Verified ✓
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-red-400 text-[10px] font-sans font-bold">
                    <XCircle className="w-3 h-3" /> Tampered / Invalid
                  </span>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between text-[10px] text-gray-500">
                  <span>Content Digest:</span>
                  <button
                    onClick={() => copyToClipboard(selectedReceipt.digest, 'digest')}
                    className="text-gray-400 hover:text-gray-200 inline-flex items-center gap-0.5"
                  >
                    {copiedKey === 'digest' ? <Check className="w-2.5 h-2.5 text-emerald-400" /> : <Copy className="w-2.5 h-2.5" />}
                    {copiedKey === 'digest' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <span className="text-gray-300 text-[11px] break-all">{selectedReceipt.digest}</span>
              </div>

              <div>
                <div className="flex items-center justify-between text-[10px] text-gray-500">
                  <span>Previous Chain Hash:</span>
                  <button
                    onClick={() => copyToClipboard(selectedReceipt.prevHash, 'prevHash')}
                    className="text-gray-400 hover:text-gray-200 inline-flex items-center gap-0.5"
                  >
                    {copiedKey === 'prevHash' ? <Check className="w-2.5 h-2.5 text-emerald-400" /> : <Copy className="w-2.5 h-2.5" />}
                    {copiedKey === 'prevHash' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <span className="text-gray-400 text-[11px] break-all">{selectedReceipt.prevHash}</span>
              </div>

              <div>
                <div className="flex items-center justify-between text-[10px] text-gray-500">
                  <span>Chain Hash (HMAC):</span>
                  <button
                    onClick={() => copyToClipboard(selectedReceipt.chainHash, 'chainHash')}
                    className="text-gray-400 hover:text-gray-200 inline-flex items-center gap-0.5"
                  >
                    {copiedKey === 'chainHash' ? <Check className="w-2.5 h-2.5 text-emerald-400" /> : <Copy className="w-2.5 h-2.5" />}
                    {copiedKey === 'chainHash' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <span className="text-blue-300 text-[11px] break-all">{selectedReceipt.chainHash}</span>
              </div>
            </div>

            {/* Output Tail Viewer */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs font-sans">
                <span className="font-bold text-gray-300 uppercase text-[10px]">Execution Output Tail</span>
                <span className="text-[11px] text-gray-500 font-mono">{selectedReceipt.outputBytes} bytes</span>
              </div>
              <pre className="p-3 bg-surface-base border border-border-muted rounded-lg text-xs font-mono text-gray-300 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                {selectedReceipt.outputTail || '<empty output>'}
              </pre>
            </div>

            <div className="pt-2 flex justify-end">
              <button
                onClick={() => setSelectedReceipt(null)}
                className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-surface-base border border-border-muted hover:bg-surface-overlay text-gray-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
