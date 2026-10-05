import React, { useState, useEffect } from 'react';
import { getCsrfToken } from '../auth/AuthProvider';
import { 
  CheckCircle2, AlertCircle, Play, ShieldCheck, 
  Terminal, RefreshCw, Loader2, FileCode, CheckSquare, Layers, PlusSquare, Search
} from 'lucide-react';

interface ReadinessCheck {
  id: string;
  name: string;
  passed: boolean;
  details: string;
}

interface TheaterOccurrence {
  file: string;
  line: number;
  content: string;
}

interface TheaterScanResult {
  clean: boolean;
  occurrences: TheaterOccurrence[];
}

export function TestingReadiness() {
  const [checks, setChecks] = useState<ReadinessCheck[]>([]);
  const [isChecking, setIsChecking] = useState(false);
  const [testOutput, setTestOutput] = useState<string>('');
  const [isRunningTests, setIsRunningTests] = useState(false);
  const [isReady, setIsReady] = useState(false);

  const [candidates, setCandidates] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState<string | null>(null);
  
  const [theaterScan, setTheaterScan] = useState<TheaterScanResult | null>(null);

  const fetchReadiness = async () => {
    setIsChecking(true);
    try {
      const res = await fetch('/api/workspace/deploy-readiness');
      if (res.ok) {
        const data = await res.json();
        setChecks(data.checks || []);
        setIsReady(data.ready);
      }
      
      const theaterRes = await fetch('/api/workspace/theater-scan');
      if (theaterRes.ok) {
        setTheaterScan(await theaterRes.json());
      }
    } catch (e) {
      console.error('Failed to fetch readiness', e);
    } finally {
      setIsChecking(false);
    }
  };

  const fetchCandidates = async () => {
    try {
      const res = await fetch('/api/workspace/test/candidates');
      if (res.ok) {
        const data = await res.json();
        setCandidates(data.candidates || []);
      }
    } catch (e) {
      console.error('Failed to fetch candidates', e);
    }
  };

  const generateTest = async (file: string) => {
    setIsGenerating(file);
    try {
      const res = await fetch('/api/workspace/test/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ file })
      });
      if (res.ok) {
        // Remove from candidates and optionally re-run tests
        setCandidates(prev => prev.filter(c => c !== file));
        setTestOutput(prev => prev + `\nGenerated test scaffold for ${file}...`);
      }
    } catch (e) {
      console.error('Generation failed', e);
    } finally {
      setIsGenerating(null);
    }
  };

  const runTests = async () => {
    setIsRunningTests(true);
    setTestOutput('Starting test suite...');
    try {
      const res = await fetch('/api/workspace/test');
      if (res.ok) {
        const data = await res.json();
        setTestOutput(data.output || 'Tests completed.');
        // Refresh readiness checks after running tests
        fetchReadiness();
        fetchCandidates();
      }
    } catch (e: any) {
      setTestOutput(`Error running tests: ${e.message}`);
    } finally {
      setIsRunningTests(false);
    }
  };

  useEffect(() => {
    fetchReadiness();
    fetchCandidates();
  }, []);

  return (
    <div className="flex-1 w-full max-w-6xl mx-auto flex flex-col gap-5 px-4 py-6 relative z-10">
      
      {/* Hero header */}
      <section className="gradient-hero rounded-2xl p-6 relative overflow-hidden">
        <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-emerald-300">
          <ShieldCheck className="w-4 h-4 text-emerald-300" /> Deployment Verification Facility
        </div>
        <h1 className="mt-2">Testing &amp; <span className="text-info">Readiness.</span></h1>
        <div className="mt-4 flex flex-wrap gap-2.5">
          <button 
            onClick={fetchReadiness}
            disabled={isChecking}
            className="inline-flex items-center rounded-lg border border-border-muted bg-surface-base/70 hover:border-blue-500/50 px-4 py-2 text-sm font-bold text-gray-400 disabled:opacity-50"
          >
            {isChecking ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />} 
            Verify Readiness
          </button>
          <button
            disabled
            title={isReady
              ? 'Pre-flight checks passed. Staging deploy is not wired in this build — no deployment was triggered.'
              : 'Deployment blocked: resolve the failing pre-flight checks first. This button never deploys on its own.'}
            className={`inline-flex items-center px-4 py-2 rounded-lg text-sm font-bold shadow-lg ${isReady ? 'bg-surface-overlay text-gray-300 border border-border-muted' : 'bg-surface-overlay text-gray-400 cursor-not-allowed'}`}
          >
            <Play className="w-4 h-4 mr-2" /> {isReady ? 'Checks Passed — Deploy Not Wired' : 'Deployment Blocked'}
          </button>
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
         {/* Column 1: Deployment Checklist */}
         <div className="industrial-card p-8 xl:col-span-1">
            <h2 className="text-gray-400 mb-6 flex items-center text-sm font-black uppercase tracking-widest">
               <CheckSquare className="w-4 h-4 mr-3 text-orange-500" /> Pre-Flight Checklist
            </h2>
            <div className="space-y-4">
               {checks.map(check => (
                  <div key={check.id} className="flex items-start space-x-4 p-4 bg-surface-raised border border-border-muted">
                     <div className="mt-0.5 shrink-0">
                        {check.passed ? (
                           <CheckCircle2 className="w-5 h-5 text-green-500" />
                        ) : (
                           <AlertCircle className="w-5 h-5 text-red-500" />
                        )}
                     </div>
                     <div>
                        <div className="text-[var(--color-text-primary)] text-xs font-bold uppercase tracking-widest">{check.name}</div>
                        <div className="text-xs font-mono text-gray-400 mt-1">{check.details}</div>
                     </div>
                  </div>
               ))}
               
               {checks.length === 0 && !isChecking && (
                  <div className="p-4 bg-surface-base text-gray-400 font-mono text-xs text-center border border-border-muted border-dashed rounded-lg">
                   Run verification to see checklist status.
                 </div>
               )}
            </div>
         </div>

         {/* Column 2: Test Generation */}
         <div className="industrial-card p-0 flex flex-col h-full xl:col-span-1 min-h-[400px]">
            <div className="p-6 border-b border-border-muted flex items-center justify-between">
               <h2 className="text-gray-400 flex items-center text-sm font-black uppercase tracking-widest mb-0">
                  <Layers className="w-4 h-4 mr-3 text-purple-500" /> Coverage Generation
               </h2>
               <div className="text-xs font-mono text-gray-400">{candidates.length} Untested Modules</div>
            </div>
            <div className="flex-1 bg-black/40 p-4 overflow-auto border-t-2 border-transparent relative space-y-2">
               {candidates.length === 0 ? (
                 <div className="text-green-500 font-mono text-xs text-center p-8 border border-green-500/20 bg-green-500/5">
                   All tracked files have associated tests.
                 </div>
               ) : (
                 candidates.map(file => (
                   <div key={file} className="flex justify-between items-center bg-surface-raised border border-border-muted p-3">
                     <span className="text-gray-400 font-mono text-xs truncate w-3/5">{file}</span>
                     <button
                       onClick={() => generateTest(file)}
                       disabled={isGenerating === file}
                       className="bg-purple-500/10 text-purple-500 border border-purple-500/20 px-3 py-1 font-black text-xs uppercase tracking-widest hover:bg-purple-500/20 transition-all disabled:opacity-50 flex items-center shrink-0"
                     >
                       {isGenerating === file ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <PlusSquare className="w-3 h-3 mr-1" />}
                       Scaffold
                     </button>
                   </div>
                 ))
               )}
            </div>
         </div>

         {/* Column 3: Unit Testing Facility */}
         <div className="industrial-card p-0 flex flex-col h-full xl:col-span-1 min-h-[400px]">
            <div className="p-6 border-b border-border-muted flex items-center justify-between">
               <h2 className="text-gray-400 flex items-center text-sm font-black uppercase tracking-widest mb-0">
                  <Terminal className="w-4 h-4 mr-3 text-blue-500" /> Test Runner
               </h2>
               <button 
                  onClick={runTests}
                  disabled={isRunningTests}
                  className="bg-blue-500/10 text-blue-500 border border-blue-500/20 px-4 py-1.5 font-black text-xs uppercase tracking-widest hover:bg-blue-500/20 transition-all disabled:opacity-50 flex items-center"
               >
                  {isRunningTests ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : <Play className="w-3.5 h-3.5 mr-2" />} Run Suite
               </button>
            </div>
            <div className="flex-1 bg-black/60 p-6 overflow-auto border-t-2 border-transparent relative">
               <pre className="font-mono text-xs text-gray-400 whitespace-pre-wrap leading-relaxed opacity-80">
                  {testOutput || 'No test output recorded. Click "Run Suite" to execute tests.'}
               </pre>
            </div>
         </div>
      </div>
      
      {/* Lower Metrics Panel */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: 'var(--color-success)', ['--accent2' as string]: 'var(--color-success)' }}>
          <div className="text-xs font-extrabold text-gray-400 uppercase tracking-[0.14em]">Readiness Score</div>
          <div className="mt-1 text-2xl font-extrabold text-[var(--color-text-primary)] tracking-tight">
            {checks.length ? Math.round((checks.filter(c => c.passed).length / checks.length) * 100) : 0}%
          </div>
          <div className="meter mt-2.5"><span style={{ width: `${checks.length ? Math.round((checks.filter(c => c.passed).length / checks.length) * 100) : 0}%` }} /></div>
        </div>
        <div className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: 'var(--color-info)', ['--accent2' as string]: 'var(--color-accent)' }}>
          <div className="text-xs font-extrabold text-gray-400 uppercase tracking-[0.14em]">Untested Modules</div>
          <div className="mt-1 text-2xl font-extrabold text-[var(--color-text-primary)] tracking-tight">{candidates.length}</div>
          <div className="mt-0.5 text-[11px] text-gray-400">Files without an associated test (from /api/workspace/test/candidates) — not a coverage %</div>
        </div>
        <div className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: 'var(--color-warning)', ['--accent2' as string]: 'var(--color-warning)' }}>
          <div className="text-xs font-extrabold text-gray-400 uppercase tracking-[0.14em]">Environment Target</div>
          <div className="mt-1 text-2xl font-extrabold text-[var(--color-text-primary)] tracking-tight">Unconfigured</div>
          <div className="mt-0.5 text-[11px] text-gray-400">No staging cluster is wired in this build — readiness score above is the deploy signal</div>
        </div>
      </div>

      {/* Theater Scan Results Panel */}
      {theaterScan && !theaterScan.clean && Array.isArray(theaterScan.occurrences) && (
        <div className="industrial-card p-6 mt-2 border-l-4 border-red-500">
          <div className="flex items-center justify-between mb-4">
             <h2 className="text-red-400 flex items-center text-sm font-black uppercase tracking-widest mb-0">
                <Search className="w-4 h-4 mr-3 text-red-500" /> Theater / Mock Data Detected
             </h2>
             <div className="text-xs font-mono text-red-500">{theaterScan.occurrences.length} Occurrences</div>
          </div>
          <p className="text-xs text-gray-400 mb-4">
            The readiness facility detected placeholder data, mocked states, or stubbed endpoints. 
            All mock data must be replaced with true system integrations before deployment.
          </p>
          <div className="bg-surface-raised border border-border-muted max-h-[300px] overflow-auto">
            {theaterScan.occurrences.map((occ, i) => (
              <div key={i} className="flex flex-col p-3 border-b border-border-muted last:border-none">
                <div className="text-xs font-bold text-gray-400 font-mono flex items-center gap-2">
                  <FileCode className="w-3 h-3 text-red-400" />
                  {occ.file} <span className="text-red-500">Line {occ.line}</span>
                </div>
                <div className="text-xs text-gray-400 font-mono mt-2 bg-black/50 p-2 rounded-sm border border-red-900/30">
                  {occ.content}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      
      {theaterScan && theaterScan.clean && (
        <div className="industrial-card p-4 mt-2 bg-green-500/5 border border-green-500/20 flex items-center">
          <CheckCircle2 className="w-5 h-5 text-green-500 mr-3" />
          <div>
            <div className="text-green-400 text-xs font-black uppercase tracking-widest">Codebase is Theater-Free</div>
            <div className="text-xs text-green-500/70 font-mono mt-1">No mocks, stubs, or fake artifacts detected in src/ directory.</div>
          </div>
        </div>
      )}

    </div>
  );
}
