import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import type { ConnectorConfig } from '@vornrun/connector-sdk'

const execFileAsync = promisify(execFile)

export const API_ROOT = 'https://api.stripe.com/v1'

// The version these shapes were read from; without it every account answers in its own default version.
export const STRIPE_VERSION = '2026-08-26.dahlia'

// Stripe's documented maximum for `limit`; the default is 10.
export const MAX_PAGE_SIZE = 100

// Pages a single poll walks before leaving the rest for the next one.
export const MAX_LIST_PAGES = 10

const STRIPE_TIMEOUT_MS = 10_000

const MAX_ERROR_BODY = 300

// Retries after the first try for a POST, since the SDK will not repeat a write on its own.
const POST_RETRIES = 2

const POST_BACKOFF_MS = 500

export function stripeInstallHint(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'darwin':
      return 'Install with Homebrew: `brew install stripe/stripe-cli/stripe`'
    case 'win32':
      return 'Install with Scoop: `scoop bucket add stripe https://github.com/stripe/scoop-stripe-cli.git && scoop install stripe`'
    default:
      return 'Install from https://docs.stripe.com/stripe-cli#install (apt, yum and tarballs)'
  }
}

export class StripeNotFoundError extends Error {
  readonly code = 'STRIPE_CLI_NOT_FOUND'
  constructor() {
    super(`Stripe CLI (stripe) not found on PATH. ${stripeInstallHint()}`)
    this.name = 'StripeNotFoundError'
  }
}

export class StripeSignedOutError extends Error {
  readonly code = 'STRIPE_SIGNED_OUT'
  constructor(detail?: string) {
    super(`Not signed in to Stripe. Run \`stripe login\`.${detail ? `\n${detail}` : ''}`)
    this.name = 'StripeSignedOutError'
  }
}

// What Stripe said when a call failed, as `<type>/<code>: <message> (<Request-Id>)`.
export class StripeApiError extends Error {
  readonly status: number
  readonly type: string | undefined
  readonly errorCode: string | undefined
  readonly requestId: string | undefined
  constructor(
    status: number,
    detail: { type?: string; code?: string; message: string; requestId?: string }
  ) {
    const head = detail.type ? `${detail.type}${detail.code ? `/${detail.code}` : ''}: ` : ''
    super(`${head}${detail.message}${detail.requestId ? ` (${detail.requestId})` : ''}`)
    this.name = 'StripeApiError'
    this.status = status
    this.type = detail.type
    this.errorCode = detail.code
    this.requestId = detail.requestId
  }
}

export type RunStripe = (args: string[]) => Promise<string>

// Run `stripe`, translating the one failure a user can act on: the CLI being absent.
export const runStripe: RunStripe = async (args) => {
  try {
    const { stdout } = await execFileAsync('stripe', args, { timeout: STRIPE_TIMEOUT_MS })
    return stdout
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') throw new StripeNotFoundError()
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim()
    throw new Error(stderr || (error instanceof Error ? error.message : String(error)))
  }
}

const TABLE_LINE = /^\s*\[\s*"?([^"\]]+?)"?\s*\]\s*$/
const KEY_LINE = /^\s*(test_mode_api_key|live_mode_api_key)\s*=\s*"([^"]*)"\s*$/

// The key one profile of `stripe config --list` holds: a table named after the project, `default` when none was given.
export function readProfileKey(toml: string, project: string, liveMode: boolean): string | undefined {
  const wanted = liveMode ? 'live_mode_api_key' : 'test_mode_api_key'
  let table = ''
  for (const line of toml.split(/\r?\n/)) {
    const heading = TABLE_LINE.exec(line)
    if (heading) {
      table = heading[1].trim()
      continue
    }
    const entry = KEY_LINE.exec(line)
    if (entry && table === project && entry[1] === wanted && entry[2].trim() !== '') {
      return entry[2].trim()
    }
  }
  return undefined
}

