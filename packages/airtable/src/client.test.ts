import { describe, expect, it, vi } from 'vitest'
import {
  API_ROOT,
  AirtableApiError,
  LOCKOUT_MS,
  MAX_LIST_PAGES,
  createAirtableClient,
  createRateLimiter,
  retryAfterMs
} from './client'

interface Reply {
  status?: number
  body?: unknown
  text?: string
  headers?: Record<string, string>
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
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === 'string' && { body: init.body })
    })
    const reply = replies[Math.min(index++, replies.length - 1)] ?? {}
    const text = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body))
    return new Response(text, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers }
    })
  }) as unknown as typeof fetch
  return { fetchImpl, sent }
}

// A clock that only moves when something sleeps on it.
function fakeClock(start = 1_000_000) {
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

function clientOver(fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createAirtableClient>[0]> = {}) {
  const clock = fakeClock()
  const client = createAirtableClient({
    apiKey: 'pat.test',
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
  it('reads seconds and HTTP dates, and nothing else', () => {
    const now = Date.parse('2026-09-05T12:00:00.000Z')
    expect(retryAfterMs('7', now)).toBe(7000)
    expect(retryAfterMs(' 0 ', now)).toBe(0)
    expect(retryAfterMs('Sat, 05 Sep 2026 12:00:30 GMT', now)).toBe(30_000)
    expect(retryAfterMs('Sat, 05 Sep 2026 11:00:00 GMT', now)).toBe(0)
    expect(retryAfterMs(null, now)).toBeUndefined()
    expect(retryAfterMs('', now)).toBeUndefined()
    expect(retryAfterMs('soon', now)).toBeUndefined()
  })
})

describe('createRateLimiter', () => {
  it('lets five calls through per second per base and holds the sixth', async () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep })
    for (let index = 0; index < 5; index++) await limiter.acquire('appA')
    await limiter.acquire('appB')
    expect(clock.waits).toEqual([])
    await limiter.acquire('appA')
    expect(clock.waits).toEqual([1000])
    await limiter.acquire('appA')
    expect(clock.waits).toEqual([1000])
  })

  it('spaces the next second by the oldest call rather than the newest', async () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep, perSecond: 2 })
    await limiter.acquire('app')
    await clock.sleep(600)
    await limiter.acquire('app')
    await limiter.acquire('app')
    expect(clock.waits).toEqual([600, 400])
  })

  it('runs on the real clock when given none', async () => {
    const limiter = createRateLimiter()
    await limiter.acquire('app')
  })
})

