import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import * as THREE from 'three';
import { getAuthHeaders } from '../../../auth/AuthProvider';

interface BackendResult {
  name?: string;
  reachable?: boolean;
}
interface QueryItem {
  id: string;
  query: string;
  result?: { backends?: BackendResult[] } | null;
}

function Constellation({ queries }: { queries: QueryItem[] }) {
  const group = useRef<THREE.Group>(null);
  useFrame((state, delta) => {
    if (group.current && !state.gl?.xr?.isPresenting) group.current.rotation.y += delta * 0.12;
  });

  const shown = useMemo(() => queries.slice(0, 6), [queries]);

  return (
    <group ref={group}>
      {/* hub star: the research engine */}
      <mesh>
        <sphereGeometry args={[0.55, 32, 32]} />
        <meshStandardMaterial color="#e3b341" emissive="#e3b341" emissiveIntensity={1} />
      </mesh>
      {shown.map((q, i) => {
        const angle = (i / Math.max(1, shown.length)) * Math.PI * 2;
        const radius = 2.6;
        const pos: [number, number, number] = [Math.cos(angle) * radius, ((i % 3) - 1) * 0.9, Math.sin(angle) * radius];
        const backends = Array.isArray(q.result?.backends) ? q.result!.backends!.slice(0, 4) : [];
        return (
          <group key={q.id} position={pos}>
            <mesh>
              <sphereGeometry args={[0.28, 24, 24]} />
              <meshStandardMaterial color="#58a6ff" emissive="#58a6ff" emissiveIntensity={0.6} />
            </mesh>
            <Html position={[0, 0.55, 0]} center>
              <div style={{ fontFamily: 'monospace', fontSize: 10, color: '#c9d1d9', maxWidth: 140, textAlign: 'center' }}>
                {q.query.slice(0, 42)}
              </div>
            </Html>
            {backends.map((b, j) => {
              const ba = (j / Math.max(1, backends.length)) * Math.PI * 2;
              return (
                <mesh key={j} position={[Math.cos(ba) * 0.85, Math.sin(ba * 1.3) * 0.5, Math.sin(ba) * 0.85]}>
                  <sphereGeometry args={[0.11, 16, 16]} />
                  <meshStandardMaterial
                    color={b.reachable ? '#3fb950' : '#484f58'}
                    emissive={b.reachable ? '#3fb950' : '#000000'}
                    emissiveIntensity={b.reachable ? 0.8 : 0}
                  />
                </mesh>
              );
            })}
          </group>
        );
      })}
    </group>
  );
}

/** Research gathering as a forming constellation: queries orbit the hub, backends are moons. */
export function ResearchView() {
  const [queries, setQueries] = useState<QueryItem[]>([]);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/research/queries', { credentials: 'include', headers: getAuthHeaders() });
        const data = await res.json();
        if (!cancelled && data.ok) setQueries(Array.isArray(data.queries) ? data.queries.slice(0, 6) : []);
      } catch (err) {
        if (!cancelled) setNote(err instanceof Error ? err.message : 'research history unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 px-1 pb-2">
        <span className="font-mono text-[10px] text-gray-400">
          {queries.length ? `${queries.length} recent research constellations` : note || 'no research queries yet — ask the copilot'}
        </span>
      </div>
      <div className="min-h-0 flex-1 rounded-lg border border-surface-overlay bg-black/40">
        <Canvas camera={{ position: [0, 3.5, 9], fov: 50 }}>
          <ambientLight intensity={0.6} />
          <pointLight position={[6, 6, 6]} intensity={1.2} />
          <Constellation queries={queries} />
          <OrbitControls enableZoom />
        </Canvas>
      </div>
    </div>
  );
}