// A publishable key answers `secret_key_required`; refusing it here names the cause before any call.
export function assertSecretKey(key: string): string {
  if (key.startsWith('pk_')) {
    throw new Error(
      'STRIPE_API_KEY is a publishable key (pk_…), which cannot call the API. Use a restricted (rk_) or secret (sk_) key.'
    )
  }
  return key
}

export interface TokenSourceOptions {
  /** A key from the connection. When set, `stripe` is never run. */
  apiKey?: string
  /** The CLI profile (`--project-name`) to borrow from. */
  project?: string
  /** Borrow the live key rather than the test one. */
  liveMode?: boolean
  /** Injected in tests, so nothing spawns a process. */
  stripe?: RunStripe
}

// The current key, cached until Stripe rejects it; a pasted key is never re-read because it would be the same key.
export function createTokenSource(options: TokenSourceOptions = {}) {
  const stripe = options.stripe ?? runStripe
  const pasted = String(options.apiKey ?? '').trim()
  const project = String(options.project ?? '').trim() || 'default'
  const liveMode = options.liveMode === true
  let cached: string | undefined = pasted || undefined

  async function read(): Promise<string> {
    const args = ['config', '--list', ...(project !== 'default' ? ['--project-name', project] : [])]
    const key = readProfileKey(await stripe(args), project, liveMode)
    if (!key) {
      const which = liveMode ? 'live_mode_api_key' : 'test_mode_api_key'
      throw new StripeSignedOutError(`stripe config --list holds no ${which} for profile "${project}".`)
    }
    return key
  }

  return {
    borrowed: !pasted,
    async get(): Promise<string> {
      return assertSecretKey((cached ??= await read()))
    },
    invalidate(): void {
      if (!pasted) cached = undefined
    }
  }
}

export type TokenSource = ReturnType<typeof createTokenSource>

export type Params = Record<string, unknown>

// Stripe's form and query encoding: nested values become bracketed keys, `created[gte]=1` and `metadata[order]=6`.
export function encodeParams(params: Params, into = new URLSearchParams(), prefix = ''): URLSearchParams {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    const name = prefix ? `${prefix}[${key}]` : key
    if (Array.isArray(value)) {
      value.forEach((entry, index) => encodeParams({ [index]: entry }, into, name))
    } else if (typeof value === 'object') {
      encodeParams(value as Params, into, name)
    } else {
      into.set(name, String(value))
    }
  }
  return into
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value as Params)
        .sort()
        .map((key) => [key, canonical((value as Params)[key])])
    )
  }
  return value
}

// SHA-256 of the action and its inputs with keys sorted: identical inputs replay Stripe's first answer, and nothing sensitive reaches the header.
export function idempotencyKey(action: string, args: Params): string {
  return createHash('sha256').update(`${action}\n${JSON.stringify(canonical(args))}`).digest('hex')
}

export function dashboardUrl(path: string, livemode: boolean | undefined): string {
  return `https://dashboard.stripe.com/${livemode ? '' : 'test/'}${path}`
}

async function describeFailure(response: Response): Promise<StripeApiError> {
  const text = await response.text().catch(() => '')
  const requestId = response.headers.get('request-id') ?? undefined
  try {
    const parsed = JSON.parse(text) as { error?: { type?: string; code?: string; message?: string } }
    if (parsed.error && typeof parsed.error.message === 'string') {
      return new StripeApiError(response.status, {
        ...(parsed.error.type && { type: parsed.error.type }),
        ...(parsed.error.code && { code: parsed.error.code }),
        message: parsed.error.message,
        ...(requestId && { requestId })
      })
    }
  } catch {
    // Not JSON; the raw text says what it says.
  }
  const quoted = text.length > MAX_ERROR_BODY ? `${text.slice(0, MAX_ERROR_BODY)}…` : text
  return new StripeApiError(response.status, {
    message: `Stripe API ${response.status}${quoted ? `: ${quoted}` : ''}`,
    ...(requestId && { requestId })
  })
}

