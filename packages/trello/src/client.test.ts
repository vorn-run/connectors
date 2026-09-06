import { describe, expect, it, vi } from 'vitest'
import {
  API_ROOT,
  RATE_LIMIT_WINDOW_MS,
  TrelloApiError,
  createTrelloClient,
  rateLimitWaitMs,
  retryAfterMs
} from './client'

const NOW = Date.parse('2026-09-06T12:00:00.000Z')

interface Reply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

// A fake api.trello.com answering in order, remembering what was asked.
function serving(replies: Reply[]) {
  const sent: Array<{ url: URL; method: string }> = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: new URL(String(input)), method: (init?.method ?? 'GET').toUpperCase() })
    const reply = replies[Math.min(sent.length - 1, replies.length - 1)] ?? {}
    const body = typeof reply.body === 'string' ? reply.body : reply.body === undefined ? '' : JSON.stringify(reply.body)
    return new Response(body, {
      status: reply.status ?? 200,
      headers: { 'content-type': typeof reply.body === 'string' ? 'text/plain' : 'application/json', ...reply.headers }
    })
  }) as unknown as typeof fetch
  return { fetchImpl, sent }
}

function client(replies: Reply[], sleep = vi.fn(async () => {})) {
  const { fetchImpl, sent } = serving(replies)
  const api = createTrelloClient({ apiKey: 'k', token: 't', fetch: fetchImpl, sleep, now: () => NOW })
  return { api, sent, sleep }
}

describe('retryAfterMs', () => {
  it('reads seconds, an HTTP date, and nothing', () => {
    expect(retryAfterMs('3', NOW)).toBe(3000)
    expect(retryAfterMs(new Date(NOW + 5000).toUTCString(), NOW)).toBe(5000)
    expect(retryAfterMs(new Date(NOW - 5000).toUTCString(), NOW)).toBe(0)
    expect(retryAfterMs(null, NOW)).toBeUndefined()
    expect(retryAfterMs('  ', NOW)).toBeUndefined()
    expect(retryAfterMs('soon', NOW)).toBeUndefined()
  })
})

describe('rateLimitWaitMs', () => {
  it('prefers Retry-After over the window headers', () => {
    const headers = new Headers({ 'retry-after': '2', 'x-rate-limit-api-token-remaining': '0', 'x-rate-limit-api-token-interval-ms': '10000' })
    expect(rateLimitWaitMs(headers, NOW)).toBe(2000)
  })

  it('takes the longest exhausted window when no Retry-After is given', () => {
    const headers = new Headers({
      'x-rate-limit-api-key-remaining': '0',
      'x-rate-limit-api-key-interval-ms': '10000',
      'x-rate-limit-api-token-remaining': '0',
      'x-rate-limit-api-token-interval-ms': '15000'
    })
    expect(rateLimitWaitMs(headers, NOW)).toBe(15000)
  })

  it('ignores a window with budget left or a malformed interval', () => {
    const left = new Headers({ 'x-rate-limit-api-key-remaining': '5', 'x-rate-limit-api-key-interval-ms': '10000' })
    expect(rateLimitWaitMs(left, NOW)).toBe(RATE_LIMIT_WINDOW_MS)
    const broken = new Headers({ 'x-rate-limit-api-token-remaining': '0', 'x-rate-limit-api-token-interval-ms': 'x' })
    expect(rateLimitWaitMs(broken, NOW)).toBe(RATE_LIMIT_WINDOW_MS)
    expect(rateLimitWaitMs(new Headers(), NOW)).toBe(RATE_LIMIT_WINDOW_MS)
  })
})

