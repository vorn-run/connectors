export const DEFAULT_BASE_URL = 'http://localhost:11434'

/** Chat, generate and pull can take minutes on a laptop. */
export const LONG_TIMEOUT_MS = 10 * 60_000

export const DEFAULT_TIMEOUT_MS = 30_000

/** How long the one retry waits for a server that may be starting. */
export const CONNECTION_RETRY_WAIT_MS = 2_000

const MAX_ERROR_BODY = 300

const MODEL_NOT_FOUND = /^model '([^']*)' not found$/

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type Sleep = (ms: number) => Promise<void>

/* ------------------------------------------------------------ base url -- */

// The FAQ's OLLAMA_HOST values are host:port without a scheme, and a copied URL often ends in /api.
export function normalizeBaseUrl(raw: unknown): string {
  let url = String(raw ?? '').trim()
  if (url === '') return DEFAULT_BASE_URL
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`
  url = url.replace(/\/+$/, '')
  url = url.replace(/\/api$/i, '')
  return url.replace(/\/+$/, '')
}

/* -------------------------------------------------------------- errors -- */

export class OllamaApiError extends Error {
  readonly status: number
  readonly detail: string
  constructor(status: number, body: unknown) {
    const detail = errorMessage(body)
    super(`${describeFailure(detail)} (HTTP ${status})`)
    this.name = 'OllamaApiError'
    this.status = status
    this.detail = detail
  }
}

function errorMessage(body: unknown): string {
  const error = (body as { error?: unknown } | undefined)?.error
  if (typeof error === 'string' && error.trim() !== '') return error.trim()
  const raw = typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body)
  const trimmed = raw.trim()
  if (trimmed === '') return 'no body'
  return trimmed.length > MAX_ERROR_BODY ? `${trimmed.slice(0, MAX_ERROR_BODY)}…` : trimmed
}

// A missing model is said plainly, and never pulled on the caller's behalf.
export function describeFailure(detail: string): string {
  const missing = MODEL_NOT_FOUND.exec(detail)
  return missing ? `Model '${missing[1]}' is not present on the server; pull it first` : detail
}

function isConnectionRefused(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown; errors?: unknown[] }
    if (candidate.code === 'ECONNREFUSED') return true
    if (Array.isArray(candidate.errors) && candidate.errors.some(isConnectionRefused)) return true
    current = candidate.cause
  }
  return false
}

/* -------------------------------------------------------------- client -- */

export interface RequestOptions {
  body?: unknown
  timeoutMs?: number
}

export interface OllamaClient {
  readonly baseUrl: string
  request<T = unknown>(method: string, path: string, options?: RequestOptions): Promise<T>
  get<T = unknown>(path: string): Promise<T>
  post<T = unknown>(path: string, body: unknown, timeoutMs?: number): Promise<T>
}

export interface OllamaClientOptions {
  baseUrl?: string
  /** Sent as `Authorization: Bearer` only when set, for a hosted or proxied server. */
  apiKey?: string
  /** Injected in tests, so nothing reaches the network. */
  fetchImpl?: FetchLike
  /** Injected in tests, so the connection retry spends no real time. */
  sleep?: Sleep
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

export function createOllamaClient(options: OllamaClientOptions = {}): OllamaClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const fetchImpl = options.fetchImpl ?? defaultFetch
  const sleep = options.sleep ?? defaultSleep
  const apiKey = String(options.apiKey ?? '').trim()
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(apiKey !== '' && { authorization: `Bearer ${apiKey}` })
  }

  async function send(url: string, init: RequestInit, timeoutMs: number, route: string): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Ollama did not answer ${route} within ${Math.round(timeoutMs / 1000)}s`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = `${baseUrl}/api/${path.replace(/^\//, '')}`
    const route = `${method.toUpperCase()} /api/${path.replace(/^\//, '')}`
    const init: RequestInit = {
      method: method.toUpperCase(),
      headers: opts.body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) })
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

    let response: Response
    try {
      response = await send(url, init, timeoutMs, route)
    } catch (error) {
      if (!isConnectionRefused(error)) throw error
      await sleep(CONNECTION_RETRY_WAIT_MS)
      try {
        response = await send(url, init, timeoutMs, route)
      } catch (again) {
        if (!isConnectionRefused(again)) throw again
        throw new Error(`Ollama did not answer at ${baseUrl}; the server may be starting or not running`)
      }
    }
    const body = await readBody(response)
    if (!response.ok) throw new OllamaApiError(response.status, body)
    return body as T
  }

  return {
    baseUrl,
    request,
    get: (path) => request('GET', path),
    post: (path, body, timeoutMs) => request('POST', path, { body, ...(timeoutMs !== undefined && { timeoutMs }) })
  }
}
