import { describe, it, expect } from 'vitest'
import {
  PublishStateMachine,
  classifyErrorCode,
  classifyPublishStatus,
  isInboxTerminal,
  type Publisher,
  type PublisherResult,
  type CreatorInfo,
  type InitResult,
  type UploadResult,
  type PublishStatus,
  type PublishStep,
  type TransitionInfo,
} from './index.js'

function ok<T>(data: T, httpStatus = 200): PublisherResult<T> {
  return { ok: true, httpStatus, errorCode: 'ok', data, raw: { data } }
}
function err<T>(errorCode: string, httpStatus: number): PublisherResult<T> {
  return { ok: false, httpStatus, errorCode, data: null, raw: { error: { code: errorCode } } }
}

/** A scripted Publisher — each method returns whatever the test wired up. */
class FakePublisher implements Publisher {
  readonly name = 'fake'
  constructor(
    private readonly script: {
      creatorInfo?: PublisherResult<CreatorInfo>
      init?: PublisherResult<InitResult>
      upload?: PublisherResult<UploadResult>
      status?: PublisherResult<PublishStatus>
    }
  ) {}
  async getCreatorInfo(): Promise<PublisherResult<CreatorInfo>> {
    return (
      this.script.creatorInfo ??
      ok<CreatorInfo>({
        privacyLevelOptions: ['PUBLIC_TO_EVERYONE'],
        commentDisabled: false,
        duetDisabled: false,
        stitchDisabled: false,
        maxVideoPostDurationSec: 600,
      })
    )
  }
  async initInboxUpload(): Promise<PublisherResult<InitResult>> {
    return this.script.init ?? ok<InitResult>({ publishId: 'pub_1', uploadUrl: 'https://u/1' })
  }
  async uploadChunk(): Promise<PublisherResult<UploadResult>> {
    return ok<UploadResult>({ bytesUploaded: 0 })
  }
  async uploadFile(): Promise<PublisherResult<UploadResult>> {
    return this.script.upload ?? ok<UploadResult>({ bytesUploaded: 10 })
  }
  async fetchStatus(): Promise<PublisherResult<PublishStatus>> {
    return (
      this.script.status ??
      ok<PublishStatus>({ status: 'SEND_TO_USER_INBOX', publicPostId: null, failReason: null })
    )
  }
}

const job = { account: { accessToken: 't' }, video: { bytes: new Uint8Array(10) } }

describe('classifyErrorCode (pure, keyed on the STRING)', () => {
  it('maps ok, spam_risk_*, url_ownership_unverified, and fatals', () => {
    expect(classifyErrorCode('ok')).toBe('ok')
    expect(classifyErrorCode(null)).toBe('ok')
    expect(classifyErrorCode('spam_risk_too_many_posts')).toBe('spam_risk')
    expect(classifyErrorCode('url_ownership_unverified')).toBe('url_ownership_unverified')
    expect(classifyErrorCode('some_other_error')).toBe('fatal')
  })
})

describe('classifyPublishStatus', () => {
  it('treats anything non-terminal (incl. null) as pending', () => {
    expect(classifyPublishStatus('PUBLISH_COMPLETE')).toBe('published')
    expect(classifyPublishStatus('FAILED')).toBe('failed')
    expect(classifyPublishStatus('PROCESSING_UPLOAD')).toBe('pending')
    expect(classifyPublishStatus('SEND_TO_USER_INBOX')).toBe('pending')
    expect(classifyPublishStatus(null)).toBe('pending')
    expect(isInboxTerminal('SEND_TO_USER_INBOX')).toBe(true)
  })
})

describe('PublishStateMachine.run', () => {
  it('drives the full sequence and treats a 200 inbox status as PENDING, not published', async () => {
    const steps: PublishStep[] = []
    const sm = new PublishStateMachine({
      publisher: new FakePublisher({}),
      onTransition: (step: PublishStep, _info: TransitionInfo) => {
        steps.push(step)
      },
    })
    const outcome = await sm.run(job)
    expect(outcome.status).toBe('pending')
    expect(outcome.publishId).toBe('pub_1')
    expect(outcome.publicPostId).toBeNull()
    expect(steps).toEqual(['creator_info', 'init', 'upload', 'status_poll'])
  })

  it('reports published ONLY when the status is terminal AND a public id exists', async () => {
    const sm = new PublishStateMachine({
      publisher: new FakePublisher({
        status: ok<PublishStatus>({
          status: 'PUBLISH_COMPLETE',
          publicPostId: '70999',
          failReason: null,
        }),
      }),
    })
    const outcome = await sm.run(job)
    expect(outcome.status).toBe('published')
    expect(outcome.publicPostId).toBe('70999')
  })

  it('handles url_ownership_unverified IDENTICALLY whether it is 400 or 403', async () => {
    const run = async (httpStatus: number) => {
      const sm = new PublishStateMachine({
        publisher: new FakePublisher({
          init: err<InitResult>('url_ownership_unverified', httpStatus),
        }),
      })
      return sm.run(job)
    }
    const at400 = await run(400)
    const at403 = await run(403)
    expect(at400).toEqual(at403) // outcome carries no http status — string decides
    expect(at400.status).toBe('failed')
    expect(at400.errorCode).toBe('url_ownership_unverified')
    expect(at400.needsUrlVerification).toBe(true)
    expect(at400.step).toBe('init')
  })

  it('quarantines (not merely fails) on a spam_risk_* error', async () => {
    const sm = new PublishStateMachine({
      publisher: new FakePublisher({
        creatorInfo: err<CreatorInfo>('spam_risk_too_many_posts', 429),
      }),
    })
    const outcome = await sm.run(job)
    expect(outcome.status).toBe('quarantined')
    expect(outcome.errorCode).toBe('spam_risk_too_many_posts')
    expect(outcome.step).toBe('creator_info')
  })

  it('surfaces a FAILED status as a failed outcome with the fail reason', async () => {
    const sm = new PublishStateMachine({
      publisher: new FakePublisher({
        status: ok<PublishStatus>({ status: 'FAILED', publicPostId: null, failReason: 'picture_size_check_failed' }),
      }),
    })
    const outcome = await sm.run(job)
    expect(outcome.status).toBe('failed')
    expect(outcome.errorCode).toBe('picture_size_check_failed')
  })
})

describe('PublishStateMachine.reconcile', () => {
  it('keeps an inbox draft PENDING (no zombie) until a human publishes', async () => {
    const sm = new PublishStateMachine({ publisher: new FakePublisher({}) })
    const r = await sm.reconcile({ accessToken: 't' }, 'pub_1')
    expect(r.status).toBe('pending')
    expect(r.publicPostId).toBeNull()
  })

  it('resolves the public id once moderation clears', async () => {
    const sm = new PublishStateMachine({
      publisher: new FakePublisher({
        status: ok<PublishStatus>({ status: 'PUBLISH_COMPLETE', publicPostId: '70123', failReason: null }),
      }),
    })
    const r = await sm.reconcile({ accessToken: 't' }, 'pub_1')
    expect(r.status).toBe('published')
    expect(r.publicPostId).toBe('70123')
  })
})
