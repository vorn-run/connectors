export const API_ROOT = 'https://api.anthropic.com/v1'

// "You must send an anthropic-version request header"; 2023-06-01 is the newest listed version.
export const ANTHROPIC_VERSION = '2023-06-01'

// Both lists take `limit` from 1 to 1000; 100 keeps a page small enough to answer quickly.
export const PAGE_LIMIT = 100

// Pages one poll or one list call walks before leaving the rest for the next one.
export const MAX_LIST_PAGES = 10

// The longest a retry-after or a reset header is honoured for, so a step never hangs on a bad header.
export const MAX_WAIT_MS = 60_000

const SERVER_ERROR_BACKOFF_MS = 1000

const MAX_ERROR_BODY = 300

export type Params = Record<string, unknown>

export interface AnthropicModel {
  id: string
  type?: string
  display_name?: string
  created_at?: string
  max_input_tokens?: number
  max_tokens?: number
  capabilities?: Record<string, unknown>
}

export interface RequestCounts {
  processing?: number
  succeeded?: number
  errored?: number
  canceled?: number
  expired?: number
}

export interface MessageBatch {
  id: string
  type?: string
  processing_status?: string
  request_counts?: RequestCounts
  created_at?: string
  ended_at?: string | null
  expires_at?: string
  archived_at?: string | null
  cancel_initiated_at?: string | null
  results_url?: string | null
}

export interface Page<T> {
  data?: T[]
  has_more?: boolean
  first_id?: string | null
  last_id?: string | null
}

export interface BatchResult {
  custom_id?: string
  result?: Record<string, unknown>
}

// What the API said when a call failed, as `<error.type>: <error.message>` with the status and request id kept alongside.
export class AnthropicApiError extends Error {
  readonly status: number
  readonly type: string | undefined
  readonly requestId: string | undefined
  constructor(status: number, detail: { type?: string; message: string; requestId?: string }) {
    const head = detail.type ? `${detail.type}: ${detail.message}` : detail.message
    super(detail.requestId ? `${head} (HTTP ${status}, request ${detail.requestId})` : `${head} (HTTP ${status})`)
    this.name = 'AnthropicApiError'
    this.status = status
    this.type = detail.type
    this.requestId = detail.requestId
  }
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

// retry-after as seconds or an HTTP date, in milliseconds, capped so a bad header cannot park a step.
export function retryAfterMs(header: string | null, now: number): number | undefined {
  const trimmed = (header ?? '').trim()
  if (trimmed === '') return undefined
  const seconds = Number(trimmed)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(trimmed) - now
  return Number.isNaN(ms) ? undefined : Math.min(MAX_WAIT_MS, Math.max(0, ms))
}

export interface RateGateOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

// Remembers a reply that said no requests remain, so the next call waits for the reset rather than tripping a 429.
export function createRateGate(options: RateGateOptions = {}) {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? wait
  let resetAt: number | undefined

  async function acquire(): Promise<void> {
    if (resetAt === undefined) return
    const delay = Math.min(MAX_WAIT_MS, resetAt - now())
    resetAt = undefined
    if (delay > 0) await sleep(delay)
  }

  function observe(headers: Headers): void {
    const remaining = headers.get('anthropic-ratelimit-requests-remaining')
    const reset = headers.get('anthropic-ratelimit-requests-reset')
    if (remaining === null || Number(remaining) > 0 || reset === null) return
    const at = Date.parse(reset)
    if (!Number.isNaN(at)) resetAt = at
  }

  return { acquire, observe }
}

export type RateGate = ReturnType<typeof createRateGate>

async function describeFailure(response: Response): Promise<AnthropicApiError> {
  const requestId = response.headers.get('request-id') ?? undefined
  const text = await response.text().catch(() => '')
  try {
    const parsed = JSON.parse(text) as { error?: { type?: string; message?: string }; request_id?: string }
    if (parsed.error && typeof parsed.error === 'object') {
      return new AnthropicApiError(response.status, {
        ...(parsed.error.type && { type: parsed.error.type }),
        message: parsed.error.message ?? `Anthropic API ${response.status}`,
        requestId: parsed.request_id ?? requestId
      })
    }
  } catch {
    // Not JSON; the raw text says what it says.
  }
  const quoted = text.length > MAX_ERROR_BODY ? `${text.slice(0, MAX_ERROR_BODY)}…` : text
  return new AnthropicApiError(response.status, {
    message: `Anthropic API ${response.status}${quoted ? `: ${quoted}` : ''}`,
    requestId
  })
}

function compact(params: Params): Params {
  const out: Params = {}
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value
  }
  return out
}

