import { describe, expect, it, vi } from 'vitest'
import {
  API_ROOT,
  MAX_RATE_LIMIT_WAIT_MS,
  POST_FIELDS,
  SERVER_ERROR_RETRY_MS,
  XApiError,
  createXClient,
  describeFailure
} from './client'

const CREDENTIALS = {
  consumerKey: 'consumer-key',
  consumerSecret: 'consumer-secret',
  token: '123-token',
  tokenSecret: 'token-secret'
}
const NOW_MS = Date.parse('2026-09-10T12:00:00.000Z')

interface Sent {
  method: string
  url: URL
  headers: Record<string, string>
  body?: unknown
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> }

function replies(...queue: Reply[]) {
  const sent: Sent[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const next = queue.shift() ?? { body: {} }
    sent.push({
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    })
    const status = next.status ?? 200
    const body = next.body === undefined ? '' : typeof next.body === 'string' ? next.body : JSON.stringify(next.body)
    return new Response(status === 204 ? null : body, { status, headers: next.headers ?? {} })
  }) as unknown as typeof fetch
  return { sent, fetchImpl }
}

function client(fetchImpl: typeof fetch, extra: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {}) {
  return createXClient({ credentials: CREDENTIALS, fetch: fetchImpl, now: () => NOW_MS, ...extra })
}

describe('createXClient', () => {
  it('signs every call with an OAuth header and sends JSON bodies', async () => {
    const { sent, fetchImpl } = replies({ status: 201, body: { data: { id: '1', text: 'hi' } } })
    const answer = await client(fetchImpl).createPost({ text: 'hi' })
    expect(answer.data?.id).toBe('1')
    expect(sent[0].method).toBe('POST')
    expect(sent[0].url.toString()).toBe(`${API_ROOT}/tweets`)
    expect(sent[0].headers.Authorization).toMatch(/^OAuth oauth_consumer_key="consumer-key", oauth_nonce="\w+", oauth_signature="[^"]+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1789041600", oauth_token="123-token", oauth_version="1.0"$/)
    expect(sent[0].headers['Content-Type']).toBe('application/json')
    expect(sent[0].body).toEqual({ text: 'hi' })
  })

  it('puts the query on the URL and leaves blank parameters out', async () => {
    const { sent, fetchImpl } = replies({ body: { data: [] } })
    await client(fetchImpl).searchRecent({ query: 'from:x', since_id: undefined, max_results: 10 })
    const url = sent[0].url
    expect(url.pathname).toBe('/2/tweets/search/recent')
    expect(url.searchParams.get('query')).toBe('from:x')
    expect(url.searchParams.get('sort_order')).toBe('recency')
    expect(url.searchParams.get('max_results')).toBe('10')
    expect(url.searchParams.has('since_id')).toBe(false)
    expect(url.searchParams.get('tweet.fields')).toBe(POST_FIELDS['tweet.fields'])
    expect(sent[0].headers['Content-Type']).toBeUndefined()
  })

  it('escapes path segments and reads an empty body as an empty object', async () => {
    const { sent, fetchImpl } = replies({ status: 204 })
    const api = client(fetchImpl)
    expect(await api.deletePost('1/2')).toEqual({})
    expect(sent[0].url.pathname).toBe('/2/tweets/1%2F2')
    expect(sent[0].method).toBe('DELETE')
    await api.getUserByUsername('x y', { 'user.fields': 'id' })
    expect(sent[1].url.pathname).toBe('/2/users/by/username/x%20y')
    await api.mentions('42', { since_id: '7' })
    expect(sent[2].url.pathname).toBe('/2/users/42/mentions')
    expect(sent[2].url.searchParams.get('since_id')).toBe('7')
    await api.getPost('20')
    expect(sent[3].url.searchParams.get('expansions')).toBe('author_id')
    await api.getMe()
    expect(sent[4].url.searchParams.get('user.fields')).toBe('id,username,name')
  })

  it('looks the connected account up once and forgets a failed lookup', async () => {
    const { sent, fetchImpl } = replies(
      { status: 500, body: { title: 'Internal' } },
      { status: 503, body: {} },
      { body: { data: { id: '9', username: 'me' } } }
    )
    const sleep = vi.fn(async () => {})
    const api = client(fetchImpl, { sleep })
    await expect(api.myId()).rejects.toThrow('503')
    expect(await api.myId()).toEqual({ id: '9', username: 'me' })
    expect(await api.myId()).toEqual({ id: '9', username: 'me' })
    expect(sent).toHaveLength(3)
  })

  it('returns an empty user when /users/me carries no data', async () => {
    const { fetchImpl } = replies({ body: {} })
    expect(await client(fetchImpl).myId()).toEqual({})
  })

  it('waits until the reset header and retries a 429 once', async () => {
    const reset = String(Math.floor(NOW_MS / 1000) + 30)
    const { sent, fetchImpl } = replies(
      { status: 429, body: { errors: [{ code: 88, message: 'Rate limit exceeded' }] }, headers: { 'x-rate-limit-reset': reset } },
      { body: { data: { id: '9' } } }
    )
    const sleep = vi.fn(async () => {})
    expect((await client(fetchImpl, { sleep }).getMe()).data?.id).toBe('9')
    expect(sleep).toHaveBeenCalledWith(30_000)
    expect(sent).toHaveLength(2)
  })

  it('waits a second when a 429 names no reset, and reports a second 429', async () => {
    const { fetchImpl } = replies(
      { status: 429, body: { errors: [{ code: 88, message: 'Rate limit exceeded' }] } },
      { status: 429, body: { title: 'Too Many Requests', detail: 'Too Many Requests', type: 'about:blank' } }
    )
    const sleep = vi.fn(async () => {})
    await expect(client(fetchImpl, { sleep }).getMe()).rejects.toThrow('429 Too Many Requests: Too Many Requests')
    expect(sleep).toHaveBeenCalledWith(SERVER_ERROR_RETRY_MS)
  })

  it('does not hold a call open past the wait ceiling', async () => {
    const reset = String(Math.floor(NOW_MS / 1000) + MAX_RATE_LIMIT_WAIT_MS / 1000 + 1)
    const { sent, fetchImpl } = replies({
      status: 429,
      body: { errors: [{ code: 88, message: 'Rate limit exceeded' }] },
      headers: { 'x-rate-limit-reset': reset }
    })
    const sleep = vi.fn(async () => {})
    await expect(client(fetchImpl, { sleep }).getMe()).rejects.toThrow(
      '429: Rate limit exceeded (code 88). The rate limit resets at 2026-09-10T12:01:01.000Z.'
    )
    expect(sleep).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
  })

  it('reports a usage cap at once instead of waiting', async () => {
    const { sent, fetchImpl } = replies({
      status: 429,
      body: { title: 'Usage cap exceeded', detail: 'Monthly cap', type: 'https://api.x.com/2/problems/usage-capped' },
      headers: { 'x-rate-limit-reset': '1' }
    })
    const sleep = vi.fn(async () => {})
    const error = await client(fetchImpl, { sleep }).getMe().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(XApiError)
    expect((error as XApiError).message).toBe(
      "429 Usage cap exceeded: Monthly cap [usage-capped]. The app's plan or credits do not cover this endpoint."
    )
    expect((error as XApiError).accessDenied).toBe(true)
    expect(sleep).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
  })

  it('retries a 5xx once after a second and then reports it', async () => {
    const { sent, fetchImpl } = replies({ status: 502, body: 'bad gateway' }, { status: 504, body: '' })
    const sleep = vi.fn(async () => {})
    await expect(client(fetchImpl, { sleep }).getMe()).rejects.toThrow('X API 504')
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(SERVER_ERROR_RETRY_MS)
    expect(sent).toHaveLength(2)
  })

  it('reports a 4xx without retrying', async () => {
    const { sent, fetchImpl } = replies({
      status: 404,
      body: { title: 'Not Found Error', detail: 'Could not find tweet with id: [456].', type: 'https://api.x.com/2/problems/resource-not-found' }
    })
    await expect(client(fetchImpl).getPost('456')).rejects.toThrow(
      '404 Not Found Error: Could not find tweet with id: [456]. [resource-not-found]'
    )
    expect(sent).toHaveLength(1)
  })

  it('uses the real clock and a real wait by default', async () => {
    const { sent, fetchImpl } = replies({ status: 500, body: {} }, { body: { data: { id: '1' } } })
    const api = createXClient({ credentials: CREDENTIALS, fetch: fetchImpl })
    vi.useFakeTimers()
    try {
      const pending = api.getMe()
      await vi.advanceTimersByTimeAsync(SERVER_ERROR_RETRY_MS)
      expect((await pending).data?.id).toBe('1')
    } finally {
      vi.useRealTimers()
    }
    expect(sent).toHaveLength(2)
  })

  it('takes a replacement fetch', async () => {
    const first = replies({ body: { data: { id: '1' } } })
    const second = replies({ body: { data: { id: '2' } } })
    const api = client(first.fetchImpl)
    api.setFetch(second.fetchImpl)
    expect((await api.getMe()).data?.id).toBe('2')
    expect(first.sent).toHaveLength(0)
  })
})

