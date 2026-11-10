import { describe, it, expect } from 'vitest'
import { makeAttributeDeps, type AttributeDeps, type BioLinkRotationRow } from './deps.js'
import { resolveRotationAtClick, rotateBioLink, currentLiveRotation } from './bio-link.js'
import { mockDb, opsFor, quietLogger, type Router } from './testutil.js'

const NOW = new Date('2026-08-16T12:00:00Z')

function deps(client: AttributeDeps['client']): AttributeDeps {
  return makeAttributeDeps({ client, now: () => NOW, logger: quietLogger })
}

function rotation(overrides: Partial<BioLinkRotationRow> = {}): BioLinkRotationRow {
  return {
    id: 1,
    bio_link_id: 1,
    featured_post_id: 100,
    utm_content: '1111111111',
    format_cluster_id: 7,
    rotated_on_at: '2026-08-01T00:00:00Z',
    rotated_off_at: '2026-08-10T00:00:00Z',
    ...overrides,
  } as BioLinkRotationRow
}

// A two-row history: window A [08-01, 08-10], then live window B from 08-10.
const HISTORY: BioLinkRotationRow[] = [
  rotation({ id: 2, featured_post_id: 200, utm_content: '2222222222', rotated_on_at: '2026-08-10T00:00:00Z', rotated_off_at: null }),
  rotation({ id: 1, featured_post_id: 100, utm_content: '1111111111', rotated_on_at: '2026-08-01T00:00:00Z', rotated_off_at: '2026-08-10T00:00:00Z' }),
]

const historyRouter: Router = (op) => {
  if (op.table === 'bio_link_rotation' && op.kind === 'select') return { data: HISTORY }
  return { data: null }
}

describe('resolveRotationAtClick — pins an install to the live window at click time', () => {
  it('resolves a click inside the earlier window to that window', async () => {
    const { client } = mockDb(historyRouter)
    const r = await resolveRotationAtClick(deps(client), 1, '2026-08-05T00:00:00Z')
    expect(r?.id).toBe(1)
    expect(r?.featured_post_id).toBe(100)
  })

  it('resolves a click after rotation to the currently-live window', async () => {
    const { client } = mockDb(historyRouter)
    const r = await resolveRotationAtClick(deps(client), 1, '2026-08-15T00:00:00Z')
    expect(r?.id).toBe(2)
    expect(r?.featured_post_id).toBe(200)
  })

  it('resolves to null for a click before any rotation existed', async () => {
    const { client } = mockDb(historyRouter)
    const r = await resolveRotationAtClick(deps(client), 1, '2026-07-01T00:00:00Z')
    expect(r).toBeNull()
  })

  it('boundary: a click exactly at rotated_off_at still belongs to that window', async () => {
    const { client } = mockDb(historyRouter)
    // 08-10 is rotated_off_at of window 1 AND rotated_on_at of window 2; the
    // find picks the first (newest-first order) match = window 2 (live).
    const r = await resolveRotationAtClick(deps(client), 1, '2026-08-10T00:00:00Z')
    expect(r?.id).toBe(2)
  })
})

describe('rotateBioLink — append-only, closes the previous live row', () => {
  it('closes the previous live rotation and appends a new one', async () => {
    const router: Router = (op) => {
      if (op.table === 'bio_link_rotation' && op.kind === 'select') return { data: rotation({ id: 5, rotated_off_at: null }) }
      if (op.table === 'bio_link_rotation' && op.kind === 'insert') return { data: { id: 6 } }
      return { data: null }
    }
    const { client, calls } = mockDb(router)

    const res = await rotateBioLink(deps(client), {
      bioLinkId: 1,
      featuredPostId: 300,
      utmContent: '3333333333',
      formatClusterId: 9,
    })

    expect(res.closedRotationId).toBe(5)
    expect(res.newRotationId).toBe(6)

    // The close is an UPDATE stamping rotated_off_at (the only permitted mutation).
    const closeOp = opsFor(calls, 'bio_link_rotation', 'update')[0]
    expect(closeOp?.payload.rotated_off_at).toBe(NOW.toISOString())
    expect(closeOp?.filters).toContainEqual(['is', 'rotated_off_at', null])

    // The append carries the new video + a null rotated_off_at (now live).
    const insertOp = opsFor(calls, 'bio_link_rotation', 'insert')[0]
    expect(insertOp?.payload.utm_content).toBe('3333333333')
    expect(insertOp?.payload.featured_post_id).toBe(300)
    expect(insertOp?.payload.rotated_off_at).toBeNull()
  })

  it('appends without a close when there is no live rotation yet', async () => {
    const router: Router = (op) => {
      if (op.table === 'bio_link_rotation' && op.kind === 'select') return { data: null }
      if (op.table === 'bio_link_rotation' && op.kind === 'insert') return { data: { id: 1 } }
      return { data: null }
    }
    const { client, calls } = mockDb(router)
    const res = await rotateBioLink(deps(client), { bioLinkId: 1, featuredPostId: 300, utmContent: '3333333333' })
    expect(res.closedRotationId).toBeNull()
    expect(opsFor(calls, 'bio_link_rotation', 'update')).toHaveLength(0)
  })

  it('rejects a non-numeric utm_content (privacy invariant)', async () => {
    const { client } = mockDb()
    await expect(
      rotateBioLink(deps(client), { bioLinkId: 1, featuredPostId: 300, utmContent: 'not-a-video' })
    ).rejects.toThrow(/privacy invariant/)
  })
})

describe('currentLiveRotation', () => {
  it('reads the live (rotated_off_at is null) row', async () => {
    const { client, calls } = mockDb((op) =>
      op.table === 'bio_link_rotation' ? { data: rotation({ id: 5, rotated_off_at: null }) } : { data: null }
    )
    const r = await currentLiveRotation(deps(client), 1)
    expect(r?.id).toBe(5)
    expect(calls[0]?.filters).toContainEqual(['is', 'rotated_off_at', null])
  })
})
