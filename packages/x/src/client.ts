import { sign, type OAuthCredentials } from './oauth'

export const API_ROOT = 'https://api.x.com/2'

// The longest a 429 is waited out inside one call; a fresh 15-minute window is reported instead of held open.
export const MAX_RATE_LIMIT_WAIT_MS = 60_000

// What a 500, 502, 503 or 504 waits before its single retry.
export const SERVER_ERROR_RETRY_MS = 1_000

const RETRYABLE_SERVER_STATUSES = new Set([500, 502, 503, 504])

const MAX_ERROR_BODY = 300

export type Params = Record<string, string | number | undefined>

export interface XUser {
  id?: string
  username?: string
  name?: string
  description?: string
  created_at?: string
  public_metrics?: Record<string, number>
}

export interface XPost {
  id?: string
  text?: string
  author_id?: string
  created_at?: string
  conversation_id?: string
  in_reply_to_user_id?: string
  public_metrics?: Record<string, number>
}

export interface XListMeta {
  result_count?: number
  newest_id?: string
  oldest_id?: string
  next_token?: string
}

export interface XEnvelope<T> {
  data?: T
  includes?: { users?: XUser[] }
  meta?: XListMeta
  errors?: unknown[]
}

// A v2 problem, or the legacy `errors` list the rate-limit page still shows for a 429.
interface ProblemBody {
  title?: string
  detail?: string
  type?: string
  reason?: string
  errors?: Array<{ code?: number; message?: string }>
}

const ACCESS_PROBLEMS = new Set(['client-forbidden', 'usage-capped'])

export class XApiError extends Error {
  readonly status: number
  readonly title: string | undefined
  readonly detail: string | undefined
  /** The last path segment of the problem `type`, such as `client-forbidden`. */
  readonly problem: string | undefined
  readonly reason: string | undefined
  constructor(status: number, message: string, body: ProblemBody = {}) {
    super(message)
    this.name = 'XApiError'
    this.status = status
    this.title = body.title
    this.detail = body.detail
    this.problem = problemName(body.type)
    this.reason = body.reason
  }

  /** Whether the plan or the credit balance, not a window, is what refused the call. */
  get accessDenied(): boolean {
    return this.status === 402 || (this.problem !== undefined && ACCESS_PROBLEMS.has(this.problem))
  }
}

function problemName(type: string | undefined): string | undefined {
  if (!type || type === 'about:blank') return undefined
  const segment = type.split('/').filter(Boolean).pop()
  return segment || undefined
}

async function readBody(response: Response): Promise<{ parsed: ProblemBody; text: string }> {
  const text = await response.text().catch(() => '')
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed === 'object' && parsed !== null) return { parsed: parsed as ProblemBody, text }
  } catch {
    // Not JSON; the text stands on its own.
  }
  return { parsed: {}, text }
}

export function describeFailure(status: number, parsed: ProblemBody, text: string): XApiError {
  const legacy = parsed.errors?.find((entry) => typeof entry?.message === 'string')
  let message: string
  if (parsed.title || parsed.detail) {
    message = `${status} ${parsed.title ?? 'Error'}${parsed.detail ? `: ${parsed.detail}` : ''}`
  } else if (legacy) {
    message = `${status}: ${legacy.message}${legacy.code !== undefined ? ` (code ${legacy.code})` : ''}`
  } else {
    const quoted = text.length > MAX_ERROR_BODY ? `${text.slice(0, MAX_ERROR_BODY)}…` : text
    message = `X API ${status}${quoted ? `: ${quoted}` : ''}`
  }
  const problem = problemName(parsed.type)
  if (problem) message += ` [${problem}]`
  if (status === 403 && parsed.reason) message += ` reason: ${parsed.reason}`
  if (status === 401) {
    message +=
      '. The four credentials or the signature are wrong: check the Keys and tokens tab of the app and regenerate the access token after setting Read and Write.'
  }
  if (status === 402 || (problem && ACCESS_PROBLEMS.has(problem))) {
    message += ". The app's plan or credits do not cover this endpoint."
  }
  return new XApiError(status, message, parsed)
}

export interface XClientOptions {
  credentials: OAuthCredentials
  fetch: typeof fetch
  /** Replaced in tests so a wait costs no real time. */
  sleep?: (ms: number) => Promise<void>
  /** Milliseconds since the epoch; the rate-limit wait and the OAuth timestamp are measured by it. */
  now?: () => number
}

