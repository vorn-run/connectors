export const API_ROOT = 'https://api.airtable.com/v0'

// Airtable's documented maximum for `pageSize`, and its default.
export const MAX_PAGE_SIZE = 100

// Pages one poll or one listRecords call walks before leaving the rest for the next one.
export const MAX_LIST_PAGES = 10

// Records one create or upsert request may carry.
export const MAX_BATCH_RECORDS = 10

// "The API is limited to 5 requests per second per base."
export const RATE_LIMIT_PER_SECOND = 5

// "You will need to wait 30 seconds before subsequent requests will succeed."
export const LOCKOUT_MS = 30_000

const SERVER_ERROR_BACKOFF_MS = 500

const MAX_ERROR_BODY = 300

export type Params = Record<string, unknown>

export interface AirtableRecord {
  id: string
  createdTime: string
  fields: Record<string, unknown>
}

export interface RecordPage {
  records?: AirtableRecord[]
  offset?: string
}

// What Airtable said when a call failed, as `<type>: <message>` with the HTTP status kept alongside.
export class AirtableApiError extends Error {
  readonly status: number
  readonly type: string | undefined
  constructor(status: number, detail: { type?: string; message: string }) {
    super(detail.type ? `${detail.type}: ${detail.message}` : detail.message)
    this.name = 'AirtableApiError'
    this.status = status
    this.type = detail.type
  }
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export interface RateLimiterOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  perSecond?: number
}

// A sliding window per base: the sixth call inside one second waits until the oldest of the five is a second old.
export function createRateLimiter(options: RateLimiterOptions = {}) {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? wait
  const perSecond = options.perSecond ?? RATE_LIMIT_PER_SECOND
  const stamps = new Map<string, number[]>()

  async function acquire(base: string): Promise<void> {
    const recent = stamps.get(base) ?? []
    stamps.set(base, recent)
    for (;;) {
      const at = now()
      while (recent.length > 0 && recent[0] <= at - 1000) recent.shift()
      if (recent.length < perSecond) {
        recent.push(at)
        return
      }
      await sleep(recent[0] + 1000 - at)
    }
  }

  return { acquire }
}

export type RateLimiter = ReturnType<typeof createRateLimiter>

// Retry-After as seconds or an HTTP date, in milliseconds; the docs promise neither, so both are read.
export function retryAfterMs(header: string | null, now: number): number | undefined {
  const trimmed = (header ?? '').trim()
  if (trimmed === '') return undefined
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

async function describeFailure(response: Response): Promise<AirtableApiError> {
  const text = await response.text().catch(() => '')
  try {
    const parsed = JSON.parse(text) as { error?: string | { type?: string; message?: string } }
    if (typeof parsed.error === 'string') {
      return new AirtableApiError(response.status, { message: parsed.error })
    }
    if (parsed.error && typeof parsed.error === 'object') {
      const message = parsed.error.message ?? `Airtable API ${response.status}`
      return new AirtableApiError(response.status, {
        ...(parsed.error.type && { type: parsed.error.type }),
        message
      })
    }
  } catch {
    // Not JSON; the raw text says what it says.
  }
  const quoted = text.length > MAX_ERROR_BODY ? `${text.slice(0, MAX_ERROR_BODY)}…` : text
  return new AirtableApiError(response.status, {
    message: `Airtable API ${response.status}${quoted ? `: ${quoted}` : ''}`
  })
}

function compact(params: Params): Params {
  const out: Params = {}
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value
  }
  return out
}

export interface AirtableClientOptions {
  apiKey: string
  fetch: typeof fetch
  limiter?: RateLimiter
  /** Replaced in tests so a wait costs no real time. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  random?: () => number
}

export interface CallOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  query?: Params
  body?: Params
  /** The base the call counts against; meta calls count against none. */
  base?: string
  /** Whether a 5xx answer may be sent again; a create may have landed, so it is not. */
  idempotent?: boolean
}

export interface ListRecordsParams {
  filterByFormula?: string
  view?: string
  fields?: string[]
  sort?: Array<Record<string, unknown>>
  pageSize?: number
  maxRecords?: number
  returnFieldsByFieldId?: boolean
}

export interface ListOptions {
  maxPages?: number
}

