import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  API_ROOT,
  DiscordApiError,
  MAX_WAIT_MS,
  compareSnowflakes,
  createDiscordClient,
  describeFailure,
  firstFieldError,
  isSnowflake,
  maxSnowflake,
  normalizeToken,
  routeKey,
  snowflakeFrom,
  snowflakeTime,
  userAgent
} from './client'

interface Reply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
  text?: string
}

interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/** A fetch that serves the replies given, in order, and records each request. */
function fetchReplying(...replies: Reply[]) {
  const sent: Sent[] = []
  let index = 0
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    sent.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === 'string' && { body: init.body })
    })
    const reply = replies[Math.min(index++, replies.length - 1)] ?? {}
    const status = reply.status ?? 200
    const text = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body))
    return new Response(status === 204 ? null : text, {
      status,
      headers: { 'content-type': 'application/json', ...reply.headers }
    })
  })
  return { fetchImpl, sent }
}

function client(fetchImpl: ReturnType<typeof fetchReplying>['fetchImpl'], extra = {}) {
  const waits: number[] = []
  const warnings: string[] = []
  const api = createDiscordClient({
    token: 'tok',
    version: '1.2.3',
    fetchImpl,
    sleep: async (ms) => {
      waits.push(ms)
    },
    warn: (message) => {
      warnings.push(message)
    },
    ...extra
  })
  return { api, waits, warnings }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normalizeToken', () => {
  it('strips a pasted Bot prefix and surrounding space', () => {
    expect(normalizeToken('  Bot abc.def  ')).toBe('abc.def')
    expect(normalizeToken('bot abc')).toBe('abc')
    expect(normalizeToken('abc')).toBe('abc')
  })

  it('refuses an empty token with the portal path', () => {
    expect(() => normalizeToken('')).toThrow(/DISCORD_BOT_TOKEN is required.*Reset Token/)
    expect(() => normalizeToken(undefined)).toThrow(/required/)
    expect(() => normalizeToken('Bot ')).toThrow(/required/)
  })
})

describe('userAgent', () => {
  it('follows the documented DiscordBot form', () => {
    expect(userAgent('0.1.0')).toBe('DiscordBot (https://github.com/vorn-run/connectors, 0.1.0)')
  })
})

describe('snowflakes', () => {
  it('recognises decimal ids only', () => {
    expect(isSnowflake('1412345678901234567')).toBe(true)
    expect(isSnowflake('abc')).toBe(false)
    expect(isSnowflake(12)).toBe(false)
  })

  it('round-trips a time through a snowflake', () => {
    const ms = Date.parse('2026-09-04T18:41:02.123Z')
    expect(snowflakeTime(snowflakeFrom(ms))).toBe(ms)
    expect(snowflakeTime('175928847299117063')).toBe(1462015105796)
  })

  it('never produces a negative snowflake for a time before the epoch', () => {
    expect(snowflakeFrom(0)).toBe('0')
    expect(snowflakeFrom(-5)).toBe('0')
  })

  it('compares ids as integers rather than strings', () => {
    expect(compareSnowflakes('9', '10')).toBe(-1)
    expect(compareSnowflakes('10', '9')).toBe(1)
    expect(compareSnowflakes('10', '10')).toBe(0)
    expect(compareSnowflakes('18446744073709551615', '18446744073709551614')).toBe(1)
  })

  it('finds the newest id in a list', () => {
    expect(maxSnowflake(['9', '100', '10'])).toBe('100')
    expect(maxSnowflake([])).toBeUndefined()
  })
})

describe('describeFailure', () => {
  it('reads status, code and message', () => {
    expect(describeFailure(404, { code: 10003, message: 'Unknown Channel' })).toBe(
      '404 10003: Unknown Channel'
    )
  })

  it('appends the first nested field error of an invalid form body', () => {
    const body = {
      code: 50035,
      message: 'Invalid Form Body',
      errors: {
        embeds: { '0': { title: { _errors: [{ code: 'BASE_TYPE_MAX_LENGTH', message: 'Must be 256 or fewer in length.' }] } } }
      }
    }
    expect(describeFailure(400, body)).toBe(
      '400 50035: Invalid Form Body (embeds.0.title: Must be 256 or fewer in length.)'
    )
  })

  it('quotes a body that is not the error shape', () => {
    expect(describeFailure(502, 'Bad Gateway')).toBe('502: Bad Gateway')
    expect(describeFailure(500, undefined)).toBe('500: no body')
    expect(describeFailure(500, { unexpected: true })).toBe('500: {"unexpected":true}')
    expect(describeFailure(500, 'x'.repeat(400))).toMatch(/…$/)
  })

  it('adds a note when given one', () => {
    expect(describeFailure(429, { message: 'Slow down' }, '(bucket b)')).toBe('429: Slow down (bucket b)')
  })
})

