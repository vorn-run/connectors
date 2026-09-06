export const API_ROOT = 'https://api.trello.com/1'

// "The API limits Action queries to 1000 at a time."
export const MAX_ACTION_LIMIT = 1000

// Pages of actions one poll walks with `before` before leaving the rest for the next one.
export const MAX_ACTION_PAGES = 5

// Both documented windows are 10 seconds; the wait when a 429 names neither Retry-After nor an exhausted window.
export const RATE_LIMIT_WINDOW_MS = 10_000

const MAX_ERROR_BODY = 300

export type Params = Record<string, unknown>

// What Trello said when a call failed, as `<status>: <body text>`; the URL is never quoted because it carries the key and token.
export class TrelloApiError extends Error {
  readonly status: number
  readonly body: string
  constructor(status: number, body: string) {
    super(body ? `${status}: ${body}` : String(status))
    this.name = 'TrelloApiError'
    this.status = status
    this.body = body
  }
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

// Retry-After as seconds or an HTTP date, in milliseconds; the guide promises neither, so both are read.
export function retryAfterMs(header: string | null, now: number): number | undefined {
  const trimmed = (header ?? '').trim()
  if (trimmed === '') return undefined
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

// The interval of every x-rate-limit-<scope> window whose remaining budget is 0, largest first.
function exhaustedWindowMs(headers: Headers): number | undefined {
  let longest: number | undefined
  for (const scope of ['api-key', 'api-token']) {
    const remaining = Number(headers.get(`x-rate-limit-${scope}-remaining`))
    const interval = Number(headers.get(`x-rate-limit-${scope}-interval-ms`))
    if (headers.get(`x-rate-limit-${scope}-remaining`) === null || remaining > 0) continue
    if (!Number.isFinite(interval) || interval <= 0) continue
    if (longest === undefined || interval > longest) longest = interval
  }
  return longest
}

// How long to wait after a 429: Retry-After, else the exhausted window, else the documented 10 seconds.
export function rateLimitWaitMs(headers: Headers, now: number): number {
  return retryAfterMs(headers.get('retry-after'), now) ?? exhaustedWindowMs(headers) ?? RATE_LIMIT_WINDOW_MS
}

async function describeFailure(response: Response): Promise<TrelloApiError> {
  const text = (await response.text().catch(() => '')).trim()
  const quoted = text.length > MAX_ERROR_BODY ? `${text.slice(0, MAX_ERROR_BODY)}…` : text
  return new TrelloApiError(response.status, quoted)
}

function compact(params: Params): Params {
  const out: Params = {}
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value
  }
  return out
}

export interface TrelloClientOptions {
  apiKey: string
  token: string
  fetch: typeof fetch
  /** Replaced in tests so a wait costs no real time. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT'
  query?: Params
}

export interface ActionsParams {
  filter: string
  since?: string
  before?: string
  limit?: number
}

export interface TrelloAction {
  id: string
  type?: string
  date?: string
  idMemberCreator?: string
  data?: Record<string, unknown>
  memberCreator?: Record<string, unknown>
}

export interface TrelloCard {
  id: string
  name?: string
  due?: string | null
  dueComplete?: boolean
  closed?: boolean
  idBoard?: string
  idList?: string
  shortLink?: string
  shortUrl?: string
  url?: string
  dateLastActivity?: string
  [key: string]: unknown
}

// A client bound to one key and token, sent as query parameters on every call; a 429 is retried once after the documented wait.
export function createTrelloClient(options: TrelloClientOptions) {
  const apiKey = options.apiKey.trim()
  const token = options.token.trim()
  if (!apiKey) throw new Error('TRELLO_API_KEY is required')
  if (!token) throw new Error('TRELLO_TOKEN is required')
  const sleep = options.sleep ?? wait
  const now = options.now ?? Date.now

  async function call<T>(path: string, callOptions: CallOptions = {}): Promise<T> {
    const url = new URL(`${API_ROOT}/${path}`)
    for (const [key, value] of Object.entries(compact(callOptions.query ?? {}))) {
      url.searchParams.set(key, String(value))
    }
    url.searchParams.set('key', apiKey)
    url.searchParams.set('token', token)
    const init: RequestInit = { method: callOptions.method ?? 'GET' }
    for (let attempt = 0; ; attempt++) {
      const response = await options.fetch(url.toString(), init)
      if (attempt === 0 && response.status === 429) {
        await sleep(rateLimitWaitMs(response.headers, now()))
        continue
      }
      if (!response.ok) throw await describeFailure(response)
      const text = await response.text()
      return (text === '' ? {} : JSON.parse(text)) as T
    }
  }

  const segment = (id: string) => encodeURIComponent(id)

  function boardActions(boardId: string, params: ActionsParams): Promise<TrelloAction[]> {
    return call<TrelloAction[] | Params>(`boards/${segment(boardId)}/actions`, {
      query: {
        ...params,
        memberCreator: 'true',
        member: 'false',
        fields: 'id,type,date,data',
        memberCreator_fields: 'fullName,username'
      }
    }).then((body) => (Array.isArray(body) ? body : []))
  }

  function boardCards(boardId: string, fields: string): Promise<TrelloCard[]> {
    return call<TrelloCard[] | Params>(`boards/${segment(boardId)}/cards`, { query: { fields } }).then(
      (body) => (Array.isArray(body) ? body : [])
    )
  }

  function createCard(query: Params): Promise<TrelloCard> {
    return call<TrelloCard>('cards', { method: 'POST', query })
  }

  function addComment(cardId: string, text: string): Promise<TrelloAction> {
    return call<TrelloAction>(`cards/${segment(cardId)}/actions/comments`, { method: 'POST', query: { text } })
  }

  function addLabel(cardId: string, labelId: string): Promise<unknown> {
    return call<unknown>(`cards/${segment(cardId)}/idLabels`, { method: 'POST', query: { value: labelId } })
  }

  function search(query: Params): Promise<unknown> {
    return call<unknown>('search', { query })
  }

  function me(): Promise<{ id?: string; username?: string; fullName?: string }> {
    return call('members/me', { query: { fields: 'id,username,fullName' } })
  }

  return { call, boardActions, boardCards, createCard, addComment, addLabel, search, me }
}

export type TrelloClient = ReturnType<typeof createTrelloClient>
