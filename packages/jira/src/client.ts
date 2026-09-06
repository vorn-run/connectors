// Jira Cloud's REST API v3 lives under the site's origin.
export const API_PATH = '/rest/api/3'

// "Start with a base delay (e.g., 2 seconds)" when a 429 names no wait.
export const DEFAULT_RATE_LIMIT_WAIT_MS = 2_000

export const DEFAULT_SERVER_ERROR_WAIT_MS = 1_000

// "Multiply the delay by a random factor (e.g; between 0.7 and 1.3)".
export const JITTER_MIN = 0.7
export const JITTER_SPAN = 0.6

const RETRYABLE_SERVER_STATUS = new Set([500, 502, 503, 504])

const MAX_ERROR_BODY = 300

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type Sleep = (ms: number) => Promise<void>

export const TOKEN_HINT =
  'Create one at https://id.atlassian.com/manage-profile/security/api-tokens (Create API token, without scopes) and set JIRA_API_TOKEN on the connection.'

/* ---------------------------------------------------------------- site -- */

// The site's origin only: a pasted URL often carries a trailing slash or a /jira/... path, and the API lives under the origin.
export function siteOrigin(raw: unknown): string {
  const value = String(raw ?? '').trim()
  if (value === '') throw new Error('JIRA_SITE_URL is required, such as https://example.atlassian.net')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`JIRA_SITE_URL is not a URL: "${value}"`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`JIRA_SITE_URL must be an http(s) URL, got "${value}"`)
  }
  return url.origin
}

// "Build a string of the form useremail:api_token. BASE64 encode the string."
export function basicAuth(email: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${email}:${apiToken}`, 'utf8').toString('base64')}`
}

export function browseUrl(site: string, key: string): string {
  return `${site}/browse/${encodeURIComponent(key)}`
}

/* -------------------------------------------------------------- errors -- */

export interface ErrorCollection {
  errorMessages?: string[]
  errors?: Record<string, string>
  status?: number
}

export class JiraApiError extends Error {
  readonly status: number
  readonly errorMessages: string[]
  readonly errors: Record<string, string>
  readonly rateLimitReason: string | undefined
  constructor(status: number, statusText: string, body: unknown, rateLimitReason?: string | null) {
    super(describeFailure(status, statusText, body, rateLimitReason))
    this.name = 'JiraApiError'
    this.status = status
    const collection = collectionOf(body)
    this.errorMessages = collection.errorMessages ?? []
    this.errors = collection.errors ?? {}
    this.rateLimitReason = rateLimitReason ?? undefined
  }
}

