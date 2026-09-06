import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RATE_LIMIT_WAIT_MS,
  DEFAULT_SERVER_ERROR_WAIT_MS,
  JiraApiError,
  basicAuth,
  browseUrl,
  createJiraClient,
  describeFailure,
  retryAfterMs,
  retryDelayMs,
  siteOrigin
} from './client'

interface Reply {
  status?: number
  body?: unknown
  text?: string
  headers?: Record<string, string>
  /** Throw instead of answering, as a dead socket does. */
  fail?: boolean
}

interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

// A fetch that serves the replies given, in order, and records each request.
function fetchReplying(...replies: Reply[]) {
  const sent: Sent[] = []
  let index = 0
  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    sent.push({
      url: input,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === 'string' && { body: init.body })
    })
    const reply = replies[Math.min(index, replies.length - 1)] ?? {}
    index += 1
    if (reply.fail) throw new TypeError('fetch failed')
    const text = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body))
    return new Response(text === '' ? null : text, { status: reply.status ?? 200, statusText: 'Status', headers: reply.headers })
  })
  return { fetchImpl, sent }
}

const NOW = Date.parse('2026-09-06T12:00:00.000Z')

function clientOver(fetchImpl: ReturnType<typeof fetchReplying>['fetchImpl'], random = () => 0.5) {
  const waits: number[] = []
  const client = createJiraClient({
    siteUrl: 'https://example.atlassian.net/',
    email: 'me@example.com',
    apiToken: 'token-value',
    fetchImpl,
    sleep: async (ms) => {
      waits.push(ms)
    },
    now: () => NOW,
    random
  })
  return { client, waits }
}

describe('siteOrigin', () => {
  it('keeps the origin and drops a trailing slash or a path', () => {
    expect(siteOrigin('https://example.atlassian.net/')).toBe('https://example.atlassian.net')
    expect(siteOrigin('https://example.atlassian.net/jira/software/projects')).toBe('https://example.atlassian.net')
    expect(siteOrigin(' example.atlassian.net ')).toBe('https://example.atlassian.net')
    expect(siteOrigin('http://localhost:8080/x')).toBe('http://localhost:8080')
  })

  it('refuses a blank, a non-URL and a non-http scheme', () => {
    expect(() => siteOrigin('')).toThrow(/JIRA_SITE_URL is required/)
    expect(() => siteOrigin(undefined)).toThrow(/JIRA_SITE_URL is required/)
    expect(() => siteOrigin('https://exa mple')).toThrow(/not a URL/)
    expect(() => siteOrigin('ftp://example.atlassian.net')).toThrow(/http\(s\) URL/)
  })
})

describe('basicAuth and browseUrl', () => {
  it('encodes email:token as the basic-auth page describes', () => {
    expect(basicAuth('me@example.com', 'secret')).toBe(
      `Basic ${Buffer.from('me@example.com:secret').toString('base64')}`
    )
  })

  it('builds the browse URL with the key encoded', () => {
    expect(browseUrl('https://example.atlassian.net', 'EX-1')).toBe('https://example.atlassian.net/browse/EX-1')
    expect(browseUrl('https://example.atlassian.net', 'a b')).toBe('https://example.atlassian.net/browse/a%20b')
  })
})

describe('describeFailure', () => {
  it('joins errorMessages and errors as field: message', () => {
    expect(
      describeFailure(400, 'Bad Request', {
        errorMessages: ["Field 'priority' is required"],
        errors: { summary: 'You must specify a summary of the issue.' }
      })
    ).toBe("400: Field 'priority' is required; summary: You must specify a summary of the issue.")
  })

  it('falls back to the status text, or the raw text, when the body is not an error collection', () => {
    expect(describeFailure(401, 'Unauthorized', undefined)).toBe('401: Unauthorized')
    expect(describeFailure(502, '', undefined)).toBe('502: request failed')
    expect(describeFailure(404, 'Not Found', { errorMessages: [], errors: {} })).toBe('404: Not Found')
    expect(describeFailure(503, 'x', 'upstream down')).toBe('503: upstream down')
    expect(describeFailure(503, 'x', `${'a'.repeat(400)}`)).toMatch(/^503: a{300}…$/)
    expect(describeFailure(400, 'x', [1, 2])).toBe('400: x')
  })

  it('names the rate limit that fired', () => {
    expect(describeFailure(429, 'Too Many Requests', {}, 'jira-burst-based')).toBe(
      '429: Too Many Requests (jira-burst-based)'
    )
  })

  it('keeps the parts on the error object', () => {
    const error = new JiraApiError(400, 'Bad Request', { errorMessages: ['a', 2], errors: { f: 1 } }, null)
    expect(error.name).toBe('JiraApiError')
    expect(error.status).toBe(400)
    expect(error.errorMessages).toEqual(['a'])
    expect(error.errors).toEqual({ f: '1' })
    expect(error.rateLimitReason).toBeUndefined()
    const bare = new JiraApiError(500, 'Server Error', 'html', 'jira-quota-tenant-based')
    expect(bare.errorMessages).toEqual([])
    expect(bare.errors).toEqual({})
    expect(bare.rateLimitReason).toBe('jira-quota-tenant-based')
  })
})

