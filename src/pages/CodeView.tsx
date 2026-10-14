import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useStore, FileNode, SecurityFinding } from '../store';
import { File, Folder, HardDrive, History, Tags, Check, Search, Download, Star, UploadCloud, Eye, Lightbulb, ChevronRight, CornerDownRight, Copy, ShieldAlert, ShieldCheck, Loader2, Terminal } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

export function CodeView() {
  const { owner, repo: repoName } = useParams();
  const { repositories, beginnerMode, scanFile, logAuditAction, triggerPipeline, currentUser } = useStore();
  const repo = repositories.find(r => r.owner === owner && r.name === repoName);
  
  const [selectedFile, setSelectedFile] = useState<FileNode | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanResults, setScanResults] = useState<SecurityFinding[] | null>(null);
  const [readmeContent, setReadmeContent] = useState<string | null>(null);

  React.useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/repos/${owner}/${repoName}/contents?path=README.md`, { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data.type === 'file' && typeof data.content === 'string') {
          setReadmeContent(data.content);
        }
      } catch { /* README unavailable — leave empty */ }
    })();
    return () => { cancelled = true; };
  }, [owner, repoName, repo?.id]);
  
  if (!repo) return null;

  const handleScan = async () => {
    if (!selectedFile) return;
    setIsScanning(true);
    setScanResults(null);
    
    // Scan the actual selected file content. If the file is empty, there is
    // nothing to scan, so surface zero findings rather than fabricating input.
    const content = selectedFile.content || '';
    
    const findings = await scanFile(content, selectedFile.name);
    setScanResults(findings);
    setIsScanning(false);
    
    logAuditAction('security.file_scan', `Scanned ${selectedFile.name} - ${findings.length} findings`, repo.id);
  };

  const handleQuickUpload = async () => {
    if (!selectedFile) return;
    setIsScanning(true);
    logAuditAction('verification.scan', `Scanning ${selectedFile.name} before verification loop`, repo.id);

    // Honest pre-check: scan the exact content, then run the Axiom
    // verification loop. This never commits or pushes to GitHub — use
    // Settings → GitHub → Push Sync for a real push.
    const findings = await scanFile(selectedFile.content || '', selectedFile.name);
    if (findings.length > 0) {
      logAuditAction('verification.blocked', `Verification blocked by pre-check: secrets detected in ${selectedFile.name}`, repo.id);
      alert('Verification blocked: security scan detected sensitive information in this file.');
    } else {
      logAuditAction('verification.requested', `Verification loop requested for ${selectedFile.name} via Axiom engine`, repo.id);
      try {
        const runId = await triggerPipeline(repo.id, `Verify ${selectedFile.name} via web`);
        if (runId) {
          logAuditAction('verification.started', `Axiom verification loop ${runId} started for ${selectedFile.name}`, repo.id);
        } else {
          logAuditAction('verification.failed', `Axiom verification loop could not start for ${selectedFile.name}`, repo.id);
          alert('Verification loop could not start — check the Axiom engine status.');
        }
      } catch {
        logAuditAction('verification.failed', `Axiom verification loop error for ${selectedFile.name}`, repo.id);
      }
    }
    setIsScanning(false);
  };

  return (
    <div className="flex flex-col md:flex-row gap-6">
      <div className="md:w-3/4 flex flex-col">
        {beginnerMode && !selectedFile && (
          <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg flex items-start">
            <div className="flex-1">
              <h3 className="font-bold text-yellow-800 text-lg mb-1">Welcome to Beginner Mode!</h3>
              <p className="text-sm text-yellow-800/80 mb-3">
                This mode highlights features to help you navigate and use the version control system effectively. Try dragging files into the box below to quickly upload them, or check out the Visual History.
              </p>
            </div>
            <button className="text-xs font-bold uppercase tracking-widest text-success bg-success/10 hover:bg-success/20 border border-success px-3 py-1.5 rounded-md flex items-center transition-colors">
              Begin Tutorial
            </button>
          </div>
        )}

        {/* Breadcrumb Navigation */}
        <div className="flex items-center space-x-2 text-sm mb-4">
          <Link to={`/${owner}/${repoName}`} className="text-info font-bold hover:underline" onClick={() => setSelectedFile(null)}>
            {repoName}
          </Link>
          {selectedFile && (
            <>
              <ChevronRight className="w-4 h-4 text-gray-400" />
              <span className="text-gray-400 font-medium truncate max-w-[200px]">{selectedFile.name}</span>
            </>
          )}
        </div>

        {/* Top actions toolbar */}
        {!selectedFile && (
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 gap-4">
            <div className="flex items-center space-x-2">
               <button className="bg-surface-raised hover:bg-surface-base border border-border-muted rounded-md px-3 py-1.5 text-sm font-semibold flex items-center shadow-sm">
                 <History className="w-4 h-4 mr-2 text-gray-400" /> {repo.defaultBranch} <span className="text-xs ml-1.5">â–¼</span>
               </button>
                <div className="flex items-center text-sm text-gray-400 space-x-4 ml-4">
                  <span className="flex items-center" title="Files tracked in this workspace view">
                    <History className="w-4 h-4 mr-1 text-gray-400" />
                    <span className="font-semibold mr-1">{repo.files.length}</span> Files
                  </span>
                  <span className="flex items-center" title="Branches in this workspace view">
                    <Tags className="w-4 h-4 mr-1 text-gray-400" />
                    <span className="font-semibold mr-1">{repo.branches.length}</span> Branches
                  </span>
                </div>
            </div>
            
            <div className="flex space-x-2">
              <button 
                onClick={handleQuickUpload}
                disabled={isScanning}
                className="text-xs font-bold uppercase tracking-widest text-success bg-success/10 hover:bg-success/20 border border-success px-3 py-1.5 rounded-md flex items-center transition-colors disabled:opacity-50"
              >
                {isScanning ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <UploadCloud className="w-4 h-4 mr-2" />}
                Scan & Verify
              </button>
              <button className="text-xs font-bold uppercase tracking-widest text-info bg-info/10 hover:bg-info/20 border border-info px-3 py-1.5 rounded-md flex items-center transition-colors hidden sm:flex">
                <Eye className="w-4 h-4 mr-2" /> Visual History
              </button>
              <div className="relative group">
                <button className="text-sm font-medium text-white bg-green-600 hover:bg-green-700 px-3 py-1.5 rounded-md flex items-center shadow-md">
                  <Download className="w-4 h-4 mr-1" /> Code <span className="text-xs ml-1.5">▼</span>
                </button>
                <div className="absolute right-0 mt-2 w-80 bg-surface-raised border border-border-muted rounded-lg shadow-xl hidden group-hover:block z-50 overflow-hidden">
                  <div className="p-4 space-y-4">
                    <div className="flex items-center justify-between text-xs font-black uppercase tracking-widest text-gray-400">
                      <span>Clone</span>
                      <ShieldCheck className="w-4 h-4 text-green-500" />
                    </div>
                    
                    <div className="space-y-3">
                      <div>
                        <label className="text-[10px] font-bold text-gray-400 mb-1 block">HTTPS</label>
                        <div className="flex items-center bg-surface-base border border-border-muted rounded px-2 py-1.5">
                          <input 
                            readOnly 
                            value={`https://openhub.internal/${owner}/${repoName}.git`} 
                            className="bg-transparent text-[11px] font-mono text-gray-400 flex-1 outline-none" 
                          />
                          <button aria-label="Copy HTTPS clone URL" title="Copy HTTPS clone URL" className="text-gray-400 hover:text-blue-500 ml-2"><Copy className="w-3.5 h-3.5" /></button>
                        </div>
                      </div>
                      
                      <div>
                        <label className="text-[10px] font-bold text-gray-400 mb-1 block uppercase">SSH</label>
                        <div className="flex items-center bg-surface-overlay border border-border-muted rounded px-2 py-1.5">
                          <input 
                            readOnly 
                            value={`git@openhub.internal:${owner}/${repoName}.git`} 
                            className="bg-transparent text-[11px] font-mono text-gray-400 flex-1 outline-none" 
                          />
                          <button aria-label="Copy SSH clone URL" title="Copy SSH clone URL" className="text-gray-400 hover:text-blue-500 ml-2"><Copy className="w-3.5 h-3.5" /></button>
                        </div>
                      </div>
                    </div>

                    <div className="pt-4 border-t border-border-muted italic text-[10px] text-gray-400">
                      Use your <Link to="/settings" className="text-blue-500 hover:underline">SSH keys</Link> for secure local transport without passwords.
                    </div>
                  </div>
                  
                  <div className="bg-surface-base p-2 border-t border-border-muted flex flex-col space-y-1">
                    <button className="w-full text-left px-3 py-2 text-xs font-bold text-gray-400 hover:bg-surface-raised hover:text-blue-600 rounded flex items-center transition-colors">
                      <Download className="w-3.5 h-3.5 mr-2" /> Download ZIP
                    </button>
                    <button className="w-full text-left px-3 py-2 text-xs font-bold text-gray-400 hover:bg-surface-raised hover:text-blue-600 rounded flex items-center transition-colors">
                      <Terminal className="w-3.5 h-3.5 mr-2" /> Open in Local Terminal
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* File tree or single file viewer */}
        <div 
          className={`border ${isDragging ? 'border-blue-500 bg-blue-500/10' : 'border-border-muted bg-surface-raised'} rounded-md overflow-hidden shadow-sm relative transition-all duration-200`}
          onDragOver={(e) => { e.preventDefault(); !selectedFile && setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => { e.preventDefault(); setIsDragging(false); }}
        >
          {isDragging && !selectedFile && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-surface-raised/90 backdrop-blur-sm border-2 border-dashed border-info rounded-md m-1">
              <UploadCloud className="w-16 h-16 text-info mb-4 animate-bounce" />
              <h2 className="text-text-primary !text-xl font-display uppercase tracking-widest text-center">Drop files to upload</h2>
              <p className="text-text-secondary mt-2 font-mono text-[10px] uppercase tracking-widest">// Auto-commits to {repo.defaultBranch}</p>
            </div>
          )}

          {!selectedFile ? (
            <>
              {/* Header */}
              <div className="bg-surface-base border-b border-border-muted px-4 py-3 flex items-center justify-between">
                <div className="flex items-center space-x-3 text-sm">
                  <img src={currentUser?.avatarUrl} alt="author" className="w-6 h-6 rounded-full" />
                  <a href="#" className="font-semibold hover:underline hover:text-blue-600">developer</a>
                  <span className="text-gray-400 truncate max-w-xs">{repo.files[0]?.lastCommitMessage || 'Initial commit'}</span>
                </div>
                <div className="text-sm text-gray-400 hidden sm:flex items-center space-x-2">
                  <Check className="w-4 h-4 text-green-500" />
                  <span>{repo.files[0] ? formatDistanceToNow(new Date(repo.files[0].lastCommitDate!)) : '1 day'} ago</span>
                </div>
              </div>

              {/* Files List */}
              <ul className="text-sm">
                {repo.files.map((file, i) => (
                  <li key={file.name} className={`flex items-center px-4 py-2 border-b border-border-muted hover:bg-surface-base transition-colors ${i === repo.files.length - 1 ? 'border-none' : ''}`}>
                    <div className="w-1/3 flex items-center">
                      {file.type === 'dir' ? (
                        <Folder className="w-4 h-4 text-blue-400 mr-2 shrink-0 fill-current" />
                      ) : (
                        <File className="w-4 h-4 text-gray-400 mr-2 shrink-0" />
                      )}
                      <button 
                        onClick={() => file.type === 'file' && setSelectedFile(file)}
                        className={`text-gray-400 hover:text-blue-600 hover:underline text-left ${file.type === 'dir' ? 'cursor-default' : 'cursor-pointer font-medium'}`}
                      >
                        {file.name}
                      </button>
                    </div>
                    <div className="w-1/2 text-gray-400 truncate hidden sm:block">
                      <span className="hover:text-blue-600 transition-colors cursor-default">{file.lastCommitMessage}</span>
                    </div>
                    <div className="w-1/6 text-right text-gray-400 text-xs hidden sm:block">
                      {formatDistanceToNow(new Date(file.lastCommitDate!))} ago
                    </div>
                  </li>
                ))}
                {repo.files.length === 0 && (
                  <div className="p-8 text-center text-gray-400 font-mono text-sm">// Repository is currently empty.</div>
                )}
              </ul>
            </>
          ) : (
            <>
              {/* Single File Header */}
              <div className="bg-surface-base border-b border-border-muted px-4 py-3 flex items-center justify-between">
                <div className="flex items-center space-x-4">
                   <div className="flex items-center text-sm font-mono text-gray-400">
                      <File className="w-4 h-4 mr-2" />
                      {selectedFile.name}
                   </div>
                   <div className="text-[10px] text-gray-400 border border-border-muted px-1.5 py-0.5 rounded tracking-widest uppercase font-bold">
                      {(selectedFile.name.split('.').pop() || 'text').toUpperCase()}
                   </div>
                </div>
                <div className="flex items-center space-x-2">
                   <button 
                     onClick={handleScan}
                     disabled={isScanning}
                     className={`flex items-center text-xs font-bold uppercase tracking-widest px-3 py-1.5 rounded-md border transition-all ${
                       scanResults && scanResults.length > 0 
                       ? 'bg-red-50 text-red-600 border-red-200 hover:bg-red-100' 
                       : 'bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100'
                     }`}
                   >
                     {isScanning ? (
                       <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                     ) : (
                       <ShieldAlert className="w-3.5 h-3.5 mr-2" />
                     )}
                     {isScanning ? 'Scanning...' : 'Security Audit'}
                   </button>
                   <button className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-white/5 rounded transition-colors" title="Copy Content">
                      <Copy className="w-4 h-4" />
                   </button>
                   <button className="text-xs font-bold text-gray-400 hover:text-gray-200 px-3 py-1.5 border border-border-muted rounded hover:bg-surface-base transition-colors">
                      Raw
                   </button>
                </div>
              </div>
              {/* File Content with Syntax Highlighting */}
              <div className="overflow-x-auto">
                <SyntaxHighlighter 
                  language={selectedFile.name.split('.').pop() === 'ts' ? 'typescript' : 'javascript'}
                  style={vscDarkPlus}
                  customStyle={{
                    margin: 0,
                    borderRadius: 0,
                    fontSize: '13px',
                    lineHeight: '1.6'
                  }}
                  showLineNumbers={true}
                >
                  {selectedFile.content || ''}
                </SyntaxHighlighter>
              </div>
              
              {scanResults && (
                <div className={`p-4 border-t ${scanResults.length > 0 ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'}`}>
                  <h4 className={`text-sm font-bold flex items-center mb-2 ${scanResults.length > 0 ? 'text-red-800' : 'text-green-800'}`}>
                    {scanResults.length > 0 ? <ShieldAlert className="w-4 h-4 mr-2" /> : <ShieldCheck className="w-4 h-4 mr-2" />}
                    Security Scan Summary
                  </h4>
                  {scanResults.length > 0 ? (
                    <div className="space-y-2">
                       {scanResults.map(f => (
                         <div key={f.id} className="text-xs text-red-700 bg-white/50 p-2 rounded border border-red-100 flex items-start">
                            <span className="font-mono bg-red-100 px-1 rounded mr-2">L{f.line}</span>
                            <div>
                               <div className="font-bold">{f.title}</div>
                               <div className="opacity-80">{f.description}</div>
                            </div>
                         </div>
                       ))}
                    </div>
                  ) : (
                    <p className="text-xs text-green-700 italic">No secrets or vulnerabilities detected in this file snapshot.</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        
        {beginnerMode && !selectedFile && (
          <div className="mt-8 border border-border-muted bg-bg-base rounded-md overflow-hidden relative shadow-lg">
            <div className="bg-surface-raised border-b border-border-muted px-4 py-2 font-bold text-xs uppercase tracking-widest text-text-primary">
              Git Flow Anatomy
            </div>
            <div className="p-6 flex flex-col md:flex-row items-center justify-between text-center gap-6">
               <div className="flex-1 bg-surface-raised border border-border-muted p-4 rounded-md relative z-10 w-full">
                  <div className="text-text-secondary text-xs font-bold uppercase tracking-wider mb-2">Stage 1</div>
                  <div className="text-[var(--color-text-primary)] font-bold mb-1">Local Workspace</div>
                  <div className="text-xs text-text-secondary">Your actual files on disk.</div>
               </div>
               
               <div className="hidden md:flex flex-col items-center justify-center shrink-0 w-8">
                  <span className="text-text-secondary text-[10px] font-bold uppercase mb-1">Commit</span>
                  <div className="w-full h-0.5 bg-border-muted relative after:content-[''] after:absolute after:right-0 after:-top-1 after:border-t-4 after:border-t-transparent after:border-b-4 after:border-b-transparent after:border-l-4 after:border-l-border-muted"></div>
               </div>
               <div className="md:hidden h-8 flex flex-col items-center justify-center w-full">
                  <div className="h-full w-0.5 bg-border-muted"></div>
               </div>
               
               <div className="flex-1 bg-success/10 border border-success/30 p-4 rounded-md relative z-10 w-full">
                  <div className="text-success text-xs font-bold uppercase tracking-wider mb-2">Stage 2</div>
                  <div className="text-text-primary font-bold mb-1">Local Repository</div>
                  <div className="text-xs text-text-secondary">Tracked changes in OpenHub.</div>
               </div>
               
               <div className="hidden md:flex flex-col items-center justify-center shrink-0 w-8">
                  <span className="text-info text-[10px] font-bold uppercase mb-1">Push</span>
                  <div className="w-full h-0.5 bg-info/50 relative after:content-[''] after:absolute after:right-0 after:-top-1 after:border-t-4 after:border-t-transparent after:border-b-4 after:border-b-transparent after:border-l-4 after:border-l-info/50"></div>
               </div>
               <div className="md:hidden h-8 flex flex-col items-center justify-center w-full">
                  <div className="h-full w-0.5 bg-info/50"></div>
               </div>
               
               <div className="flex-1 bg-info/10 border border-info/30 p-4 rounded-md relative z-10 w-full">
                  <div className="text-info text-xs font-bold uppercase tracking-wider mb-2">Stage 3</div>
                  <div className="text-text-primary font-bold mb-1">Remote Server</div>
                  <div className="text-xs text-text-secondary">Synced to cloud/other machines.</div>
               </div>
            </div>
          </div>
        )}
        
        {/* Real README rendered from the repository's actual file */}
        {readmeContent && (
          <div className="mt-8 border border-border-muted rounded-md bg-surface-raised overflow-hidden shadow-sm">
            <div className="bg-surface-base border-b border-border-muted px-4 py-3 font-semibold flex items-center">
              <Search className="w-4 h-4 mr-2 text-gray-400" /> README.md
            </div>
            <pre className="p-8 font-mono text-xs text-gray-400 whitespace-pre-wrap break-words max-h-[600px] overflow-y-auto">{readmeContent}</pre>
          </div>
        )}
      </div>

      <div className="md:w-1/4 flex flex-col space-y-6">
        
        {beginnerMode && (
          <div className="border border-yellow-200 bg-yellow-50 rounded-md p-4">
            <h3 className="font-bold text-yellow-800 flex items-center mb-3">
              <Lightbulb className="w-4 h-4 mr-2" /> Learning Center
            </h3>
            <ul className="space-y-3 text-sm">
              <li><a href="#" className="flex hover:underline text-blue-600 font-medium">How Version Control Works</a></li>
              <li><a href="#" className="flex hover:underline text-blue-600 font-medium">When to Commit vs Push</a></li>
              <li><a href="#" className="flex hover:underline text-blue-600 font-medium">Anatomy of a Code Review</a></li>
              <li><a href="#" className="flex hover:underline text-blue-600 font-medium">Resolving Merge Conflicts Visually</a></li>
            </ul>
          </div>
        )}

        <div>
          <h3 className="font-semibold text-gray-400 mb-2">About</h3>
          <p className="text-sm text-gray-400 mb-4">{repo.description}</p>
          <div className="flex items-center text-sm text-gray-400 hover:text-blue-600 cursor-pointer mb-2">
            <HardDrive className="w-4 h-4 mr-2" /> Readme
          </div>
          <div className="flex items-center text-sm text-gray-400 hover:text-blue-600 cursor-pointer mb-4">
            <Star className="w-4 h-4 mr-2" /> {repo.stars} stars
          </div>
          <div className="border border-border-muted mt-4"></div>
        </div>

        <div>
          <h3 className="font-semibold text-gray-400 mb-2">Releases</h3>
          <p className="text-sm text-gray-400">No releases published</p>
        </div>

        <div>
          <h3 className="font-semibold text-gray-400 mb-2">Packages</h3>
          <p className="text-sm text-gray-400">No packages published</p>
        </div>

        <div>
          <h3 className="font-semibold text-gray-400 mb-2">Languages</h3>
          <div className="w-full h-2 bg-surface-overlay rounded-full overflow-hidden flex mb-2 mt-2">
            <div className="bg-blue-500 w-[100%] h-full"></div>
          </div>
          <div className="flex items-center justify-between text-xs font-semibold text-gray-400 px-1">
             <div className="flex items-center"><span className="w-2 h-2 rounded-full bg-blue-500 mr-1.5"></span>{repo.language}</div>
             <span>100%</span>
          </div>
        </div>
      </div>
    </div>
  );
}
