import { describe, it, expect } from 'vitest'
import { TikTokOAuthClient, PublishingError } from './index.js'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

describe('TikTokOAuthClient.authorizeUrl', () => {
  it('requests video.upload and NEVER video.publish', () => {
    const client = new TikTokOAuthClient({
      clientKey: 'ck_test',
      redirectUri: 'https://write.goodfor.app/api/auth/tiktok/callback',
      scopes: 'user.info.basic,video.list,video.upload',
    })
    const url = new URL(client.authorizeUrl('csrf-nonce-123'))
    const scope = url.searchParams.get('scope') ?? ''
    expect(scope.split(',')).toContain('video.upload')
    expect(scope).not.toContain('video.publish')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_key')).toBe('ck_test')
    expect(url.searchParams.get('state')).toBe('csrf-nonce-123')
    expect(url.origin + url.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/')
  })

  it('refuses to construct a client that requests video.publish', () => {
    expect(
      () =>
        new TikTokOAuthClient({
          clientKey: 'ck',
          redirectUri: 'https://x/cb',
          scopes: 'video.upload,video.publish',
        })
    ).toThrow(PublishingError)
  })

  it('throws at call time when a required secret is missing', () => {
    const prev = process.env.TIKTOK_CLIENT_KEY
    delete process.env.TIKTOK_CLIENT_KEY
    try {
      const client = new TikTokOAuthClient({ redirectUri: 'https://x/cb', scopes: 'video.upload' })
      expect(() => client.authorizeUrl('s')).toThrow(/TIKTOK_CLIENT_KEY/)
    } finally {
      if (prev !== undefined) process.env.TIKTOK_CLIENT_KEY = prev
    }
  })
})

describe('TikTokOAuthClient.exchangeCode', () => {
  it('posts the authorization_code grant and maps tokens + expiries + open_id', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    const fetchImpl = (async (url: unknown, init: unknown) => {
      captured = { url: String(url), init: init as RequestInit }
      return jsonResponse({
        access_token: 'act_access',
        refresh_token: 'act_refresh',
        open_id: 'open_abc',
        scope: 'video.upload',
        expires_in: 86400,
        refresh_expires_in: 31536000,
        token_type: 'Bearer',
      })
    }) as unknown as typeof fetch

    const client = new TikTokOAuthClient({
      clientKey: 'ck',
      clientSecret: 'cs',
      redirectUri: 'https://x/cb',
      scopes: 'video.upload',
      fetchImpl,
    })

    const before = Date.now()
    const tokens = await client.exchangeCode('the-code')

    expect(tokens.accessToken).toBe('act_access')
    expect(tokens.refreshToken).toBe('act_refresh')
    expect(tokens.openId).toBe('open_abc')
    expect(tokens.accessExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 86400 * 1000)
    expect(tokens.refreshExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 31536000 * 1000)

    const body = String((captured!.init as RequestInit).body)
    expect(body).toContain('grant_type=authorization_code')
    expect(body).toContain('code=the-code')
    expect(body).toContain('client_secret=cs')
  })

  it('throws PublishingError on an OAuth error response', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: 'invalid_grant', error_description: 'bad code' }, 400)) as unknown as typeof fetch
    const client = new TikTokOAuthClient({
      clientKey: 'ck',
      clientSecret: 'cs',
      redirectUri: 'https://x/cb',
      scopes: 'video.upload',
      fetchImpl,
    })
    await expect(client.exchangeCode('bad')).rejects.toThrow(PublishingError)
  })
})

describe('TikTokOAuthClient.refresh', () => {
  it('posts the refresh_token grant', async () => {
    let body = ''
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      body = String((init as RequestInit).body)
      return jsonResponse({
        access_token: 'a2',
        refresh_token: 'r2',
        open_id: 'o',
        expires_in: 100,
        refresh_expires_in: 200,
      })
    }) as unknown as typeof fetch
    const client = new TikTokOAuthClient({
      clientKey: 'ck',
      clientSecret: 'cs',
      redirectUri: 'https://x/cb',
      scopes: 'video.upload',
      fetchImpl,
    })
    const t = await client.refresh('old_refresh')
    expect(t.accessToken).toBe('a2')
    expect(body).toContain('grant_type=refresh_token')
    expect(body).toContain('refresh_token=old_refresh')
  })
})
