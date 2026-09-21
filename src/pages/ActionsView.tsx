import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useStore } from '../store';
import { CheckCircle2, XCircle, Clock, Loader2, GitCommit, Search, ChevronLeft, ArrowRight, Play, Terminal, Shield, Package, ShieldCheck, Activity } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export function ActionsView() {
  const { owner, repo: repoName } = useParams();
  const { repositories, actionRuns, triggerPipeline, getPipelineStatus } = useStore();
  const repo = repositories.find(r => r.owner === owner && r.name === repoName);
  const runs = actionRuns.filter(i => i.repoId === repo?.id);
  
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const selectedRun = actionRuns.find(r => r.id === selectedRunId);
  const [activeDetailTab, setActiveDetailTab] = useState<'pipeline' | 'policy'>('pipeline');
  const [isTriggering, setIsTriggering] = useState(false);
  const [runReceipts, setRunReceipts] = useState<any[]>([]);
  const [loadingReceipts, setLoadingReceipts] = useState(false);

  // Polling for selected running pipeline
  useEffect(() => {
    let interval: any;
    if (selectedRun && selectedRun.status === 'running') {
      interval = setInterval(() => {
        getPipelineStatus(selectedRun.id);
      }, 3000);
    }
    return () => clearInterval(interval);
  }, [selectedRun?.id, selectedRun?.status]);

  useEffect(() => {
    if (!selectedRun) {
      setRunReceipts([]);
      return;
    }
    setLoadingReceipts(true);
    fetch(`/api/receipts?runId=${encodeURIComponent(selectedRun.id)}&includeProbes=1`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : { receipts: [] }))
      .then((data) => setRunReceipts(data.receipts || []))
      .catch(() => setRunReceipts([]))
      .finally(() => setLoadingReceipts(false));
  }, [selectedRun?.id]);

  if (!repo) return null;

  const handleTrigger = async () => {
    setIsTriggering(true);
    const runId = await triggerPipeline(repo.id, 'Manual trigger: Core audit');
    setSelectedRunId(runId);
    setIsTriggering(false);
  };

  return (
    <div className="flex flex-col md:flex-row gap-8">
      {selectedRun ? (
        <div className="flex-1 flex flex-col space-y-6">
            <div className="flex items-center space-x-2 flex-1">
              <button onClick={() => setSelectedRunId(null)} className="p-1 px-3 bg-surface-raised border border-border-muted rounded hover:bg-surface-base flex items-center text-sm font-bold shadow-sm">
                  <ChevronLeft className="w-4 h-4 mr-1" /> Back
              </button>
              <h2 className="text-xl font-bold truncate flex-1">{selectedRun.commitMessage} <span className="text-gray-400 font-normal">#{selectedRun.id.slice(0, 6)}</span></h2>
            </div>
            
            <div className="flex items-center bg-surface-raised p-1 rounded-lg border border-border-muted">
               <button 
                onClick={() => setActiveDetailTab('pipeline')}
                className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all ${activeDetailTab === 'pipeline' ? 'bg-surface-raised shadow-sm text-blue-300' : 'text-gray-400 hover:text-gray-200'}`}
               >
                 Pipeline
               </button>
               <button 
                onClick={() => setActiveDetailTab('policy')}
                className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all ${activeDetailTab === 'policy' ? 'bg-surface-raised shadow-sm text-blue-300' : 'text-gray-400 hover:text-gray-200'}`}
               >
                 Policy as Code
               </button>
            </div>

            {activeDetailTab === 'pipeline' ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in duration-300">
             <div className="lg:col-span-2 space-y-6">
                {/* Visual Pipeline Graph */}
                <div className="bg-surface-base border border-border-muted rounded-lg p-8 relative overflow-hidden">
                   <div className="absolute top-0 left-0 right-0 h-1 bg-green-500"></div>
                   <div className="flex flex-col md:flex-row items-center justify-between gap-4 relative z-10">
                      
                      {selectedRun.stages.map((stage: any, index: number) => (
                        <React.Fragment key={stage.id}>
                          <div className="flex flex-col items-center group">
                             <div className={`w-10 h-10 rounded-full flex items-center justify-center mb-2 shadow-sm transition-all ${
                               stage.status === 'success' ? 'bg-green-500/20 border border-green-500 text-green-500' :
                               stage.status === 'running' ? 'bg-blue-500/20 border border-blue-500 text-blue-500 animate-pulse' :
                               stage.status === 'failed' ? 'bg-red-500/20 border border-red-500 text-red-500' :
                               'bg-surface-overlay border border-border-muted text-gray-400'
                             }`}>
                                {stage.status === 'success' && <CheckCircle2 className="w-5 h-5" />}
                                {stage.status === 'running' && <Loader2 className="w-5 h-5 animate-spin" />}
                                {stage.status === 'pending' && <Clock className="w-5 h-5" />}
                                {stage.status === 'failed' && <XCircle className="w-5 h-5" />}
                                {stage.status === 'skipped' && <Clock className="w-5 h-5" />}
                             </div>
                             <div className="text-[var(--color-text-primary)] font-bold text-[10px] text-center max-w-[80px] leading-tight">{stage.name}</div>
                             {stage.duration && <div className="text-[10px] text-gray-400">{stage.duration}</div>}
                          </div>
                          {index < selectedRun.stages.length - 1 && (
                            <div className={`hidden md:block h-0.5 w-8 ${
                              selectedRun.stages[index + 1].status !== 'pending' ? 'bg-green-500/50' : 'bg-surface-overlay'
                            }`}></div>
                          )}
                        </React.Fragment>
                      ))}

                   </div>
                </div>

                {/* Security Findings & Gates */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                   <div className="bg-surface-raised border border-border-muted rounded-lg overflow-hidden">
                      <div className="bg-surface-base px-4 py-2 border-b border-border-muted flex items-center justify-between">
                         <div className="text-xs font-bold text-gray-400 flex items-center">
                            <Shield className="w-4 h-4 mr-2 text-yellow-500" /> Security Findings
                         </div>
                         <span className="text-[10px] bg-yellow-500/10 text-yellow-500 px-2 py-0.5 rounded border border-yellow-500/20">{selectedRun.findings.length} found</span>
                      </div>
                      <div className="p-4 space-y-3">
                         {selectedRun.findings.map((f: any) => (
                            <div key={f.id} className="p-3 bg-surface-base border border-border-muted rounded-md">
                               <div className="flex items-center justify-between mb-1">
                                  <span className={`text-[10px] font-black uppercase tracking-widest ${
                                     f.severity === 'CRITICAL' ? 'text-red-500' : 'text-yellow-500'
                                  }`}>{f.severity}</span>
                                  <span className="text-[10px] text-gray-400 font-mono">{f.type}</span>
                               </div>
                               <div className="text-sm font-bold text-gray-400">{f.title}</div>
                               <p className="text-xs text-gray-400 mt-1">{f.description}</p>
                            </div>
                         ))}
                         {selectedRun.findings.length === 0 && (
                            <div className="text-center py-4 text-gray-400 text-sm italic">No security vulnerabilities detected.</div>
                         )}
                      </div>
                   </div>

                   <div className="bg-surface-raised border border-border-muted rounded-lg overflow-hidden flex flex-col">
                      <div className="bg-surface-base px-4 py-2 border-b border-border-muted flex items-center justify-between">
                         <div className="text-xs font-bold text-gray-400 flex items-center">
                            <ShieldCheck className="w-4 h-4 mr-2 text-green-500" /> Hard Quality Gates
                         </div>
                         <div className="flex items-center space-x-1">
                            <div className="w-2 h-2 rounded-full bg-green-500"></div>
                            <span className="text-[10px] text-green-500 font-black uppercase">Enforced</span>
                         </div>
                      </div>
                      <div className="p-4 space-y-2 flex-1">
                         {selectedRun.gates.map((g: any) => (
                            <div key={g.id} className="p-3 bg-surface-base border border-border-muted rounded-lg group hover:border-info transition-all">
                               <div className="flex items-center justify-between mb-2">
                                  <div className="text-xs font-bold text-gray-400">{g.name}</div>
                                  {g.status === 'passed' ? (
                                    <span className="text-[10px] font-black text-green-500 bg-green-500/10 px-1.5 py-0.5 rounded border border-green-500/20 uppercase tracking-tighter">GATE PASSED</span>
                                  ) : (
                                    <div className="flex flex-col items-end">
                                       <span className="text-[10px] font-black text-red-500 bg-red-500/10 px-1.5 py-0.5 rounded border border-red-500/20 uppercase tracking-tighter">BLOCKING FAILURE</span>
                                       <span className="text-[11px] text-red-400 font-bold mt-1 uppercase">Pipeline Terminated</span>
                                    </div>
                                  )}
                               </div>
                               <div className="flex items-end justify-between">
                                  <div className="space-y-1">
                                     <div className="text-[10px] text-gray-400 uppercase font-black tracking-widest">THRESHOLD</div>
                                     <div className="text-xs font-mono text-gray-400">{g.threshold}</div>
                                  </div>
                                  <div className="text-right">
                                     <div className="text-[10px] text-gray-400 uppercase font-black tracking-widest">ACTUAL</div>
                                     <div className={`text-sm font-black font-mono ${
                                       g.status === 'passed' ? 'text-green-500' : 'text-red-500'
                                     }`}>{g.value}</div>
                                  </div>
                               </div>
                               <div className="mt-2 w-full bg-surface-overlay h-1 rounded-full overflow-hidden">
                                  <div 
                                    className={`h-full rounded-full transition-all duration-1000 ${g.status === 'passed' ? 'bg-green-500' : 'bg-red-500'}`}
                                    style={{ width: g.status === 'passed' ? '85%' : '45%' }}
                                  ></div>
                               </div>
                            </div>
                         ))}
                      </div>
                      <div className="p-3 bg-surface-base border-t border-border-muted italic text-[10px] text-gray-400">
                         Policy: <span className="text-blue-500">standard-ci-v2.rego</span> enforced by OPA
                      </div>
                   </div>
                </div>

                {/* Evidence Spine Receipts */}
                <div className="bg-bg-base border border-border-muted rounded-lg overflow-hidden font-mono text-xs">
                   <div className="bg-surface-raised border-b border-border-muted px-4 py-2 flex items-center justify-between">
                      <div className="flex items-center text-gray-400">
                         <Terminal className="w-4 h-4 mr-2 text-blue-400" />
                         Evidence Spine · Executed Command Receipts
                      </div>
                      <div className="text-gray-400">{runReceipts.length} recorded</div>
                   </div>
                   <div className="p-4 space-y-3 max-h-[400px] overflow-y-auto">
                      {runReceipts.length > 0 ? (
                        runReceipts.map((r: any) => (
                          <div key={r.id} className="p-2.5 rounded bg-surface-base border border-border-muted space-y-1">
                            <div className="flex items-center justify-between text-[11px]">
                              <span className="text-blue-300 font-bold">{r.command}</span>
                              <span className={r.status === 'passed' ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
                                {r.status} ({r.durationMs}ms)
                              </span>
                            </div>
                            {r.outputTail ? (
                              <pre className="text-[10px] text-gray-400 whitespace-pre-wrap overflow-x-auto bg-black/30 p-1.5 rounded">
                                {r.outputTail}
                              </pre>
                            ) : null}
                          </div>
                        ))
                      ) : (
                        <div className="text-gray-500 italic py-4 text-center font-sans">
                          {loadingReceipts ? 'Loading receipts...' : 'No executed command receipts recorded for this run.'}
                        </div>
                      )}
                   </div>
                </div>
             </div>

             <div className="lg:col-span-1 space-y-6">
                <div className="bg-surface-raised border border-border-muted rounded-lg p-4 shadow-sm">
                   <h4 className="font-bold text-gray-400 mb-3 border-b border-border-muted pb-2 flex items-center">
                      <Clock className="w-4 h-4 mr-2" /> Summary
                   </h4>
                   <div className="space-y-4">
                      <div>
                         <div className="text-[10px] font-black uppercase text-gray-400 tracking-widest">Status</div>
                         <div className="flex items-center mt-1">
                            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse mr-2"></div>
                            <span className="font-bold text-blue-600">InProgress</span>
                         </div>
                      </div>
                      <div>
                         <div className="text-[10px] font-black uppercase text-gray-400 tracking-widest">Total Duration</div>
                         <div className="font-mono text-sm mt-1">00:42.5s</div>
                      </div>
                      <div>
                         <div className="text-[10px] font-black uppercase text-gray-400 tracking-widest">Evidence & Verification</div>
                         <div className="mt-2 space-y-2">
                            <div className="flex items-center justify-between text-[11px]">
                               <span className="text-gray-400">Receipts</span>
                               <span className="font-mono text-gray-200 font-bold">
                                  {runReceipts.length} recorded
                               </span>
                            </div>
                            <div className="flex items-center justify-between text-[11px]">
                               <span className="text-gray-400">Chain Audit</span>
                               <Link
                                  to={`/assurance?av=receipts&runId=${selectedRun.id}`}
                                  className="flex items-center text-blue-400 font-bold hover:underline"
                               >
                                  <ShieldCheck className="w-3 h-3 mr-1 text-emerald-400" /> Inspect Chain
                               </Link>
                            </div>
                         </div>
                      </div>
                   </div>
                </div>
             </div>
          </div>
          ) : (
            <div className="flex-1 bg-bg-base border border-border-muted rounded-xl overflow-hidden flex flex-col animate-in slide-in-from-right-4 duration-300 min-h-[600px]">
               <div className="border-b border-border-muted px-6 py-4 flex items-center justify-between bg-surface-raised">
                  <div>
                    <h3 className="text-[var(--color-text-primary)] font-bold flex items-center">
                       <ShieldCheck className="w-4 h-4 mr-2 text-blue-500" /> Policy as Code (OPA)
                    </h3>
                    <p className="text-xs text-gray-400">Centrally managed policies enforced across all OpenHub nodes.</p>
                  </div>
                  <button className="text-[10px] font-black uppercase text-blue-500 hover:text-blue-400 transition-colors">
                     View Global Documentation
                  </button>
               </div>
               
               <div className="flex-1 flex overflow-hidden">
                  {/* File Sidebar */}
                  <div className="w-64 border-r border-border-muted bg-surface-base p-2 space-y-1">
                     <div className="text-[10px] font-black text-gray-400 px-3 py-2 uppercase tracking-widest">active policies</div>
                     <button className="w-full text-left px-3 py-2 rounded-md text-sm font-bold bg-surface-raised text-info flex items-center">
                        <ShieldCheck className="w-4 h-4 mr-2" /> deployment.rego
                     </button>
                     <button className="w-full text-left px-3 py-2 rounded-md text-sm font-bold text-gray-400 hover:bg-surface-raised hover:text-gray-200 flex items-center">
                        <Shield className="w-4 h-4 mr-2" /> security_v2.rego
                     </button>
                     <button className="w-full text-left px-3 py-2 rounded-md text-sm font-bold text-gray-400 hover:bg-surface-raised hover:text-gray-200 flex items-center">
                        <Terminal className="w-4 h-4 mr-2" /> baseline.rego
                     </button>
                  </div>
                  
                  {/* Rego Editor */}
                  <div className="flex-1 flex flex-col bg-bg-base">
                      <div className="p-4 border-b border-border-muted flex items-center justify-between">
                         <div className="flex items-center space-x-4">
                            <span className="text-xs font-mono text-gray-400">deployment.rego</span>
                            <span className="text-[10px] bg-green-500/10 text-green-500 border border-green-500/20 px-1.5 py-0.5 rounded">READ ONLY</span>
                         </div>
                         <div className="text-[10px] text-gray-400 italic">Last synced from Policy Hub: 42m ago</div>
                      </div>
                      <div className="flex-1 p-6 font-mono text-sm overflow-y-auto">
<pre className="text-gray-400">
<span className="text-purple-400">package</span> localhub.deployment

<span className="text-gray-400">{"# Policy: Hard stops for production deployment"}</span>
<span className="text-gray-400">{"# Source: config/policies/core.rego"}</span>

<span className="text-blue-400">default</span> allow = <span className="text-orange-400">false</span>

<span className="text-gray-400">{"# Rule 1: No critical CVEs allowed"}</span>
allow &#x7B;
    input.security.critical_cves == 0
    input.security.sast_blockers == 0
    input.quality.coverage &gt;= 0.8
    not bundle_too_large
&#x7D;

<span className="text-gray-400">{"# Rule 2: Bundle size check"}</span>
bundle_too_large &#x7B;
    input.artifacts.bundle_size_mb &gt; 5.0
&#x7D;

<span className="text-gray-400">{"# Rule 3: Coverage Regressions"}</span>
deny[msg] &#x7B;
    input.quality.coverage_drop &gt; 0.05
    msg := <span className="text-green-400">"Coverage dropped more than 5%"</span>
&#x7D;

<span className="text-gray-400">{"# Rule 4: Critical Vulnerabilities"}</span>
deny[msg] &#x7B;
    input.security.critical_cves &gt; 0
    msg := sprintf(<span className="text-green-400">"Security gate failed: %d critical vulnerabilities found"</span>, [input.security.critical_cves])
&#x7D;
</pre>
                      </div>
                  </div>
               </div>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Sidebar for workflows */}
      <div className="w-full md:w-1/4">
        <h3 className="font-semibold text-gray-400 mb-4 px-2">Workflows</h3>
        <ul className="space-y-1">
          <li>
             <a href="#" className="flex items-center px-2 py-1.5 text-sm font-semibold bg-surface-raised text-gray-400 rounded-md">
                All workflows
             </a>
          </li>
          <li>
             <a href="#" className="flex items-center px-2 py-1.5 text-sm text-gray-400 hover:bg-surface-base rounded-md transition-colors">
                CI/CD Pipeline
             </a>
          </li>
          <li>
             <a href="#" className="flex items-center px-2 py-1.5 text-sm text-gray-400 hover:bg-surface-base rounded-md transition-colors">
                CodeQL Analysis
             </a>
          </li>
        </ul>
      </div>

      {/* Main timeline */}
      <div className="w-full md:w-3/4 flex flex-col space-y-4">
        <div className="flex w-full mb-2">
          <div className="relative w-full">
             <Search className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" />
             <input type="text" placeholder="Filter workflow runs" className="w-full pl-9 pr-3 py-1.5 border rounded-md border-border-muted bg-surface-base text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-surface-raised" />
          </div>
        </div>

        <div className="border border-border-muted rounded-md bg-surface-raised shadow-sm overflow-hidden">
          <div className="bg-surface-base border-b border-border-muted px-4 py-3 flex items-center justify-between text-sm font-semibold text-gray-400">
             <div>{runs.length} workflow runs</div>
             <button 
               onClick={handleTrigger}
               disabled={isTriggering}
               className="bg-blue-600 text-white px-3 py-1.5 rounded text-[10px] font-bold hover:bg-blue-700 transition-colors uppercase tracking-widest disabled:opacity-50"
             >
               {isTriggering ? 'Triggering...' : 'New Run'}
             </button>
          </div>
          
          <div className="divide-y divide-border-muted">
            {runs.map(run => (
              <div key={run.id} 
                onClick={() => setSelectedRunId(run.id)}
                className="flex p-4 hover:bg-surface-base transition-colors group cursor-pointer"
              >
                <div className="pt-1 mr-3 shrink-0">
                  {run.status === 'success' && <CheckCircle2 className="w-5 h-5 text-green-500" />}
                  {run.status === 'failure' && <XCircle className="w-5 h-5 text-red-500" />}
                  {run.status === 'running' && <Loader2 className="w-5 h-5 text-yellow-500 animate-spin" />}
                  {run.status === 'queued' && <Clock className="w-5 h-5 text-gray-400" />}
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex items-center flex-wrap gap-2 mb-1">
                    <a href="#" className="text-base font-semibold text-gray-400 hover:text-blue-600 truncate">{run.commitMessage}</a>
                  </div>
                  <div className="flex items-center text-xs text-gray-400 mt-1 space-x-2">
                    <span className="font-semibold text-gray-400">{run.workflowName}</span>
                    <span>#12</span>
                    <span className="flex items-center">
                      <GitCommit className="w-3.5 h-3.5 mr-1" />
                      <span className="font-mono text-[10px]">f32b8a</span>
                    </span>
                  </div>
                </div>

                <div className="hidden sm:flex flex-col items-end justify-center text-xs text-gray-400 ml-4 shrink-0">
                  <div className="flex items-center mb-1">
                    <Clock className="w-3.5 h-3.5 mr-1" /> {run.duration}
                  </div>
                  <div className="flex items-center">
                    <img src={run.author.avatarUrl} alt="avatar" className="w-4 h-4 rounded-full mr-1.5" />
                    {formatDistanceToNow(new Date(run.createdAt))} ago
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      </>
      )}
    </div>
  );
}