describe('createTrelloClient', () => {
  it('refuses a blank key or token', () => {
    expect(() => createTrelloClient({ apiKey: ' ', token: 't', fetch })).toThrow('TRELLO_API_KEY is required')
    expect(() => createTrelloClient({ apiKey: 'k', token: '', fetch })).toThrow('TRELLO_TOKEN is required')
  })

  it('sends key and token as query parameters and drops empty values', async () => {
    const { api, sent } = client([{ body: { id: '1' } }])
    await expect(api.call('cards/abc', { query: { a: '1', b: '', c: undefined, d: 0 } })).resolves.toEqual({ id: '1' })
    const [{ url, method }] = sent
    expect(method).toBe('GET')
    expect(url.origin + url.pathname).toBe(`${API_ROOT}/cards/abc`)
    expect(url.searchParams.get('key')).toBe('k')
    expect(url.searchParams.get('token')).toBe('t')
    expect(url.searchParams.get('a')).toBe('1')
    expect(url.searchParams.get('d')).toBe('0')
    expect(url.searchParams.has('b')).toBe(false)
    expect(url.searchParams.has('c')).toBe(false)
  })

  it('reads an empty body as an empty object', async () => {
    const { api } = client([{}])
    await expect(api.call('cards/abc')).resolves.toEqual({})
  })

  it('retries a 429 once after the documented wait and then reports the second one', async () => {
    const once = client([{ status: 429, body: 'API_TOKEN_LIMIT_EXCEEDED', headers: { 'retry-after': '4' } }, { body: [] }])
    await expect(once.api.call('search')).resolves.toEqual([])
    expect(once.sleep).toHaveBeenCalledWith(4000)
    expect(once.sent).toHaveLength(2)

    const twice = client([{ status: 429, body: 'API_KEY_LIMIT_EXCEEDED' }])
    await expect(twice.api.call('search')).rejects.toMatchObject({ status: 429, message: '429: API_KEY_LIMIT_EXCEEDED' })
    expect(twice.sleep).toHaveBeenCalledWith(RATE_LIMIT_WINDOW_MS)
    expect(twice.sent).toHaveLength(2)
  })

  it('throws status and body text on any other failure, trimmed to a readable length', async () => {
    const { api } = client([{ status: 401, body: 'invalid token' }])
    const error = await api.call('members/me').catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(TrelloApiError)
    expect(error).toMatchObject({ status: 401, body: 'invalid token', message: '401: invalid token' })

    const long = client([{ status: 400, body: 'x'.repeat(400) }])
    await expect(long.api.call('cards/abc')).rejects.toThrow(`400: ${'x'.repeat(300)}…`)

    const bare = client([{ status: 500 }])
    await expect(bare.api.call('cards/abc')).rejects.toThrow(/^500$/)
  })

  it('reads board actions with the fields the poll needs, and an odd answer as none', async () => {
    const { api, sent } = client([{ body: [{ id: 'a1' }] }, { body: { error: true } }])
    await expect(api.boardActions('b/1', { filter: 'createCard', since: 'S', limit: 1000 })).resolves.toEqual([{ id: 'a1' }])
    const [{ url }] = sent
    expect(url.pathname).toBe('/1/boards/b%2F1/actions')
    expect(url.searchParams.get('filter')).toBe('createCard')
    expect(url.searchParams.get('since')).toBe('S')
    expect(url.searchParams.get('limit')).toBe('1000')
    expect(url.searchParams.get('memberCreator')).toBe('true')
    expect(url.searchParams.get('member')).toBe('false')
    expect(url.searchParams.get('fields')).toBe('id,type,date,data')
    expect(url.searchParams.get('memberCreator_fields')).toBe('fullName,username')
    await expect(api.boardActions('b', { filter: 'commentCard' })).resolves.toEqual([])
  })

  it('reads board cards with the given fields', async () => {
    const { api, sent } = client([{ body: [{ id: 'c1' }] }, { body: {} }])
    await expect(api.boardCards('b', 'id,due')).resolves.toEqual([{ id: 'c1' }])
    expect(sent[0].url.pathname).toBe('/1/boards/b/cards')
    expect(sent[0].url.searchParams.get('fields')).toBe('id,due')
    await expect(api.boardCards('b', 'id')).resolves.toEqual([])
  })

  it('writes with POST and query parameters only', async () => {
    const { api, sent } = client([{ body: { id: 'c' } }, { body: { id: 'a' } }, { body: ['l1'] }])
    await expect(api.createCard({ idList: 'l', name: 'n', desc: undefined })).resolves.toEqual({ id: 'c' })
    expect(sent[0].method).toBe('POST')
    expect(sent[0].url.pathname).toBe('/1/cards')
    expect(sent[0].url.searchParams.get('idList')).toBe('l')
    expect(sent[0].url.searchParams.has('desc')).toBe(false)

    await expect(api.addComment('c 1', 'hi there')).resolves.toEqual({ id: 'a' })
    expect(sent[1].url.pathname).toBe('/1/cards/c%201/actions/comments')
    expect(sent[1].url.searchParams.get('text')).toBe('hi there')

    await expect(api.addLabel('c', 'l1')).resolves.toEqual(['l1'])
    expect(sent[2].url.pathname).toBe('/1/cards/c/idLabels')
    expect(sent[2].url.searchParams.get('value')).toBe('l1')
  })

  it('searches and reads the member', async () => {
    const { api, sent } = client([{ body: { cards: [] } }, { body: { id: 'm', username: 'bob' } }])
    await expect(api.search({ query: 'test', modelTypes: 'cards' })).resolves.toEqual({ cards: [] })
    expect(sent[0].url.pathname).toBe('/1/search')
    expect(sent[0].url.searchParams.get('query')).toBe('test')
    await expect(api.me()).resolves.toEqual({ id: 'm', username: 'bob' })
    expect(sent[1].url.pathname).toBe('/1/members/me')
    expect(sent[1].url.searchParams.get('fields')).toBe('id,username,fullName')
  })

  it('waits for real when no sleep is injected', async () => {
    vi.useFakeTimers()
    try {
      const { fetchImpl } = serving([{ status: 429, headers: { 'retry-after': '1' } }, { body: {} }])
      const api = createTrelloClient({ apiKey: 'k', token: 't', fetch: fetchImpl })
      const pending = api.call('search')
      await vi.advanceTimersByTimeAsync(1000)
      await expect(pending).resolves.toEqual({})
    } finally {
      vi.useRealTimers()
    }
  })
})
