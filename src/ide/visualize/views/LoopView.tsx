import { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import * as THREE from 'three';
import type { SystemSnapshot } from '../useSnapshot';

const STATUS_COLOR: Record<string, string> = {
  looping: '#d76027',
  auditing: '#58a6ff',
  repairing: '#e3b341',
  complete: '#3fb950',
  failed: '#f85149',
};

function Helix({ iteration, max, color }: { iteration: number; max: number; color: string }) {
  const group = useRef<THREE.Group>(null);
  const rings = useMemo(() => {
    const total = Math.max(1, Math.min(24, max));
    return Array.from({ length: total }, (_, i) => {
      const t = i / Math.max(1, total - 1);
      const angle = t * Math.PI * 4;
      return {
        position: [Math.cos(angle) * 2.2, (t - 0.5) * 5, Math.sin(angle) * 2.2] as [number, number, number],
        lit: i < Math.round((iteration / Math.max(1, max)) * total),
      };
    });
  }, [iteration, max]);

  useFrame((_, delta) => {
    if (group.current) group.current.rotation.y += delta * 0.25;
  });

  return (
    <group ref={group}>
      {rings.map((r, i) => (
        <mesh key={i} position={r.position}>
          <torusGeometry args={[0.28, 0.05, 12, 32]} />
          <meshStandardMaterial color={r.lit ? color : '#21262d'} emissive={r.lit ? color : '#000000'} emissiveIntensity={r.lit ? 0.9 : 0} />
        </mesh>
      ))}
      <mesh>
        <sphereGeometry args={[0.7, 32, 32]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.7} />
      </mesh>
    </group>
  );
}

/** Axiom long-run as an iteration helix: rings ignite per iteration, core = status. */
export function LoopView({ snapshot }: { snapshot: SystemSnapshot | null }) {
  const run = (snapshot?.runs as any)?.latest ?? null;
  const iteration = typeof run?.iteration === 'number' ? run.iteration : 0;
  const max = typeof run?.maxIterations === 'number' ? run.maxIterations : 8;
  const status: string = run?.status ?? 'idle';
  const color = STATUS_COLOR[status] ?? '#484f58';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 px-1 pb-2">
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-gray-400">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
          {run ? `${run.goal ?? 'run'} · iter ${iteration}/${max} · ${status}` : 'no supervised run yet'}
        </span>
      </div>
      <div className="min-h-0 flex-1 rounded-lg border border-surface-overlay bg-black/40">
        <Canvas camera={{ position: [0, 2.5, 9], fov: 50 }}>
          <ambientLight intensity={0.6} />
          <pointLight position={[6, 6, 6]} intensity={1.2} />
          <Helix iteration={iteration} max={max} color={color} />
          <OrbitControls enableZoom autoRotate={!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches} autoRotateSpeed={0.8} />
          <Html position={[0, -3.4, 0]} center>
            <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#8b949e', whiteSpace: 'nowrap' }}>
              {run ? `loop ${(run.loopId ?? '').toString().slice(0, 8)}` : 'dispatch a run to light the helix'}
            </div>
          </Html>
        </Canvas>
      </div>
    </div>
  );
}
