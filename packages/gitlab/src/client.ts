/**
 * GitLab's REST API, with the credential borrowed from the GitLab CLI.
 *
 * The connector keeps no token of its own unless someone pastes one. When the
 * `token` field is empty it asks `glab config get token --host <host>` — the
 * documented, machine-readable way to read what `glab auth login` stored —
 * and sends the answer as `Authorization: Bearer`. Bearer rather than
 * `PRIVATE-TOKEN` because `glab auth login --web` stores an OAuth token, which
 * the `PRIVATE-TOKEN` header does not accept; a personal access token is fine
 * either way.
 *
 * A borrowed credential can rotate underneath us — OAuth tokens live two hours
 * — so a 401 re-reads it once and retries before giving up.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ConnectorConfig } from '@vornrun/connector-sdk'

const execFileAsync = promisify(execFile)

/** How long `glab` gets to answer before we give up on it. */
const GLAB_TIMEOUT_MS = 10_000

/** Where the API lives on every instance: "the root endpoint path must begin with /api/v4". */
const API_PATH = '/api/v4'

export const DEFAULT_BASE_URL = 'https://gitlab.com'

/** The documented maximum for `per_page`; the default is 20. */
export const MAX_PAGE_SIZE = 100

/** How much of an error body to quote back. Enough to name the cause. */
const MAX_ERROR_BODY = 300

export function glabInstallHint(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'darwin':
      return 'Install with Homebrew: `brew install glab`'
    case 'win32':
      return 'Install with winget: `winget install glab.glab` (or see https://gitlab.com/gitlab-org/cli)'
    default:
      return 'Install from https://gitlab.com/gitlab-org/cli (releases carry .deb, .rpm and tarballs)'
  }
}

export class GlabNotFoundError extends Error {
  readonly code = 'GLAB_NOT_FOUND'
  constructor() {
    super(`GitLab CLI (glab) not found on PATH. ${glabInstallHint()}`)
    this.name = 'GlabNotFoundError'
  }
}

export class GlabSignedOutError extends Error {
  readonly code = 'GLAB_SIGNED_OUT'
  constructor(detail?: string) {
    super(`Not signed in to GitLab. Run \`glab auth login\`.${detail ? `\n${detail}` : ''}`)
    this.name = 'GlabSignedOutError'
  }
}

export type RunGlab = (args: string[]) => Promise<string>

/** Run `glab`, translating the two failures a user can actually do something about. */
export const runGlab: RunGlab = async (args) => {
  try {
    const { stdout } = await execFileAsync('glab', args, { timeout: GLAB_TIMEOUT_MS })
    return stdout
  } catch (error) {
    // ENOENT is the only way to learn `glab` is absent — there is no probe
    // that does not also cost a process spawn.
    if ((error as { code?: unknown }).code === 'ENOENT') throw new GlabNotFoundError()
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim()
    throw new Error(stderr || (error instanceof Error ? error.message : String(error)))
  }
}

/** The instance URL with nothing after the host (or the relative root), trailing slash gone. */
export function normalizeBaseUrl(value: unknown): string {
  const trimmed = String(value ?? '').trim()
  const base = trimmed === '' ? DEFAULT_BASE_URL : trimmed
  let url: URL
  try {
    url = new URL(base)
  } catch {
    throw new Error(`GITLAB_BASE_URL is not a URL: "${base}"`)
  }
  return url.toString().replace(/\/+$/, '')
}

/** The `--host` `glab` keeps its login under: the host as typed at `glab auth login`. */
export function hostOf(baseUrl: string): string {
  return new URL(normalizeBaseUrl(baseUrl)).host
}

export function apiUrl(baseUrl: string, path: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}${API_PATH}${path}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/** A project path is sent URL-encoded (`group%2Fproject`); a numeric id passes through. */
export function projectSegment(project: unknown): string {
  const value = String(project ?? '').trim()
  if (!value) throw new Error('GITLAB_PROJECT is required')
  return encodeURIComponent(value)
}

export interface TokenSourceOptions {
  /** A personal access token from the connection. When set, `glab` is never run. */
  token?: string
  /** The instance the token must belong to. */
  baseUrl?: string
  /** Injected in tests, so nothing spawns a process. */
  glab?: RunGlab
}

/**
 * The current GitLab token, cached until something rejects it.
 *
 * Cached because `glab config get token` is a process spawn and a poll makes
 * several calls; invalidated rather than expired because the CLI, not this
 * connector, knows when a token rotates — the only reliable signal is a 401.
 * A pasted token is never invalidated: re-reading it would give the same one.
 */
