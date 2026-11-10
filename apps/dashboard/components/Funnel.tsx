/** Dub-style sankey funnel — rounded ends, soft blur glow, cumulative-% pills. Pure SVG. */
export interface FunnelStep {
  label: string
  value: number
  color: string
}

const W = 1000
const H = 260
const PAD = 32
const MIN_H = 7

export default function Funnel({ steps }: { steps: FunnelStep[] }) {
  const cy = H / 2
  const area = H - PAD * 2
  const base = Math.max(steps[0]?.value ?? 0, 1)
  const h = (v: number) => Math.min(area, Math.max(MIN_H, (v / base) * area))
  const nodes = steps.map((s, i) => ({
    x: 250 + i * ((810 - 250) / Math.max(steps.length - 1, 1)),
    h: h(s.value),
  }))
  const first = nodes[0]!
  const last = nodes[nodes.length - 1]!
  const Lc = 96
  const Rc = 904
  const R = Math.min(30, first.h / 2)
  const Rr = Math.min(10, last.h / 2)
  const t = (y: number) => cy - y / 2
  const b = (y: number) => cy + y / 2

  // outline: rounded-left cap → smooth top through nodes → rounded-right cap → smooth bottom back
  let d = `M ${Lc} ${t(first.h) + R} Q ${Lc} ${t(first.h)} ${Lc + R} ${t(first.h)} L ${first.x} ${t(first.h)}`
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i]!, c = nodes[i + 1]!, xm = (a.x + c.x) / 2
    d += ` C ${xm} ${t(a.h)} ${xm} ${t(c.h)} ${c.x} ${t(c.h)}`
  }
  d += ` L ${Rc - Rr} ${t(last.h)} Q ${Rc} ${t(last.h)} ${Rc} ${t(last.h) + Rr}`
  d += ` L ${Rc} ${b(last.h) - Rr} Q ${Rc} ${b(last.h)} ${Rc - Rr} ${b(last.h)} L ${last.x} ${b(last.h)}`
  for (let i = nodes.length - 1; i > 0; i--) {
    const c = nodes[i]!, a = nodes[i - 1]!, xm = (a.x + c.x) / 2
    d += ` C ${xm} ${b(c.h)} ${xm} ${b(a.h)} ${a.x} ${b(a.h)}`
  }
  d += ` L ${Lc + R} ${b(first.h)} Q ${Lc} ${b(first.h)} ${Lc} ${b(first.h) - R} Z`

  const cum = (v: number) => {
    const f = steps[0]?.value ?? 0
    if (f <= 0) return '0%'
    const p = (v / f) * 100
    return `${p >= 99.95 ? 100 : Number(p.toFixed(2))}%`
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="conversion funnel" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="funnelGrad" gradientUnits="userSpaceOnUse" x1={Lc} y1="0" x2={Rc} y2="0">
          <stop offset="0%" stopColor={steps[0]?.color ?? '#2f6bf6'} />
          <stop offset="34%" stopColor={steps[0]?.color ?? '#2f6bf6'} />
          <stop offset="52%" stopColor={steps[1]?.color ?? '#8b3ff5'} />
          <stop offset="80%" stopColor={steps[steps.length - 1]?.color ?? '#4ad6b4'} />
          <stop offset="100%" stopColor={steps[steps.length - 1]?.color ?? '#4ad6b4'} />
        </linearGradient>
        <filter id="funnelGlow" x="-20%" y="-60%" width="140%" height="220%">
          <feGaussianBlur stdDeviation="11" />
        </filter>
        <filter id="pillShadow" x="-40%" y="-60%" width="180%" height="220%">
          <feDropShadow dx="0" dy="1" stdDeviation="2" floodColor="#000" floodOpacity="0.12" />
        </filter>
      </defs>

      <path d={d} fill="url(#funnelGrad)" filter="url(#funnelGlow)" opacity="0.38" />
      <path d={d} fill="url(#funnelGrad)" />

      {nodes.map((nd, i) => {
        const label = cum(steps[i]!.value)
        const w = 26 + label.length * 9.5
        return (
          <g key={i} filter="url(#pillShadow)">
            <rect x={nd.x - w / 2} y={cy - 16} width={w} height={32} rx={16} fill="var(--surface)" stroke="var(--border-2)" />
            <text x={nd.x} y={cy + 5} textAnchor="middle" fontSize="15" fontWeight="600" fill="var(--text)" fontFamily="var(--mono)">
              {label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
