import React, { useState, useEffect, useMemo } from 'react';
import { getCsrfToken } from '../auth/AuthProvider';
import {
  Send,
  Server,
  Play,
  Square,
  RefreshCw,
  Search,
  CheckCircle2,
  AlertTriangle,
  Copy,
  Check,
  Code2,
  Sliders,
  Radio,
  Clock,
  Layers,
  ArrowRight,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useStore } from '../store';
import type { DiscoveredEndpoint, RequestExecutionResult, MockServerConfig } from '../services/apiStudio';

const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  POST: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  PUT: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  PATCH: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  DELETE: 'bg-red-500/15 text-red-400 border-red-500/30',
};

export function ApiStudioView() {
  const { activeProject } = useStore();
  const [endpoints, setEndpoints] = useState<DiscoveredEndpoint[]>([]);
  const [selectedEndpoint, setSelectedEndpoint] = useState<DiscoveredEndpoint | null>(null);
  const [loadingEndpoints, setLoadingEndpoints] = useState(false);

  // Request form state
  const [method, setMethod] = useState<'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'>('GET');
  const [url, setUrl] = useState('http://localhost:4050/api/health');
  const [activeTab, setActiveTab] = useState<'body' | 'headers' | 'contract'>('headers');
  const [headersText, setHeadersText] = useState('{\n  "Accept": "application/json"\n}');
  const [bodyText, setBodyText] = useState('{\n  \n}');

  // Execution state
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<RequestExecutionResult | null>(null);
  const [copied, setCopied] = useState(false);

  // Mock server state
  const [mockConfig, setMockConfig] = useState<MockServerConfig>({
    port: 4050,
    active: false,
    latencyMs: 30,
    errorRate: 0,
    endpointsCount: 0,
  });
  const [mockLoading, setMockLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const loadEndpoints = async () => {
    if (!activeProject?.path) return;
    setLoadingEndpoints(true);
    try {
      const res = await fetch(`/api/studio/endpoints?targetDir=${encodeURIComponent(activeProject.path)}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setEndpoints(data.endpoints || []);
        if (!selectedEndpoint && data.endpoints?.length > 0) {
          handleSelectEndpoint(data.endpoints[0]);
        }
      }
    } catch {
      /* ignore */
    } finally {
      setLoadingEndpoints(false);
    }
  };

  const loadMockStatus = async () => {
    try {
      const res = await fetch('/api/studio/mock/status', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setMockConfig(data.config);
      }
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    loadEndpoints();
    loadMockStatus();
  }, [activeProject?.path]);

  const handleSelectEndpoint = (ep: DiscoveredEndpoint) => {
    setSelectedEndpoint(ep);
    setMethod(ep.method);
    const mockHost = mockConfig.active ? `http://localhost:${mockConfig.port}` : 'http://localhost:3000';
    setUrl(`${mockHost}${ep.path}`);

    if (ep.requestBodySchema) {
      setBodyText(JSON.stringify(ep.requestBodySchema.example || {}, null, 2));
      setActiveTab('body');
    }
  };

  const handleSendRequest = async () => {
    setExecuting(true);
    setResult(null);

    let parsedHeaders: Record<string, string> = {};
    try {
      parsedHeaders = JSON.parse(headersText);
    } catch {
      parsedHeaders = {};
    }

    let parsedBody: any = undefined;
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        parsedBody = bodyText;
      }
    }

    try {
      const res = await fetch('/api/studio/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        credentials: 'include',
        body: JSON.stringify({
          url,
          method,
          headers: parsedHeaders,
          body: parsedBody,
          expectedSchema: selectedEndpoint?.responses?.['200']?.schema,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setResult(data.result);
      } else {
        setResult({
          status: 500,
          statusText: 'Studio Error',
          durationMs: 0,
          headers: {},
          body: { error: data.error },
          bodyBytes: 0,
          contractValid: false,
        });
      }
    } catch (err: any) {
      setResult({
        status: 0,
        statusText: 'Failed',
        durationMs: 0,
        headers: {},
        body: { error: err.message || 'Execution error' },
        bodyBytes: 0,
        contractValid: false,
      });
    } finally {
      setExecuting(false);
    }
  };

  const toggleMockServer = async () => {
    setMockLoading(true);
    try {
      if (mockConfig.active) {
        await fetch('/api/studio/mock/stop', { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': getCsrfToken() } });
        setMockConfig((prev) => ({ ...prev, active: false }));
      } else {
        const res = await fetch('/api/studio/mock/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
          credentials: 'include',
          body: JSON.stringify({
            targetDir: activeProject?.path,
            port: mockConfig.port || 4050,
            latencyMs: mockConfig.latencyMs || 30,
            errorRate: mockConfig.errorRate || 0,
          }),
        });
        const data = await res.json();
        if (data.ok) {
          setMockConfig(data.config);
          // Auto-switch URL to mock port
          setUrl((u) => u.replace(/:\d+/, `:${data.config.port}`));
        }
      }
    } finally {
      setMockLoading(false);
    }
  };

  const copyResponse = () => {
    if (!result) return;
    navigator.clipboard.writeText(JSON.stringify(result.body, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const filteredEndpoints = useMemo(() => {
    if (!searchQuery.trim()) return endpoints;
    const q = searchQuery.toLowerCase();
    return endpoints.filter((ep) => ep.path.toLowerCase().includes(q) || ep.method.toLowerCase().includes(q) || (ep.summary || '').toLowerCase().includes(q));
  }, [endpoints, searchQuery]);

  return (
    <div className="space-y-6">
      {/* Top Banner & Mock Controls */}
      <div className="bg-surface-raised border border-border-muted rounded-xl p-5 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Server className="w-5 h-5 text-purple-400" />
              <h3 className="text-base font-bold text-gray-100">API Studio & Autonomous Mock Engine</h3>
              <span className="text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/20 px-2 py-0.5 rounded font-mono font-bold">
                Postman / Mockoon Alternative
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              Interactive request execution, response contract schema validation, and instant zero-config local mock server.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 bg-surface-base px-3 py-1.5 rounded-lg border border-border-muted text-xs font-mono">
              <span className="text-gray-400">Mock Engine:</span>
              <span className={cn('font-bold', mockConfig.active ? 'text-emerald-400' : 'text-gray-500')}>
                {mockConfig.active ? `:${mockConfig.port} (ONLINE)` : 'OFFLINE'}
              </span>
              <button
                onClick={toggleMockServer}
                disabled={mockLoading}
                className={cn(
                  'ml-2 px-2.5 py-0.5 rounded text-[11px] font-bold transition-colors shadow-sm',
                  mockConfig.active
                    ? 'bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30'
                    : 'bg-emerald-500 text-black hover:bg-emerald-400',
                )}
              >
                {mockLoading ? 'Working…' : mockConfig.active ? 'Stop Mock' : 'Start Mock'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Studio Workspace: 2-Column Split */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Left Column: Discovered Endpoints Explorer */}
        <div className="bg-surface-raised border border-border-muted rounded-xl p-4 shadow-sm flex flex-col space-y-3">
          <div className="flex items-center justify-between border-b border-border-muted pb-2">
            <span className="text-xs font-bold text-gray-200 uppercase tracking-wider font-sans">
              Endpoints ({endpoints.length})
            </span>
            <button
              onClick={loadEndpoints}
              disabled={loadingEndpoints}
              className="text-gray-400 hover:text-gray-200 p-1"
              title="Refresh endpoints"
            >
              <RefreshCw className={cn('w-3 h-3', loadingEndpoints && 'animate-spin')} />
            </button>
          </div>

          <div className="relative">
            <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search route or method..."
              className="w-full pl-7 pr-2.5 py-1 bg-surface-base border border-border-muted rounded-lg text-xs font-mono text-gray-200 placeholder:text-gray-500 focus:outline-none"
            />
          </div>

          <div className="flex-1 overflow-y-auto space-y-1 max-h-[520px]">
            {filteredEndpoints.length === 0 ? (
              <div className="text-center py-8 text-xs text-gray-500 font-mono">
                No endpoints found
              </div>
            ) : (
              filteredEndpoints.map((ep) => (
                <button
                  key={ep.id}
                  onClick={() => handleSelectEndpoint(ep)}
                  className={cn(
                    'w-full text-left p-2 rounded-lg border text-xs font-mono transition-colors flex items-center gap-2 truncate',
                    selectedEndpoint?.id === ep.id
                      ? 'bg-surface-overlay border-blue-500/40 text-gray-100'
                      : 'bg-surface-base border-transparent hover:border-border-muted text-gray-400 hover:text-gray-200',
                  )}
                >
                  <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-bold border', METHOD_COLORS[ep.method] || 'text-gray-400')}>
                    {ep.method}
                  </span>
                  <span className="truncate">{ep.path}</span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right 3 Columns: Request Studio & Live Response Inspector */}
        <div className="lg:col-span-3 space-y-4">
          {/* Request URL Composer Bar */}
          <div className="bg-surface-raised border border-border-muted rounded-xl p-3 shadow-sm flex flex-col sm:flex-row items-center gap-2">
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as any)}
              className={cn(
                'px-3 py-2 rounded-lg text-xs font-mono font-bold border outline-none cursor-pointer bg-surface-base',
                METHOD_COLORS[method] || 'text-gray-200 border-border-muted',
              )}
            >
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>

            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:4050/api/..."
              className="flex-1 px-3 py-2 bg-surface-base border border-border-muted rounded-lg text-xs font-mono text-gray-100 placeholder:text-gray-500 focus:outline-none focus:border-blue-500/50"
            />

            <button
              onClick={handleSendRequest}
              disabled={executing || !url.trim()}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors shadow-sm shrink-0"
            >
              {executing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              Send
            </button>
          </div>

          {/* Request Tabs (Headers / Body / Schema) */}
          <div className="bg-surface-base border border-border-muted rounded-xl overflow-hidden shadow-sm">
            <div className="flex border-b border-border-muted px-3 pt-2 bg-surface-raised gap-2">
              <button
                onClick={() => setActiveTab('headers')}
                className={cn(
                  'px-3 py-1.5 text-xs font-semibold rounded-t-lg transition-colors border-b-2',
                  activeTab === 'headers' ? 'text-blue-400 border-blue-400 bg-surface-base' : 'text-gray-400 border-transparent hover:text-gray-200',
                )}
              >
                Headers
              </button>
              <button
                onClick={() => setActiveTab('body')}
                className={cn(
                  'px-3 py-1.5 text-xs font-semibold rounded-t-lg transition-colors border-b-2',
                  activeTab === 'body' ? 'text-blue-400 border-blue-400 bg-surface-base' : 'text-gray-400 border-transparent hover:text-gray-200',
                )}
              >
                Request Body (JSON)
              </button>
              {selectedEndpoint?.responses && (
                <button
                  onClick={() => setActiveTab('contract')}
                  className={cn(
                    'px-3 py-1.5 text-xs font-semibold rounded-t-lg transition-colors border-b-2',
                    activeTab === 'contract' ? 'text-blue-400 border-blue-400 bg-surface-base' : 'text-gray-400 border-transparent hover:text-gray-200',
                  )}
                >
                  Contract Schema
                </button>
              )}
            </div>

            <div className="p-3">
              {activeTab === 'headers' && (
                <textarea
                  value={headersText}
                  onChange={(e) => setHeadersText(e.target.value)}
                  rows={4}
                  className="w-full bg-surface-raised border border-border-muted rounded-lg p-2.5 text-xs font-mono text-gray-300 outline-none focus:border-blue-500/50"
                />
              )}

              {activeTab === 'body' && (
                <textarea
                  value={bodyText}
                  onChange={(e) => setBodyText(e.target.value)}
                  rows={6}
                  className="w-full bg-surface-raised border border-border-muted rounded-lg p-2.5 text-xs font-mono text-gray-300 outline-none focus:border-blue-500/50"
                />
              )}

              {activeTab === 'contract' && (
                <pre className="p-2.5 bg-surface-raised border border-border-muted rounded-lg text-xs font-mono text-gray-400 max-h-36 overflow-y-auto">
                  {JSON.stringify(selectedEndpoint?.responses?.['200']?.schema || selectedEndpoint?.responses, null, 2)}
                </pre>
              )}
            </div>
          </div>

          {/* Response Inspector */}
          {result && (
            <div className="bg-surface-raised border border-border-muted rounded-xl p-4 space-y-3 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-muted pb-3">
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      'px-2.5 py-0.5 rounded text-xs font-bold font-mono',
                      result.status >= 200 && result.status < 300 && 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
                      result.status >= 400 && result.status < 500 && 'bg-amber-500/20 text-amber-300 border border-amber-500/30',
                      result.status >= 500 && 'bg-red-500/20 text-red-300 border border-red-500/30',
                      result.status === 0 && 'bg-red-500/20 text-red-300 border border-red-500/30',
                    )}
                  >
                    {result.status} {result.statusText}
                  </span>

                  <span className="text-xs font-mono text-gray-400 flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" />
                    {result.durationMs}ms
                  </span>

                  <span className="text-xs font-mono text-gray-500">
                    {result.bodyBytes} bytes
                  </span>
                </div>

                {/* Contract Validation Badge */}
                <div className="flex items-center gap-2">
                  {result.contractValid !== undefined && (
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded uppercase font-mono',
                        result.contractValid
                          ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20'
                          : 'bg-amber-500/15 text-amber-400 border border-amber-500/20',
                      )}
                    >
                      {result.contractValid ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                      {result.contractValid ? 'Contract Valid' : 'Schema Drift'}
                    </span>
                  )}

                  <button
                    onClick={copyResponse}
                    className="text-gray-400 hover:text-gray-200 text-xs inline-flex items-center gap-1 p-1"
                    title="Copy response body"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {result.contractErrors && result.contractErrors.length > 0 && (
                <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300 font-mono space-y-1">
                  <span className="font-bold uppercase text-[10px] block">Contract Validation Drift:</span>
                  {result.contractErrors.map((err, idx) => (
                    <div key={idx}>• {err}</div>
                  ))}
                </div>
              )}

              {/* JSON Response Body */}
              <pre className="p-3 bg-surface-base border border-border-muted rounded-lg text-xs font-mono text-gray-200 max-h-72 overflow-y-auto whitespace-pre-wrap">
                {typeof result.body === 'object' ? JSON.stringify(result.body, null, 2) : String(result.body)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
