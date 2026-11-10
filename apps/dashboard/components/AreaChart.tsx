/** Sober area/line chart (SVG, server-rendered). Clean empty state when no data. */
export interface AreaChartProps {
  data: number[]
  labels?: string[]
  height?: number
}

const W = 720

export default function AreaChart({ data, labels = [], height = 220 }: AreaChartProps) {
  const H = height
  const padX = 8
  const padTop = 16
  const padBottom = 26
  const plotH = H - padTop - padBottom
  const hasData = data.length > 1 && data.some((v) => v > 0)

  // gridlines
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => padTop + plotH * f)

  if (!hasData) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="performance chart" style={{ display: 'block' }}>
        {grid.map((y, i) => (
          <line key={i} x1={padX} y1={y} x2={W - padX} y2={y} stroke="var(--border)" strokeWidth="1" />
        ))}
        <line x1={padX} y1={padTop + plotH / 2} x2={W - padX} y2={padTop + plotH / 2}
          stroke="var(--border-2)" strokeWidth="1.5" strokeDasharray="5 6" />
        <text x={W / 2} y={padTop + plotH / 2 - 12} textAnchor="middle" fontSize="12.5" fill="var(--faint)">
          No performance data yet
        </text>
      </svg>
    )
  }

  const max = Math.max(...data)
  const min = Math.min(...data, 0)
  const n = data.length
  const x = (i: number) => padX + (i / (n - 1)) * (W - padX * 2)
  const y = (v: number) => padTop + plotH - ((v - min) / (max - min || 1)) * plotH

  // smooth path
  let line = `M ${x(0)} ${y(data[0]!)}`
  for (let i = 1; i < n; i++) {
    const xm = (x(i - 1) + x(i)) / 2
    line += ` C ${xm} ${y(data[i - 1]!)} ${xm} ${y(data[i]!)} ${x(i)} ${y(data[i]!)}`
  }
  const area = `${line} L ${x(n - 1)} ${padTop + plotH} L ${x(0)} ${padTop + plotH} Z`
  const lastX = x(n - 1)
  const lastY = y(data[n - 1]!)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="performance chart" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {grid.map((gy, i) => (
        <line key={i} x1={padX} y1={gy} x2={W - padX} y2={gy} stroke="var(--border)" strokeWidth="1" />
      ))}
      <path d={area} fill="url(#areaFill)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r="3.5" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />
      {labels.length > 0 && labels.map((l, i) => (
        <text key={i} x={x(Math.round((i / (labels.length - 1)) * (n - 1)))} y={H - 8}
          textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'}
          fontSize="11" fill="var(--faint)" fontFamily="var(--mono)">{l}</text>
      ))}
    </svg>
  )
}