describe('describeFailure', () => {
  it('quotes a 403 reason and explains a 401', () => {
    const forbidden = describeFailure(403, { title: 'Forbidden', detail: 'Not allowed', reason: 'client-not-enrolled' }, '')
    expect(forbidden.message).toBe('403 Forbidden: Not allowed reason: client-not-enrolled')
    expect(forbidden.reason).toBe('client-not-enrolled')
    const unauthorized = describeFailure(401, { title: 'Unauthorized' }, '')
    expect(unauthorized.message).toContain('401 Unauthorized. The four credentials or the signature are wrong')
    expect(unauthorized.title).toBe('Unauthorized')
    expect(unauthorized.detail).toBeUndefined()
  })

  it('names a forbidden plan and a 402', () => {
    const plan = describeFailure(403, { title: 'Forbidden', detail: 'App not enrolled', type: 'https://api.x.com/2/problems/client-forbidden' }, '')
    expect(plan.message).toBe("403 Forbidden: App not enrolled [client-forbidden]. The app's plan or credits do not cover this endpoint.")
    expect(plan.accessDenied).toBe(true)
    const payment = describeFailure(402, {}, 'Payment Required')
    expect(payment.message).toBe("X API 402: Payment Required. The app's plan or credits do not cover this endpoint.")
    expect(payment.accessDenied).toBe(true)
    expect(describeFailure(403, { title: 'Forbidden' }, '').accessDenied).toBe(false)
  })

  it('truncates a long non-JSON body and ignores an empty type', () => {
    const long = 'x'.repeat(400)
    expect(describeFailure(500, {}, long).message).toBe(`X API 500: ${'x'.repeat(300)}…`)
    expect(describeFailure(400, { detail: 'Bad', type: '/' }, '').message).toBe('400 Error: Bad')
    expect(describeFailure(400, { errors: [{}] }, '{"errors":[{}]}').message).toBe('X API 400: {"errors":[{}]}')
    expect(describeFailure(400, { errors: [{ message: 'Bad request' }] }, '').message).toBe('400: Bad request')
  })
})
