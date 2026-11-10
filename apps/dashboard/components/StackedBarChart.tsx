/** fuselab-style stacked bars (likes/comments/shares) + a views line overlay. Pure SVG. */
export interface Bucket {
  label: string
  likes: number
  comments: number
  shares: number
  views: number
}

const W = 780
const H = 300
const PADL = 44
const PADR = 12
const PADT = 16
const PADB = 30

const fmt = (v: number) =>
  v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(Math.round(v))

const SERIES = [
  { key: 'shares' as const, color: 'var(--c-teal)' },
  { key: 'comments' as const, color: 'var(--c-purple)' },
  { key: 'likes' as const, color: 'var(--c-gold)' },
]

export default function StackedBarChart({ data }: { data: Bucket[] }) {
  const plotW = W - PADL - PADR
  const plotH = H - PADT - PADB
  const has = data.length > 0 && data.some((d) => d.likes + d.comments + d.shares + d.views > 0)

  const grid = [0, 0.25, 0.5, 0.75, 1]
  if (!has) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="engagement over time" style={{ display: 'block' }}>
        {grid.map((f, i) => {
          const y = PADT + plotH * f
          return <line key={i} x1={PADL} y1={y} x2={W - PADR} y2={y} stroke="var(--border)" strokeWidth="1" />
        })}
        <text x={W / 2} y={PADT + plotH / 2} textAnchor="middle" fontSize="12.5" fill="var(--faint)">No performance data yet</text>
      </svg>
    )
  }

  const n = data.length
  const maxStack = Math.max(...data.map((d) => d.likes + d.comments + d.shares), 1)
  const maxLine = Math.max(...data.map((d) => d.views), 1)
  const bw = (plotW / n) * 0.58
  const cx = (i: number) => PADL + (i + 0.5) * (plotW / n)
  const yStack = (v: number) => PADT + plotH - (v / maxStack) * plotH
  const yLine = (v: number) => PADT + plotH - (v / maxLine) * plotH

  // views line (smooth)
  let line = `M ${cx(0)} ${yLine(data[0]!.views)}`
  for (let i = 1; i < n; i++) {
    const xm = (cx(i - 1) + cx(i)) / 2
    line += ` C ${xm} ${yLine(data[i - 1]!.views)} ${xm} ${yLine(data[i]!.views)} ${cx(i)} ${yLine(data[i]!.views)}`
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="engagement over time" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="viewsFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--c-line)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--c-line)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* y grid + labels */}
      {grid.map((f, i) => {
        const y = PADT + plotH * f
        return (
          <g key={i}>
            <line x1={PADL} y1={y} x2={W - PADR} y2={y} stroke="var(--border)" strokeWidth="1" />
            <text x={PADL - 8} y={y + 3} textAnchor="end" fontSize="10" fill="var(--faint)" fontFamily="var(--mono)">
              {fmt(maxStack * (1 - f))}
            </text>
          </g>
        )
      })}

      {/* stacked bars */}
      {data.map((d, i) => {
        let base = PADT + plotH
        return (
          <g key={i}>
            {SERIES.map((s) => {
              const v = d[s.key]
              const h = (v / maxStack) * plotH
              const y = base - h
              base = y
              return <rect key={s.key} x={cx(i) - bw / 2} y={y} width={bw} height={Math.max(h, 0)} fill={s.color} rx="1.5" />
            })}
          </g>
        )
      })}

      {/* views line + soft fill */}
      <path d={`${line} L ${cx(n - 1)} ${PADT + plotH} L ${cx(0)} ${PADT + plotH} Z`} fill="url(#viewsFill)" />
      <path d={line} fill="none" stroke="var(--c-line)" strokeWidth="2" strokeLinecap="round" />
      <circle cx={cx(n - 1)} cy={yLine(data[n - 1]!.views)} r="3.5" fill="var(--c-line)" stroke="var(--surface)" strokeWidth="2" />

      {/* x labels (every other) */}
      {data.map((d, i) =>
        i % 2 === 0 ? (
          <text key={i} x={cx(i)} y={H - 10} textAnchor="middle" fontSize="10" fill="var(--faint)" fontFamily="var(--mono)">{d.label}</text>
        ) : null
      )}
    </svg>
  )
}
