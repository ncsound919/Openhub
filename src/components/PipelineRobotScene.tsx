import { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows, Html, OrbitControls, Stars } from '@react-three/drei';
import * as THREE from 'three';
import { stageLight, type PipelineJobView, type PipelineStageView } from '../ide/usePipeline';
import { nowStageForJob, partKeyForStage, type RobotPartKey } from './PipelineRobot';

type LightState = 'idle' | 'working' | 'ok' | 'warn' | 'error' | 'offline';

/**
 * Sector palette — the user's contract:
 * working = bright pulsing green (highlighted), todo = yellow,
 * done = solid green, failed = red, skipped/off = gray.
 * Working vs done are both green on purpose; working *moves and pulses*,
 * done sits steady. The legend in the wrapper states this explicitly.
 */
export const PART_PALETTE: Record<LightState, { color: string; emissive: string; intensity: number }> = {
  working: { color: '#0e2a16', emissive: '#39ff6a', intensity: 1.6 },
  ok: { color: '#0d2818', emissive: '#2ea043', intensity: 0.55 },
  error: { color: '#2a1215', emissive: '#f85149', intensity: 1.2 },
  warn: { color: '#2a2111', emissive: '#d29922', intensity: 0.5 },
  idle: { color: '#21262d', emissive: '#d29922', intensity: 0.18 },
  offline: { color: '#21262d', emissive: '#6e7681', intensity: 0.12 },
};

export interface PartStates {
  lights: Record<RobotPartKey, LightState>;
  active: RobotPartKey | null;
}

/** Pure: which robot sector each stage drives, and which sector is hot. */
export function buildPartStates(stages: PipelineStageView[]): PartStates {
  const lights: Record<RobotPartKey, LightState> = {
    head: 'idle',
    visor: 'idle',
    torso: 'idle',
    'arm-left': 'idle',
    'arm-right': 'idle',
    legs: 'idle',
  };
  for (const s of stages) {
    const key = partKeyForStage(s.id);
    if (key) lights[key] = stageLight(s);
  }
  const now = nowStageForJob(stages);
  const active = now && now.status === 'running' ? partKeyForStage(now.id) : null;
  return { lights, active };
}

function SectorTag({ position, text, tone }: { position: [number, number, number]; text: string; tone: string }) {
  return (
    <Html position={position} center distanceFactor={9} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
      <div
        style={{
          fontFamily: 'ui-monospace, monospace',
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: '0.08em',
          color: tone,
          background: 'rgba(0,0,0,0.55)',
          border: `1px solid ${tone}55`,
          borderRadius: 4,
          padding: '1px 5px',
          whiteSpace: 'nowrap',
        }}
      >
        {text}
      </div>
    </Html>
  );
}

function PartMesh({ light }: { light: LightState }) {
  const p = PART_PALETTE[light];
  return (
    <meshStandardMaterial
      color={p.color}
      emissive={p.emissive}
      emissiveIntensity={p.intensity}
      metalness={0.55}
      roughness={0.42}
    />
  );
}

/** Dark joint / trim material shared by hinges, vents and panel lines. */
function TrimMesh() {
  return <meshStandardMaterial color="#12161c" metalness={0.7} roughness={0.5} />;
}

/**
 * The build-bot. Six pipeline sectors as robot hardware:
 * head = logic (typecheck) · visor = gate (verify) · torso = backend core (audit)
 * backpack = backend unit (audit) · arm-left = probe (adversary) ·
 * arm-right = tool (repair) · legs = drive (loop).
 * Idle bob + slow turntable always; the hot sector animates (waves/nods/marches).
 */
