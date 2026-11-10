import { describe, it, expect } from 'vitest'
import { makeAttributeDeps, type AttributeDeps, type BioLinkRotationRow } from './deps.js'
import { ingestInstall } from './install-ingest.js'
import { mockDb, opsFor, quietLogger, type Router } from './testutil.js'

const NOW = new Date('2026-08-16T12:00:00Z')

function deps(client: AttributeDeps['client']): AttributeDeps {
  return makeAttributeDeps({ client, now: () => NOW, logger: quietLogger })
}

const liveRotation: BioLinkRotationRow = {
  id: 2,
  bio_link_id: 1,
  featured_post_id: 200,
  utm_content: '2222222222',
  format_cluster_id: 7,
  rotated_on_at: '2026-08-10T00:00:00Z',
  rotated_off_at: null,
} as BioLinkRotationRow

/** Router: rotation lookup returns the live window; the install insert returns an id. */
const router: Router = (op) => {
  if (op.table === 'bio_link_rotation' && op.kind === 'select') return { data: [liveRotation] }
  if (op.table === 'attributed_install' && op.kind === 'insert') return { data: { id: 99 } }
  return { data: null }
}

describe('ingestInstall — Android Play Install Referrer is deterministic', () => {
  it('writes is_deterministic=true and the referrer video id for an Android play_referrer', async () => {
    const { client, calls } = mockDb(router)
    const res = await ingestInstall(deps(client), {
      platform: 'android',
      bioLinkId: 1,
      referrer: 'utm_source=tiktok&utm_content=7412345678901234567',
      clickedAt: '2026-08-15T00:00:00Z',
      installedAt: '2026-08-15T00:05:00Z',
      devicePseudoId: 'pseudo-abc',
    })

    expect(res.isDeterministic).toBe(true)
    expect(res.installId).toBe(99)

    const insert = opsFor(calls, 'attributed_install', 'insert')[0]!
    expect(insert.payload.is_deterministic).toBe(true)
    expect(insert.payload.source).toBe('play_referrer')
    // Ground truth: the referrer's own video id, not the rotation's.
    expect(insert.payload.utm_content).toBe('7412345678901234567')
    // The rotation live at click time supplies featured_post + format.
    expect(insert.payload.featured_post_id).toBe(200)
    expect(insert.payload.format_cluster_id).toBe(7)
    expect(insert.payload.platform).toBe('android')
  })
})

describe('ingestInstall — iOS is never deterministic', () => {
  it('writes is_deterministic=false for an iOS install', async () => {
    const { client, calls } = mockDb(router)
    const res = await ingestInstall(deps(client), {
      platform: 'ios',
      bioLinkId: 1,
      installedAt: '2026-08-15T00:05:00Z',
    })

    expect(res.isDeterministic).toBe(false)
    const insert = opsFor(calls, 'attributed_install', 'insert')[0]!
    expect(insert.payload.is_deterministic).toBe(false)
    expect(insert.payload.source).toBe('ios_extrapolated')
    // Best-effort: falls back to the rotation's stamped video id.
    expect(insert.payload.utm_content).toBe('2222222222')
  })

  it('marks a Kochava-sourced install non-deterministic even on Android', async () => {
    const { client, calls } = mockDb(router)
    const res = await ingestInstall(deps(client), {
      platform: 'android',
      bioLinkId: 1,
      utmContent: '2222222222',
      installedAt: '2026-08-15T00:05:00Z',
      source: 'kochava',
    })
    expect(res.isDeterministic).toBe(false)
    const insert = opsFor(calls, 'attributed_install', 'insert')[0]!
    expect(insert.payload.is_deterministic).toBe(false)
    expect(insert.payload.source).toBe('kochava')
  })
})

describe('ingestInstall — privacy', () => {
  it('rejects a referrer carrying PII', async () => {
    const { client } = mockDb(router)
    await expect(
      ingestInstall(deps(client), {
        platform: 'android',
        referrer: 'utm_source=tiktok&utm_content=alice@example.com',
        installedAt: '2026-08-15T00:05:00Z',
      })
    ).rejects.toThrow(/PII/)
  })
})
