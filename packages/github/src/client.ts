/**
 * GitHub's REST API, reached through Octokit, with credentials borrowed from
 * the GitHub CLI.
 *
 * The split is deliberate. `gh auth token` supplies the credential, so nothing
 * is ever pasted into a connection and the token stays wherever `gh` keeps it
 * — the same local-first arrangement `packages/ado` has with `az login`.
 * Octokit then does the calling, because it is GitHub's own client and already
 * handles pagination, secondary rate limits and the retry policy that a
 * hand-rolled `gh api` loop would have to re-derive per endpoint.
 *
 * The cost of borrowing a credential is that it can be rotated underneath us,
 * so a 401 re-reads the token once and retries rather than failing the poll.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Octokit } from '@octokit/rest'
import { retry } from '@octokit/plugin-retry'
import { throttling } from '@octokit/plugin-throttling'

const execFileAsync = promisify(execFile)

/** How long `gh` gets to answer before we give up on it. */
const GH_TIMEOUT_MS = 10_000

const PluggedOctokit = Octokit.plugin(retry, throttling)

/**
 * The client callers see.
 *
 * Named as `Octokit` rather than as the inferred plugin-augmented instance:
 * `retry` and `throttling` hook the request pipeline and add no methods, and
 * the inferred type cannot be written into a .d.ts without reaching into
 * `@octokit/plugin-rest-endpoint-methods` internals — which tsup refuses to
 * emit as non-portable, correctly.
 */
export type GitHubApi = Octokit

export function ghInstallHint(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'darwin':
      return 'Install with Homebrew: `brew install gh`'
    case 'win32':
      return 'Install with winget: `winget install --id GitHub.cli` (or download from https://cli.github.com)'
    default:
      return 'Install from https://cli.github.com (Debian/Ubuntu: `sudo apt install gh`)'
  }
}

export class GhNotFoundError extends Error {
  readonly code = 'GH_NOT_FOUND'
  constructor() {
    super(`GitHub CLI (gh) not found on PATH. ${ghInstallHint()}`)
    this.name = 'GhNotFoundError'
  }
}

export class GhSignedOutError extends Error {
  readonly code = 'GH_SIGNED_OUT'
  constructor(detail?: string) {
    super(`Not signed in to GitHub. Run \`gh auth login\`.${detail ? `\n${detail}` : ''}`)
    this.name = 'GhSignedOutError'
  }
}

export type RunGh = (args: string[]) => Promise<string>

/** Run `gh`, translating the two failures a user can actually do something about. */
export const runGh: RunGh = async (args) => {
  try {
    const { stdout } = await execFileAsync('gh', args, { timeout: GH_TIMEOUT_MS })
    return stdout
  } catch (error) {
    // ENOENT is the only way to learn `gh` is absent — there is no probe that
    // does not also cost a process spawn.
    if ((error as { code?: unknown }).code === 'ENOENT') throw new GhNotFoundError()
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim()
    throw new Error(stderr || (error instanceof Error ? error.message : String(error)))
  }
}

export interface TokenSourceOptions {
  /** Injected in tests, so nothing spawns a process. */
  gh?: RunGh
}

/**
 * The current GitHub token, cached until something rejects it.
 *
 * Cached because `gh auth token` is a process spawn and a poll makes several
 * calls; invalidated rather than expired because the CLI, not this connector,
 * knows when a token rotates — the only reliable signal we get is a 401.
 */
export function createTokenSource(options: TokenSourceOptions = {}) {
  const gh = options.gh ?? runGh
  let cached: string | undefined

  async function read(): Promise<string> {
    const token = (await gh(['auth', 'token'])).trim()
    if (!token) throw new GhSignedOutError()
    return token
  }

  return {
    async get(): Promise<string> {
      return (cached ??= await read())
    },
    /** Drop the cached token so the next `get()` asks `gh` again. */
    invalidate(): void {
      cached = undefined
    }
  }
}

export type TokenSource = ReturnType<typeof createTokenSource>

export interface GitHubClientOptions extends TokenSourceOptions {
  /** Injected in tests so no request leaves the process. */
  createApi?: (token: string) => GitHubApi
}

/** How many times a rate-limited request waits before giving up. */
export const MAX_RATE_LIMIT_RETRIES = 2

/**
 * Whether to wait out a rate limit and try again.
 *
 * Waiting is the correct response to GitHub's own limits, but only a bounded
 * number of times: the budget is shared with everything else the user has
 * authorised, and an unbounded retry would hold a poll open indefinitely
 * rather than failing and letting the next scheduled poll try.
 */
export function shouldRetryRateLimit(retryCount: number): boolean {
  return retryCount < MAX_RATE_LIMIT_RETRIES
}

/**
 * Octokit's throttle hooks. Both limits get the same answer, and it is built
 * here rather than inline so the decision is reachable without standing up a
 * client and provoking a real rate limit.
 */
export function throttleOptions(): {
  onRateLimit: (retryAfter: number, options: unknown, octokit: unknown, retryCount: number) => boolean
  onSecondaryRateLimit: (
    retryAfter: number,
    options: unknown,
    octokit: unknown,
    retryCount: number
  ) => boolean
} {
  const decide = (
    _retryAfter: number,
    _options: unknown,
    _octokit: unknown,
    retryCount: number
  ): boolean => shouldRetryRateLimit(retryCount)
  return { onRateLimit: decide, onSecondaryRateLimit: decide }
}

function defaultApi(token: string): GitHubApi {
  return new PluggedOctokit({ auth: token, throttle: throttleOptions() })
}

function isUnauthorized(error: unknown): boolean {
  return (error as { status?: unknown })?.status === 401
}

/**
 * An Octokit bound to the CLI's token, which re-authenticates itself once.
 *
 * Every call goes through `run`, so the 401 path is shared rather than
 * repeated per endpoint: read the token again, rebuild the client, try once
 * more. A second 401 is a real authorization problem and is reported as one.
 */
export function createGitHubClient(options: GitHubClientOptions = {}) {
  const tokens = createTokenSource(options)
  const makeApi = options.createApi ?? defaultApi
  let api: GitHubApi | undefined

  async function current(): Promise<GitHubApi> {
    return (api ??= makeApi(await tokens.get()))
  }

  return {
    async run<T>(call: (api: GitHubApi) => Promise<T>): Promise<T> {
      try {
        return await call(await current())
      } catch (error) {
        if (!isUnauthorized(error)) throw error
        // The token `gh` gave us is no longer accepted. It may simply have
        // rotated, which is invisible from here until exactly this moment.
        tokens.invalidate()
        api = undefined
        try {
          return await call(await current())
        } catch (retryError) {
          if (isUnauthorized(retryError)) {
            throw new GhSignedOutError('The token from `gh auth token` was rejected twice.')
          }
          throw retryError
        }
      }
    }
  }
}

export type GitHubClient = ReturnType<typeof createGitHubClient>

export interface PreflightResult {
  ok: boolean
  message?: string
}

/**
 * Whether this connector could run right now.
 *
 * Answers the two states a user can correct — `gh` missing, and `gh` present
 * but signed out — and says what to do about each. Anything else is reported
 * verbatim rather than guessed at.
 */
export async function githubPreflight(options: TokenSourceOptions = {}): Promise<PreflightResult> {
  try {
    await createTokenSource(options).get()
    return { ok: true }
  } catch (error) {
    if (error instanceof GhNotFoundError || error instanceof GhSignedOutError) {
      return { ok: false, message: error.message }
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