export interface CallOptions {
  method?: 'GET' | 'POST' | 'DELETE'
  query?: Params
  body?: unknown
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

function compact(params: Params): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') out.push([key, String(value)])
  }
  return out
}

/** The fields every post read asks for, so a mention, a search hit and a lookup share one shape. */
export const POST_FIELDS: Params = {
  'tweet.fields': 'created_at,author_id,conversation_id,in_reply_to_user_id',
  expansions: 'author_id',
  'user.fields': 'username,name'
}

export const USER_FIELDS = 'id,username,name'

// A client bound to one set of credentials: signs every call, waits out a 429 once, and retries a 5xx once.
export function createXClient(options: XClientOptions) {
  const sleep = options.sleep ?? wait
  const now = options.now ?? Date.now
  let fetchImpl = options.fetch

  async function call<T>(path: string, callOptions: CallOptions = {}): Promise<T> {
    const method = callOptions.method ?? 'GET'
    const url = new URL(`${API_ROOT}${path}`)
    for (const [key, value] of compact(callOptions.query ?? {})) url.searchParams.set(key, value)
    const hasBody = callOptions.body !== undefined
    for (let attempt = 0; ; attempt++) {
      const { header } = sign(options.credentials, {
        method,
        url: url.toString(),
        timestamp: Math.floor(now() / 1000)
      })
      const response = await fetchImpl(url.toString(), {
        method,
        headers: { Authorization: header, ...(hasBody && { 'Content-Type': 'application/json' }) },
        ...(hasBody && { body: JSON.stringify(callOptions.body) })
      })
      if (response.ok) {
        const text = await response.text()
        return (text === '' ? {} : JSON.parse(text)) as T
      }
      const { parsed, text } = await readBody(response)
      const failure = describeFailure(response.status, parsed, text)
      if (attempt === 0 && response.status === 429 && !failure.accessDenied) {
        const resetAt = Number(response.headers.get('x-rate-limit-reset')) * 1000
        const pending = Number.isFinite(resetAt) && resetAt > 0 ? resetAt - now() : SERVER_ERROR_RETRY_MS
        if (pending > MAX_RATE_LIMIT_WAIT_MS) {
          throw new XApiError(
            429,
            `${failure.message}. The rate limit resets at ${new Date(resetAt).toISOString()}.`,
            parsed
          )
        }
        await sleep(Math.max(0, pending))
        continue
      }
      if (attempt === 0 && RETRYABLE_SERVER_STATUSES.has(response.status)) {
        await sleep(SERVER_ERROR_RETRY_MS)
        continue
      }
      throw failure
    }
  }

  let me: Promise<XUser> | undefined

  return {
    call,
    /** The host hands a fresh resilient fetch to every call; a memoised client takes the latest. */
    setFetch(next: typeof fetch) {
      fetchImpl = next
    },
    getMe: () => call<XEnvelope<XUser>>('/users/me', { query: { 'user.fields': USER_FIELDS } }),
    // Fetched once per process: the SDK keeps no store beyond the cursor, so a memo is the nearest thing to per connection.
    myId(): Promise<XUser> {
      me ??= this.getMe()
        .then((envelope) => envelope.data ?? {})
        .catch((error: unknown) => {
          me = undefined
          throw error
        })
      return me
    },
    getPost: (id: string, query: Params = POST_FIELDS) =>
      call<XEnvelope<XPost>>(`/tweets/${encodeURIComponent(id)}`, { query }),
    getUserByUsername: (username: string, query: Params) =>
      call<XEnvelope<XUser>>(`/users/by/username/${encodeURIComponent(username)}`, { query }),
    mentions: (userId: string, query: Params) =>
      call<XEnvelope<XPost[]>>(`/users/${encodeURIComponent(userId)}/mentions`, { query: { ...POST_FIELDS, ...query } }),
    searchRecent: (query: Params) =>
      call<XEnvelope<XPost[]>>('/tweets/search/recent', { query: { ...POST_FIELDS, sort_order: 'recency', ...query } }),
    createPost: (body: Record<string, unknown>) => call<XEnvelope<XPost>>('/tweets', { method: 'POST', body }),
    deletePost: (id: string) =>
      call<XEnvelope<{ deleted?: boolean }>>(`/tweets/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
}

export type XClient = ReturnType<typeof createXClient>
