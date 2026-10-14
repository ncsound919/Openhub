import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useStore } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { CircleDot, MessageSquare, Tag, Check, Filter, Bug, Lightbulb, Zap } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export function IssuesView() {
  const { owner, repo: repoName } = useParams();
  const repo = useStore((state) => state.repositories.find(r => r.owner === owner && r.name === repoName));
  const issues = useStore(useShallow(state => state.issues.filter(i => i.repoId === repo?.id)));
  const beginnerMode = useStore((state) => state.beginnerMode);
  
  const [showNewIssue, setShowNewIssue] = useState(false);
  
  if (!repo) return null;

  const openIssues = issues.filter(i => i.state === 'open').length;
  const closedIssues = issues.filter(i => i.state === 'closed').length;

  return (
    <div className="flex flex-col space-y-6">
      
      {/* Filters and search */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex w-full sm:w-auto">
          <button className="bg-surface-overlay hover:bg-border-muted border border-border-muted rounded-l-sm px-4 py-1.5 text-xs font-black uppercase tracking-widest text-gray-400 hover:text-[var(--color-text-primary)] transition-colors">
             Filters <span className="text-[10px] ml-1.5">▼</span>
          </button>
          <div className="relative flex-1 sm:w-80">
             <Filter className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" />
             <input type="text" defaultValue="is:issue is:open " className="w-full pl-9 pr-3 py-1.5 border-t border-b border-r rounded-r-sm border-border-muted bg-surface-overlay font-mono text-xs text-gray-400 focus:outline-none focus:border-blue-500" />
          </div>
        </div>
          <div className="flex space-x-2 w-full sm:w-auto">
            <button className="px-4 py-1.5 text-xs font-black uppercase tracking-widest border border-border-muted rounded-sm hover:bg-border-muted flex items-center bg-transparent text-gray-400 hover:text-[var(--color-text-primary)] transition-colors"><Tag className="w-3.5 h-3.5 mr-2" />Labels</button>
            <button className="px-4 py-1.5 text-xs font-black uppercase tracking-widest border border-border-muted rounded-sm hover:bg-border-muted flex items-center bg-transparent text-gray-400 hover:text-[var(--color-text-primary)] transition-colors">Milestones</button>
            <button 
              onClick={() => setShowNewIssue(!showNewIssue)}
              className="bg-orange-500 hover:bg-orange-400 text-black px-6 py-1.5 rounded-sm text-xs font-black uppercase tracking-widest transition-all shadow-lg"
            >
              New issue
            </button>
          </div>
      </div>
      
      {showNewIssue && beginnerMode && (
         <div className="border border-blue-500/30 bg-blue-500/10 p-6 rounded-lg shadow-sm animate-in slide-in-from-top-4 relative">
             <div className="absolute top-0 right-0 bg-info text-white px-3 py-1 rounded-bl-lg rounded-tr-lg text-xs font-bold tracking-widest uppercase">
               Guided Creator
             </div>
             <h3 className="text-xl font-bold text-gray-400 mb-2">What kind of issue are you creating?</h3>
             <p className="text-sm text-gray-400 mb-6 max-w-2xl">
               Select a template below, and we'll pre-fill the form with helpful headers so you don't forget to include important details.
             </p>
             <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <button className="flex flex-col items-center justify-center p-6 border-2 border-border-muted hover:border-red-400 hover:bg-red-50 rounded-lg text-center transition-all bg-surface-raised group">
                  <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                    <Bug className="w-6 h-6 text-red-500" />
                  </div>
                  <div className="font-bold text-gray-400 mb-1">Bug Report</div>
                  <div className="text-xs text-gray-400">Something isn't working right</div>
                </button>
                <button className="flex flex-col items-center justify-center p-6 border-2 border-border-muted hover:border-blue-400 hover:bg-blue-50 rounded-lg text-center transition-all bg-surface-raised group">
                  <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                    <Lightbulb className="w-6 h-6 text-blue-500" />
                  </div>
                  <div className="font-bold text-gray-400 mb-1">Feature Request</div>
                  <div className="text-xs text-gray-400">I have an idea for a new feature</div>
                </button>
                <button className="flex flex-col items-center justify-center p-6 border-2 border-border-muted hover:border-green-400 hover:bg-green-50 rounded-lg text-center transition-all bg-surface-raised group">
                  <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                    <Zap className="w-6 h-6 text-green-500" />
                  </div>
                  <div className="font-bold text-gray-400 mb-1">Task</div>
                  <div className="text-xs text-gray-400">Just a general item on the to-do list</div>
                </button>
             </div>
         </div>
      )}

      {/* Issue list */}
      <div className="border border-border-muted rounded-sm bg-surface-overlay shadow-sm overflow-hidden industrial-card">
        {/* List Header */}
        <div className="bg-surface-overlay border-b border-border-muted px-4 py-3 flex items-center justify-between text-[10px] font-black uppercase tracking-widest">
           <div className="flex space-x-4 text-gray-400">
             <div className="flex items-center text-[var(--color-text-primary)] cursor-pointer">
               <CircleDot className="w-3.5 h-3.5 mr-2 text-orange-500" /> {openIssues} Open
             </div>
             <div className="flex items-center hover:text-[var(--color-text-primary)] cursor-pointer transition-colors">
               <Check className="w-3.5 h-3.5 mr-2 text-green-500" /> {closedIssues} Closed
             </div>
           </div>
           
           <div className="hidden sm:flex space-x-4 text-gray-400 cursor-pointer">
             <span className="hover:text-gray-200">Author â¼</span>
             <span className="hover:text-gray-200">Label â¼</span>
             <span className="hover:text-gray-200">Projects â¼</span>
             <span className="hover:text-gray-200">Milestones â¼</span>
             <span className="hover:text-gray-200">Assignee â¼</span>
             <span className="hover:text-gray-200">Sort â¼</span>
           </div>
        </div>

        {/* List Body */}
        <div className="divide-y divide-border-muted">
          {issues.map(issue => (
            <div key={issue.id} className="flex p-4 hover:bg-white/5 transition-colors">
              <div className="pt-0.5 mr-3">
                {issue.state === 'open' 
                  ? <CircleDot className="w-5 h-5 text-green-600" /> 
                  : <Check className="w-5 h-5 text-purple-600 shrink-0" />}
              </div>
              <div className="flex-1">
                <div className="flex items-center flex-wrap gap-2 mb-1">
                  <a href="#" className="text-base font-semibold text-gray-400 hover:text-blue-600">{issue.title}</a>
                  {issue.labels.map(l => (
                    <span key={l.name} className={`${l.color} bg-opacity-20 text-${l.color.replace('bg-', 'text-').replace('-500', '-700')} border border-${l.color.replace('bg-', '').replace('-500', '-300')} text-xs px-2 py-0.5 rounded-full font-medium`}>
                      {l.name}
                    </span>
                  ))}
                </div>
                <div className="text-xs text-gray-400">
                  #{issue.number} opened {formatDistanceToNow(new Date(issue.createdAt))} ago by <a href="#" className="hover:text-blue-600 hover:underline">{issue.author.username}</a>
                </div>
              </div>
              
              <div className="hidden sm:flex ml-4 shrink-0 flex-col items-end justify-start pt-1 text-gray-400 hover:text-blue-600 cursor-pointer">
                {issue.comments > 0 && (
                  <div className="flex items-center text-xs">
                    <MessageSquare className="w-4 h-4 mr-1 stroke-2" /> {issue.comments}
                  </div>
                )}
              </div>
            </div>
          ))}
          {issues.length === 0 && (
            <div className="p-12 text-center text-gray-400">
              <CircleDot className="w-8 h-8 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-gray-400">No issues found</h3>
              <p>Welcome to issues! Issues are used to track todos, bugs, feature requests, and more.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
