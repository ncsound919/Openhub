import { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import * as THREE from 'three';
import type { SystemSnapshot } from '../useSnapshot';

const PALETTE = ['#58a6ff', '#3fb950', '#d76027', '#bc8cff', '#39c5cf'];

function Islands({ sources }: { sources: { label: string; entries: number }[] }) {
  const group = useRef<THREE.Group>(null);
  useFrame((_, delta) => {
    if (group.current) group.current.rotation.y += delta * 0.08;
  });
  const max = Math.max(1, ...sources.map((s) => s.entries));

  return (
    <group ref={group}>
      {sources.slice(0, 8).map((s, i) => {
        const angle = (i / Math.max(1, Math.min(8, sources.length))) * Math.PI * 2;
        const x = Math.cos(angle) * 3;
        const z = Math.sin(angle) * 3;
        const h = 0.4 + (s.entries / max) * 2.4;
        const color = PALETTE[i % PALETTE.length];
        return (
          <group key={s.label} position={[x, 0, z]}>
            <mesh position={[0, -0.35, 0]}>
              <cylinderGeometry args={[1.1, 0.7, 0.5, 24]} />
              <meshStandardMaterial color="#161b22" roughness={0.9} />
            </mesh>
            <mesh position={[0, h / 2 - 0.1, 0]}>
              <boxGeometry args={[0.7, h, 0.7]} />
              <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.45} />
            </mesh>
            <Html position={[0, h + 0.35, 0]} center>
              <div style={{ fontFamily: 'monospace', fontSize: 10, color: '#c9d1d9', textAlign: 'center', whiteSpace: 'nowrap' }}>
                {s.label} · {s.entries}
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

/** Ecosystem state as an archipelago: one island per intel source, height = entries. */
export function EcosystemView3D({ snapshot }: { snapshot: SystemSnapshot | null }) {
  const sources = useMemo(() => {
    const list = (snapshot?.ecosystem as any)?.sources;
    return Array.isArray(list) ? list : [];
  }, [snapshot]);
  const total = (snapshot?.ecosystem as any)?.entries ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 px-1 pb-2">
        <span className="font-mono text-[10px] text-gray-400">
          {sources.length ? `${sources.length} islands · ${total} entries` : 'ecosystem index empty'}
        </span>
      </div>
      <div className="min-h-0 flex-1 rounded-lg border border-surface-overlay bg-black/40">
        <Canvas camera={{ position: [0, 5.5, 9], fov: 50 }}>
          <ambientLight intensity={0.7} />
          <pointLight position={[6, 8, 4]} intensity={1.2} />
          <Islands sources={sources} />
          <OrbitControls enableZoom />
        </Canvas>
      </div>
    </div>
  );
}
