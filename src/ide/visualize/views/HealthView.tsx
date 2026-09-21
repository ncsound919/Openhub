import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import * as THREE from 'three';
import { getAuthHeaders } from '../../../auth/AuthProvider';
import type { SystemSnapshot } from '../useSnapshot';

const VERDICT_COLOR: Record<string, string> = { pass: '#3fb950', warn: '#e3b341', fail: '#f85149' };

function Orb({
  verdict,
  tools,
  driftRatio,
  crackCount,
}: {
  verdict: string | null;
  tools: { name: string; ok: boolean }[];
  driftRatio: number;
  crackCount: number;
}) {
  const group = useRef<THREE.Group>(null);
  const color = (verdict && VERDICT_COLOR[verdict]) || '#484f58';
  useFrame((_, delta) => {
    if (group.current) group.current.rotation.y += delta * 0.2;
  });

  const cracks = useMemo(() => {
    const n = Math.min(24, crackCount);
    return Array.from({ length: n }, (_, i) => {
      const a = (i / Math.max(1, n)) * Math.PI * 2;
      const r = 1.35;
      return { position: [Math.cos(a) * r, ((i * 37) % 20) / 10 - 1, Math.sin(a) * r] as [number, number, number] };
    });
  }, [crackCount]);

  return (
    <group ref={group}>
      <mesh>
        <sphereGeometry args={[1.1, 48, 48]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.55} roughness={0.35} />
      </mesh>
      {/* drift ring: radius grows with ahead+behind */}
      <mesh rotation={[Math.PI / 2.4, 0, 0]}>
        <torusGeometry args={[1.9 + driftRatio * 0.9, 0.035, 12, 64]} />
        <meshStandardMaterial color="#58a6ff" emissive="#58a6ff" emissiveIntensity={0.5} />
      </mesh>
      {/* audit-tool satellites */}
      {tools.slice(0, 10).map((t, i) => {
        const a = (i / Math.max(1, Math.min(10, tools.length))) * Math.PI * 2;
        return (
          <mesh key={t.name} position={[Math.cos(a) * 2.7, Math.sin(a * 2) * 0.7, Math.sin(a) * 2.7]}>
            <sphereGeometry args={[0.14, 16, 16]} />
            <meshStandardMaterial color={t.ok ? '#3fb950' : '#e3b341'} emissive={t.ok ? '#3fb950' : '#e3b341'} emissiveIntensity={0.9} />
          </mesh>
        );
      })}
      {/* work-order cracks */}
      {cracks.map((c, i) => (
        <mesh key={i} position={c.position}>
          <boxGeometry args={[0.1, 0.1, 0.1]} />
          <meshStandardMaterial color="#f85149" emissive="#f85149" emissiveIntensity={1} />
        </mesh>
      ))}
    </group>
  );
}

/** Repo health as an orb: color = audit verdict, satellites = audit tools, ring = drift, cracks = findings. */
export function HealthView({ snapshot }: { snapshot: SystemSnapshot | null }) {
  const [tools, setTools] = useState<{ name: string; ok: boolean }[]>([]);
  const [cracks, setCracks] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [tRes, rRes] = await Promise.all([
          fetch('/api/audit/tools', { credentials: 'include', headers: getAuthHeaders() }),
          fetch('/api/audit/readouts', { credentials: 'include', headers: getAuthHeaders() }),
        ]);
        const t = await tRes.json();
        const r = await rRes.json();
        if (cancelled) return;
        if (t.ok && Array.isArray(t.tools)) {
          setTools(t.tools.map((x: any) => ({ name: String(x.label ?? x.name), ok: !!x.configured })));
        }
        if (r.ok) {
          const total = typeof r.workOrder?.total === 'number' ? r.workOrder.total : 0;
          setCracks(total);
        }
      } catch { /* health extras unavailable */ }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const verdict = ((snapshot?.audit as any)?.ok ? (snapshot?.audit as any)?.verdict : null) ?? null;
  const drift: any = (snapshot?.drift as any) ?? {};
  const driftTotal = (drift.ahead ?? 0) + (drift.behind ?? 0) + (drift.uncommitted ?? 0);
  const project = (snapshot?.project as any)?.repositoryName ?? 'no project';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 px-1 pb-2">
        <span className="font-mono text-[10px] text-gray-400">
          {project} · verdict {verdict ?? '—'} · drift {driftTotal} · {cracks} open findings
        </span>
      </div>
      <div className="min-h-0 flex-1 rounded-lg border border-surface-overlay bg-black/40">
        <Canvas camera={{ position: [0, 1.5, 7], fov: 50 }}>
          <ambientLight intensity={0.6} />
          <pointLight position={[5, 5, 5]} intensity={1.2} />
          <Orb verdict={verdict} tools={tools} driftRatio={Math.min(1, driftTotal / 12)} crackCount={cracks} />
          <OrbitControls enableZoom />
          <Html position={[0, -2.4, 0]} center>
            <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#8b949e', whiteSpace: 'nowrap' }}>
              {verdict ? `audit: ${verdict}` : 'no audit recorded'}
            </div>
          </Html>
        </Canvas>
      </div>
    </div>
  );
}
