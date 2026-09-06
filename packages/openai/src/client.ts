export const API_ROOT = 'https://api.openai.com/v1'

// A 429 the docs say to wait out; anything else under 429 needs a person (quota, billing, spend limits).
const RETRYABLE_429_CODES = new Set(['rate_limit_error', 'rate_limit_exceeded', 'slow_down', 'server_is_overloaded'])

const RETRYABLE_SERVER_STATUS = new Set([500, 502, 503, 504])

export const DEFAULT_RATE_LIMIT_WAIT_MS = 2_000

export const DEFAULT_SERVER_ERROR_WAIT_MS = 1_000

export const MAX_JITTER_MS = 500

// Longest a call sleeps because the previous answer said the request budget was spent.
export const MAX_PREEMPTIVE_WAIT_MS = 10_000

const MAX_ERROR_BODY = 300

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type Sleep = (ms: number) => Promise<void>

export type Warn = (message: string) => void

/* ---------------------------------------------------------------- key -- */

export const KEY_HINT =
  'Create one at https://platform.openai.com/api-keys (Create new secret key) and set OPENAI_API_KEY on the connection.'

// Trimmed: a copied key often arrives with a trailing space or newline, which the API reports as invalid_api_key.
export function normalizeKey(raw: unknown): string {
  const key = String(raw ?? '').trim()
  if (key === '') throw new Error(`OPENAI_API_KEY is required. ${KEY_HINT}`)
  return key
}

/* ----------------------------------------------------------- durations -- */

const DURATION_PART = /(\d+(?:\.\d+)?)(ms|h|m|s)/g

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }

/** Milliseconds in a Go-style duration such as `1s`, `6m0s` or `120ms`, as the reset headers carry. */
export function durationMs(value: string | null | undefined): number | undefined {
  const text = String(value ?? '').trim()
  if (text === '') return undefined
  let total = 0
  let matched = ''
  for (const part of text.matchAll(DURATION_PART)) {
    total += Number(part[1]) * UNIT_MS[part[2]!]!
    matched += part[0]
  }
  return matched === text ? total : undefined
}

function seconds(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/* ------------------------------------------------------------- errors -- */

export interface OpenAIErrorBody {
  error?: { message?: string; type?: string; code?: string | null; param?: string | null }
}

export class OpenAIApiError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly type: string | undefined
  readonly param: string | undefined
  readonly requestId: string | undefined
  constructor(status: number, body: unknown, requestId?: string) {
    super(describeFailure(status, body, requestId))
    this.name = 'OpenAIApiError'
    const error = errorOf(body)
    this.status = status
    this.code = error.code ?? undefined
    this.type = error.type
    this.param = error.param ?? undefined
    this.requestId = requestId
  }
}

function errorOf(body: unknown): NonNullable<OpenAIErrorBody['error']> {
  const error = (body as OpenAIErrorBody | undefined)?.error
  return typeof error === 'object' && error !== null ? error : {}
}

// `<status> <code>: <message>`, with `type` standing in when the body names no code.
export function describeFailure(status: number, body: unknown, requestId?: string): string {
  const error = errorOf(body)
  const label = error.code ?? error.type
  let message = typeof error.message === 'string' ? error.message.trim() : ''
  if (message === '') {
    const raw = typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body)
    message = raw.length > MAX_ERROR_BODY ? `${raw.slice(0, MAX_ERROR_BODY)}…` : raw
  }
  const head = label ? `${status} ${label}` : String(status)
  const tail = requestId ? ` (request ${requestId})` : ''
  return `${head}: ${message || 'no body'}${tail}`
}

/* ------------------------------------------------------------- client -- */

export interface RequestOptions {
  query?: Record<string, string | number | undefined>
  body?: unknown
}

export interface OpenAIClient {
  request<T = unknown>(method: string, path: string, options?: RequestOptions): Promise<T>
  get<T = unknown>(path: string, query?: RequestOptions['query']): Promise<T>
}

export interface OpenAIClientOptions {
  apiKey: string
  organization?: string
  project?: string
  /** Injected in tests, so nothing reaches the network. */
  fetchImpl?: FetchLike
  /** Injected in tests, so no test spends real time asleep. */
  sleep?: Sleep
  /** Advisories go to stderr: stdout carries the MCP protocol. */
  warn?: Warn
  now?: () => number
  /** Source of the retry jitter; fixed in tests. */
  random?: () => number
}

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function createOpenAIClient(options: OpenAIClientOptions): OpenAIClient {
  const fetchImpl = options.fetchImpl ?? defaultFetch
  const sleep = options.sleep ?? defaultSleep
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const now = options.now ?? (() => Date.now())
  const random = options.random ?? Math.random
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.apiKey}`,
    ...(options.organization && { 'openai-organization': options.organization }),
    ...(options.project && { 'openai-project': options.project })
  }

  // When the last answer said no requests remain, the instant the budget resets.
  let exhaustedUntil = 0

  async function pause(ms: number, why: string): Promise<void> {
    warn(`OpenAI: ${why}; waiting ${(ms / 1000).toFixed(1)}s.`)
    await sleep(ms)
  }

  function jitter(): number {
    return Math.floor(random() * MAX_JITTER_MS)
  }

  function remember(response: Response): void {
    const remaining = seconds(response.headers.get('x-ratelimit-remaining-requests'))
    const reset = durationMs(response.headers.get('x-ratelimit-reset-requests'))
    if (remaining === 0 && reset !== undefined) exhaustedUntil = now() + reset
  }

  async function waitForBudget(): Promise<void> {
    const left = Math.min(MAX_PREEMPTIVE_WAIT_MS, exhaustedUntil - now())
    if (left > 0) await pause(left, 'the request budget is spent')
  }

  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(`${API_ROOT}/${path.replace(/^\//, '')}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
    }
    const init: RequestInit = {
      method: method.toUpperCase(),
      headers: opts.body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) })
    }
    const route = `${method.toUpperCase()} /${path.replace(/^\//, '')}`

    let rateLimited = false
    let serverErrored = false
    for (;;) {
      await waitForBudget()
      const response = await fetchImpl(url.toString(), init)
      remember(response)
      const body = await readBody(response)
      if (response.ok) return body as T

      const requestId = response.headers.get('x-request-id') ?? undefined
      const failure = new OpenAIApiError(response.status, body, requestId)
      const retryAfter = seconds(response.headers.get('retry-after'))

      if (response.status === 429) {
        const retryable = failure.code === undefined || RETRYABLE_429_CODES.has(failure.code)
        if (!retryable || rateLimited) throw failure
        rateLimited = true
        const asked =
          retryAfter !== undefined
            ? retryAfter * 1000
            : (durationMs(response.headers.get('x-ratelimit-reset-requests')) ?? DEFAULT_RATE_LIMIT_WAIT_MS)
        await pause(asked + jitter(), `${route} was rate limited`)
        continue
      }

      if (RETRYABLE_SERVER_STATUS.has(response.status) && !serverErrored) {
        serverErrored = true
        const asked = retryAfter !== undefined ? retryAfter * 1000 : DEFAULT_SERVER_ERROR_WAIT_MS
        await pause(asked + jitter(), `${route} answered ${response.status}`)
        continue
      }

      throw failure
    }
  }

  return {
    request,
    get: (path, query) => request('GET', path, { query })
  }
}