describe('retry waits', () => {
  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterMs(null, NOW)).toBeUndefined()
    expect(retryAfterMs('  ', NOW)).toBeUndefined()
    expect(retryAfterMs('3', NOW)).toBe(3000)
    expect(retryAfterMs(new Date(NOW + 5000).toUTCString(), NOW)).toBe(5000)
    expect(retryAfterMs(new Date(NOW - 5000).toUTCString(), NOW)).toBe(0)
    expect(retryAfterMs('soon', NOW)).toBeUndefined()
  })

  it('prefers Retry-After, then X-RateLimit-Reset on a 429, then the defaults', () => {
    const response = (status: number, headers: Record<string, string>) => new Response('', { status, headers })
    expect(retryDelayMs(response(429, { 'retry-after': '4' }), NOW)).toBe(4000)
    expect(retryDelayMs(response(429, { 'x-ratelimit-reset': new Date(NOW + 7000).toISOString() }), NOW)).toBe(7000)
    expect(retryDelayMs(response(429, {}), NOW)).toBe(DEFAULT_RATE_LIMIT_WAIT_MS)
    expect(retryDelayMs(response(503, {}), NOW)).toBe(DEFAULT_SERVER_ERROR_WAIT_MS)
    expect(retryDelayMs(response(503, { 'retry-after': '1' }), NOW)).toBe(1000)
  })
})