// A client bound to one token, retrying a 429 once after Retry-After or the documented lockout, and a 5xx once on a read.
export function createAirtableClient(options: AirtableClientOptions) {
  const apiKey = options.apiKey.trim()
  if (!apiKey) throw new Error('AIRTABLE_API_KEY is required')
  const limiter = options.limiter ?? createRateLimiter(options)
  const sleep = options.sleep ?? wait
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random

  async function call<T>(path: string, callOptions: CallOptions = {}): Promise<T> {
    const method = callOptions.method ?? 'GET'
    const url = new URL(`${API_ROOT}/${path}`)
    for (const [key, value] of Object.entries(compact(callOptions.query ?? {}))) {
      url.searchParams.set(key, String(value))
    }
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(callOptions.body !== undefined && { 'Content-Type': 'application/json' })
      },
      ...(callOptions.body !== undefined && { body: JSON.stringify(compact(callOptions.body)) })
    }
    for (let attempt = 0; ; attempt++) {
      if (callOptions.base !== undefined) await limiter.acquire(callOptions.base)
      const response = await options.fetch(url.toString(), init)
      if (attempt === 0 && response.status === 429) {
        await sleep(retryAfterMs(response.headers.get('retry-after'), now()) ?? LOCKOUT_MS)
        continue
      }
      if (attempt === 0 && response.status >= 500 && callOptions.idempotent === true) {
        await sleep(SERVER_ERROR_BACKOFF_MS * (0.5 + random()))
        continue
      }
      if (!response.ok) throw await describeFailure(response)
      const text = await response.text()
      return (text === '' ? {} : JSON.parse(text)) as T
    }
  }

  const recordPath = (baseId: string, table: string, recordId?: string) =>
    [baseId, table, recordId]
      .filter((segment): segment is string => segment !== undefined)
      .map(encodeURIComponent)
      .join('/')

  function getRecord(baseId: string, table: string, recordId: string, query: Params = {}) {
    return call<AirtableRecord>(recordPath(baseId, table, recordId), {
      query,
      base: baseId,
      idempotent: true
    })
  }

  function createRecord(baseId: string, table: string, body: Params) {
    return call<AirtableRecord>(recordPath(baseId, table), { method: 'POST', body, base: baseId })
  }

  function updateRecord(baseId: string, table: string, recordId: string, body: Params) {
    return call<AirtableRecord>(recordPath(baseId, table, recordId), {
      method: 'PATCH',
      body,
      base: baseId,
      idempotent: true
    })
  }

  function upsertRecords(baseId: string, table: string, body: Params) {
    return call<{ records?: AirtableRecord[]; createdRecords?: string[]; updatedRecords?: string[] }>(
      recordPath(baseId, table),
      { method: 'PATCH', body, base: baseId }
    )
  }

  function deleteRecord(baseId: string, table: string, recordId: string) {
    return call<{ id?: string; deleted?: boolean }>(recordPath(baseId, table, recordId), {
      method: 'DELETE',
      base: baseId,
      idempotent: true
    })
  }

  // Always the POST form: a formula in a query string can pass the 16,000 character URL limit, and a JSON body cannot.
  async function listRecords(
    baseId: string,
    table: string,
    params: ListRecordsParams,
    listOptions: ListOptions = {}
  ): Promise<AirtableRecord[]> {
    const maxPages = listOptions.maxPages ?? MAX_LIST_PAGES
    const wanted = params.maxRecords
    const collected: AirtableRecord[] = []
    let offset: string | undefined
    for (let index = 0; index < maxPages; index++) {
      const page = await call<RecordPage>(`${recordPath(baseId, table)}/listRecords`, {
        method: 'POST',
        body: { ...params, pageSize: params.pageSize ?? MAX_PAGE_SIZE, offset },
        base: baseId,
        idempotent: true
      })
      collected.push(...(page.records ?? []))
      if (!page.offset || (wanted !== undefined && collected.length >= wanted)) break
      offset = page.offset
    }
    return wanted === undefined ? collected : collected.slice(0, wanted)
  }

  return { call, getRecord, createRecord, updateRecord, upsertRecords, deleteRecord, listRecords }
}

export type AirtableClient = ReturnType<typeof createAirtableClient>
