import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GhNotFoundError,
  GhSignedOutError,
  createGitHubClient,
  createTokenSource,
  ghInstallHint,
  githubPreflight,
  runGh,
  shouldRetryRateLimit,
  throttleOptions,
  MAX_RATE_LIMIT_RETRIES,
  type GitHubApi
} from './client'

/** A fake `gh` that answers with the tokens given, in order. */
function ghReturning(...tokens: string[]) {
  const calls: string[][] = []
  let next = 0
  return {
    calls,
    gh: async (args: string[]) => {
      calls.push(args)
      return tokens[Math.min(next++, tokens.length - 1)]
    }
  }
}

function unauthorized(): Error {
  return Object.assign(new Error('Bad credentials'), { status: 401 })
}

describe('createTokenSource', () => {
  it('asks gh for the token', async () => {
    const { gh, calls } = ghReturning('ghp_one\n')
    expect(await createTokenSource({ gh }).get()).toBe('ghp_one')
    expect(calls[0]).toEqual(['auth', 'token'])
  })

  // Every call in a poll would otherwise spawn a process.
  it('caches, so a second read costs nothing', async () => {
    const { gh, calls } = ghReturning('ghp_one')
    const tokens = createTokenSource({ gh })
    await tokens.get()
    await tokens.get()
    expect(calls).toHaveLength(1)
  })

  it('asks again after being invalidated', async () => {
    const { gh, calls } = ghReturning('ghp_one', 'ghp_two')
    const tokens = createTokenSource({ gh })
    expect(await tokens.get()).toBe('ghp_one')
    tokens.invalidate()
    expect(await tokens.get()).toBe('ghp_two')
    expect(calls).toHaveLength(2)
  })

  // `gh auth token` exits 0 with nothing when signed out on some versions, so
  // an empty answer has to be read as signed out rather than as a token.
  it('treats an empty answer as signed out', async () => {
    const { gh } = ghReturning('   \n')
    await expect(createTokenSource({ gh }).get()).rejects.toBeInstanceOf(GhSignedOutError)
  })
})

