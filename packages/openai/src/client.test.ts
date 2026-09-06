import { describe, expect, it, vi } from 'vitest'
import {
  API_ROOT,
  DEFAULT_RATE_LIMIT_WAIT_MS,
  DEFAULT_SERVER_ERROR_WAIT_MS,
  MAX_PREEMPTIVE_WAIT_MS,
  OpenAIApiError,
  createOpenAIClient,
  describeFailure,
  durationMs,
  normalizeKey
} from './client'

interface Reply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

/** Serves the replies in order and records every request. */
function sequence(replies: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? {}
    const body = reply.body === undefined ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
    return new Response(body, { status: reply.status ?? 200, headers: reply.headers ?? {} })
  })
  return { fetchImpl, calls }
}

function clientWith(replies: Reply[], extra: Record<string, unknown> = {}) {
  const { fetchImpl, calls } = sequence(replies)
  const waits: number[] = []
  const warnings: string[] = []
  let clock = 1_000_000
  const client = createOpenAIClient({
    apiKey: 'sk-test',
    fetchImpl,
    sleep: async (ms) => {
      waits.push(ms)
      clock += ms
    },
    warn: (message) => {
      warnings.push(message)
    },
    now: () => clock,
    random: () => 0,
    ...extra
  })
  return { client, calls, waits, warnings, fetchImpl }
}

describe('normalizeKey', () => {
  it('trims the pasted value', () => {
    expect(normalizeKey('  sk-abc \n')).toBe('sk-abc')
  })

  it('refuses an empty key with a pointer to where one is made', () => {
    expect(() => normalizeKey('')).toThrow(/OPENAI_API_KEY is required.*platform\.openai\.com\/api-keys/)
    expect(() => normalizeKey(undefined)).toThrow(/required/)
  })
})

describe('durationMs', () => {
  it('reads the Go durations the reset headers carry', () => {
    expect(durationMs('1s')).toBe(1000)
    expect(durationMs('6m0s')).toBe(360_000)
    expect(durationMs('120ms')).toBe(120)
    expect(durationMs('1h2m3.5s')).toBe(3_723_500)
  })

  it('is undefined for nothing or for text that is not a duration', () => {
    expect(durationMs(null)).toBeUndefined()
    expect(durationMs('')).toBeUndefined()
    expect(durationMs('soon')).toBeUndefined()
    expect(durationMs('5 s')).toBeUndefined()
  })
})

describe('describeFailure', () => {
  it('reads code and message from the error body', () => {
    expect(describeFailure(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } })).toBe(
      '401 invalid_api_key: Incorrect API key provided'
    )
  })

  it('falls back to the type when the body names no code', () => {
    expect(describeFailure(429, { error: { message: 'Rate limit reached', type: 'rate_limit_error', code: null } })).toBe(
      '429 rate_limit_error: Rate limit reached'
    )
  })

  it('quotes a body that is not the error shape, and says when there is none', () => {
    expect(describeFailure(502, 'Bad gateway')).toBe('502: Bad gateway')
    expect(describeFailure(500, undefined)).toBe('500: no body')
    expect(describeFailure(500, { unexpected: true })).toBe('500: {"unexpected":true}')
    expect(describeFailure(500, 'x'.repeat(400))).toMatch(/…$/)
  })

  it('names the request id when the response carried one', () => {
    expect(describeFailure(404, { error: { message: 'No such model', code: 'model_not_found' } }, 'req_1')).toBe(
      '404 model_not_found: No such model (request req_1)'
    )
  })
})

