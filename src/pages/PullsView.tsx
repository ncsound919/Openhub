import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useStore } from '../store';
import { useShallow } from 'zustand/react/shallow';
import {
  GitPullRequest, GitMerge, MessageSquare, Filter, ExternalLink, Users,
  SplitSquareHorizontal, ChevronLeft, CheckCircle2, ShieldCheck, AlertCircle,
  Zap, Loader2, ShieldAlert, AlertTriangle, Info, Wrench, Check, RefreshCw,
  Activity, Cpu, Package, BookOpen, TestTube, Github,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { getCsrfToken } from '../auth/AuthProvider';
import { cn } from '../lib/utils';
import type { ReviewResult } from '../services/codeReviewer';

export function PullsView() {
  const { owner, repo: repoName } = useParams();
  const repo = useStore((state) => state.repositories.find(r => r.owner === owner && r.name === repoName));
  const protection = useStore((state) => state.branchProtection.find(rule => rule.repoId === repo?.id && rule.pattern === repo?.defaultBranch));
  const pulls = useStore(useShallow(state => state.pullRequests.filter(i => i.repoId === repo?.id)));
  
  const [selectedPR, setSelectedPR] = useState<any>(null);
  const [isAiReviewing, setIsAiReviewing] = useState(false);
  const [aiReviewResult, setAiReviewResult] = useState<ReviewResult | null>(null);
  const [aiWalkthrough, setAiWalkthrough] = useState<string | null>(null);
  const [aiReviewError, setAiReviewError] = useState<string | null>(null);
  const [isPosting, setIsPosting] = useState(false);
  const [githubPosted, setGithubPosted] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  if (!repo) return null;

  // Real GitHub PR review: fetches the PR diff from GitHub (via the stored
  // integration) and runs the static + LLM pipeline on it — never the local
  // worktree diff. With post=true the findings go back as inline PR comments.
  const runPrReview = async (post: boolean) => {
    if (!selectedPR) return;
    if (post) setIsPosting(true); else setIsAiReviewing(true);
    if (!post) {
      setAiReviewResult(null);
      setAiWalkthrough(null);
      setGithubPosted(false);
    }
    setAiReviewError(null);
    setPostError(null);

    try {
      const response = await fetch('/api/ai/review/pr', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': getCsrfToken(),
        },
        credentials: 'include',
        body: JSON.stringify({
          owner,
          repo: repoName,
          pullNumber: selectedPR.number,
          postToGitHub: post,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new Error(data?.error ?? `PR review request failed (HTTP ${response.status})`);
      }
      if (!data.result) {
        setAiWalkthrough(data.message ?? 'No diff found for this PR.');
        return;
      }
      setAiReviewResult(data.result);
      setAiWalkthrough(data.result.walkthrough ?? null);
      if (post) {
        if (data.postError) throw new Error(data.postError);
        if (!data.postedToGitHub) throw new Error('GitHub did not confirm the post-back.');
        setGithubPosted(true);
      }
    } catch (e: any) {
      const msg = e?.message || 'Technical error in reaching the review engine.';
      if (post) setPostError(`Post to GitHub failed: ${msg}`);
      else {
        setAiReviewError(msg);
        setAiWalkthrough(null);
      }
    } finally {
      if (post) setIsPosting(false); else setIsAiReviewing(false);
    }
  };

  const handleAiReview = () => runPrReview(false);
  const handlePostToGithub = () => runPrReview(true);

  const openPulls = pulls.filter(i => i.state === 'open').length;
  const closedPulls = pulls.filter(i => i.state === 'closed' || i.state === 'merged').length;

  return (
    <div className="flex flex-col space-y-6">
      {selectedPR ? (
        <div className="flex flex-col space-y-4">
          <div className="flex items-center space-x-2">
            <button onClick={() => setSelectedPR(null)} className="p-1 px-3 bg-surface-raised border border-border-muted rounded hover:bg-surface-base flex items-center text-sm font-bold shadow-sm">
                <ChevronLeft className="w-4 h-4 mr-1" /> Back to list
            </button>
            <h2 className="text-xl font-bold truncate flex-1">{selectedPR.title} <span className="text-gray-400 font-normal">#{selectedPR.number}</span></h2>
          </div>
          
          <div className="border border-border-muted rounded-md bg-surface-raised overflow-hidden shadow-sm">
             <div className="bg-surface-base border-b border-border-muted px-4 py-3 flex items-center justify-between">
                 <div className="flex items-center space-x-4 text-sm font-bold">
                    {/* Measured from the PR review when available — never hardcoded. */}
                    {aiReviewResult ? (
                      <>
                        <div className="text-gray-400 bg-surface-overlay px-2 py-1 rounded">Files reviewed: {aiReviewResult.summary.filesReviewed}</div>
                        <div className="text-green-600">{aiReviewResult.verdict.replace('_', ' ')}</div>
                      </>
                    ) : (
                      <div className="text-gray-400 bg-surface-overlay px-2 py-1 rounded">Diff stats appear after AI Review runs</div>
                    )}
                 </div>
                {protection && (
                   <div className="hidden md:flex items-center text-[10px] uppercase font-black text-blue-600 bg-blue-50 px-2 py-1 rounded border border-blue-100 tracking-widest">
                      <ShieldCheck className="w-3 h-3 mr-1.5" /> Branch Protected
                   </div>
                )}
                <div className="flex space-x-2">
                    <button 
                      onClick={handleAiReview}
                      disabled={isAiReviewing}
                      title={`Fetch the real diff for ${owner}/${repoName}#${selectedPR.number} from GitHub and run the static + LLM review`}
                      className="bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-bold hover:bg-blue-700 transition-colors shadow-sm flex items-center disabled:opacity-50"
                    >
                       {isAiReviewing ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : <Zap className="w-3.5 h-3.5 mr-2" />}
                       AI Review
                    </button>
                    <button
                      onClick={handlePostToGithub}
                      disabled={isPosting || !aiReviewResult || githubPosted}
                      title={!aiReviewResult ? 'Run AI Review first, then post its findings' : `Post findings as inline comments on ${owner}/${repoName}#${selectedPR.number}`}
                      className="bg-surface-overlay border border-border-muted text-gray-200 px-3 py-1.5 rounded-md text-sm font-bold hover:bg-surface-base transition-colors shadow-sm flex items-center disabled:opacity-50"
                    >
                       {isPosting ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : <Github className="w-3.5 h-3.5 mr-2" />}
                       {githubPosted ? 'Posted to GitHub' : isPosting ? 'Posting…' : 'Post to GitHub'}
                    </button>
                    <button className="bg-green-600 text-white px-3 py-1.5 rounded-md text-sm font-bold hover:bg-green-700 transition-colors shadow-sm">
                       Review changes
                    </button>
                 </div>
             </div>

              {/* AI Review Block — structured findings from the real PR diff */}
              {(isAiReviewing || aiReviewResult || aiWalkthrough || aiReviewError || postError) && (
              <div className="border-t border-border-muted">
                {/* Loading skeleton */}
                {isAiReviewing && (
                  <div className="p-4 flex items-center gap-3 text-xs text-purple-400 font-mono">
                    <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                    <span>AI is analyzing the PR diff — fetching real code changes from GitHub…</span>
                  </div>
                )}

                {/* Honest error states — never a canned failure sentence */}
                {!isAiReviewing && aiReviewError && (
                  <div className="p-4 bg-red-500/5 border-b border-red-500/20 text-xs text-red-400">
                    AI review failed: {aiReviewError} (connect GitHub in Settings and check the PR number)
                  </div>
                )}
                {!isAiReviewing && !aiReviewError && postError && (
                  <div className="p-4 bg-red-500/5 border-b border-red-500/20 text-xs text-red-400">
                    {postError}
                  </div>
                )}
                {!isAiReviewing && !aiReviewError && githubPosted && (
                  <div className="p-4 bg-emerald-500/5 border-b border-emerald-500/20 text-xs text-emerald-400 flex items-center gap-2">
                    <Check className="w-4 h-4" /> Findings posted as inline comments on {owner}/{repoName}#{selectedPR.number}.
                  </div>
                )}

               {/* Walk-through prose */}
               {!isAiReviewing && aiWalkthrough && (
                 <div className="p-4 bg-blue-500/5 border-b border-blue-500/20">
                   <div className="flex items-center gap-2 mb-2">
                     <Zap className="w-4 h-4 text-blue-400" />
                     <span className="text-xs font-bold text-blue-300 uppercase tracking-wider">AI Walk-Through</span>
                   </div>
                   <p className="text-xs text-gray-300 leading-relaxed">{aiWalkthrough}</p>
                 </div>
               )}

               {/* Verdict + metrics */}
               {!isAiReviewing && aiReviewResult && (
                 <div className="p-4 space-y-3">
                   <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
                     <span className={cn(
                       'font-bold uppercase px-2 py-0.5 rounded border',
                       aiReviewResult.verdict === 'APPROVE' && 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
                       aiReviewResult.verdict === 'COMMENT' && 'text-amber-400 border-amber-500/30 bg-amber-500/10',
                       aiReviewResult.verdict === 'REQUEST_CHANGES' && 'text-red-400 border-red-500/30 bg-red-500/10',
                     )}>
                       {aiReviewResult.verdict.replace('_', ' ')}
                     </span>
                     {aiReviewResult.summary.critical > 0 && (
                       <span className="text-red-400"><ShieldAlert className="w-3 h-3 inline mr-1" />{aiReviewResult.summary.critical} critical</span>
                     )}
                     {aiReviewResult.summary.warning > 0 && (
                       <span className="text-amber-400"><AlertTriangle className="w-3 h-3 inline mr-1" />{aiReviewResult.summary.warning} warnings</span>
                     )}
                     {aiReviewResult.summary.info > 0 && (
                       <span className="text-blue-400"><Info className="w-3 h-3 inline mr-1" />{aiReviewResult.summary.info} info</span>
                     )}
                     <span className="text-gray-500">{aiReviewResult.summary.filesReviewed} file(s) reviewed</span>
                   </div>

                   {/* Finding cards */}
                   {aiReviewResult.comments.length > 0 && (
                     <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                       {aiReviewResult.comments.slice(0, 12).map((c) => (
                         <div key={c.id} className="bg-surface-raised border border-border-muted rounded-lg p-3 space-y-1.5">
                           <div className="flex flex-wrap items-center gap-2">
                             <span className={cn(
                               'px-1.5 py-0.5 rounded text-[10px] font-bold font-mono uppercase',
                               c.severity === 'critical' && 'bg-red-500/20 text-red-400 border border-red-500/30',
                               c.severity === 'warning' && 'bg-amber-500/20 text-amber-400 border border-amber-500/30',
                               c.severity === 'info' && 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
                             )}>
                               {c.severity}
                             </span>
                             <span className="text-[10px] font-mono text-gray-500 uppercase bg-surface-base border border-border-muted px-1.5 py-0.5 rounded">
                               {c.category.replace('_', ' ')}
                             </span>
                             <span className={cn(
                               'text-[11px] font-bold font-mono uppercase px-1.5 py-0.5 rounded border',
                               c.determinism === 'deterministic'
                                 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                 : 'bg-purple-500/10 text-purple-400 border-purple-500/20',
                             )}>
                               {c.determinism === 'deterministic' ? '✓ RULE' : '⚡ AI'}
                             </span>
                             <span className="text-[10px] font-mono text-gray-500">{c.file}:{c.line}</span>
                           </div>
                           <div className="text-xs font-semibold text-gray-100">{c.title}</div>
                           <p className="text-xs text-gray-400 leading-relaxed">{c.description}</p>
                         </div>
                       ))}
                       {aiReviewResult.comments.length > 12 && (
                         <div className="text-center text-xs text-gray-500 py-2 font-mono">
                           +{aiReviewResult.comments.length - 12} more findings · Open Code Review panel for full analysis
                         </div>
                       )}
                     </div>
                   )}
                 </div>
               )}
             </div>
             )}


             <div className="p-0 font-mono text-xs overflow-x-auto">
                <div className="bg-surface-raised px-4 py-2 text-gray-400 border-b border-border-muted">
                   @@ -1,5 +1,14 @@ server.ts
                </div>
                <div className="bg-surface-raised">
                   <div className="px-4 py-0.5 text-gray-400">import express from "express";</div>
                   <div className="px-4 py-0.5 text-gray-400">const app = express();</div>
                   <div className="px-4 py-0.5 bg-red-50 text-red-700 flex">
                      <span className="w-6 shrink-0 opacity-50">-</span> const PORT = 8080;
                   </div>
                   <div className="px-4 py-0.5 bg-green-50 text-green-700 flex">
                      <span className="w-6 shrink-0 opacity-50">+</span> const PORT = process.env.PORT || 3000;
                   </div>
                   <div className="px-4 py-0.5 bg-green-50 text-green-700 flex">
                      <span className="w-6 shrink-0 opacity-50">+</span> 
                   </div>
                   <div className="px-4 py-0.5 bg-green-50 text-green-700 flex">
                      <span className="w-6 shrink-0 opacity-50">+</span> // Added health check endpoint for OpenHub internal monitoring
                   </div>
                   <div className="px-4 py-0.5 bg-green-500/10 text-green-500 flex">
                      <span className="w-6 shrink-0 opacity-50">+</span> app.get("/api/health", (req, res) =&gt; {'{'}
                   </div>
                   <div className="px-4 py-0.5 bg-green-50 text-green-700 flex">
                      <span className="w-6 shrink-0 opacity-50">+</span>   res.json({'{'} status: "ok" {'}'});
                   </div>
                   <div className="px-4 py-0.5 bg-green-50 text-green-700 flex">
                      <span className="w-6 shrink-0 opacity-50">+</span> {'}'});
                   </div>
                   <div className="px-4 py-0.5 text-gray-400">app.listen(PORT, () =&gt; {'{'}</div>
                </div>
             </div>
          </div>
          
          <div className="bg-surface-raised border border-border-muted rounded-md p-6 flex flex-col items-center justify-center text-center">
              {protection?.requireReviews ? (
                <div className="mb-4">
                   <div className="flex items-center justify-center space-x-2 text-yellow-500 mb-2">
                      <AlertCircle className="w-8 h-8" />
                      <span className="text-xl font-bold">Review required</span>
                   </div>
                   <p className="text-gray-400 text-sm">At least 1 approving review is required before merging to <span className="font-mono text-gray-400">main</span>.</p>
                </div>
              ) : (
                <>
                   {aiReviewResult ? (
                     <>
                       <CheckCircle2 className="w-12 h-12 text-green-500 mb-4" />
                       <h3 className="font-bold text-[var(--color-text-primary)] text-xl">AI review: {aiReviewResult.verdict.replace('_', ' ')}</h3>
                       <p className="text-gray-400 text-sm mt-2 max-w-md">
                         {aiReviewResult.summary.critical} critical · {aiReviewResult.summary.warning} warnings · {aiReviewResult.summary.info} info across {aiReviewResult.summary.filesReviewed} file(s), measured from the PR diff above.
                       </p>
                     </>
                   ) : (
                     <>
                       <CheckCircle2 className="w-12 h-12 text-gray-400 mb-4" />
                       <h3 className="font-bold text-[var(--color-text-primary)] text-xl">No review yet</h3>
                       <p className="text-gray-400 text-sm mt-2 max-w-md">Run AI Review to get an evidence-backed assessment before merging.</p>
                     </>
                   )}
                </>
              )}
             <button disabled={protection?.requireReviews} className={`mt-6 font-bold px-6 py-2 rounded-md transition-colors shadow-lg ${protection?.requireReviews ? 'bg-surface-overlay text-gray-400 cursor-not-allowed' : 'bg-success hover:bg-success text-[var(--color-text-primary)]'}`}>
                {protection?.requireReviews ? 'Merge Blocked' : 'Merge pull request'}
             </button>
          </div>
        </div>
      ) : (
        <>
          {/* 3rd Party Integration Banner / Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-surface-raised border border-border-muted rounded-md p-4 shadow-sm gap-4">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-info/10 rounded-full border border-info/30 flex items-center justify-center shrink-0">
            <Users className="w-5 h-5 text-info" />
          </div>
          <div>
            <h3 className="font-bold text-text-primary tracking-tight">Pull-request review</h3>
            <p className="text-xs text-text-secondary">AI + static review of the real PR diff, with one-click post-back to GitHub.</p>
          </div>
        </div>
        <div className="flex space-x-3 w-full sm:w-auto">
          <button className="px-3 py-1.5 w-full sm:w-auto justify-center text-xs font-bold border border-border-muted rounded-md hover:bg-border-muted transition-colors text-text-primary bg-transparent flex items-center">
             <ExternalLink className="w-3.5 h-3.5 mr-1.5" /> Manage Integrations
          </button>
        </div>
      </div>

      {/* Filters and search */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex w-full sm:w-auto">
          <button className="bg-surface-overlay hover:bg-border-muted border border-border-muted rounded-l-sm px-4 py-1.5 text-xs font-black uppercase tracking-widest text-gray-400 hover:text-[var(--color-text-primary)] transition-colors">
             Filters <span className="text-[10px] ml-1.5">▼</span>
          </button>
          <div className="relative flex-1 sm:w-80">
             <Filter className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" />
             <input type="text" defaultValue="is:pr is:open " className="w-full pl-9 pr-3 py-1.5 border-t border-b border-r rounded-r-sm border-border-muted bg-surface-overlay font-mono text-xs text-gray-400 focus:outline-none focus:border-blue-500" />
          </div>
        </div>
        <div className="flex space-x-2 w-full sm:w-auto">
           <button className="bg-orange-500 hover:bg-orange-400 text-black px-6 py-1.5 rounded-sm text-xs font-black uppercase tracking-widest transition-all shadow-lg">New pull request</button>
        </div>
      </div>

      {/* PR list */}
      <div className="border border-border-muted rounded-sm bg-surface-overlay shadow-sm overflow-hidden industrial-card">
        {/* List Header */}
        <div className="bg-surface-overlay border-b border-border-muted px-4 py-3 flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-gray-400">
           <div className="flex space-x-4">
             <div className="flex items-center text-[var(--color-text-primary)] cursor-pointer hover:text-orange-500 transition-colors">
               <GitPullRequest className="w-3.5 h-3.5 mr-2 text-[var(--color-text-primary)]" /> {openPulls} Open
             </div>
             <div className="flex items-center hover:text-[var(--color-text-primary)] cursor-pointer transition-colors">
               <GitMerge className="w-3.5 h-3.5 mr-2 text-purple-500" /> {closedPulls} Closed
             </div>
           </div>
           
           <div className="hidden sm:flex space-x-4 text-gray-400 cursor-pointer">
             <span className="hover:text-gray-200">Author â¼</span>
             <span className="hover:text-gray-200">Label â¼</span>
             <span className="hover:text-gray-200">Projects â¼</span>
             <span className="hover:text-gray-200">Milestones â¼</span>
             <span className="hover:text-gray-200">Sort â¼</span>
           </div>
        </div>

        {/* List Body */}
        <div className="divide-y divide-border-muted">
          {pulls.map((pr, index) => (
            <div key={pr.id} 
              onClick={() => setSelectedPR(pr)}
              className="flex p-4 hover:bg-surface-base transition-colors relative group cursor-pointer"
            >
              <div className="pt-0.5 mr-3">
                {pr.state === 'open' 
                  ? <GitPullRequest className="w-5 h-5 text-green-600" /> 
                  : <GitMerge className="w-5 h-5 text-purple-600 shrink-0" />}
              </div>
              <div className="flex-1">
                <div className="flex items-center flex-wrap gap-2 mb-1">
                  <a href="#" className="text-base font-semibold text-gray-400 hover:text-blue-600">{pr.title}</a>
                </div>
                <div className="text-xs text-gray-400">
                  #{pr.number} opened {formatDistanceToNow(new Date(pr.createdAt))} ago by <a href="#" className="hover:text-blue-600 hover:underline">{pr.author.username}</a>
                  <span className="ml-2 font-mono text-[10px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded">
                    {pr.targetBranch} â {pr.sourceBranch}
                  </span>
                </div>
              </div>
              
              <div className="hidden sm:flex ml-4 shrink-0 flex-col items-end justify-between pt-1">
                <div className="flex space-x-2 text-gray-400 hover:text-blue-600 cursor-pointer">
                  {pr.comments > 0 && (
                    <div className="flex items-center text-xs">
                      <MessageSquare className="w-4 h-4 mr-1 stroke-2" /> {pr.comments}
                    </div>
                  )}
                </div>
                
                {pr.state === 'open' && (
                  <div className="mt-2 flex space-x-2">
                    <button title="Sync to Jira" className="w-7 h-7 flex items-center justify-center rounded-md border border-border-muted hover:bg-surface-raised hover:text-blue-600 transition-colors text-gray-400">
                      <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                    <button title="Live Code Review" className="w-7 h-7 flex items-center justify-center rounded-md border border-border-muted hover:bg-surface-raised hover:text-blue-600 transition-colors text-gray-400">
                      <SplitSquareHorizontal className="w-3.5 h-3.5" />
                    </button>
                    <button title="Join Voice Channel" className="w-7 h-7 flex items-center justify-center rounded-full bg-green-100 border border-green-300 text-green-700 hover:bg-green-200 transition-colors">
                      <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
          {pulls.length === 0 && (
            <div className="p-12 text-center text-gray-400">
              <GitPullRequest className="w-8 h-8 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-gray-400">No pull requests found</h3>
              <p>Welcome to pull requests! PRs are where code reviews and collaboration happen.</p>
            </div>
          )}
        </div>
        </div>
      </>
      )}
    </div>
  );
}
