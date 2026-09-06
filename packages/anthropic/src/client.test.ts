import { describe, expect, it, vi } from 'vitest'
import {
  ANTHROPIC_VERSION,
  API_ROOT,
  AnthropicApiError,
  MAX_LIST_PAGES,
  MAX_WAIT_MS,
  PAGE_LIMIT,
  createAnthropicClient,
  createRateGate,
  parseJsonl,
  retryAfterMs
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

// A fetch that serves the replies given, in order, and records each request; the last reply repeats.
function fetchReplying(...replies: Reply[]) {
  const sent: Sent[] = []
  let index = 0
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === 'string' && { body: init.body })
    })
    const reply = replies[Math.min(index++, replies.length - 1)]
    const text = reply.text ?? JSON.stringify(reply.body ?? {})
    return new Response(text, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers }
    })
  }) as unknown as typeof fetch
  return { fetchImpl, sent }
}

// A clock that only moves when something sleeps on it.
function fakeClock(start = Date.parse('2026-09-05T12:00:00Z')) {
  let at = start
  const waits: number[] = []
  return {
    now: () => at,
    waits,
    sleep: async (ms: number) => {
      waits.push(ms)
      at += ms
    }
  }
}

function clientOver(fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createAnthropicClient>[0]> = {}) {
  const clock = fakeClock()
  const client = createAnthropicClient({
    apiKey: 'test-key',
    fetch: fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0.5,
    ...extra
  })
  return { client, clock }
}

const body = (entry: Sent) => JSON.parse(entry.body ?? '{}') as Record<string, unknown>

describe('retryAfterMs', () => {
  const now = Date.parse('2026-09-05T12:00:00Z')

  it('reads seconds, an HTTP date, and nothing', () => {
    expect(retryAfterMs('2', now)).toBe(2000)
    expect(retryAfterMs('Sat, 05 Sep 2026 12:00:05 GMT', now)).toBe(5000)
    expect(retryAfterMs('Sat, 05 Sep 2026 11:00:00 GMT', now)).toBe(0)
    expect(retryAfterMs(null, now)).toBeUndefined()
    expect(retryAfterMs('  ', now)).toBeUndefined()
    expect(retryAfterMs('soon', now)).toBeUndefined()
  })

  it('caps a long wait', () => {
    expect(retryAfterMs('3600', now)).toBe(MAX_WAIT_MS)
  })
})

describe('createRateGate', () => {
  it('waits for the reset once a reply said no requests remain, then forgets it', async () => {
    const clock = fakeClock()
    const gate = createRateGate(clock)
    await gate.acquire()
    gate.observe(
      new Headers({
        'anthropic-ratelimit-requests-remaining': '0',
        'anthropic-ratelimit-requests-reset': '2026-09-05T12:00:03Z'
      })
    )
    await gate.acquire()
    await gate.acquire()
    expect(clock.waits).toEqual([3000])
  })

  it('ignores replies with requests left, no reset, an unreadable reset, or a reset already past', async () => {
    const clock = fakeClock()
    const gate = createRateGate(clock)
    gate.observe(new Headers({ 'anthropic-ratelimit-requests-remaining': '5', 'anthropic-ratelimit-requests-reset': '2026-09-05T12:00:03Z' }))
    gate.observe(new Headers({ 'anthropic-ratelimit-requests-remaining': '0' }))
    gate.observe(new Headers({ 'anthropic-ratelimit-requests-remaining': '0', 'anthropic-ratelimit-requests-reset': 'later' }))
    gate.observe(new Headers({ 'anthropic-ratelimit-requests-remaining': '0', 'anthropic-ratelimit-requests-reset': '2026-09-05T11:00:00Z' }))
    await gate.acquire()
    expect(clock.waits).toEqual([])
  })

  it('caps the wait at a minute', async () => {
    const clock = fakeClock()
    const gate = createRateGate(clock)
    gate.observe(new Headers({ 'anthropic-ratelimit-requests-remaining': '0', 'anthropic-ratelimit-requests-reset': '2026-09-05T13:00:00Z' }))
    await gate.acquire()
    expect(clock.waits).toEqual([MAX_WAIT_MS])
  })

  it('sleeps for real when nothing is injected', async () => {
    const gate = createRateGate()
    gate.observe(new Headers({ 'anthropic-ratelimit-requests-remaining': '0', 'anthropic-ratelimit-requests-reset': new Date(Date.now() + 1).toISOString() }))
    await gate.acquire()
  })
})

describe('parseJsonl', () => {
  it('parses one object per line and skips blank lines', () => {
    expect(parseJsonl('{"custom_id":"a"}\n\n{"custom_id":"b"}\n')).toEqual([{ custom_id: 'a' }, { custom_id: 'b' }])
    expect(parseJsonl('')).toEqual([])
  })

  it('names the line that is not JSON', () => {
    expect(() => parseJsonl('{"ok":1}\nnope')).toThrow('Batch results line 2 is not JSON')
  })
})