function collectionOf(body: unknown): ErrorCollection {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {}
  const raw = body as Record<string, unknown>
  const errorMessages = Array.isArray(raw.errorMessages)
    ? raw.errorMessages.filter((entry): entry is string => typeof entry === 'string')
    : undefined
  const errors =
    typeof raw.errors === 'object' && raw.errors !== null && !Array.isArray(raw.errors)
      ? Object.fromEntries(Object.entries(raw.errors as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
      : undefined
  return { ...(errorMessages && { errorMessages }), ...(errors && { errors }) }
}

// `<status>: <errorMessages>; <field>: <message>`; the status text alone when the body is not an error collection.
export function describeFailure(status: number, statusText: string, body: unknown, rateLimitReason?: string | null): string {
  const collection = collectionOf(body)
  const parts = [
    ...(collection.errorMessages ?? []),
    ...Object.entries(collection.errors ?? {}).map(([field, message]) => `${field}: ${message}`)
  ]
  let detail = parts.join('; ')
  if (detail === '') {
    if (typeof body === 'string' && body.trim() !== '') {
      const text = body.trim()
      detail = text.length > MAX_ERROR_BODY ? `${text.slice(0, MAX_ERROR_BODY)}…` : text
    } else {
      detail = statusText || 'request failed'
    }
  }
  const reason = rateLimitReason ? ` (${rateLimitReason})` : ''
  return `${status}: ${detail}${reason}`
}

/* --------------------------------------------------------------- waits -- */

// Retry-After as seconds or an HTTP date, in milliseconds; the guide documents seconds, the 5xx note leaves it open.
export function retryAfterMs(header: string | null, now: number): number | undefined {
  const trimmed = (header ?? '').trim()
  if (trimmed === '') return undefined
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

// Retry-After first, then X-RateLimit-Reset on a 429, then the guide's base delay.
export function retryDelayMs(response: Response, now: number): number {
  const asked = retryAfterMs(response.headers.get('retry-after'), now)
  if (asked !== undefined) return asked
  if (response.status === 429) {
    const reset = Date.parse(response.headers.get('x-ratelimit-reset') ?? '')
    return Number.isNaN(reset) ? DEFAULT_RATE_LIMIT_WAIT_MS : Math.max(0, reset - now)
  }
  return DEFAULT_SERVER_ERROR_WAIT_MS
}

/* -------------------------------------------------------------- client -- */

export type Query = Record<string, string | number | boolean | undefined>

export interface RequestOptions {
  query?: Query
  body?: unknown
  /** Whether a 5xx answer may be sent again; a create may have landed, so it is not. */
  idempotent?: boolean
}

export interface JiraClient {
  readonly site: string
  request<T = unknown>(method: string, path: string, options?: RequestOptions): Promise<T>
  get<T = unknown>(path: string, query?: Query): Promise<T>
}

export interface JiraClientOptions {
  siteUrl: string
  email: string
  apiToken: string
  /** Injected in tests and by the SDK, so nothing reaches the network on its own. */
  fetchImpl?: FetchLike
  /** Injected in tests, so no test spends real time asleep. */
  sleep?: Sleep
  now?: () => number
  /** Source of the retry jitter; fixed in tests. */
  random?: () => number
}

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

async function readBody(response: Response): Promise<{ text: string; json: unknown | undefined }> {
  const text = await response.text()
  if (text === '') return { text, json: undefined }
  try {
    return { text, json: JSON.parse(text) as unknown }
  } catch {
    return { text, json: undefined }
  }
}

export function createJiraClient(options: JiraClientOptions): JiraClient {
  const site = siteOrigin(options.siteUrl)
  const email = options.email.trim()
  const apiToken = options.apiToken.trim()
  if (email === '') throw new Error('JIRA_EMAIL is required: the email of the Atlassian account the token belongs to')
  if (apiToken === '') throw new Error(`JIRA_API_TOKEN is required. ${TOKEN_HINT}`)
  const fetchImpl = options.fetchImpl ?? defaultFetch
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? (() => Date.now())
  const random = options.random ?? Math.random
  const headers: Record<string, string> = {
    authorization: basicAuth(email, apiToken),
    accept: 'application/json'
  }

  function jittered(ms: number): number {
    return Math.round(ms * (JITTER_MIN + random() * JITTER_SPAN))
  }

  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(`${site}${API_PATH}/${path.replace(/^\//, '')}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
    }
    const init: RequestInit = {
      method: method.toUpperCase(),
      headers: opts.body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) })
    }

    let retried = false
    for (;;) {
      let response: Response
      try {
        response = await fetchImpl(url.toString(), init)
      } catch (error) {
        // No answer arrived at all, so nothing landed; one more try is safe even for a create.
        if (retried) throw error
        retried = true
        await sleep(jittered(DEFAULT_SERVER_ERROR_WAIT_MS))
        continue
      }
      const rateLimited = response.status === 429
      const serverErrored = RETRYABLE_SERVER_STATUS.has(response.status) && opts.idempotent !== false
      if ((rateLimited || serverErrored) && !retried) {
        retried = true
        await response.text().catch(() => '')
        await sleep(jittered(retryDelayMs(response, now())))
        continue
      }
      const { text, json } = await readBody(response)
      if (!response.ok) {
        throw new JiraApiError(response.status, response.statusText, json ?? text, response.headers.get('ratelimit-reason'))
      }
      // A mistyped site answers 200 with an HTML login page, which is not an API answer.
      if (json === undefined && text !== '') {
        throw new Error(`${site} answered with something other than JSON; check JIRA_SITE_URL: ${text.slice(0, 80)}`)
      }
      return (json ?? {}) as T
    }
  }

  return {
    site,
    request,
    get: (path, query) => request('GET', path, { query, idempotent: true })
  }
}