describe('createAirtableClient', () => {
  it('refuses to start without a token', () => {
    expect(() => createAirtableClient({ apiKey: ' ', fetch })).toThrow('AIRTABLE_API_KEY is required')
  })

  it('sends the bearer token and reads a record', async () => {
    const { fetchImpl, sent } = fetchReplying({ body: { id: 'rec1', createdTime: 't', fields: { Name: 'A' } } })
    const { client } = clientOver(fetchImpl)
    const record = await client.getRecord('appA', 'My Table', 'rec1', { returnFieldsByFieldId: true })
    expect(record.fields).toEqual({ Name: 'A' })
    expect(sent[0]).toMatchObject({
      method: 'GET',
      url: `${API_ROOT}/appA/My%20Table/rec1?returnFieldsByFieldId=true`,
      headers: { Authorization: 'Bearer pat.test' }
    })
    expect(sent[0].headers['Content-Type']).toBeUndefined()
  })

  it('creates, updates, upserts and deletes with JSON bodies stripped of unset keys', async () => {
    const { fetchImpl, sent } = fetchReplying({ body: { id: 'rec1' } })
    const { client } = clientOver(fetchImpl)
    await client.createRecord('appA', 'tbl1', { fields: { Name: 'A' }, typecast: undefined })
    await client.updateRecord('appA', 'tbl1', 'rec1', { fields: { Name: 'B' } })
    await client.upsertRecords('appA', 'tbl1', { performUpsert: { fieldsToMergeOn: ['Name'] }, records: [] })
    await client.deleteRecord('appA', 'tbl1', 'rec1')
    expect(sent.map((entry) => [entry.method, entry.url])).toEqual([
      ['POST', `${API_ROOT}/appA/tbl1`],
      ['PATCH', `${API_ROOT}/appA/tbl1/rec1`],
      ['PATCH', `${API_ROOT}/appA/tbl1`],
      ['DELETE', `${API_ROOT}/appA/tbl1/rec1`]
    ])
    expect(body(sent[0])).toEqual({ fields: { Name: 'A' } })
    expect(sent[0].headers['Content-Type']).toBe('application/json')
    expect(sent[3].body).toBeUndefined()
  })

  it('answers an empty body as an empty object', async () => {
    const { fetchImpl } = fetchReplying({ text: '' })
    const { client } = clientOver(fetchImpl)
    expect(await client.deleteRecord('appA', 'tbl1', 'rec1')).toEqual({})
  })

  it('throws the type and message Airtable gave, with the status', async () => {
    const { fetchImpl } = fetchReplying({
      status: 422,
      body: { error: { type: 'UNKNOWN_FIELD_NAME', message: 'Unknown field name: "Nmae"' } }
    })
    const { client } = clientOver(fetchImpl)
    const failure = await client.getRecord('appA', 'tbl1', 'rec1').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AirtableApiError)
    expect((failure as AirtableApiError).message).toBe('UNKNOWN_FIELD_NAME: Unknown field name: "Nmae"')
    expect((failure as AirtableApiError).status).toBe(422)
    expect((failure as AirtableApiError).type).toBe('UNKNOWN_FIELD_NAME')
  })

  it('reads the bare string form of an error and an object without a message', async () => {
    const asString = clientOver(fetchReplying({ status: 404, body: { error: 'NOT_FOUND' } }).fetchImpl)
    await expect(asString.client.getRecord('appA', 'tbl1', 'rec1')).rejects.toThrow('NOT_FOUND')
    const bare = clientOver(fetchReplying({ status: 403, body: { error: { type: 'INVALID_PERMISSIONS' } } }).fetchImpl)
    await expect(bare.client.getRecord('appA', 'tbl1', 'rec1')).rejects.toThrow('INVALID_PERMISSIONS: Airtable API 403')
  })

  it('quotes a non-JSON failure body, trimmed', async () => {
    const long = 'x'.repeat(400)
    const { fetchImpl } = fetchReplying({ status: 502, text: long })
    const { client } = clientOver(fetchImpl)
    const failure = await client.createRecord('appA', 'tbl1', { fields: {} }).catch((error: Error) => error.message)
    expect(failure).toBe(`Airtable API 502: ${'x'.repeat(300)}…`)
    const empty = clientOver(fetchReplying({ status: 500, text: '' }).fetchImpl)
    await expect(empty.client.createRecord('appA', 'tbl1', { fields: {} })).rejects.toThrow('Airtable API 500')
  })

  it('waits Retry-After on a 429 and sends once more', async () => {
    const { fetchImpl, sent } = fetchReplying(
      { status: 429, body: { error: { type: 'RATE_LIMIT_REACHED', message: 'slow down' } }, headers: { 'retry-after': '3' } },
      { body: { id: 'rec1' } }
    )
    const { client, clock } = clientOver(fetchImpl)
    expect(await client.createRecord('appA', 'tbl1', { fields: {} })).toEqual({ id: 'rec1' })
    expect(sent).toHaveLength(2)
    expect(clock.waits).toEqual([3000])
  })

  it('waits the documented lockout when a 429 names no Retry-After, and gives up on a second', async () => {
    const limited = { status: 429, body: { error: { type: 'RATE_LIMIT_REACHED', message: 'slow down' } } }
    const { fetchImpl, sent } = fetchReplying(limited, limited)
    const { client, clock } = clientOver(fetchImpl)
    await expect(client.getRecord('appA', 'tbl1', 'rec1')).rejects.toThrow('RATE_LIMIT_REACHED: slow down')
    expect(sent).toHaveLength(2)
    expect(clock.waits).toEqual([LOCKOUT_MS])
  })

  it('retries a 5xx once on a read after a jittered wait, and never on a create', async () => {
    const down = { status: 503, body: { error: 'SERVICE_UNAVAILABLE' } }
    const read = clientOver(fetchReplying(down, { body: { id: 'rec1' } }).fetchImpl)
    expect(await read.client.getRecord('appA', 'tbl1', 'rec1')).toEqual({ id: 'rec1' })
    expect(read.clock.waits).toEqual([500])
    const write = clientOver(fetchReplying(down, { body: { id: 'rec1' } }).fetchImpl)
    await expect(write.client.createRecord('appA', 'tbl1', { fields: {} })).rejects.toThrow('SERVICE_UNAVAILABLE')
    expect(write.clock.waits).toEqual([])
  })

  it('spaces record calls on one base through the shared limiter', async () => {
    const { fetchImpl } = fetchReplying({ body: { id: 'rec1' } })
    const { client, clock } = clientOver(fetchImpl)
    for (let index = 0; index < 6; index++) await client.getRecord('appA', 'tbl1', 'rec1')
    expect(clock.waits).toEqual([1000])
  })

  it('runs with the real clock and sleep when none are injected', async () => {
    const { fetchImpl, sent } = fetchReplying(
      { status: 429, body: { error: 'RATE_LIMIT_REACHED' }, headers: { 'retry-after': '0' } },
      { body: { id: 'rec1' } }
    )
    const client = createAirtableClient({ apiKey: 'pat', fetch: fetchImpl })
    expect(await client.getRecord('appA', 'tbl1', 'rec1')).toEqual({ id: 'rec1' })
    expect(sent).toHaveLength(2)
  })

  describe('listRecords', () => {
    it('posts the parameters and walks offset until the pages run out', async () => {
      const { fetchImpl, sent } = fetchReplying(
        { body: { records: [{ id: 'rec1' }], offset: 'itr1/rec1' } },
        { body: { records: [{ id: 'rec2' }] } }
      )
      const { client } = clientOver(fetchImpl)
      const records = await client.listRecords('appA', 'tbl1', { filterByFormula: '{Visited}', view: 'Grid' })
      expect(records.map((record) => record.id)).toEqual(['rec1', 'rec2'])
      expect(sent.map((entry) => [entry.method, entry.url])).toEqual([
        ['POST', `${API_ROOT}/appA/tbl1/listRecords`],
        ['POST', `${API_ROOT}/appA/tbl1/listRecords`]
      ])
      expect(body(sent[0])).toEqual({ filterByFormula: '{Visited}', view: 'Grid', pageSize: 100 })
      expect(body(sent[1])).toEqual({ filterByFormula: '{Visited}', view: 'Grid', pageSize: 100, offset: 'itr1/rec1' })
    })

    it('stops at maxRecords and trims the last page to it', async () => {
      const page = (ids: string[], offset?: string) => ({
        body: { records: ids.map((id) => ({ id })), ...(offset && { offset }) }
      })
      const { fetchImpl, sent } = fetchReplying(page(['a', 'b'], 'o1'), page(['c', 'd'], 'o2'), page(['e']))
      const { client } = clientOver(fetchImpl)
      const records = await client.listRecords('appA', 'tbl1', { maxRecords: 3, pageSize: 2 })
      expect(records.map((record) => record.id)).toEqual(['a', 'b', 'c'])
      expect(sent).toHaveLength(2)
      expect(body(sent[0])).toEqual({ maxRecords: 3, pageSize: 2 })
    })

    it('leaves the rest for another call after the page bound', async () => {
      const { fetchImpl, sent } = fetchReplying({ body: { records: [{ id: 'rec' }], offset: 'more' } })
      const { client } = clientOver(fetchImpl, { sleep: async () => undefined })
      const records = await client.listRecords('appA', 'tbl1', {}, { maxPages: 3 })
      expect(records).toHaveLength(3)
      expect(sent).toHaveLength(3)
      expect(MAX_LIST_PAGES).toBe(10)
    })

    it('reads an empty answer as no records', async () => {
      const { fetchImpl } = fetchReplying({ body: {} })
      const { client } = clientOver(fetchImpl)
      expect(await client.listRecords('appA', 'tbl1', {})).toEqual([])
    })
  })
})
