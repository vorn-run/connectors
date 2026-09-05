export const API_ROOT = 'https://discord.com/api/v10'

// "Clients using the HTTP API must provide a valid User Agent" of the form `DiscordBot ($url, $versionNumber)`.
export const USER_AGENT_URL = 'https://github.com/vorn-run/connectors'

// Milliseconds since the Unix epoch at which snowflake time starts.
export const DISCORD_EPOCH = 1420070400000n

// Retries after the first try when a call answers 429; the third 429 is the answer.
const RATE_LIMIT_RETRIES = 2

const MIN_RATE_LIMIT_WAIT_MS = 1_000

// Longest single wait, whatever the service asked for.
export const MAX_WAIT_MS = 60_000

const SERVER_ERROR_WAIT_MS = 1_000

const MAX_ERROR_BODY = 300

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type Sleep = (ms: number) => Promise<void>

export type Warn = (message: string) => void

/* ------------------------------------------------------------- token -- */

// A pasted `Bot ` prefix is stripped; a Bearer token is an OAuth2 user token and is left to the API to refuse.
export function normalizeToken(raw: unknown): string {
  const token = String(raw ?? '')
    .trim()
    .replace(/^bot\b\s*/i, '')
    .trim()
  if (token === '') {
    throw new Error(
      'DISCORD_BOT_TOKEN is required. Create one at https://discord.com/developers/applications: open the application, Bot tab, Reset Token.'
    )
  }
  return token
}

export function userAgent(version: string): string {
  return `DiscordBot (${USER_AGENT_URL}, ${version})`
}

/* -------------------------------------------------------- snowflakes -- */

const SNOWFLAKE = /^\d{1,20}$/

export function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && SNOWFLAKE.test(value)
}

/** Creation time of a snowflake in milliseconds since the Unix epoch. */
export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH)
}

/** A snowflake whose time is `ms`, valid as an `after` bound for any id-ordered list. */
export function snowflakeFrom(ms: number): string {
  const since = BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH
  return String((since < 0n ? 0n : since) << 22n)
}

// Compared as BigInt: ids exceed 2^53 and differ in length, so neither numbers nor strings order them.
export function compareSnowflakes(left: string, right: string): number {
  const a = BigInt(left)
  const b = BigInt(right)
  return a === b ? 0 : a < b ? -1 : 1
}

export function maxSnowflake(ids: string[]): string | undefined {
  let newest: string | undefined
  for (const id of ids) {
    if (newest === undefined || compareSnowflakes(id, newest) > 0) newest = id
  }
  return newest
}

/* ------------------------------------------------------------ errors -- */

interface DiscordErrorBody {
  code?: number
  message?: string
  errors?: unknown
  retry_after?: number
  global?: boolean
}

// The first nested `_errors` message of a `50035` Invalid Form Body, with the path it sits under.
export function firstFieldError(errors: unknown, path: string[] = []): string | undefined {
  if (typeof errors !== 'object' || errors === null) return undefined
  const record = errors as Record<string, unknown>
  const own = record._errors
  if (Array.isArray(own)) {
    const first = own.find((entry) => typeof entry === 'object' && entry !== null) as
      | { message?: unknown; code?: unknown }
      | undefined
    if (first) {
      const message = String(first.message ?? first.code ?? '').trim()
      if (message !== '') return path.length > 0 ? `${path.join('.')}: ${message}` : message
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === '_errors') continue
    const found = firstFieldError(value, [...path, key])
    if (found !== undefined) return found
  }
  return undefined
}

export class DiscordApiError extends Error {
  readonly status: number
  readonly code: number | undefined
  readonly bucket: string | undefined
  readonly scope: string | undefined
  constructor(
    status: number,
    body: unknown,
    detail: { bucket?: string; scope?: string; note?: string } = {}
  ) {
    super(describeFailure(status, body, detail.note))
    this.name = 'DiscordApiError'
    this.status = status
    this.code = typeof (body as DiscordErrorBody)?.code === 'number' ? (body as DiscordErrorBody).code : undefined
    this.bucket = detail.bucket
    this.scope = detail.scope
  }
}

// `<status> <code>: <message>`, with the first field error appended for an invalid form body.
export function describeFailure(status: number, body: unknown, note?: string): string {
  const error = (typeof body === 'object' && body !== null ? body : {}) as DiscordErrorBody
  const code = typeof error.code === 'number' ? ` ${error.code}` : ''
  let message = typeof error.message === 'string' && error.message !== '' ? error.message : ''
  if (message === '') {
    const raw = typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body)
    message = raw.length > MAX_ERROR_BODY ? `${raw.slice(0, MAX_ERROR_BODY)}…` : raw
  }
  const field = firstFieldError(error.errors)
  const tail = field !== undefined ? ` (${field})` : ''
  return `${status}${code}: ${message || 'no body'}${tail}${note ? ` ${note}` : ''}`
}