describe('createGitHubClient', () => {
  it('passes the token to the client it builds', async () => {
    const { gh } = ghReturning('ghp_one')
    const seen: string[] = []
    const client = createGitHubClient({
      gh,
      createApi: (token) => {
        seen.push(token)
        return {} as GitHubApi
      }
    })
    await client.run(async () => 'ok')
    expect(seen).toEqual(['ghp_one'])
  })

  it('builds the client once across calls', async () => {
    const { gh } = ghReturning('ghp_one')
    const createApi = vi.fn(() => ({}) as GitHubApi)
    const client = createGitHubClient({ gh, createApi })
    await client.run(async () => 1)
    await client.run(async () => 2)
    expect(createApi).toHaveBeenCalledTimes(1)
  })

  /**
   * The whole cost of borrowing `gh`'s credential: it can rotate underneath
   * us, and a 401 is the only signal we get. Re-read once and retry, rather
   * than failing a poll over a token that was replaced a second ago.
   */
  it('re-reads the token and retries once on a 401', async () => {
    const { gh, calls } = ghReturning('stale', 'fresh')
    const used: string[] = []
    const client = createGitHubClient({
      gh,
      createApi: (token) => ({ token }) as unknown as GitHubApi
    })
    const result = await client.run(async (api) => {
      const token = (api as unknown as { token: string }).token
      used.push(token)
      if (token === 'stale') throw unauthorized()
      return 'recovered'
    })
    expect(result).toBe('recovered')
    expect(used).toEqual(['stale', 'fresh'])
    expect(calls).toHaveLength(2)
  })

  it('reports a second 401 as signed out rather than retrying forever', async () => {
    const { gh } = ghReturning('one', 'two')
    const client = createGitHubClient({ gh, createApi: () => ({}) as GitHubApi })
    const attempt = vi.fn(async () => {
      throw unauthorized()
    })
    await expect(client.run(attempt)).rejects.toBeInstanceOf(GhSignedOutError)
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  // A 404 is about the repo, not the credential. Re-reading the token would
  // hide the real error behind an auth message.
  it('does not retry an error that is not a 401', async () => {
    const { gh } = ghReturning('one')
    const client = createGitHubClient({ gh, createApi: () => ({}) as GitHubApi })
    const attempt = vi.fn(async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 })
    })
    await expect(client.run(attempt)).rejects.toThrow('Not Found')
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('surfaces a different error raised by the retry', async () => {
    const { gh } = ghReturning('one', 'two')
    const client = createGitHubClient({ gh, createApi: () => ({}) as GitHubApi })
    let call = 0
    await expect(
      client.run(async () => {
        call += 1
        throw call === 1 ? unauthorized() : Object.assign(new Error('gone'), { status: 410 })
      })
    ).rejects.toThrow('gone')
  })
})

describe('githubPreflight', () => {
  it('passes when gh answers with a token', async () => {
    const { gh } = ghReturning('ghp_one')
    expect(await githubPreflight({ gh })).toEqual({ ok: true })
  })

  // The message is the whole point of the check: it has to say what to do.
  it('reports how to install gh when it is missing', async () => {
    const result = await githubPreflight({
      gh: async () => {
        throw new GhNotFoundError()
      }
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('not found on PATH')
    expect(result.message).toContain(ghInstallHint())
  })

  it('reports how to sign in when gh is present but signed out', async () => {
    const result = await githubPreflight({ gh: async () => '' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('gh auth login')
  })

  it('describes a thrown non-Error rather than reporting [object Object]', async () => {
    const result = await githubPreflight({
      gh: async () => {
        throw 'keychain locked'
      }
    })
    expect(result).toEqual({ ok: false, message: 'keychain locked' })
  })

  it('passes an unexpected failure through rather than guessing at it', async () => {
    const result = await githubPreflight({
      gh: async () => {
        throw new Error('keychain is locked')
      }
    })
    expect(result).toEqual({ ok: false, message: 'keychain is locked' })
  })
})


describe('runGh', () => {
  /**
   * Driven against a stub `gh` on PATH rather than the real one. The failure
   * translation is what matters here, and depending on the machine having the
   * CLI installed — and signed in — would make this pass or fail for reasons
   * that have nothing to do with the code.
   */
  async function withFakeGh<T>(script: string, run: () => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'gh-stub-'))
    const bin = join(dir, 'gh')
    writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = dir
    try {
      // Awaited inside the try: restoring PATH before the spawn resolves would
      // mean the stub is gone by the time `gh` is actually looked up.
      return await run()
    } finally {
      process.env.PATH = path
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('returns what gh printed', async () => {
    await expect(withFakeGh("echo 'ghp_token'", () => runGh(['auth', 'token']))).resolves.toBe(
      'ghp_token\n'
    )
  })

  // ENOENT is the only signal that `gh` is absent; there is no probe that does
  // not itself cost a process spawn.
  it('reports the install hint when gh is not on PATH', async () => {
    const path = process.env.PATH
    process.env.PATH = '/nonexistent'
    try {
      await expect(runGh(['--version'])).rejects.toBeInstanceOf(GhNotFoundError)
    } finally {
      process.env.PATH = path
    }
  })

  // gh writes the useful part to stderr and exits non-zero. Surfacing only
  // "Command failed" would throw the reason away.
  it('surfaces what gh printed on stderr when it fails', async () => {
    await expect(
      withFakeGh("echo 'you are not logged in' >&2; exit 1", () => runGh(['auth', 'token']))
    ).rejects.toThrow('you are not logged in')
  })

  it('falls back to the error itself when gh printed nothing', async () => {
    await expect(withFakeGh('exit 3', () => runGh(['auth', 'token']))).rejects.toThrow(/3|failed/i)
  })
})

describe('ghInstallHint', () => {
  it('names the package manager for each platform', () => {
    expect(ghInstallHint('darwin')).toContain('brew')
    expect(ghInstallHint('win32')).toContain('winget')
    expect(ghInstallHint('linux')).toContain('cli.github.com')
  })
})

describe('throttleOptions', () => {
  it('applies the same bounded policy to both of GitHub\'s limits', () => {
    const { onRateLimit, onSecondaryRateLimit } = throttleOptions()
    expect(onRateLimit(1, {}, {}, 0)).toBe(true)
    expect(onRateLimit(1, {}, {}, MAX_RATE_LIMIT_RETRIES)).toBe(false)
    expect(onSecondaryRateLimit(1, {}, {}, 0)).toBe(true)
    expect(onSecondaryRateLimit(1, {}, {}, MAX_RATE_LIMIT_RETRIES)).toBe(false)
  })
})

describe('shouldRetryRateLimit', () => {
  // Waiting out GitHub's limit is right; waiting forever holds a poll open
  // against a budget shared with everything else the user authorised.
  it('waits a bounded number of times', () => {
    expect(shouldRetryRateLimit(0)).toBe(true)
    expect(shouldRetryRateLimit(MAX_RATE_LIMIT_RETRIES - 1)).toBe(true)
    expect(shouldRetryRateLimit(MAX_RATE_LIMIT_RETRIES)).toBe(false)
  })
})

describe('the default gh runner', () => {
  // Nothing passes `gh`, so this is the only test that exercises the wiring
  // from the token source to the real runner.
  it('is used when no runner is injected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-stub-'))
    writeFileSync(join(dir, 'gh'), "#!/bin/sh\necho 'ghp_default'\n", { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = dir
    try {
      expect(await createTokenSource().get()).toBe('ghp_default')
    } finally {
      process.env.PATH = path
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the client it builds by default', () => {
  it('constructs a real Octokit rather than requiring one to be injected', async () => {
    // Proves the default path is wired: no createApi, so client.ts builds the
    // Octokit itself. The call is never made, so nothing reaches the network.
    const client = createGitHubClient({ gh: async () => 'ghp_token' })
    const seen = await client.run(async (api) => typeof api.rest.issues.create)
    expect(seen).toBe('function')
  })
})