describe('createJiraClient', () => {
  it('refuses a blank email or token', () => {
    const { fetchImpl } = fetchReplying()
    expect(() => createJiraClient({ siteUrl: 'https://x.atlassian.net', email: ' ', apiToken: 't', fetchImpl })).toThrow(
      /JIRA_EMAIL is required/
    )
    expect(() => createJiraClient({ siteUrl: 'https://x.atlassian.net', email: 'e', apiToken: '', fetchImpl })).toThrow(
      /JIRA_API_TOKEN is required/
    )
  })

  it('sends basic auth and JSON to the site’s v3 root, dropping unset query values', async () => {
    const { fetchImpl, sent } = fetchReplying({ body: { accountId: 'a' } })
    const { client } = clientOver(fetchImpl)
    expect(client.site).toBe('https://example.atlassian.net')
    const me = await client.get<{ accountId: string }>('/myself', { expand: undefined, fields: '', maxResults: 5 })
    expect(me.accountId).toBe('a')
    expect(sent[0]?.url).toBe('https://example.atlassian.net/rest/api/3/myself?maxResults=5')
    expect(sent[0]?.method).toBe('GET')
    expect(sent[0]?.headers.authorization).toBe(basicAuth('me@example.com', 'token-value'))
    expect(sent[0]?.headers.accept).toBe('application/json')
    expect(sent[0]?.headers['content-type']).toBeUndefined()
    expect(sent[0]?.body).toBeUndefined()
  })

  it('posts a JSON body and reads an empty 204 as an empty object', async () => {
    const { fetchImpl, sent } = fetchReplying({ status: 204 })
    const { client } = clientOver(fetchImpl)
    expect(await client.request('POST', 'issue/EX-1/transitions', { body: { transition: { id: '31' } } })).toEqual({})
    expect(sent[0]?.method).toBe('POST')
    expect(sent[0]?.headers['content-type']).toBe('application/json')
    expect(sent[0]?.body).toBe('{"transition":{"id":"31"}}')
  })

  it('throws the error collection on a failed answer', async () => {
    const { fetchImpl } = fetchReplying({
      status: 400,
      body: { errorMessages: ["Field 'priority' is required"], errors: {} }
    })
    const { client } = clientOver(fetchImpl)
    await expect(client.get('issue/EX-1')).rejects.toThrow("400: Field 'priority' is required")
  })

  it('never retries a 401 and reports the raw text when the body is HTML', async () => {
    const { fetchImpl } = fetchReplying({ status: 401, text: '<html>login</html>' })
    const { client, waits } = clientOver(fetchImpl)
    await expect(client.get('myself')).rejects.toThrow('401: <html>login</html>')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(waits).toEqual([])
  })

  it('reports a 200 that is not JSON as a wrong site', async () => {
    const { fetchImpl } = fetchReplying({ text: '<!DOCTYPE html><html>' })
    const { client } = clientOver(fetchImpl)
    await expect(client.get('myself')).rejects.toThrow(/other than JSON; check JIRA_SITE_URL/)
  })

  it('retries a 429 once after Retry-After with jitter, then reports the second', async () => {
    const { fetchImpl, sent } = fetchReplying(
      { status: 429, headers: { 'retry-after': '2', 'ratelimit-reason': 'jira-burst-based' } },
      { body: { ok: true } }
    )
    const { client, waits } = clientOver(fetchImpl, () => 0)
    expect(await client.request('POST', 'issue', { body: {}, idempotent: false })).toEqual({ ok: true })
    expect(sent).toHaveLength(2)
    expect(waits).toEqual([1400])

    const twice = fetchReplying({ status: 429, headers: { 'ratelimit-reason': 'jira-quota-tenant-based' } })
    const again = clientOver(twice.fetchImpl, () => 1)
    await expect(again.client.get('myself')).rejects.toThrow('429: Status (jira-quota-tenant-based)')
    expect(twice.sent).toHaveLength(2)
    expect(again.waits).toEqual([Math.round(DEFAULT_RATE_LIMIT_WAIT_MS * 1.3)])
  })

  it('retries a 5xx once on an idempotent call and never on a create', async () => {
    const { fetchImpl, sent } = fetchReplying({ status: 503 }, { body: { ok: true } })
    const { client, waits } = clientOver(fetchImpl)
    expect(await client.get('myself')).toEqual({ ok: true })
    expect(sent).toHaveLength(2)
    expect(waits).toEqual([DEFAULT_SERVER_ERROR_WAIT_MS])

    const create = fetchReplying({ status: 502, text: 'bad gateway' })
    const once = clientOver(create.fetchImpl)
    await expect(once.client.request('POST', 'issue', { body: {}, idempotent: false })).rejects.toThrow(
      '502: bad gateway'
    )
    expect(create.sent).toHaveLength(1)

    const gaveUp = fetchReplying({ status: 500, body: { errorMessages: ['boom'] } })
    await expect(clientOver(gaveUp.fetchImpl).client.get('myself')).rejects.toThrow('500: boom')
    expect(gaveUp.sent).toHaveLength(2)
  })

  it('retries once when no answer arrived at all, even for a create', async () => {
    const { fetchImpl, sent } = fetchReplying({ fail: true }, { status: 201, body: { id: '1' } })
    const { client, waits } = clientOver(fetchImpl)
    expect(await client.request('POST', 'issue', { body: {}, idempotent: false })).toEqual({ id: '1' })
    expect(sent).toHaveLength(2)
    expect(waits).toEqual([DEFAULT_SERVER_ERROR_WAIT_MS])

    const dead = fetchReplying({ fail: true })
    await expect(clientOver(dead.fetchImpl).client.get('myself')).rejects.toThrow('fetch failed')
    expect(dead.sent).toHaveLength(2)
  })

  it('reaches the global fetch, clock and sleep when none are injected', async () => {
    const served = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', served)
    vi.useFakeTimers()
    try {
      const client = createJiraClient({ siteUrl: 'https://x.atlassian.net', email: 'e', apiToken: 't' })
      const pending = client.get('myself')
      await vi.runAllTimersAsync()
      expect(await pending).toEqual({ ok: true })
      expect(served).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})
