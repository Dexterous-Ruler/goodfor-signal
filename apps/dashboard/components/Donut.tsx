/** Sober donut chart (SVG). Ring + centre label; legend rendered by the caller. */
export interface DonutSeg {
  label: string
  value: number
  color: string
}

export default function Donut({
  segments,
  centerValue,
  centerLabel,
  size = 150,
}: {
  segments: DonutSeg[]
  centerValue: string
  centerLabel: string
  size?: number
}) {
  const r = 54
  const sw = 18
  const c = 2 * Math.PI * r
  const total = segments.reduce((s, x) => s + x.value, 0)
  const cx = size / 2
  const cy = size / 2

  let offset = 0
  const arcs =
    total > 0
      ? segments
          .filter((s) => s.value > 0)
          .map((s, i) => {
            const len = (s.value / total) * c
            const el = (
              <circle
                key={i}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={sw}
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-offset}
                transform={`rotate(-90 ${cx} ${cy})`}
                strokeLinecap="butt"
              />
            )
            offset += len
            return el
          })
      : []

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={centerLabel}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth={sw} />
      {arcs}
      <text x={cx} y={cy - 2} textAnchor="middle" fontSize="24" fontWeight="680" fill="var(--text)"
        fontFamily="var(--font-display), sans-serif" style={{ letterSpacing: '-0.02em' }}>
        {centerValue}
      </text>
      <text x={cx} y={cy + 16} textAnchor="middle" fontSize="10.5" fill="var(--faint)"
        style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {centerLabel}
      </text>
    </svg>
  )
}