describe('createAnthropicClient', () => {
  it('refuses an empty key', () => {
    expect(() => createAnthropicClient({ apiKey: '  ', fetch })).toThrow('ANTHROPIC_API_KEY is required')
  })

  it('sends the key and version on every call, and JSON only with a body', async () => {
    const { fetchImpl, sent } = fetchReplying({ body: { id: 'msg_1' } }, { body: { input_tokens: 3 } })
    const { client } = clientOver(fetchImpl)
    await client.getModel('claude-sonnet-5')
    await client.countTokens({ model: 'claude-sonnet-5', messages: [], system: undefined })
    expect(sent[0]).toMatchObject({
      method: 'GET',
      url: `${API_ROOT}/models/claude-sonnet-5`,
      headers: { 'x-api-key': 'test-key', 'anthropic-version': ANTHROPIC_VERSION }
    })
    expect(sent[0].headers['content-type']).toBeUndefined()
    expect(sent[0].body).toBeUndefined()
    expect(sent[1]).toMatchObject({ method: 'POST', url: `${API_ROOT}/messages/count_tokens` })
    expect(sent[1].headers['content-type']).toBe('application/json')
    expect(body(sent[1])).toEqual({ model: 'claude-sonnet-5', messages: [] })
  })

  it('URL-encodes ids in paths', async () => {
    const { fetchImpl, sent } = fetchReplying({ body: {} })
    const { client } = clientOver(fetchImpl)
    await client.getBatch('msgbatch_a/b')
    await client.cancelBatch('x y')
    await client.getBatchResults('r?1')
    expect(sent.map((entry) => entry.url)).toEqual([
      `${API_ROOT}/messages/batches/msgbatch_a%2Fb`,
      `${API_ROOT}/messages/batches/x%20y/cancel`,
      `${API_ROOT}/messages/batches/r%3F1/results`
    ])
    expect(sent[1].method).toBe('POST')
  })

  it('reads an empty body as an empty object', async () => {
    const { fetchImpl } = fetchReplying({ text: '' })
    const { client } = clientOver(fetchImpl)
    expect(await client.getModel('x')).toEqual({})
  })

  it('parses batch results from JSONL', async () => {
    const { fetchImpl } = fetchReplying({ text: '{"custom_id":"a","result":{"type":"succeeded"}}\n{"custom_id":"b","result":{"type":"errored"}}' })
    const { client } = clientOver(fetchImpl)
    expect(await client.getBatchResults('msgbatch_1')).toEqual([
      { custom_id: 'a', result: { type: 'succeeded' } },
      { custom_id: 'b', result: { type: 'errored' } }
    ])
  })

  it('posts a message and a batch as given', async () => {
    const { fetchImpl, sent } = fetchReplying({ body: { id: 'msg_1' } }, { body: { id: 'msgbatch_1' } })
    const { client } = clientOver(fetchImpl)
    await client.createMessage({ model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 })
    await client.createBatch([{ custom_id: 'a', params: {} }])
    expect(body(sent[0])).toEqual({ model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 })
    expect(body(sent[1])).toEqual({ requests: [{ custom_id: 'a', params: {} }] })
  })

  it('throws the error type, message, status and request id', async () => {
    const { fetchImpl } = fetchReplying({
      status: 404,
      body: { type: 'error', error: { type: 'not_found_error', message: 'The requested resource could not be found.' }, request_id: 'req_1' }
    })
    const { client } = clientOver(fetchImpl)
    const error = await client.getModel('nope').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AnthropicApiError)
    expect(error).toMatchObject({ status: 404, type: 'not_found_error', requestId: 'req_1' })
    expect((error as Error).message).toBe('not_found_error: The requested resource could not be found. (HTTP 404, request req_1)')
  })

  it('takes the request id from the header and falls back on the raw text', async () => {
    const { fetchImpl } = fetchReplying(
      { status: 400, body: { error: {} }, headers: { 'request-id': 'req_h' } },
      { status: 403, text: 'forbidden', headers: { 'request-id': 'req_t' } },
      { status: 400, text: `<${'x'.repeat(400)}>` },
      { status: 400, body: { message: 'no error object' } }
    )
    const { client } = clientOver(fetchImpl)
    await expect(client.getModel('a')).rejects.toThrow('Anthropic API 400 (HTTP 400, request req_h)')
    await expect(client.getModel('b')).rejects.toThrow('Anthropic API 403: forbidden (HTTP 403, request req_t)')
    await expect(client.getModel('c')).rejects.toThrow(/^Anthropic API 400: <x{299}… \(HTTP 400\)$/)
    await expect(client.getModel('d')).rejects.toThrow('Anthropic API 400: {"message":"no error object"} (HTTP 400)')
  })

  it('retries a 429 once after retry-after, then throws', async () => {
    const { fetchImpl, sent } = fetchReplying(
      { status: 429, headers: { 'retry-after': '2' }, body: { error: { type: 'rate_limit_error', message: 'slow down' } } },
      { status: 429, headers: { 'retry-after': '3' }, body: { error: { type: 'rate_limit_error', message: 'slow down' } } }
    )
    const { client, clock } = clientOver(fetchImpl)
    await expect(client.getModel('m')).rejects.toThrow('rate_limit_error: slow down (HTTP 429)')
    expect(sent).toHaveLength(2)
    expect(clock.waits).toEqual([2000])
  })

  it('throws a 429 without retry-after at once, since that is the spend cap', async () => {
    const { fetchImpl, sent } = fetchReplying({
      status: 429,
      body: { error: { type: 'rate_limit_error', message: 'spend limit reached', details: { error_code: 'enforced_spend_limit_reached' } } }
    })
    const { client, clock } = clientOver(fetchImpl)
    await expect(client.getModel('m')).rejects.toThrow('rate_limit_error: spend limit reached')
    expect(sent).toHaveLength(1)
    expect(clock.waits).toEqual([])
  })

  it('retries a 529 or 5xx once after retry-after or a jittered second', async () => {
    const { fetchImpl, sent } = fetchReplying(
      { status: 529, body: { error: { type: 'overloaded_error', message: 'Overloaded' } } },
      { body: { id: 'ok' } },
      { status: 500, headers: { 'retry-after': '4' }, body: { error: { type: 'api_error', message: 'boom' } } },
      { status: 500, body: { error: { type: 'api_error', message: 'boom' } } }
    )
    const { client, clock } = clientOver(fetchImpl)
    expect(await client.getModel('a')).toEqual({ id: 'ok' })
    await expect(client.getModel('b')).rejects.toThrow('api_error: boom (HTTP 500)')
    expect(sent).toHaveLength(4)
    expect(clock.waits).toEqual([1500, 4000])
  })

  it('waits for the reset before the call after a reply with no requests remaining', async () => {
    const { fetchImpl } = fetchReplying(
      { body: {}, headers: { 'anthropic-ratelimit-requests-remaining': '0', 'anthropic-ratelimit-requests-reset': '2026-09-05T12:00:10Z' } },
      { body: {} }
    )
    const { client, clock } = clientOver(fetchImpl)
    await client.getModel('a')
    await client.getModel('b')
    expect(clock.waits).toEqual([10_000])
  })

  it('walks after_id pages while has_more, stopping at the window or the page cap', async () => {
    const { fetchImpl, sent } = fetchReplying(
      { body: { data: [{ id: 'm1' }, { id: 'm2' }], has_more: true, last_id: 'm2' } },
      { body: { data: [{ id: 'm3' }], has_more: true, last_id: 'm3' } },
      { body: { data: [{ id: 'm4' }], has_more: false, last_id: 'm4' } }
    )
    const { client } = clientOver(fetchImpl)
    expect((await client.listModels()).map((model) => model.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(sent.map((entry) => new URL(entry.url).searchParams.get('after_id'))).toEqual([null, 'm2', 'm3'])
    expect(new URL(sent[0].url).searchParams.get('limit')).toBe(String(PAGE_LIMIT))

    sent.length = 0
    const stopped = fetchReplying(
      { body: { data: [{ id: 'b1', created_at: '2026-09-05T11:00:00Z' }, { id: 'b0', created_at: '2020-01-01T00:00:00Z' }], has_more: true, last_id: 'b0' } }
    )
    const windowed = clientOver(stopped.fetchImpl).client
    const batches = await windowed.listBatches({ until: (batch) => batch.created_at === '2020-01-01T00:00:00Z' })
    expect(batches.map((batch) => batch.id)).toEqual(['b1', 'b0'])
    expect(stopped.sent).toHaveLength(1)
  })

  it('stops at the page cap and treats a reply without a list as empty', async () => {
    const endless = fetchReplying({ body: { data: [{ id: 'x' }], has_more: true, last_id: 'x' } })
    expect(await clientOver(endless.fetchImpl).client.listModels()).toHaveLength(MAX_LIST_PAGES)
    expect(endless.sent).toHaveLength(MAX_LIST_PAGES)
    expect(await clientOver(endless.fetchImpl).client.listModels({ maxPages: 2 })).toHaveLength(2)

    const bare = fetchReplying({ body: {} })
    expect(await clientOver(bare.fetchImpl).client.listBatches()).toEqual([])
    const missingLast = fetchReplying({ body: { data: [{ id: 'y' }], has_more: true } })
    expect(await clientOver(missingLast.fetchImpl).client.listBatches()).toHaveLength(1)
  })

  it('uses the real clock, sleep and random when none are injected', async () => {
    const { fetchImpl } = fetchReplying({ status: 503, headers: { 'retry-after': '0' } }, { body: { id: 'ok' } })
    const client = createAnthropicClient({ apiKey: 'k', fetch: fetchImpl })
    expect(await client.getModel('a')).toEqual({ id: 'ok' })
  })
})