/* ------------------------------------------------------------ client -- */

export interface RequestOptions {
  query?: Record<string, string | number | undefined>
  body?: unknown
}

export interface DiscordClient {
  request<T = unknown>(method: string, path: string, options?: RequestOptions): Promise<T>
  get<T = unknown>(path: string, query?: RequestOptions['query']): Promise<T>
}

export interface DiscordClientOptions {
  token: string
  version: string
  /** Injected in tests, so nothing reaches the network. */
  fetchImpl?: FetchLike
  /** Injected in tests, so no test spends real time asleep. */
  sleep?: Sleep
  /** Advisories go to stderr: stdout carries the MCP protocol. */
  warn?: Warn
  now?: () => number
}

interface BucketState {
  remaining: number
  resetAt: number
}

// The route with its ids stripped, which is the bucket until the response names one.
export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replace(/\/\d{5,}/g, '/:id')}`
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

function seconds(value: unknown): number | undefined {
  const parsed = Number(value)
  return value === null || value === undefined || value === '' || !Number.isFinite(parsed)
    ? undefined
    : parsed
}

export function createDiscordClient(options: DiscordClientOptions): DiscordClient {
  const fetchImpl = options.fetchImpl ?? defaultFetch
  const sleep = options.sleep ?? defaultSleep
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const now = options.now ?? (() => Date.now())
  const headers = {
    authorization: `Bot ${options.token}`,
    'user-agent': userAgent(options.version)
  }

  const buckets = new Map<string, BucketState>()
  const bucketOf = new Map<string, string>()

  async function pause(ms: number, why: string): Promise<void> {
    const wait = Math.min(MAX_WAIT_MS, Math.max(0, ms))
    warn(`Discord: ${why}; waiting ${(wait / 1000).toFixed(1)}s.`)
    await sleep(wait)
  }

  // A bucket the last response emptied is waited out before the next call on it, so a 429 never has to happen.
  async function waitForBucket(route: string): Promise<void> {
    const key = bucketOf.get(route) ?? route
    const state = buckets.get(key)
    if (!state || state.remaining > 0) return
    const left = state.resetAt - now()
    if (left <= 0) return
    await pause(left, `rate limit bucket ${key} is exhausted`)
  }

  function remember(route: string, response: Response): void {
    const bucket = response.headers.get('x-ratelimit-bucket') ?? route
    bucketOf.set(route, bucket)
    const remaining = seconds(response.headers.get('x-ratelimit-remaining'))
    const resetAfter = seconds(response.headers.get('x-ratelimit-reset-after'))
    if (remaining === undefined || resetAfter === undefined) return
    buckets.set(bucket, { remaining, resetAt: now() + resetAfter * 1000 })
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
    const route = routeKey(method, path)

    let rateLimited = 0
    let serverErrors = 0
    for (;;) {
      await waitForBucket(route)
      const response = await fetchImpl(url.toString(), init)
      remember(route, response)
      const body = await readBody(response)
      if (response.ok) return body as T

      if (response.status === 429) {
        const bucket = response.headers.get('x-ratelimit-bucket') ?? route
        const scope = response.headers.get('x-ratelimit-scope') ?? undefined
        const asked =
          seconds(response.headers.get('retry-after')) ??
          seconds((body as DiscordErrorBody | undefined)?.retry_after) ??
          MIN_RATE_LIMIT_WAIT_MS / 1000
        if (rateLimited >= RATE_LIMIT_RETRIES) {
          throw new DiscordApiError(429, body, {
            bucket,
            ...(scope && { scope }),
            note: `(rate limited ${rateLimited + 1} times on bucket ${bucket}${scope ? `, scope ${scope}` : ''})`
          })
        }
        rateLimited += 1
        await pause(
          Math.max(MIN_RATE_LIMIT_WAIT_MS, asked * 1000),
          `${method.toUpperCase()} /${path} was rate limited on bucket ${bucket}${scope ? ` (${scope})` : ''}`
        )
        continue
      }

      if (response.status >= 500 && serverErrors === 0) {
        serverErrors += 1
        await pause(SERVER_ERROR_WAIT_MS, `${method.toUpperCase()} /${path} answered ${response.status}`)
        continue
      }

      throw new DiscordApiError(response.status, body)
    }
  }

  return {
    request,
    get: (path, query) => request('GET', path, { query })
  }
}
