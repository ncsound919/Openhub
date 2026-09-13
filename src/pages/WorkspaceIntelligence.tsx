import React, { useState, useEffect } from 'react';
import { 
  GitBranch, GitCommit, Search, RefreshCw, Terminal, CheckCircle2, AlertCircle, Bot, Zap, Package, Server, ShieldCheck
} from 'lucide-react';
import { motion } from 'framer-motion';

export function WorkspaceIntelligence() {
  const [gitStatus, setGitStatus] = useState<string[]>([]);
  const [gitHistory, setGitHistory] = useState<any[]>([]);
  const [outdatedDeps, setOutdatedDeps] = useState<Record<string, any>>({});
  const [hygiene, setHygiene] = useState<any>(null);
  
  const [ollamaPrompt, setOllamaPrompt] = useState('');
  const [ollamaResponse, setOllamaResponse] = useState('');
  const [isOllamaLoading, setIsOllamaLoading] = useState(false);

  const fetchGitData = async () => {
    try {
      const [statusRes, historyRes] = await Promise.all([
        fetch('/api/workspace/git/status'),
        fetch('/api/workspace/git/history')
      ]);
      if (statusRes.ok) {
        const data = await statusRes.json();
        setGitStatus(data.status || []);
      }
      if (historyRes.ok) {
        const data = await historyRes.json();
        setGitHistory(data.history || []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchDeps = async () => {
    try {
      const res = await fetch('/api/workspace/deps/outdated');
      if (res.ok) {
        const data = await res.json();
        setOutdatedDeps(data.outdated || {});
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchHygiene = async () => {
    try {
      const res = await fetch('/api/workspace/hygiene');
      if (res.ok) {
        const data = await res.json();
        setHygiene(data);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleOllamaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ollamaPrompt.trim()) return;
    
    setIsOllamaLoading(true);
    setOllamaResponse('');
    
    try {
      const res = await fetch('/api/workspace/ollama/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: ollamaPrompt })
      });
      const data = await res.json();
      if (res.ok) {
        setOllamaResponse(data.response || 'No response generated.');
      } else {
        setOllamaResponse(`[ERROR] ${data.error || 'Failed to connect to Ollama'}`);
      }
    } catch (e: any) {
      setOllamaResponse(`[ERROR] ${e.message}`);
    } finally {
      setIsOllamaLoading(false);
    }
  };

  useEffect(() => {
    fetchGitData();
    fetchDeps();
    fetchHygiene();
  }, []);

  return (
    <div className="flex-1 max-w-7xl mx-auto w-full flex flex-col gap-8 px-4 py-8 relative z-10">
      
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-4">
         <div>
            <h1 className="text-white font-industrial text-4xl flex items-center">
              <Terminal className="w-8 h-8 mr-4 text-green-500" /> Workspace Intelligence
            </h1>
            <p className="text-gray-500 font-mono text-[10px] uppercase tracking-widest mt-2">
               Deep Git Integration // Repo Hygiene // Local AI
            </p>
         </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
         
         {/* Git Tracking */}
         <div className="industrial-card p-6 flex flex-col h-[500px]">
            <div className="flex items-center justify-between border-b border-gray-800 pb-4 mb-4">
               <h2 className="text-white font-industrial text-xl flex items-center">
                  <GitBranch className="w-5 h-5 mr-3 text-orange-500" /> Version Control
               </h2>
               <button onClick={fetchGitData} className="text-gray-500 hover:text-white transition-colors">
                 <RefreshCw className="w-4 h-4" />
               </button>
            </div>
            
            <div className="flex-1 overflow-y-auto font-mono text-xs pr-2 space-y-6">
              <div>
                <div className="text-gray-500 uppercase tracking-widest mb-3 text-[10px]">Uncommitted Changes ({gitStatus.length})</div>
                {gitStatus.length === 0 ? (
                  <div className="text-green-500 flex items-center"><CheckCircle2 className="w-3 h-3 mr-2"/> Working tree clean</div>
                ) : (
                  <ul className="space-y-1">
                    {gitStatus.map((s, i) => (
                      <li key={i} className="text-orange-500">{s}</li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <div className="text-gray-500 uppercase tracking-widest mb-3 text-[10px]">Recent Commits</div>
                <div className="space-y-3">
                  {gitHistory.map((c, i) => (
                    <div key={i} className="bg-gray-800/30 p-2 rounded-sm border border-gray-800">
                      <div className="flex justify-between items-start">
                        <span className="text-white">{c.message}</span>
                        <span className="text-orange-500 text-[10px]">{c.hash}</span>
                      </div>
                      <div className="text-gray-500 text-[10px] mt-1 flex justify-between">
                        <span>{c.author}</span>
                        <span>{c.time}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
         </div>

         {/* Right Column Grid */}
         <div className="flex flex-col gap-8 h-[500px]">
            
            {/* Repo Hygiene */}
            <div className="industrial-card p-6 flex-1 flex flex-col">
              <div className="flex items-center justify-between border-b border-gray-800 pb-4 mb-4">
                 <h2 className="text-white font-industrial text-xl flex items-center">
                    <ShieldCheck className="w-5 h-5 mr-3 text-blue-500" /> Repo Hygiene
                 </h2>
                 <button onClick={fetchHygiene} className="text-gray-500 hover:text-white transition-colors">
                   <RefreshCw className="w-4 h-4" />
                 </button>
              </div>
              <div className="flex-1 flex flex-col justify-center">
                {hygiene ? (
                  <>
                    <div className="flex items-center justify-center mb-6">
                      <div className={`text-4xl font-industrial ${hygiene.score === 100 ? 'text-green-500' : 'text-orange-500'}`}>
                        {hygiene.score}%
                      </div>
                      <div className="ml-4 text-[10px] text-gray-500 font-mono uppercase">Overall Score</div>
                    </div>
                    <div className="space-y-2">
                      {hygiene.checks.map((c: any, i: number) => (
                        <div key={i} className="flex justify-between items-center text-xs font-mono">
                          <span className="text-gray-300">{c.name}</span>
                          {c.passed ? (
                            <span className="text-green-500">PASS</span>
                          ) : (
                            <span className="text-red-500">FAIL</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="text-center text-gray-500 text-xs font-mono">Running deterministic checks...</div>
                )}
              </div>
            </div>

            {/* Dependency Updater */}
            <div className="industrial-card p-6 flex-1 flex flex-col">
              <div className="flex items-center justify-between border-b border-gray-800 pb-4 mb-4">
                 <h2 className="text-white font-industrial text-xl flex items-center">
                    <Package className="w-5 h-5 mr-3 text-yellow-500" /> Dependency Alignment
                 </h2>
                 <button onClick={fetchDeps} className="text-gray-500 hover:text-white transition-colors">
                   <RefreshCw className="w-4 h-4" />
                 </button>
              </div>
              <div className="flex-1 overflow-y-auto pr-2">
                {Object.keys(outdatedDeps).length === 0 ? (
                  <div className="flex items-center justify-center h-full text-green-500 text-xs font-mono">
                    <CheckCircle2 className="w-4 h-4 mr-2" /> All dependencies up to date
                  </div>
                ) : (
                  <div className="space-y-2">
                    {Object.entries(outdatedDeps).map(([pkg, info]: [string, any]) => (
                      <div key={pkg} className="flex justify-between items-center text-xs font-mono bg-gray-800/30 p-2 border border-gray-800">
                        <span className="text-white">{pkg}</span>
                        <div className="text-right">
                          <div className="text-gray-500 text-[10px]">Current: {info.current}</div>
                          <div className="text-yellow-500 text-[10px]">Latest: {info.latest}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
         </div>
      </div>

      {/* Ollama Local Agent */}
      <div className="industrial-card p-6">
        <div className="flex items-center justify-between border-b border-gray-800 pb-4 mb-4">
           <h2 className="text-white font-industrial text-xl flex items-center">
              <Bot className="w-5 h-5 mr-3 text-purple-500" /> Local AI (Ollama)
           </h2>
           <div className="text-[10px] font-mono text-purple-500 uppercase flex items-center">
             <Server className="w-3 h-3 mr-1" /> http://127.0.0.1:11434
           </div>
        </div>
        <div className="flex flex-col gap-4">
          <form onSubmit={handleOllamaSubmit} className="flex gap-4">
            <input 
              type="text" 
              value={ollamaPrompt}
              onChange={(e) => setOllamaPrompt(e.target.value)}
              placeholder="Ask the local model to analyze the codebase..."
              className="flex-1 bg-black border border-gray-700 text-white px-4 py-2 text-sm font-mono focus:border-purple-500 focus:outline-none transition-colors"
            />
            <button 
              type="submit" 
              disabled={isOllamaLoading}
              className="bg-purple-500 text-white px-6 py-2 font-black text-xs uppercase tracking-widest hover:bg-purple-600 transition-colors disabled:opacity-50"
            >
              {isOllamaLoading ? 'Thinking...' : 'Execute'}
            </button>
          </form>
          {ollamaResponse && (
            <div className="bg-black/50 border border-gray-800 p-4 text-sm font-mono text-gray-300 max-h-[300px] overflow-y-auto whitespace-pre-wrap">
              {ollamaResponse}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