describe('createOpenAIClient', () => {
  it('sends the bearer key and JSON body to the API root', async () => {
    const { client, calls } = clientWith([{ body: { ok: true } }])
    const result = await client.request('POST', 'responses', { body: { model: 'gpt-4o-mini' } })
    expect(result).toEqual({ ok: true })
    expect(calls[0]!.url).toBe(`${API_ROOT}/responses`)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.headers).toEqual({ authorization: 'Bearer sk-test', 'content-type': 'application/json' })
    expect(calls[0]!.init?.body).toBe('{"model":"gpt-4o-mini"}')
  })

  it('adds the organization and project headers only when set', async () => {
    const { client, calls } = clientWith([{ body: {} }], { organization: 'org-1', project: 'proj_1' })
    await client.get('models')
    expect(calls[0]!.init?.headers).toEqual({
      authorization: 'Bearer sk-test',
      'openai-organization': 'org-1',
      'openai-project': 'proj_1'
    })
    expect(calls[0]!.init?.body).toBeUndefined()
  })

  it('puts query values on the URL and leaves empty ones out', async () => {
    const { client, calls } = clientWith([{ body: {} }])
    await client.get('/files', { limit: 5, order: 'desc', purpose: undefined, after: '' })
    expect(calls[0]!.url).toBe(`${API_ROOT}/files?limit=5&order=desc`)
  })

  it('returns undefined for an empty body and text for a body that is not JSON', async () => {
    const { client } = clientWith([{ body: '' }, { body: 'plain' }])
    expect(await client.get('a')).toBeUndefined()
    expect(await client.get('b')).toBe('plain')
  })

  it('throws the API error with status, code, type, param and request id', async () => {
    const { client } = clientWith([
      {
        status: 400,
        headers: { 'x-request-id': 'req_abc' },
        body: { error: { message: 'Missing model', type: 'invalid_request_error', code: null, param: 'model' } }
      }
    ])
    const failure = await client.get('models').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(OpenAIApiError)
    const typed = failure as OpenAIApiError
    expect(typed.message).toBe('400 invalid_request_error: Missing model (request req_abc)')
    expect(typed.status).toBe(400)
    expect(typed.code).toBeUndefined()
    expect(typed.type).toBe('invalid_request_error')
    expect(typed.param).toBe('model')
    expect(typed.requestId).toBe('req_abc')
  })

  it('retries a 429 once after Retry-After seconds, then throws', async () => {
    const limited: Reply = {
      status: 429,
      headers: { 'retry-after': '3' },
      body: { error: { message: 'Rate limit reached', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }
    }
    const { client, calls, waits, warnings } = clientWith([limited, { body: { data: [] } }])
    expect(await client.get('models')).toEqual({ data: [] })
    expect(calls).toHaveLength(2)
    expect(waits).toEqual([3000])
    expect(warnings[0]).toMatch(/GET \/models was rate limited; waiting 3\.0s/)

    const twice = clientWith([limited, limited])
    await expect(twice.client.get('models')).rejects.toThrow('429 rate_limit_exceeded: Rate limit reached')
    expect(twice.calls).toHaveLength(2)
  })

  it('waits the request reset duration when there is no Retry-After, else two seconds', async () => {
    const fromReset = clientWith([
      { status: 429, headers: { 'x-ratelimit-reset-requests': '1m30s' }, body: { error: { message: 'slow', type: 'rate_limit_error' } } },
      { body: {} }
    ])
    await fromReset.client.get('models')
    expect(fromReset.waits).toEqual([90_000])

    const bare = clientWith([{ status: 429, body: '' }, { body: {} }])
    await bare.client.get('models')
    expect(bare.waits).toEqual([DEFAULT_RATE_LIMIT_WAIT_MS])
  })

  it('adds up to half a second of jitter to a retry wait', async () => {
    const { client, waits } = clientWith([{ status: 429, headers: { 'retry-after': '1' }, body: '' }, { body: {} }], {
      random: () => 0.999
    })
    await client.get('models')
    expect(waits).toEqual([1499])
  })

  it('does not retry a 429 that needs a person', async () => {
    for (const code of [
      'insufficient_quota',
      'credit_balance_exhausted',
      'organization_spend_limit_exceeded',
      'project_spend_limit_exceeded'
    ]) {
      const { client, calls } = clientWith([
        { status: 429, body: { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code } } }
      ])
      await expect(client.get('models')).rejects.toThrow(`429 ${code}: You exceeded your current quota`)
      expect(calls).toHaveLength(1)
    }
  })

  it('retries a server error once, after Retry-After or a second, then throws', async () => {
    const { client, calls, waits } = clientWith([{ status: 503, body: { error: { message: 'overloaded', code: 'server_is_overloaded' } } }, { body: { ok: 1 } }])
    expect(await client.get('models')).toEqual({ ok: 1 })
    expect(waits).toEqual([DEFAULT_SERVER_ERROR_WAIT_MS])
    expect(calls).toHaveLength(2)

    const asked = clientWith([{ status: 502, headers: { 'retry-after': '4' }, body: '' }, { body: {} }])
    await asked.client.get('models')
    expect(asked.waits).toEqual([4000])

    const twice = clientWith([{ status: 500, body: 'boom' }, { status: 500, body: 'boom' }])
    await expect(twice.client.get('models')).rejects.toThrow('500: boom')
    expect(twice.calls).toHaveLength(2)
  })

  it('does not retry a 4xx or an unlisted 5xx', async () => {
    const { client, calls } = clientWith([{ status: 403, body: { error: { message: 'unsupported_country_region_territory', code: 'unsupported_country_region_territory' } } }])
    await expect(client.get('models')).rejects.toThrow(/^403 unsupported_country_region_territory/)
    expect(calls).toHaveLength(1)

    const odd = clientWith([{ status: 501, body: '' }])
    await expect(odd.client.get('models')).rejects.toThrow('501: no body')
    expect(odd.calls).toHaveLength(1)
  })

  it('sleeps out a spent request budget before the next call, capped at ten seconds', async () => {
    const spent = { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '4s' }
    const { client, waits, warnings } = clientWith([{ headers: spent, body: {} }, { body: {} }, { body: {} }])
    await client.get('models')
    expect(waits).toEqual([])
    await client.get('models')
    expect(waits).toEqual([4000])
    expect(warnings[0]).toMatch(/request budget is spent; waiting 4\.0s/)
    await client.get('models')
    expect(waits).toEqual([4000])

    const long = clientWith([{ headers: { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '6m0s' }, body: {} }, { body: {} }])
    await long.client.get('models')
    await long.client.get('models')
    expect(long.waits).toEqual([MAX_PREEMPTIVE_WAIT_MS])
  })

  it('ignores rate-limit headers that leave requests remaining or name no reset', async () => {
    const { client, waits } = clientWith([
      { headers: { 'x-ratelimit-remaining-requests': '5', 'x-ratelimit-reset-requests': '4s' }, body: {} },
      { headers: { 'x-ratelimit-remaining-requests': '0' }, body: {} },
      { body: {} }
    ])
    await client.get('models')
    await client.get('models')
    await client.get('models')
    expect(waits).toEqual([])
  })

  it('falls back to the global fetch, a real sleep and console.warn when none are injected', async () => {
    const original = globalThis.fetch
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    try {
      const client = createOpenAIClient({ apiKey: 'sk-test' })
      expect(await client.get('models')).toEqual({})
      expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.fetch = original
      warned.mockRestore()
    }
  })

  it('uses the default sleep and warning when only fetch is injected', async () => {
    vi.useFakeTimers()
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { fetchImpl } = sequence([{ status: 500, body: '' }, { body: { ok: true } }])
      const client = createOpenAIClient({ apiKey: 'sk-test', fetchImpl, random: () => 0 })
      const pending = client.get('models')
      await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_ERROR_WAIT_MS)
      expect(await pending).toEqual({ ok: true })
      expect(warned).toHaveBeenCalledWith(expect.stringMatching(/answered 500/))
    } finally {
      warned.mockRestore()
      vi.useRealTimers()
    }
  })
})