function BuildBot({ job }: { job: PipelineJobView }) {
  const { lights, active } = useMemo(() => buildPartStates(job.stages), [job.stages]);
  const pct = Math.round((job.progress ?? 0) * 100);
  const running = job.stages.find((s) => s.status === 'running') ?? null;
  const runningPct = running ? Math.round((running.progress ?? 0) * 100) : null;

  const root = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const core = useRef<THREE.Mesh>(null);
  const visorBar = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const flameL = useRef<THREE.Mesh>(null);
  const flameR = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (root.current) {
      root.current.rotation.y = t * 0.22;
      root.current.position.y = Math.sin(t * 1.3) * 0.05;
    }
    if (head.current) head.current.rotation.x = active === 'head' ? Math.sin(t * 3.2) * 0.22 : Math.sin(t * 0.8) * 0.04;
    if (armL.current) armL.current.rotation.z = active === 'arm-left' ? 0.5 + Math.sin(t * 3.4) * 0.45 : 0.08;
    if (armR.current) armR.current.rotation.z = active === 'arm-right' ? -0.5 - Math.sin(t * 3.4) * 0.45 : -0.08;
    if (legL.current) legL.current.rotation.x = active === 'legs' ? Math.sin(t * 5.2) * 0.5 : 0;
    if (legR.current) legR.current.rotation.x = active === 'legs' ? -Math.sin(t * 5.2) * 0.5 : 0;
    if (core.current) {
      const s = active === 'torso' ? 1 + Math.sin(t * 4.2) * 0.18 : 1;
      core.current.scale.setScalar(s);
    }
    if (visorBar.current) {
      visorBar.current.position.x = active === 'visor' ? Math.sin(t * 3.6) * 0.16 : 0;
    }
    if (ring.current) {
      ring.current.rotation.z = t * 1.4;
      const s = 1 + Math.sin(t * 3) * 0.06;
      ring.current.scale.setScalar(s);
    }
    const firing = active === 'torso';
    for (const f of [flameL.current, flameR.current]) {
      if (!f) continue;
      f.scale.y = firing ? 1 + Math.abs(Math.sin(t * 18)) * 0.9 : 0.12;
      f.scale.x = firing ? 1 + Math.sin(t * 22) * 0.12 : 0.8;
      f.scale.z = firing ? 1 + Math.cos(t * 20) * 0.12 : 0.8;
    }
  });

  const tag = (key: RobotPartKey, text: string, pos: [number, number, number]) => {
    const tone = PART_PALETTE[lights[key]].emissive;
    return <SectorTag key={key} position={pos} text={text} tone={tone} />;
  };
  const activeTag = (key: RobotPartKey, text: string, pos: [number, number, number]) => {
    if (active !== key || runningPct === null) return tag(key, text, pos);
    return tag(key, `${text} · ${runningPct}%`, pos);
  };

  return (
    <group ref={root} position={[0, 0.1, 0]}>
      {/* ground */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <circleGeometry args={[2.6, 48]} />
        <meshStandardMaterial color="#0d1117" metalness={0.2} roughness={0.9} />
      </mesh>
      <gridHelper args={[9, 18, '#2ea043', '#161b22']} position={[0, 0, 0]} />
      {/* overall-progress arc on the floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <torusGeometry args={[2.85, 0.035, 10, 96, Math.max(0.001, (pct / 100) * Math.PI * 2)]} />
        <meshStandardMaterial color="#0d1117" emissive={job.status === 'running' ? '#39ff6a' : '#2ea043'} emissiveIntensity={1.3} />
      </mesh>

      {/* legs — drive (loop) */}
      {([
        { ref: legL, x: -0.35 },
        { ref: legR, x: 0.35 },
      ] as const).map(({ ref, x }) => (
        <group key={x} ref={ref} position={[x, 1.4, 0]}>
          <mesh position={[0, -0.35, 0]}>
            <boxGeometry args={[0.3, 0.7, 0.34]} />
            <PartMesh light={lights.legs} />
          </mesh>
          {/* knee joint */}
          <mesh position={[0, -0.72, 0.02]}>
            <sphereGeometry args={[0.11, 14, 14]} />
            <TrimMesh />
          </mesh>
          <mesh position={[0, -1.05, 0]}>
            <boxGeometry args={[0.26, 0.7, 0.3]} />
            <PartMesh light={lights.legs} />
          </mesh>
          {/* shin guard stripe */}
          <mesh position={[0, -1.05, 0.16]}>
            <boxGeometry args={[0.18, 0.4, 0.02]} />
            <TrimMesh />
          </mesh>
          <mesh position={[0, -1.44, 0.06]}>
            <boxGeometry args={[0.34, 0.12, 0.5]} />
            <PartMesh light={lights.legs} />
          </mesh>
        </group>
      ))}
      {activeTag('legs', 'DRIVE · loop', [-1.7, 0.7, 0])}

      {/* torso — backend core (audit) */}
      <mesh position={[0, 2.0, 0]}>
        <boxGeometry args={[1.5, 1.1, 0.9]} />
        <PartMesh light={lights.torso} />
      </mesh>
      {/* chest plate seams */}
      {[-0.5, 0.5].map((x) => (
        <mesh key={x} position={[x, 2.0, 0.46]}>
          <boxGeometry args={[0.04, 0.9, 0.02]} />
          <TrimMesh />
        </mesh>
      ))}
      {/* chest core — overall progress heartbeat */}
      <mesh ref={core} position={[0, 2.0, 0.46]}>
        <sphereGeometry args={[0.26, 24, 24]} />
        <meshStandardMaterial color="#06130b" emissive={lights.torso === 'working' ? '#39ff6a' : '#2ea043'} emissiveIntensity={lights.torso === 'working' ? 2 : 0.9} />
      </mesh>
      {/* core bezel */}
      <mesh position={[0, 2.0, 0.44]} rotation={[0, 0, 0]}>
        <torusGeometry args={[0.32, 0.03, 10, 32]} />
        <TrimMesh />
      </mesh>
      {/* vents */}
      {[-0.35, 0.35].map((x) => (
        <mesh key={x} position={[x, 1.72, 0.46]}>
          <boxGeometry args={[0.3, 0.06, 0.02]} />
          <TrimMesh />
        </mesh>
      ))}
      {activeTag('torso', 'BACKEND · audit', [1.9, 2.2, 0])}

      {/* backpack — backend unit (audit, rear) */}
      <mesh position={[0, 2.1, -0.68]}>
        <boxGeometry args={[1.0, 0.85, 0.42]} />
        <PartMesh light={lights.torso} />
      </mesh>
      {/* cooling fins */}
      {[-0.3, -0.1, 0.1, 0.3].map((x) => (
        <mesh key={x} position={[x, 2.1, -0.9]}>
          <boxGeometry args={[0.06, 0.6, 0.04]} />
          <TrimMesh />
        </mesh>
      ))}
      {[-0.28, 0.28].map((x) => (
        <mesh key={x} position={[x, 1.62, -0.68]}>
          <cylinderGeometry args={[0.09, 0.13, 0.3, 16]} />
          <PartMesh light={lights.torso} />
        </mesh>
      ))}
      {/* thruster flames — fire while the backend sector is hot */}
      <mesh ref={flameL} position={[-0.28, 1.42, -0.68]}>
        <coneGeometry args={[0.08, 0.35, 12]} />
        <meshStandardMaterial color="#1a0e02" emissive="#ff9f43" emissiveIntensity={2.2} />
      </mesh>
      <mesh ref={flameR} position={[0.28, 1.42, -0.68]}>
        <coneGeometry args={[0.08, 0.35, 12]} />
        <meshStandardMaterial color="#1a0e02" emissive="#ff9f43" emissiveIntensity={2.2} />
      </mesh>
      {tag('torso', 'BACKEND UNIT', [0, 2.75, -0.9])}

      {/* left arm — probe (adversary) */}
      <group ref={armL} position={[-0.95, 2.42, 0]}>
        {/* shoulder pad */}
        <mesh position={[0, 0.05, 0]}>
          <sphereGeometry args={[0.26, 18, 18]} />
          <PartMesh light={lights['arm-left']} />
        </mesh>
        <mesh position={[0, -0.1, 0]}>
          <sphereGeometry args={[0.2, 20, 20]} />
          <PartMesh light={lights['arm-left']} />
        </mesh>
        <mesh position={[0, -0.55, 0]}>
          <boxGeometry args={[0.24, 0.6, 0.26]} />
          <PartMesh light={lights['arm-left']} />
        </mesh>
        {/* elbow joint */}
        <mesh position={[0, -0.88, 0]}>
          <sphereGeometry args={[0.11, 14, 14]} />
          <TrimMesh />
        </mesh>
        <mesh position={[0, -1.05, 0]}>
          <boxGeometry args={[0.2, 0.34, 0.22]} />
          <PartMesh light={lights['arm-left']} />
        </mesh>
        {/* claw prongs + probe tip */}
        <mesh position={[-0.08, -1.32, 0]}>
          <boxGeometry args={[0.07, 0.28, 0.07]} />
          <PartMesh light={lights['arm-left']} />
        </mesh>
        <mesh position={[0.08, -1.32, 0]}>
          <boxGeometry args={[0.07, 0.28, 0.07]} />
          <PartMesh light={lights['arm-left']} />
        </mesh>
        <mesh position={[0, -1.18, 0.12]}>
          <boxGeometry args={[0.05, 0.05, 0.22]} />
          <meshStandardMaterial color="#06130b" emissive={PART_PALETTE[lights['arm-left']].emissive} emissiveIntensity={1.6} />
        </mesh>
      </group>
      {activeTag('arm-left', 'PROBE · adversary', [-2.1, 1.9, 0])}

      {/* right arm — tool (repair) */}
      <group ref={armR} position={[0.95, 2.42, 0]}>
        <mesh position={[0, 0.05, 0]}>
          <sphereGeometry args={[0.26, 18, 18]} />
          <PartMesh light={lights['arm-right']} />
        </mesh>
        <mesh position={[0, -0.1, 0]}>
          <sphereGeometry args={[0.2, 20, 20]} />
          <PartMesh light={lights['arm-right']} />
        </mesh>
        <mesh position={[0, -0.55, 0]}>
          <boxGeometry args={[0.24, 0.6, 0.26]} />
          <PartMesh light={lights['arm-right']} />
        </mesh>
        <mesh position={[0, -0.88, 0]}>
          <sphereGeometry args={[0.11, 14, 14]} />
          <TrimMesh />
        </mesh>
        <mesh position={[0, -1.05, 0]}>
          <boxGeometry args={[0.2, 0.34, 0.22]} />
          <PartMesh light={lights['arm-right']} />
        </mesh>
        {/* tool head + bit */}
        <mesh position={[0, -1.3, 0]}>
          <boxGeometry args={[0.12, 0.3, 0.12]} />
          <PartMesh light={lights['arm-right']} />
        </mesh>
        <mesh position={[0, -1.5, 0]}>
          <boxGeometry args={[0.2, 0.08, 0.2]} />
          <meshStandardMaterial color="#06130b" emissive={PART_PALETTE[lights['arm-right']].emissive} emissiveIntensity={1.6} />
        </mesh>
      </group>
      {activeTag('arm-right', 'TOOL · repair', [2.1, 1.9, 0])}

      {/* head — logic (typecheck) */}
      <group ref={head} position={[0, 3.0, 0]}>
        <mesh>
          <boxGeometry args={[0.72, 0.56, 0.62]} />
          <PartMesh light={lights.head} />
        </mesh>
        {/* brow plate */}
        <mesh position={[0, 0.2, 0.32]}>
          <boxGeometry args={[0.6, 0.08, 0.03]} />
          <TrimMesh />
        </mesh>
        {/* glowing eyes */}
        {[-0.16, 0.16].map((x) => (
          <mesh key={x} position={[x, 0.02, 0.32]}>
            <sphereGeometry args={[0.055, 12, 12]} />
            <meshStandardMaterial color="#06130b" emissive={PART_PALETTE[lights.head].emissive} emissiveIntensity={2} />
          </mesh>
        ))}
        <mesh position={[-0.42, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.09, 0.09, 0.06, 16]} />
          <PartMesh light={lights.head} />
        </mesh>
        <mesh position={[0.42, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.09, 0.09, 0.06, 16]} />
          <PartMesh light={lights.head} />
        </mesh>
        <mesh position={[0, 0.42, 0]}>
          <cylinderGeometry args={[0.03, 0.03, 0.3, 8]} />
          <PartMesh light={lights.head} />
        </mesh>
        <mesh position={[0, 0.6, 0]}>
          <sphereGeometry args={[0.06, 12, 12]} />
          <meshStandardMaterial color="#06130b" emissive={PART_PALETTE[lights.head].emissive} emissiveIntensity={1.4} />
        </mesh>
        {/* visor — gate (verify) */}
        <mesh position={[0, -0.14, 0.32]}>
          <boxGeometry args={[0.52, 0.15, 0.05]} />
          <PartMesh light={lights.visor} />
        </mesh>
        <mesh ref={visorBar} position={[0, -0.14, 0.36]}>
          <boxGeometry args={[0.1, 0.09, 0.02]} />
          <meshStandardMaterial color="#06130b" emissive={PART_PALETTE[lights.visor].emissive} emissiveIntensity={2} />
        </mesh>
      </group>
      {activeTag('head', 'LOGIC · typecheck', [-1.9, 3.3, 0])}
      {activeTag('visor', 'GATE · verify', [1.9, 3.3, 0])}

      {/* assembly ring — spins while the run is live */}
      <mesh ref={ring} rotation={[Math.PI / 2.4, 0, 0]} position={[0, 1.6, 0]}>
        <torusGeometry args={[2.35, 0.025, 10, 72]} />
        <meshStandardMaterial
          color="#0d1117"
          emissive={job.status === 'running' ? '#39ff6a' : '#2ea043'}
          emissiveIntensity={job.status === 'running' ? 1.1 : 0.35}
        />
      </mesh>
    </group>
  );
}

export function PipelineRobotCanvas({ job }: { job: PipelineJobView }) {
  const reduceMotion = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return (
    <Canvas
      dpr={[1, 1.75]}
      camera={{ position: [5.4, 3.4, 7.4], fov: 42 }}
      gl={{ antialias: true, alpha: true }}
      style={{ background: 'transparent' }}
    >
      <ambientLight intensity={0.55} />
      <hemisphereLight args={['#8ab4ff', '#0b0e13', 0.4]} />
      <directionalLight position={[5, 8, 5]} intensity={1.25} />
      <directionalLight position={[-6, 4, -6]} intensity={0.7} color="#58a6ff" />
      <pointLight position={[-5, 3, -4]} intensity={0.5} color="#58a6ff" />
      <Stars radius={42} depth={18} count={1400} factor={3.2} saturation={0} fade speed={0.6} />
      <BuildBot job={job} />
      <ContactShadows position={[0, 0, 0]} opacity={0.55} scale={9} blur={2.4} far={4} color="#000000" />
      <OrbitControls enablePan={false} enableZoom autoRotate={!reduceMotion} autoRotateSpeed={0.7} minDistance={4} maxDistance={14} />
    </Canvas>
  );
}
