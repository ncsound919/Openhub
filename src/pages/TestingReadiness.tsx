import React, { useState, useEffect } from 'react';
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
        headers: { 'Content-Type': 'application/json' },
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
    <div className="flex-1 max-w-7xl mx-auto w-full flex flex-col gap-8 px-4 py-8 relative z-10">
      
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-4">
         <div>
            <h1 className="text-white font-industrial text-4xl">Testing & Readiness</h1>
            <p className="text-gray-500 font-mono text-[10px] uppercase tracking-widest mt-2 flex items-center">
               <ShieldCheck className="w-3 h-3 mr-2 text-green-500" /> Deployment Verification Facility
            </p>
         </div>
         <div className="flex space-x-4">
            <button 
              onClick={fetchReadiness}
              disabled={isChecking}
              className="bg-[#161b22] border border-[#30363d] text-white px-4 py-2 font-black text-[10px] uppercase tracking-widest hover:bg-white/5 transition-all flex items-center disabled:opacity-50"
            >
               {isChecking ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-2" />} 
               Verify Readiness
            </button>
            <button 
              className={`text-black px-4 py-2 font-black text-[10px] uppercase tracking-widest shadow-lg flex items-center ${isReady ? 'bg-green-500 hover:bg-green-400' : 'bg-gray-600 opacity-50 cursor-not-allowed'}`}
              disabled={!isReady}
            >
               <Play className="w-3.5 h-3.5 mr-2" /> {isReady ? 'Deploy to Staging' : 'Deployment Blocked'}
            </button>
         </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
         {/* Column 1: Deployment Checklist */}
         <div className="industrial-card p-8 xl:col-span-1">
            <h2 className="text-gray-400 mb-6 flex items-center text-sm font-black uppercase tracking-widest">
               <CheckSquare className="w-4 h-4 mr-3 text-orange-500" /> Pre-Flight Checklist
            </h2>
            <div className="space-y-4">
               {checks.map(check => (
                  <div key={check.id} className="flex items-start space-x-4 p-4 bg-[#161B22] border border-[#30363D]">
                     <div className="mt-0.5 shrink-0">
                        {check.passed ? (
                           <CheckCircle2 className="w-5 h-5 text-green-500" />
                        ) : (
                           <AlertCircle className="w-5 h-5 text-red-500" />
                        )}
                     </div>
                     <div>
                        <div className="text-white text-xs font-bold uppercase tracking-widest">{check.name}</div>
                        <div className="text-[10px] font-mono text-gray-500 mt-1">{check.details}</div>
                     </div>
                  </div>
               ))}
               
               {checks.length === 0 && !isChecking && (
                 <div className="p-4 bg-gray-800/30 text-gray-500 font-mono text-xs text-center border border-gray-800 border-dashed">
                   Run verification to see checklist status.
                 </div>
               )}
            </div>
         </div>

         {/* Column 2: Test Generation */}
         <div className="industrial-card p-0 flex flex-col h-full xl:col-span-1 min-h-[400px]">
            <div className="p-6 border-b border-[#30363D] flex items-center justify-between">
               <h2 className="text-gray-400 flex items-center text-sm font-black uppercase tracking-widest mb-0">
                  <Layers className="w-4 h-4 mr-3 text-purple-500" /> Coverage Generation
               </h2>
               <div className="text-[9px] font-mono text-gray-500">{candidates.length} Untested Modules</div>
            </div>
            <div className="flex-1 bg-black/40 p-4 overflow-auto border-t-2 border-transparent relative space-y-2">
               {candidates.length === 0 ? (
                 <div className="text-green-500 font-mono text-xs text-center p-8 border border-green-500/20 bg-green-500/5">
                   All tracked files have associated tests.
                 </div>
               ) : (
                 candidates.map(file => (
                   <div key={file} className="flex justify-between items-center bg-[#161B22] border border-[#30363D] p-3">
                     <span className="text-gray-300 font-mono text-[10px] truncate w-3/5">{file}</span>
                     <button
                       onClick={() => generateTest(file)}
                       disabled={isGenerating === file}
                       className="bg-purple-500/10 text-purple-500 border border-purple-500/20 px-3 py-1 font-black text-[9px] uppercase tracking-widest hover:bg-purple-500/20 transition-all disabled:opacity-50 flex items-center shrink-0"
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
            <div className="p-6 border-b border-[#30363D] flex items-center justify-between">
               <h2 className="text-gray-400 flex items-center text-sm font-black uppercase tracking-widest mb-0">
                  <Terminal className="w-4 h-4 mr-3 text-blue-500" /> Test Runner
               </h2>
               <button 
                  onClick={runTests}
                  disabled={isRunningTests}
                  className="bg-blue-500/10 text-blue-500 border border-blue-500/20 px-4 py-1.5 font-black text-[10px] uppercase tracking-widest hover:bg-blue-500/20 transition-all disabled:opacity-50 flex items-center"
               >
                  {isRunningTests ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : <Play className="w-3.5 h-3.5 mr-2" />} Run Suite
               </button>
            </div>
            <div className="flex-1 bg-black/60 p-6 overflow-auto border-t-2 border-transparent relative">
               <pre className="font-mono text-[10px] text-gray-400 whitespace-pre-wrap leading-relaxed opacity-80">
                  {testOutput || 'No test output recorded. Click "Run Suite" to execute tests.'}
               </pre>
            </div>
         </div>
      </div>
      
      {/* Lower Metrics Panel */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="industrial-card p-6 bg-gradient-to-br from-green-500/5 to-transparent">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Readiness Score</div>
          </div>
          <div className="text-4xl font-display text-green-500">
            {checks.length ? Math.round((checks.filter(c => c.passed).length / checks.length) * 100) : 0}%
          </div>
        </div>
        <div className="industrial-card p-6">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Test Coverage Base</div>
          </div>
          <div className="text-4xl font-display text-white">{candidates.length ? Math.max(0, 100 - (candidates.length * 2)) : 100}%</div>
          <p className="text-[9px] text-gray-500 font-bold uppercase mt-1">Estimated by untracked file volume</p>
        </div>
        <div className="industrial-card p-6 border-l-4 border-orange-500">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Environment Target</div>
          </div>
          <div className="text-4xl font-display text-white">Staging</div>
          <p className="text-[9px] text-gray-500 font-bold uppercase mt-1">Cluster: OH-STG-USW2</p>
        </div>
      </div>

      {/* Theater Scan Results Panel */}
      {theaterScan && !theaterScan.clean && (
        <div className="industrial-card p-6 mt-2 border-l-4 border-red-500">
          <div className="flex items-center justify-between mb-4">
             <h2 className="text-red-400 flex items-center text-sm font-black uppercase tracking-widest mb-0">
                <Search className="w-4 h-4 mr-3 text-red-500" /> Theater / Mock Data Detected
             </h2>
             <div className="text-[9px] font-mono text-red-500">{theaterScan.occurrences.length} Occurrences</div>
          </div>
          <p className="text-xs text-gray-400 mb-4">
            The readiness facility detected placeholder data, mocked states, or stubbed endpoints. 
            All mock data must be replaced with true system integrations before deployment.
          </p>
          <div className="bg-[#161B22] border border-[#30363D] max-h-[300px] overflow-auto">
            {theaterScan.occurrences.map((occ, i) => (
              <div key={i} className="flex flex-col p-3 border-b border-[#30363D] last:border-none">
                <div className="text-[10px] font-bold text-gray-300 font-mono flex items-center gap-2">
                  <FileCode className="w-3 h-3 text-red-400" />
                  {occ.file} <span className="text-red-500">Line {occ.line}</span>
                </div>
                <div className="text-[10px] text-gray-500 font-mono mt-2 bg-black/50 p-2 rounded-sm border border-red-900/30">
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
            <div className="text-[10px] text-green-500/70 font-mono mt-1">No mocks, stubs, or fake artifacts detected in src/ directory.</div>
          </div>
        </div>
      )}

    </div>
  );
}
