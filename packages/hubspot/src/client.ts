export const API_ROOT = 'https://api.hubapi.com'

// The three path prefixes the connector sends, held once each so a move to HubSpot's dated versions is one edit.
export const OBJECTS_PATH = '/crm/v3/objects'
export const CRM_PATH = '/crm/v3'
export const ASSOCIATIONS_PATH = '/crm/v4/objects'

// The search API's documented maximum for `limit`.
export const MAX_SEARCH_LIMIT = 200

// Pages one poll or one search walks before leaving the rest for the next call.
export const MAX_SEARCH_PAGES = 10

// What a 429 without Retry-After waits, and the most any Retry-After is honoured for.
export const RATE_LIMIT_RETRY_MS = 1_000
export const MAX_RETRY_AFTER_MS = 30_000

// "The window of time that the X-HubSpot-RateLimit-Max ... headers apply to", when the header is missing.
export const DEFAULT_RATE_LIMIT_INTERVAL_MS = 10_000

const SERVER_ERROR_BACKOFF_MS = 500

const MAX_ERROR_BODY = 300

export type Params = Record<string, unknown>

export interface CrmRecord {
  id: string
  properties: Record<string, string | null>
  createdAt?: string
  updatedAt?: string
  archived?: boolean
}

export interface SearchPage {
  total?: number
  results?: CrmRecord[]
  paging?: { next?: { after?: string; link?: string } }
}

export interface SearchBody {
  query?: string
  filterGroups?: unknown[]
  sorts?: Array<{ propertyName: string; direction: 'ASCENDING' | 'DESCENDING' }>
  properties?: string[]
  limit?: number
  after?: string
}

export interface ErrorBody {
  status?: string
  message?: string
  category?: string
  correlationId?: string
  errorType?: string
  policyName?: string
}

// What HubSpot said when a call failed, as `<category>: <message> (<correlationId>)` with the HTTP status kept alongside.
export class HubSpotApiError extends Error {
  readonly status: number
  readonly category: string | undefined
  readonly correlationId: string | undefined
  readonly policyName: string | undefined
  constructor(status: number, detail: ErrorBody & { message: string }) {
    const suffix = [detail.errorType, detail.policyName].filter(Boolean).join(' ')
    super(
      `${detail.category ? `${detail.category}: ` : ''}${detail.message}` +
        `${detail.correlationId ? ` (${detail.correlationId})` : ''}${suffix ? ` [${suffix}]` : ''}`
    )
    this.name = 'HubSpotApiError'
    this.status = status
    this.category = detail.category
    this.correlationId = detail.correlationId
    this.policyName = detail.policyName
  }
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

// Retry-After is documented as milliseconds; an HTTP date is read too, in case a gateway sends one.
export function retryAfterMs(header: string | null, now: number): number | undefined {
  const trimmed = (header ?? '').trim()
  if (trimmed === '') return undefined
  const millis = Number(trimmed)
  if (Number.isFinite(millis)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, millis))
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? undefined : Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - now))
}

async function readError(response: Response): Promise<ErrorBody & { text: string }> {
  const text = await response.text().catch(() => '')
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed === 'object' && parsed !== null) return { ...(parsed as ErrorBody), text }
  } catch {
    // Not JSON; the raw text says what it says.
  }
  return { text }
}

function describeFailure(status: number, body: ErrorBody & { text: string }): HubSpotApiError {
  const quoted = body.text.length > MAX_ERROR_BODY ? `${body.text.slice(0, MAX_ERROR_BODY)}…` : body.text
  const message = body.message ?? `HubSpot API ${status}${quoted ? `: ${quoted}` : ''}`
  return new HubSpotApiError(status, { ...body, message })
}

function compact(params: Params): Params {
  const out: Params = {}
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value
  }
  return out
}

export interface HubSpotClientOptions {
  accessToken: string
  fetch: typeof fetch
  /** Replaced in tests so a wait costs no real time. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  random?: () => number
}

export interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: Params
  body?: unknown
  /** Whether a 5xx answer may be sent again; a create may have landed, so it is not. */
  idempotent?: boolean
}

export interface SearchOptions {
  maxPages?: number
}