describe('firstFieldError', () => {
  it('walks past keys with no message', () => {
    expect(firstFieldError({ a: { _errors: [] }, b: { _errors: [{ code: 'X' }] } })).toBe('b: X')
    expect(firstFieldError({ _errors: [{ message: 'top' }] })).toBe('top')
    expect(firstFieldError({ a: { _errors: [{ message: '' }] } })).toBeUndefined()
    expect(firstFieldError(null)).toBeUndefined()
    expect(firstFieldError({ a: 'text' })).toBeUndefined()
  })
})

describe('routeKey', () => {
  it('strips ids so one channel does not get its own bucket', () => {
    expect(routeKey('get', 'channels/41771983423143937/messages')).toBe('GET channels/:id/messages')
    expect(routeKey('GET', 'users/@me')).toBe('GET users/@me')
  })
})

describe('createDiscordClient', () => {
  it('sends the Bot header, the user agent, query and a JSON body', async () => {
    const { fetchImpl, sent } = fetchReplying({ body: { id: '1' } })
    const { api } = client(fetchImpl)

    const result = await api.request('POST', '/channels/1/messages', {
      query: { after: '5', limit: 100, blank: undefined, empty: '' },
      body: { content: 'hi' }
    })

    expect(result).toEqual({ id: '1' })
    expect(sent[0]!.url).toBe(`${API_ROOT}/channels/1/messages?after=5&limit=100`)
    expect(sent[0]!.method).toBe('POST')
    expect(sent[0]!.headers.authorization).toBe('Bot tok')
    expect(sent[0]!.headers['user-agent']).toBe(userAgent('1.2.3'))
    expect(sent[0]!.headers['content-type']).toBe('application/json')
    expect(sent[0]!.body).toBe('{"content":"hi"}')
  })

  it('sends no content type without a body and reads an empty 204', async () => {
    const { fetchImpl, sent } = fetchReplying({ status: 204 })
    const { api } = client(fetchImpl)
    expect(await api.request('PUT', 'channels/1/pins/2')).toBeUndefined()
    expect(sent[0]!.headers['content-type']).toBeUndefined()
  })

  it('returns text when the body is not JSON', async () => {
    const { fetchImpl } = fetchReplying({ text: 'plain' })
    const { api } = client(fetchImpl)
    expect(await api.get('users/@me')).toBe('plain')
  })

  it('throws a DiscordApiError for a failed status without retrying', async () => {
    const { fetchImpl } = fetchReplying({ status: 403, body: { code: 50013, message: 'Missing Permissions' } })
    const { api, waits } = client(fetchImpl)
    const error = (await api.get('channels/1').catch((thrown: unknown) => thrown)) as DiscordApiError
    expect(error).toBeInstanceOf(DiscordApiError)
    expect(error.message).toBe('403 50013: Missing Permissions')
    expect(error.status).toBe(403)
    expect(error.code).toBe(50013)
    expect(waits).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('waits Retry-After on a 429, never less than a second, then retries', async () => {
    const { fetchImpl } = fetchReplying(
      { status: 429, headers: { 'retry-after': '2.5', 'x-ratelimit-bucket': 'abc', 'x-ratelimit-scope': 'user' }, body: { retry_after: 2.5 } },
      { status: 429, headers: { 'retry-after': '0.2' }, body: {} },
      { body: { ok: true } }
    )
    const { api, waits, warnings } = client(fetchImpl)
    expect(await api.get('channels/1')).toEqual({ ok: true })
    expect(waits).toEqual([2500, 1000])
    expect(warnings[0]).toMatch(/rate limited on bucket abc \(user\); waiting 2.5s/)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('reads retry_after from the body when the header is missing, and caps the wait', async () => {
    const { fetchImpl } = fetchReplying({ status: 429, body: { retry_after: 500 } }, { body: {} })
    const { api, waits } = client(fetchImpl)
    await api.get('channels/1')
    expect(waits).toEqual([MAX_WAIT_MS])
  })

  it('falls back to a one second wait when nothing says how long', async () => {
    const { fetchImpl } = fetchReplying({ status: 429, text: 'busy' }, { body: {} })
    const { api, waits } = client(fetchImpl)
    await api.get('channels/1')
    expect(waits).toEqual([1000])
  })

  it('gives up on the third 429 and names the bucket and scope', async () => {
    const { fetchImpl } = fetchReplying({
      status: 429,
      headers: { 'retry-after': '1', 'x-ratelimit-bucket': 'b1', 'x-ratelimit-scope': 'shared' },
      body: { message: 'You are being rate limited.', retry_after: 1 }
    })
    const { api, waits } = client(fetchImpl)
    const error = (await api.get('channels/1').catch((thrown: unknown) => thrown)) as DiscordApiError
    expect(error).toBeInstanceOf(DiscordApiError)
    expect(error.message).toBe(
      '429: You are being rate limited. (rate limited 3 times on bucket b1, scope shared)'
    )
    expect(error.bucket).toBe('b1')
    expect(error.scope).toBe('shared')
    expect(waits).toEqual([1000, 1000])
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('names the route when a 429 carries no bucket', async () => {
    const { fetchImpl } = fetchReplying({ status: 429, body: { message: 'slow' } })
    const { api } = client(fetchImpl)
    await expect(api.get('channels/1')).rejects.toThrow(
      '429: slow (rate limited 3 times on bucket GET channels/1)'
    )
  })

  it('retries a 5xx once after a second, then reports it', async () => {
    const { fetchImpl } = fetchReplying({ status: 502, text: 'Bad Gateway' }, { status: 502, text: 'Bad Gateway' })
    const { api, waits } = client(fetchImpl)
    await expect(api.get('channels/1')).rejects.toThrow('502: Bad Gateway')
    expect(waits).toEqual([1000])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('recovers when the retried 5xx succeeds', async () => {
    const { fetchImpl } = fetchReplying({ status: 500, body: {} }, { body: { id: '9' } })
    const { api } = client(fetchImpl)
    expect(await api.get('channels/1')).toEqual({ id: '9' })
  })

  it('sleeps out an exhausted bucket before the next call on it', async () => {
    let clock = 1_000_000
    const { fetchImpl } = fetchReplying(
      { body: {}, headers: { 'x-ratelimit-bucket': 'msgs', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '3' } },
      { body: {} },
      { body: {} }
    )
    const { api, waits, warnings } = client(fetchImpl, { now: () => clock })

    await api.get('channels/41771983423143937/messages')
    await api.get('channels/41771983423143938/messages')
    expect(waits).toEqual([3000])
    expect(warnings[0]).toMatch(/bucket msgs is exhausted; waiting 3.0s/)

    clock += 10_000
    await api.get('channels/41771983423143939/messages')
    expect(waits).toEqual([3000])
  })

  it('ignores a bucket that is already reset or still has room', async () => {
    let clock = 5_000
    const { fetchImpl } = fetchReplying(
      { body: {}, headers: { 'x-ratelimit-remaining': '2', 'x-ratelimit-reset-after': '3' } },
      { body: {}, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '1' } },
      { body: {} }
    )
    const { api, waits } = client(fetchImpl, { now: () => clock })
    await api.get('guilds/1/channels')
    await api.get('guilds/1/channels')
    clock += 1_000
    await api.get('guilds/1/channels')
    expect(waits).toEqual([])
  })

  it('uses the global fetch, a real sleep and console.warn by default', async () => {
    const stub = vi.fn(async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.05' }
      })
    )
    vi.stubGlobal('fetch', stub)
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const api = createDiscordClient({ token: 'tok', version: '1' })
    await api.get('users/@me')
    await api.get('users/@me')

    expect(stub).toHaveBeenCalledTimes(2)
    expect(warned).toHaveBeenCalledWith(expect.stringMatching(/exhausted/))
    warned.mockRestore()
  })
})