export function createTokenSource(options: TokenSourceOptions = {}) {
  const glab = options.glab ?? runGlab
  const pasted = String(options.token ?? '').trim()
  const host = hostOf(options.baseUrl ?? DEFAULT_BASE_URL)
  let cached: string | undefined = pasted || undefined

  async function read(): Promise<string> {
    // `config get` prints nothing when the key is unset, so an empty answer is
    // the same fact as `glab auth status` failing: nobody is signed in here.
    const token = (await glab(['config', 'get', 'token', '--host', host])).trim()
    if (!token) throw new GlabSignedOutError(`glab has no token for ${host}.`)
    return token
  }

  return {
    /** Whether the token came from `glab`, and so could be re-read. */
    borrowed: !pasted,
    async get(): Promise<string> {
      return (cached ??= await read())
    },
    /** Drop a borrowed token so the next `get()` asks `glab` again. */
    invalidate(): void {
      if (!pasted) cached = undefined
    }
  }
}

export type TokenSource = ReturnType<typeof createTokenSource>

/** What a failed response said, as GitLab phrases it (`message` or `error`). */
async function describeFailure(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  let detail = text
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown }
    const message = parsed.message ?? parsed.error
    if (message !== undefined) detail = typeof message === 'string' ? message : JSON.stringify(message)
  } catch {
    // Not JSON; the raw text says what it says.
  }
  const quoted = detail.length > MAX_ERROR_BODY ? `${detail.slice(0, MAX_ERROR_BODY)}…` : detail
  return `GitLab API ${response.status}${quoted ? `: ${quoted}` : ''}`
}

export interface GitLabClientOptions {
  config: ConnectorConfig
  /** The SDK's fetch, which already retries rate limits and gateway hiccups. */
  fetch: typeof fetch
  tokens?: TokenSource
  glab?: RunGlab
}

export interface ListOptions {
  /** Stop once this many items are in hand; the SDK truncates to it anyway. */
  limit?: number
  /** Longest chain of pages one call follows. */
  maxPages?: number
}

/** Pages a single poll follows before leaving the rest for the next one. */
export const MAX_LIST_PAGES = 10

/**
 * A client bound to the connection's token, which re-authenticates itself once.
 *
 * Every call goes through `get`, so the 401 path is shared rather than
 * repeated per endpoint: read the token again, try once more. A second 401 is
 * a real authorization problem and is reported as one.
 */
export function createGitLabClient(options: GitLabClientOptions) {
  const baseUrl = normalizeBaseUrl(options.config.baseUrl)
  const tokens =
    options.tokens ??
    createTokenSource({
      ...(options.config.token !== undefined && { token: options.config.token }),
      baseUrl,
      ...(options.glab && { glab: options.glab })
    })

  async function send(url: string): Promise<Response> {
    const token = await tokens.get()
    return options.fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  }

  async function get(url: string): Promise<Response> {
    let response = await send(url)
    if (response.status === 401 && tokens.borrowed) {
      // The token `glab` gave us is no longer accepted. It may simply have
      // rotated, which is invisible from here until exactly this moment.
      tokens.invalidate()
      response = await send(url)
      if (response.status === 401) {
        throw new GlabSignedOutError('The token from `glab config get token` was rejected twice.')
      }
    }
    if (response.status === 401) {
      throw new Error(
        'GitLab rejected the personal access token (401). Check it has not expired and carries the api or read_api scope.'
      )
    }
    if (!response.ok) throw new Error(await describeFailure(response))
    return response
  }

  return {
    baseUrl,
    /** One GET, parsed as JSON. Whatever shape comes back is the caller's to judge. */
    async getJson<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
      const response = await get(apiUrl(baseUrl, path, query))
      return (await response.json()) as T
    },
    /**
     * Every page of a list endpoint, following `x-next-page` (empty when there
     * is no next page). Never `x-total`: lists over 10,000 records omit it.
     */
    async list<T>(
      path: string,
      query: Record<string, string | number | undefined>,
      listOptions: ListOptions = {}
    ): Promise<T[]> {
      const maxPages = listOptions.maxPages ?? MAX_LIST_PAGES
      const collected: T[] = []
      let page = 1
      for (let index = 0; index < maxPages; index++) {
        const response = await get(apiUrl(baseUrl, path, { ...query, per_page: MAX_PAGE_SIZE, page }))
        const items = (await response.json()) as unknown
        if (!Array.isArray(items)) {
          throw new Error(`GitLab answered ${path} with something other than a list`)
        }
        collected.push(...(items as T[]))
        if (listOptions.limit !== undefined && collected.length >= listOptions.limit) break
        const next = Number(response.headers.get('x-next-page') ?? '')
        if (!Number.isInteger(next) || next <= page) break
        page = next
      }
      return collected
    }
  }
}

export type GitLabClient = ReturnType<typeof createGitLabClient>

export interface PreflightResult {
  ok: boolean
  message?: string
}

/**
 * Whether this connector could run right now.
 *
 * Answers the states a user can correct — `glab` missing, `glab` present but
 * signed out — and says what to do about each. Anything else is reported
 * verbatim rather than guessed at. A pasted token is taken at its word: the
 * first request will say if GitLab disagrees.
 */
export async function gitlabPreflight(options: TokenSourceOptions = {}): Promise<PreflightResult> {
  try {
    await createTokenSource(options).get()
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
