/** 270° arc gauge (SVG). Shows a 0–100 value with a centre readout. */
export default function ArcGauge({
  value,
  label,
  display,
  color = 'var(--accent)',
  size = 176,
}: {
  value: number
  label: string
  display?: string
  color?: string
  size?: number
}) {
  const r = 66
  const sw = 12
  const cx = size / 2
  const cy = size / 2 + 6
  const C = 2 * Math.PI * r
  const span = 0.72 // 260°
  const track = C * span
  const pct = Math.max(0, Math.min(100, value)) / 100
  const rot = 90 + (1 - span) * 180 // start bottom-left, sweep clockwise

  return (
    <svg viewBox={`0 0 ${size} ${size - 12}`} width="100%" role="img" aria-label={label} style={{ display: 'block' }}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth={sw}
        strokeDasharray={`${track} ${C}`} strokeLinecap="round" transform={`rotate(${rot} ${cx} ${cy})`} />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={sw}
        strokeDasharray={`${track * pct} ${C}`} strokeLinecap="round" transform={`rotate(${rot} ${cx} ${cy})`} />
      <text x={cx} y={cy - 2} textAnchor="middle" fontSize="30" fontWeight="700" fill="var(--text)"
        fontFamily="var(--font-display), sans-serif" style={{ letterSpacing: '-0.03em' }}>
        {display ?? `${Math.round(value)}%`}
      </text>
      <text x={cx} y={cy + 20} textAnchor="middle" fontSize="11" fill="var(--faint)"
        style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</text>
    </svg>
  )
}
