import { describe, expect, it, vi } from 'vitest'
import {
  API_ROOT,
  DEFAULT_RATE_LIMIT_INTERVAL_MS,
  HubSpotApiError,
  MAX_RETRY_AFTER_MS,
  MAX_SEARCH_PAGES,
  RATE_LIMIT_RETRY_MS,
  createHubSpotClient,
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

function clientOver(fetchImpl: typeof fetch) {
  const clock = fakeClock()
  const client = createHubSpotClient({
    accessToken: 'pat-test',
    fetch: fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0.5
  })
  return { client, clock }
}

const body = (entry: Sent) => JSON.parse(entry.body ?? '{}') as Record<string, unknown>

const record = { id: '1', properties: { email: 'a@b.c' }, createdAt: 't', updatedAt: 't', archived: false }

describe('retryAfterMs', () => {
  it('reads milliseconds and HTTP dates, capped at thirty seconds', () => {
    const now = Date.parse('2026-09-05T12:00:00.000Z')
    expect(retryAfterMs('700', now)).toBe(700)
    expect(retryAfterMs(' 0 ', now)).toBe(0)
    expect(retryAfterMs('90000', now)).toBe(MAX_RETRY_AFTER_MS)
    expect(retryAfterMs('Sat, 05 Sep 2026 12:00:05 GMT', now)).toBe(5000)
    expect(retryAfterMs('Sat, 05 Sep 2026 11:00:00 GMT', now)).toBe(0)
    expect(retryAfterMs('soon', now)).toBeUndefined()
    expect(retryAfterMs(null, now)).toBeUndefined()
    expect(retryAfterMs('  ', now)).toBeUndefined()
  })
})

describe('createHubSpotClient', () => {
  it('needs a token', () => {
    expect(() => createHubSpotClient({ accessToken: ' ', fetch })).toThrow('HUBSPOT_ACCESS_TOKEN is required')
  })

  it('sends the bearer token and a JSON body, and encodes path segments', async () => {
    const { fetchImpl, sent } = fetchReplying({ body: record })
    const { client } = clientOver(fetchImpl)
    expect(await client.createObject('contacts', { properties: { email: 'a@b.c' } })).toEqual(record)
    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: `${API_ROOT}/crm/v3/objects/contacts`,
      headers: { Authorization: 'Bearer pat-test', 'Content-Type': 'application/json' }
    })
    expect(body(sent[0])).toEqual({ properties: { email: 'a@b.c' } })
    await client.getObject('contacts', 'a@b.c', { idProperty: 'email', properties: 'email,phone', empty: '' })
    expect(sent[1]).toMatchObject({ method: 'GET', url: `${API_ROOT}/crm/v3/objects/contacts/a%40b.c?idProperty=email&properties=email%2Cphone` })
    expect(sent[1].headers).not.toHaveProperty('Content-Type')
    await client.updateObject('deals', '1/2', { properties: {} })
    expect(sent[2]).toMatchObject({ method: 'PATCH', url: `${API_ROOT}/crm/v3/objects/deals/1%2F2` })
  })

  it('reads an empty answer as an empty object', async () => {
    const { fetchImpl } = fetchReplying({ text: '' })
    const { client } = clientOver(fetchImpl)
    expect(await client.call('/crm/v3/owners')).toEqual({})
  })

  it('throws category, message and correlation id on a failed call', async () => {
    const { fetchImpl } = fetchReplying({
      status: 409,
      body: { status: 'error', message: 'Contact already exists. Existing ID: 33451', category: 'CONFLICT', correlationId: 'abc' }
    })
    const { client } = clientOver(fetchImpl)
    const failure = await client.createObject('contacts', {}).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HubSpotApiError)
    expect(failure).toMatchObject({
      status: 409,
      category: 'CONFLICT',
      correlationId: 'abc',
      message: 'CONFLICT: Contact already exists. Existing ID: 33451 (abc)'
    })
  })

  it('quotes a body that is not JSON, and a JSON one without a message', async () => {
    const { fetchImpl } = fetchReplying({ status: 502, text: '<html>bad gateway</html>' })
    const { client } = clientOver(fetchImpl)
    await expect(client.createObject('contacts', {})).rejects.toThrow('HubSpot API 502: <html>bad gateway</html>')
    const long = fetchReplying({ status: 400, text: 'x'.repeat(400) })
    await expect(clientOver(long.fetchImpl).client.createObject('contacts', {})).rejects.toThrow(/^HubSpot API 400: x{300}…$/)
    const bare = fetchReplying({ status: 404, body: { category: 'OBJECT_NOT_FOUND' } })
    await expect(clientOver(bare.fetchImpl).client.createObject('contacts', {})).rejects.toThrow('OBJECT_NOT_FOUND: HubSpot API 404: {"category":"OBJECT_NOT_FOUND"}')
    const empty = fetchReplying({ status: 401, text: '' })
    await expect(clientOver(empty.fetchImpl).client.createObject('contacts', {})).rejects.toThrow('HubSpot API 401')
  })

  it('retries a 429 once after Retry-After milliseconds, then throws with the policy', async () => {
    const limited = {
      status: 429,
      headers: { 'retry-after': '1500' },
      body: { status: 'error', message: 'You have reached your secondly limit.', category: 'RATE_LIMITS', errorType: 'RATE_LIMIT', policyName: 'SECONDLY', correlationId: 'c1' }
    }
    const { fetchImpl, sent } = fetchReplying(limited, { body: record })
    const { client, clock } = clientOver(fetchImpl)
    expect(await client.getObject('contacts', '1')).toEqual(record)
    expect(sent).toHaveLength(2)
    expect(clock.waits).toEqual([1500])

    const twice = fetchReplying(limited, limited)
    const again = clientOver(twice.fetchImpl)
    await expect(again.client.getObject('contacts', '1')).rejects.toThrow(
      'RATE_LIMITS: You have reached your secondly limit. (c1) [RATE_LIMIT SECONDLY]'
    )
    expect(twice.sent).toHaveLength(2)
  })

  it('waits one second on a 429 without Retry-After', async () => {
    const { fetchImpl } = fetchReplying({ status: 429, body: { message: 'slow down' } }, { body: record })
    const { client, clock } = clientOver(fetchImpl)
    await client.getObject('contacts', '1')
    expect(clock.waits).toEqual([RATE_LIMIT_RETRY_MS])
  })

  it('does not retry a spent daily allowance', async () => {
    const { fetchImpl, sent } = fetchReplying({
      status: 429,
      body: { message: 'You have reached your daily limit.', category: 'RATE_LIMITS', policyName: 'DAILY' }
    })
    const { client, clock } = clientOver(fetchImpl)
    await expect(client.getObject('contacts', '1')).rejects.toThrow('RATE_LIMITS: You have reached your daily limit. [DAILY]')
    expect(sent).toHaveLength(1)
    expect(clock.waits).toEqual([])
  })

  it('waits out a spent window before the next call', async () => {
    const { fetchImpl, sent } = fetchReplying(
      { body: record, headers: { 'x-hubspot-ratelimit-remaining': '0', 'x-hubspot-ratelimit-interval-milliseconds': '10000' } },
      { body: record }
    )
    const { client, clock } = clientOver(fetchImpl)
    await client.getObject('contacts', '1')
    expect(clock.waits).toEqual([])
    await client.getObject('contacts', '2')
    expect(clock.waits).toEqual([10000])
    expect(sent).toHaveLength(2)
  })

  it('assumes the documented window when the interval header is missing, and ignores a window with room', async () => {
    const { fetchImpl } = fetchReplying(
      { body: record, headers: { 'x-hubspot-ratelimit-remaining': '3' } },
      { body: record, headers: { 'x-hubspot-ratelimit-remaining': '0' } },
      { body: record }
    )
    const { client, clock } = clientOver(fetchImpl)
    await client.getObject('contacts', '1')
    await client.getObject('contacts', '2')
    expect(clock.waits).toEqual([])
    await client.getObject('contacts', '3')
    expect(clock.waits).toEqual([DEFAULT_RATE_LIMIT_INTERVAL_MS])
  })

  it('retries a 5xx once on a safe call and never on a create', async () => {
    const { fetchImpl, sent } = fetchReplying({ status: 503, body: { message: 'down' } }, { body: record })
    const { client, clock } = clientOver(fetchImpl)
    expect(await client.getObject('contacts', '1')).toEqual(record)
    expect(sent).toHaveLength(2)
    expect(clock.waits).toEqual([500])

    const create = fetchReplying({ status: 503, body: { message: 'down' } }, { body: record })
    await expect(clientOver(create.fetchImpl).client.createObject('contacts', {})).rejects.toThrow('down')
    expect(create.sent).toHaveLength(1)

    const stillDown = fetchReplying({ status: 503, body: { message: 'down' } })
    await expect(clientOver(stillDown.fetchImpl).client.getObject('contacts', '1')).rejects.toThrow('down')
    expect(stillDown.sent).toHaveLength(2)
  })

  it('searches one page with the blanks dropped, and walks pages up to the bound', async () => {
    const { fetchImpl, sent } = fetchReplying({ body: { total: 1, results: [record] } })
    const { client } = clientOver(fetchImpl)
    const page = await client.searchPage('contacts', { query: 'test', limit: 5, after: undefined, filterGroups: undefined })
    expect(page).toEqual({ total: 1, results: [record] })
    expect(sent[0]).toMatchObject({ method: 'POST', url: `${API_ROOT}/crm/v3/objects/contacts/search` })
    expect(body(sent[0])).toEqual({ query: 'test', limit: 5 })

    const pages = fetchReplying(
      { body: { results: [record], paging: { next: { after: '1' } } } },
      { body: { results: [{ ...record, id: '2' }], paging: { next: { after: '2' } } } },
      { body: { results: [{ ...record, id: '3' }] } }
    )
    const walker = clientOver(pages.fetchImpl)
    const records = await walker.client.search('deals', { limit: 100 })
    expect(records.map((entry) => entry.id)).toEqual(['1', '2', '3'])
    expect(pages.sent.map((entry) => body(entry).after)).toEqual([undefined, '1', '2'])

    const endless = fetchReplying({ body: { results: [record], paging: { next: { after: '9' } } } })
    const bounded = await clientOver(endless.fetchImpl).client.search('deals', {})
    expect(bounded).toHaveLength(MAX_SEARCH_PAGES)
    const empty = fetchReplying({ body: {} })
    expect(await clientOver(empty.fetchImpl).client.search('deals', {}, { maxPages: 2 })).toEqual([])
  })

  it('associates with the default label or a typed one', async () => {
    const answer = { fromObjectTypeId: '0-1', fromObjectId: 1, toObjectTypeId: '0-2', toObjectId: 2, labels: [] }
    const { fetchImpl, sent } = fetchReplying({ body: answer })
    const { client } = clientOver(fetchImpl)
    expect(await client.associate({ type: 'contact', id: '1' }, { type: 'company', id: '2' })).toEqual(answer)
    expect(sent[0]).toMatchObject({ method: 'PUT', url: `${API_ROOT}/crm/v4/objects/contact/1/associations/default/company/2` })
    expect(sent[0].body).toBeUndefined()
    await client.associate({ type: 'contact', id: '1' }, { type: 'company', id: '2' }, 1)
    expect(sent[1]).toMatchObject({ method: 'PUT', url: `${API_ROOT}/crm/v4/objects/contact/1/associations/company/2` })
    expect(JSON.parse(sent[1].body ?? '')).toEqual([{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 1 }])
  })

  it('uses the real clock and a real wait when none are given', async () => {
    const { fetchImpl } = fetchReplying({ status: 429, headers: { 'retry-after': '1' }, body: {} }, { body: record })
    const client = createHubSpotClient({ accessToken: 'pat-test', fetch: fetchImpl })
    expect(await client.getObject('contacts', '1')).toEqual(record)
  })
})