export interface StripeClientOptions {
  config: ConnectorConfig
  /** The SDK's fetch, which retries reads on its own. */
  fetch: typeof fetch
  tokens?: TokenSource
  stripe?: RunStripe
  /** Replaced in tests so a write's backoff costs no real time. */
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export interface ListOptions {
  maxPages?: number
}

interface StripeList<T> {
  object?: string
  data?: T[]
  has_more?: boolean
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

// A client bound to the connection's key, which re-reads a borrowed one once when Stripe stops accepting it.
export function createStripeClient(options: StripeClientOptions) {
  const tokens =
    options.tokens ??
    createTokenSource({
      ...(options.config.apiKey !== undefined && { apiKey: options.config.apiKey }),
      ...(options.config.project !== undefined && { project: options.config.project }),
      liveMode: options.config.liveMode === 'true',
      ...(options.stripe && { stripe: options.stripe })
    })
  const sleep = options.sleep ?? wait
  const random = options.random ?? Math.random

  async function send(url: string, init: RequestInit, headers: Record<string, string>): Promise<Response> {
    const key = await tokens.get()
    return options.fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': STRIPE_VERSION, ...headers }
    })
  }

  async function authorized(url: string, init: RequestInit, headers: Record<string, string>): Promise<Response> {
    let response = await send(url, init, headers)
    if (response.status === 401 && tokens.borrowed) {
      tokens.invalidate()
      response = await send(url, init, headers)
      if (response.status === 401) {
        throw new StripeSignedOutError('The key from `stripe config --list` was rejected twice.')
      }
    }
    return response
  }

  async function settle<T>(response: Response): Promise<T> {
    if (!response.ok) throw await describeFailure(response)
    return (await response.json()) as T
  }

  async function get<T>(path: string, query: Params = {}): Promise<T> {
    const search = encodeParams(query).toString()
    const url = `${API_ROOT}${path}${search ? `?${search}` : ''}`
    return settle<T>(await authorized(url, { method: 'GET' }, {}))
  }

  // Retried on 429 and 5xx with jittered backoff: the idempotency key makes the repeat safe, and the SDK will not repeat a write itself.
  async function post<T>(path: string, form: Params, idempotency: string): Promise<T> {
    const body = encodeParams(form).toString()
    const init: RequestInit = { method: 'POST', body }
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': idempotency
    }
    for (let attempt = 0; ; attempt++) {
      const response = await authorized(`${API_ROOT}${path}`, init, headers)
      if (!isRetryable(response.status) || attempt >= POST_RETRIES) return settle<T>(response)
      await sleep(POST_BACKOFF_MS * 2 ** attempt * (0.5 + random()))
    }
  }

  // Every page of a list, newest first as Stripe returns it, following `starting_after` while `has_more`.
  async function list<T extends { id: string }>(
    path: string,
    query: Params,
    listOptions: ListOptions = {}
  ): Promise<T[]> {
    const maxPages = listOptions.maxPages ?? MAX_LIST_PAGES
    const collected: T[] = []
    let startingAfter: string | undefined
    for (let index = 0; index < maxPages; index++) {
      const page = await get<StripeList<T>>(path, {
        ...query,
        limit: MAX_PAGE_SIZE,
        ...(startingAfter !== undefined && { starting_after: startingAfter })
      })
      if (!Array.isArray(page.data)) {
        throw new Error(`Stripe answered ${path} with something other than a list`)
      }
      collected.push(...page.data)
      const last = page.data[page.data.length - 1]
      if (page.has_more !== true || last === undefined) break
      startingAfter = last.id
    }
    return collected
  }

  return { get, post, list }
}

export type StripeClient = ReturnType<typeof createStripeClient>

export interface PreflightResult {
  ok: boolean
  message?: string
}

// Whether this connector could run now: a key in hand, pasted or borrowed, that is not a publishable one.
export async function stripePreflight(options: TokenSourceOptions = {}): Promise<PreflightResult> {
  try {
    await createTokenSource(options).get()
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
