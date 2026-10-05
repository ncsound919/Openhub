/**
 * Per-dimension radar (Workstream F2).
 *
 * A hand-rolled SVG spider chart — no chart dependency. Each spoke is one audit
 * dimension; the ring is 0..100. Dimensions with no evidence sit at the centre
 * (score 0) and are drawn dashed so a blind spot is visible, not averaged away.
 */
export interface RadarDimension {
  label: string;
  score: number | null;
}

interface Point {
  angle: number;
  x: number;
  y: number;
  lx: number;
  ly: number;
  label: string;
  score: number;
  hasScore: boolean;
}

const RINGS = [0.25, 0.5, 0.75, 1];

export function DimensionRadar({ dimensions, size = 280 }: { dimensions: RadarDimension[]; size?: number }) {
  const n = dimensions.length;
  if (n < 3) {
    return <div className="text-xs text-gray-400">Radar needs at least three dimensions.</div>;
  }

  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.34;
  const labelR = size * 0.45;

  const points: Point[] = dimensions.map((d, i) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const clamped = Math.max(0, Math.min(100, d.score ?? 0));
    const value = clamped / 100;
    return {
      angle,
      x: cx + Math.cos(angle) * r * value,
      y: cy + Math.sin(angle) * r * value,
      lx: cx + Math.cos(angle) * labelR,
      ly: cy + Math.sin(angle) * labelR,
      label: d.label,
      score: clamped,
      hasScore: typeof d.score === 'number' && Number.isFinite(d.score),
    };
  });

  const ringPolygon = (fraction: number): string =>
    dimensions
      .map((_, i) => {
        const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
        return `${cx + Math.cos(angle) * r * fraction},${cy + Math.sin(angle) * r * fraction}`;
      })
      .join(' ');

  const dataPolygon = points.map((p) => `${p.x},${p.y}`).join(' ');

  const anchorFor = (lx: number): 'start' | 'middle' | 'end' =>
    Math.abs(lx - cx) < 6 ? 'middle' : lx > cx ? 'start' : 'end';

  const title = dimensions
    .filter((d) => typeof d.score === 'number')
    .map((d) => `${d.label} ${d.score}`)
    .join(' · ');

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Dimension radar: ${title}`} className="mx-auto">
      {RINGS.map((f) => (
        <polygon key={f} points={ringPolygon(f)} fill="none" stroke="currentColor" strokeOpacity={0.16} strokeWidth={1} />
      ))}
      {points.map((p, i) => (
        <line key={`axis-${i}`} x1={cx} y1={cy} x2={cx + Math.cos(p.angle) * r} y2={cy + Math.sin(p.angle) * r} stroke="currentColor" strokeOpacity={0.14} strokeWidth={1} />
      ))}

      <polygon
        points={dataPolygon}
        fill="var(--color-info, #3b82f6)"
        fillOpacity={0.22}
        stroke="var(--color-info, #3b82f6)"
        strokeWidth={1.5}
        strokeDasharray={points.some((p) => !p.hasScore) ? '4 3' : undefined}
      />
      {points.map((p, i) => (
        <circle key={`dot-${i}`} cx={p.x} cy={p.y} r={2.4} fill="var(--color-info, #3b82f6)" />
      ))}

      {points.map((p, i) => (
        <text
          key={`label-${i}`}
          x={p.lx}
          y={p.ly}
          textAnchor={anchorFor(p.lx)}
          dominantBaseline="middle"
          fontSize={9}
          fill="currentColor"
          fillOpacity={p.hasScore ? 0.85 : 0.4}
        >
          {p.label}
          {p.hasScore ? ` ${p.score}` : ''}
        </text>
      ))}
    </svg>
  );
}