// The batch results endpoint streams one JSON object per line; blank lines are skipped.
export function parseJsonl(text: string): BatchResult[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line) as BatchResult
      } catch {
        throw new Error(`Batch results line ${index + 1} is not JSON`)
      }
    })
}

export interface AnthropicClientOptions {
  apiKey: string
  fetch: typeof fetch
  gate?: RateGate
  /** Replaced in tests so a wait costs no real time. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  random?: () => number
}

export interface CallOptions {
  method?: 'GET' | 'POST'
  query?: Params
  body?: Params
  /** Read the body as text rather than JSON, for the JSONL results stream. */
  text?: boolean
}

export interface ListOptions<T> {
  maxPages?: number
  /** Stops the walk once a page holds an entry this says is past the window. */
  until?: (entry: T) => boolean
}

// A client bound to one key, retrying a 429 once after retry-after and a 529 or 5xx once after a short wait.
export function createAnthropicClient(options: AnthropicClientOptions) {
  const apiKey = options.apiKey.trim()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required')
  const gate = options.gate ?? createRateGate(options)
  const sleep = options.sleep ?? wait
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random

  async function call<T>(path: string, callOptions: CallOptions = {}): Promise<T> {
    const url = new URL(`${API_ROOT}/${path}`)
    for (const [key, value] of Object.entries(compact(callOptions.query ?? {}))) {
      url.searchParams.set(key, String(value))
    }
    const init: RequestInit = {
      method: callOptions.method ?? 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        ...(callOptions.body !== undefined && { 'content-type': 'application/json' })
      },
      ...(callOptions.body !== undefined && { body: JSON.stringify(compact(callOptions.body)) })
    }
    for (let attempt = 0; ; attempt++) {
      await gate.acquire()
      const response = await options.fetch(url.toString(), init)
      gate.observe(response.headers)
      const retryAfter = retryAfterMs(response.headers.get('retry-after'), now())
      // A 429 without retry-after is the spend cap, which no wait will lift.
      if (attempt === 0 && response.status === 429 && retryAfter !== undefined) {
        await sleep(retryAfter)
        continue
      }
      if (attempt === 0 && response.status >= 500) {
        await sleep(retryAfter ?? SERVER_ERROR_BACKOFF_MS * (1 + random()))
        continue
      }
      if (!response.ok) throw await describeFailure(response)
      const text = await response.text()
      if (callOptions.text) return text as T
      return (text === '' ? {} : JSON.parse(text)) as T
    }
  }

  // Walks `after_id` pages while `has_more`, newest first as both lists come, until the window or the page cap is met.
  async function list<T>(path: string, listOptions: ListOptions<T> = {}) {
    const maxPages = listOptions.maxPages ?? MAX_LIST_PAGES
    const collected: T[] = []
    let afterId: string | undefined
    for (let index = 0; index < maxPages; index++) {
      const page = await call<Page<T>>(path, { query: { limit: PAGE_LIMIT, after_id: afterId } })
      const entries = page.data ?? []
      collected.push(...entries)
      if (listOptions.until && entries.some(listOptions.until)) break
      if (!page.has_more || !page.last_id) break
      afterId = page.last_id
    }
    return collected
  }

  const encoded = (id: string) => encodeURIComponent(id)

  const createMessage = (body: Params) => call<Params>('messages', { method: 'POST', body })
  const countTokens = (body: Params) => call<{ input_tokens?: number }>('messages/count_tokens', { method: 'POST', body })
  const listModels = (listOptions?: ListOptions<AnthropicModel>) =>
    list<AnthropicModel>('models', listOptions)
  const getModel = (id: string) => call<AnthropicModel>(`models/${encoded(id)}`)
  const createBatch = (requests: unknown[]) =>
    call<MessageBatch>('messages/batches', { method: 'POST', body: { requests } })
  const listBatches = (listOptions?: ListOptions<MessageBatch>) =>
    list<MessageBatch>('messages/batches', listOptions)
  const getBatch = (id: string) => call<MessageBatch>(`messages/batches/${encoded(id)}`)
  const getBatchResults = async (id: string) =>
    parseJsonl(await call<string>(`messages/batches/${encoded(id)}/results`, { text: true }))
  const cancelBatch = (id: string) => call<MessageBatch>(`messages/batches/${encoded(id)}/cancel`, { method: 'POST' })

  return {
    call,
    list,
    createMessage,
    countTokens,
    listModels,
    getModel,
    createBatch,
    listBatches,
    getBatch,
    getBatchResults,
    cancelBatch
  }
}

export type AnthropicClient = ReturnType<typeof createAnthropicClient>