// A client bound to one token: waits out a spent window, retries a 429 once after Retry-After, and a 5xx once on a safe call.
export function createHubSpotClient(options: HubSpotClientOptions) {
  const accessToken = options.accessToken.trim()
  if (!accessToken) throw new Error('HUBSPOT_ACCESS_TOKEN is required')
  const sleep = options.sleep ?? wait
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  let windowResetsAt = 0

  // "X-HubSpot-RateLimit-Remaining" at 0 means the window is spent; the next call waits for it to turn over.
  function noteRateLimit(response: Response): void {
    const remaining = response.headers.get('x-hubspot-ratelimit-remaining')
    if (remaining === null || Number(remaining) > 0) return
    const interval = Number(response.headers.get('x-hubspot-ratelimit-interval-milliseconds'))
    windowResetsAt = now() + (Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_RATE_LIMIT_INTERVAL_MS)
  }

  async function call<T>(path: string, callOptions: CallOptions = {}): Promise<T> {
    const method = callOptions.method ?? 'GET'
    const url = new URL(`${API_ROOT}${path}`)
    for (const [key, value] of Object.entries(compact(callOptions.query ?? {}))) {
      url.searchParams.set(key, String(value))
    }
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(callOptions.body !== undefined && { 'Content-Type': 'application/json' })
      },
      ...(callOptions.body !== undefined && { body: JSON.stringify(callOptions.body) })
    }
    for (let attempt = 0; ; attempt++) {
      const pending = windowResetsAt - now()
      if (pending > 0) await sleep(pending)
      const response = await options.fetch(url.toString(), init)
      noteRateLimit(response)
      if (response.status === 429) {
        const body = await readError(response)
        // A spent daily allowance does not come back in a second.
        if (attempt === 0 && body.policyName !== 'DAILY') {
          await sleep(retryAfterMs(response.headers.get('retry-after'), now()) ?? RATE_LIMIT_RETRY_MS)
          continue
        }
        throw describeFailure(response.status, body)
      }
      if (attempt === 0 && response.status >= 500 && callOptions.idempotent === true) {
        await sleep(SERVER_ERROR_BACKOFF_MS * (0.5 + random()))
        continue
      }
      if (!response.ok) throw describeFailure(response.status, await readError(response))
      const text = await response.text()
      return (text === '' ? {} : JSON.parse(text)) as T
    }
  }

  const objectPath = (objectType: string, id?: string) =>
    `${OBJECTS_PATH}/${[objectType, id]
      .filter((segment): segment is string => segment !== undefined)
      .map(encodeURIComponent)
      .join('/')}`

  function getObject(objectType: string, id: string, query: Params = {}) {
    return call<CrmRecord>(objectPath(objectType, id), { query, idempotent: true })
  }

  function createObject(objectType: string, body: Params) {
    return call<CrmRecord>(objectPath(objectType), { method: 'POST', body })
  }

  function updateObject(objectType: string, id: string, body: Params) {
    return call<CrmRecord>(objectPath(objectType, id), { method: 'PATCH', body, idempotent: true })
  }

  // One page of a search; the caller passes `after` back for the next.
  function searchPage(objectType: string, body: SearchBody) {
    return call<SearchPage>(`${objectPath(objectType)}/search`, {
      method: 'POST',
      body: compact(body as Params),
      idempotent: true
    })
  }

  // Every page of a search up to the bound, oldest first as the sort says.
  async function search(objectType: string, body: SearchBody, searchOptions: SearchOptions = {}): Promise<CrmRecord[]> {
    const maxPages = searchOptions.maxPages ?? MAX_SEARCH_PAGES
    const collected: CrmRecord[] = []
    let after: string | undefined
    for (let index = 0; index < maxPages; index++) {
      const page = await searchPage(objectType, { ...body, after })
      collected.push(...(page.results ?? []))
      after = page.paging?.next?.after
      if (!after) break
    }
    return collected
  }

  function associate(from: { type: string; id: string }, to: { type: string; id: string }, typeId?: number) {
    const base = `${ASSOCIATIONS_PATH}/${encodeURIComponent(from.type)}/${encodeURIComponent(from.id)}/associations`
    const target = `${encodeURIComponent(to.type)}/${encodeURIComponent(to.id)}`
    return typeId === undefined
      ? call<Params>(`${base}/default/${target}`, { method: 'PUT', idempotent: true })
      : call<Params>(`${base}/${target}`, {
          method: 'PUT',
          body: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }],
          idempotent: true
        })
  }

  return { call, getObject, createObject, updateObject, searchPage, search, associate }
}

export type HubSpotClient = ReturnType<typeof createHubSpotClient>
