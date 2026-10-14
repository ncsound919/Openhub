import { useEffect, useMemo, useState } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import { getAuthHeaders } from '../../../auth/AuthProvider';

interface GraphNode {
  id: string;
  name?: string;
  val?: number;
  color?: string;
}
interface GraphLink {
  source: string;
  target: string;
  value?: number;
}

const PALETTE = ['#58a6ff', '#3fb950', '#d76027', '#bc8cff', '#39c5cf', '#e3b341', '#f85149'];

/** Normalize the recourse synergy map (or domains list) into nodes/links. */
function toGraph(data: any): { nodes: GraphNode[]; links: GraphLink[] } {
  if (data && Array.isArray(data.nodes)) {
    const nodes: GraphNode[] = data.nodes.slice(0, 120).map((n: any, i: number) => ({
      id: String(n.id ?? n.name ?? i),
      name: String(n.name ?? n.id ?? i),
      val: typeof n.val === 'number' ? n.val : 1 + ((n.score ?? 0) as number),
      color: PALETTE[i % PALETTE.length],
    }));
    const ids = new Set(nodes.map((n) => n.id));
    const links: GraphLink[] = (Array.isArray(data.links) ? data.links : [])
      .filter((l: any) => ids.has(String(l.source)) && ids.has(String(l.target)))
      .slice(0, 300)
      .map((l: any) => ({ source: String(l.source), target: String(l.target), value: 1 }));
    return { nodes, links };
  }
  const domains: any[] = Array.isArray(data?.domains) ? data.domains : Array.isArray(data) ? data : [];
  const nodes: GraphNode[] = [{ id: 'synergy', name: 'Synergy', val: 3, color: '#f0f6fc' }];
  const links: GraphLink[] = [];
  domains.slice(0, 40).forEach((d: any, i: number) => {
    const id = String(d?.name ?? d?.domain ?? d ?? `domain-${i}`);
    nodes.push({ id, name: id, val: 1 + (typeof d?.score === 'number' ? d.score : 0), color: PALETTE[i % PALETTE.length] });
    links.push({ source: 'synergy', target: id, value: 1 });
  });
  return { nodes, links };
}

/** Synergy map as a 3D force-directed graph (domains = nodes, synergy = edges). */
export function SynergyView() {
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; links: GraphLink[] }>({ nodes: [], links: [] });
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/recourse/synergy/map', { credentials: 'include', headers: getAuthHeaders() });
        const data = await res.json();
        if (cancelled) return;
        if (!data?.available) {
          setNote(data?.error || 'Recourse synergy map offline.');
          return;
        }
        setGraph(toGraph(data.data));
      } catch (err) {
        if (!cancelled) setNote(err instanceof Error ? err.message : 'synergy map request failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const legend = useMemo(
    () => [
      { label: `${graph.nodes.length} domains`, color: '#58a6ff' },
      { label: `${graph.links.length} synergy links`, color: '#3fb950' },
    ],
    [graph],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 px-1 pb-2">
        {legend.map((l) => (
          <span key={l.label} className="inline-flex items-center gap-1.5 font-mono text-[10px] text-gray-400">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: l.color }} />
            {l.label}
          </span>
        ))}
        {note && <span className="ml-auto font-mono text-[10px] text-amber-300">{note}</span>}
      </div>
      <div className="min-h-0 flex-1 rounded-lg border border-surface-overlay bg-black/40">
        {graph.nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6 text-center font-mono text-xs text-gray-400">
            {note || 'Loading synergy map…'}
          </div>
        ) : (
          <ForceGraph3D
            graphData={graph}
            nodeLabel="name"
            nodeColor={(n: any) => n.color || '#58a6ff'}
            linkColor={() => 'rgba(88,166,255,0.35)'}
            backgroundColor="rgba(0,0,0,0)"
            showNavInfo={false}
          />
        )}
      </div>
    </div>
  );
}
