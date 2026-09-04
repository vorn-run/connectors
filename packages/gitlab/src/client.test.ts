import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GlabNotFoundError,
  GlabSignedOutError,
  MAX_LIST_PAGES,
  MAX_PAGE_SIZE,
  apiUrl,
  createGitLabClient,
  createTokenSource,
  gitlabPreflight,
  glabInstallHint,
  hostOf,
  normalizeBaseUrl,
  projectSegment,
  runGlab
} from './client'

/** A fake `glab` that answers with the tokens given, in order. */
function glabReturning(...tokens: string[]) {
  const calls: string[][] = []
  let next = 0
  return {
    calls,
    glab: async (args: string[]) => {
      calls.push(args)
      return tokens[Math.min(next++, tokens.length - 1)]
    }
  }
}

interface Reply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
  /** Raw text instead of JSON, for bodies that are not what they claim. */
  text?: string
}

/** A fetch that serves the replies given, in order, and records each request. */
function fetchReplying(...replies: Reply[]) {
  const sent: Array<{ url: string; headers: Record<string, string> }> = []
  let index = 0
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> })
    const reply = replies[Math.min(index++, replies.length - 1)]
    const body = reply.text ?? JSON.stringify(reply.body ?? {})
    return new Response(body, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers }
    })
  }) as unknown as typeof fetch
  return { fetchImpl, sent }
}

describe('normalizeBaseUrl', () => {
  it('defaults to gitlab.com when blank', () => {
    expect(normalizeBaseUrl(undefined)).toBe('https://gitlab.com')
    expect(normalizeBaseUrl('  ')).toBe('https://gitlab.com')
  })

  it('drops a trailing slash so /api/v4 is not doubled', () => {
    expect(normalizeBaseUrl('https://gitlab.example.com/')).toBe('https://gitlab.example.com')
    expect(normalizeBaseUrl('https://gitlab.example.com')).toBe('https://gitlab.example.com')
  })

  it('keeps a relative root, which self-managed instances can sit under', () => {
    expect(normalizeBaseUrl('https://example.com/gitlab/')).toBe('https://example.com/gitlab')
  })

  it('names the setting when the value is not a URL', () => {
    expect(() => normalizeBaseUrl('gitlab.example.com')).toThrow(/GITLAB_BASE_URL is not a URL/)
  })
})

describe('hostOf', () => {
  it('is the host glab keeps its login under, port included', () => {
    expect(hostOf('https://gitlab.com')).toBe('gitlab.com')
    expect(hostOf('https://gitlab.example.com:8443/')).toBe('gitlab.example.com:8443')
  })
})

describe('apiUrl', () => {
  it('roots the path at /api/v4 and leaves out empty query values', () => {
    expect(
      apiUrl('https://gitlab.com/', '/projects/1/issues', {
        state: 'all',
        created_after: undefined,
        ref: '',
        page: 2
      })
    ).toBe('https://gitlab.com/api/v4/projects/1/issues?state=all&page=2')
  })

  it('works without a query', () => {
    expect(apiUrl('https://gitlab.com', '/projects/1')).toBe('https://gitlab.com/api/v4/projects/1')
  })
})

describe('projectSegment', () => {
  it('URL-encodes a path and passes an id through', () => {
    expect(projectSegment('gitlab-org/gitlab')).toBe('gitlab-org%2Fgitlab')
    expect(projectSegment(' 278964 ')).toBe('278964')
  })

  it('names the setting when there is no project', () => {
    expect(() => projectSegment('')).toThrow('GITLAB_PROJECT is required')
    expect(() => projectSegment(undefined)).toThrow('GITLAB_PROJECT is required')
  })
})

describe('createTokenSource', () => {
  it('uses a pasted token as-is and never runs glab', async () => {
    const { glab, calls } = glabReturning('glpat-from-glab')
    const tokens = createTokenSource({ token: ' glpat-pasted ', glab })

    expect(tokens.borrowed).toBe(false)
    expect(await tokens.get()).toBe('glpat-pasted')
    // Invalidating a pasted token would only hand back the same one.
    tokens.invalidate()
    expect(await tokens.get()).toBe('glpat-pasted')
    expect(calls).toEqual([])
  })

  it('borrows from glab for the host the base URL names', async () => {
    const { glab, calls } = glabReturning('glpat-borrowed\n')
    const tokens = createTokenSource({ baseUrl: 'https://gitlab.example.com/', glab })

    expect(tokens.borrowed).toBe(true)
    expect(await tokens.get()).toBe('glpat-borrowed')
    expect(calls).toEqual([['config', 'get', 'token', '--host', 'gitlab.example.com']])
  })

  it('asks glab once and remembers the answer until invalidated', async () => {
    const { glab, calls } = glabReturning('first', 'second')
    const tokens = createTokenSource({ glab })

    expect(await tokens.get()).toBe('first')
    expect(await tokens.get()).toBe('first')
    expect(calls).toHaveLength(1)

    tokens.invalidate()
    expect(await tokens.get()).toBe('second')
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(['config', 'get', 'token', '--host', 'gitlab.com'])
  })

  it('treats an empty answer as signed out, naming the host', async () => {
    const { glab } = glabReturning('\n')
    const tokens = createTokenSource({ glab })

    const error = await tokens.get().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GlabSignedOutError)
    expect((error as Error).message).toContain('glab auth login')
    expect((error as Error).message).toContain('gitlab.com')
  })

  it('treats a blank pasted token as absent and borrows instead', async () => {
    const { glab, calls } = glabReturning('glpat-borrowed')
    const tokens = createTokenSource({ token: '   ', glab })

    expect(tokens.borrowed).toBe(true)
    expect(await tokens.get()).toBe('glpat-borrowed')
    expect(calls).toHaveLength(1)
  })
})

describe('createGitLabClient', () => {
  const config = { baseUrl: 'https://gitlab.com', token: 'glpat-pasted' }

  it('sends the bearer token and follows x-next-page to the end', async () => {
    const { fetchImpl, sent } = fetchReplying(
      { body: [{ id: 1 }], headers: { 'x-next-page': '2' } },
      { body: [{ id: 2 }], headers: { 'x-next-page': '' } }
    )
    const client = createGitLabClient({ config, fetch: fetchImpl })

    const items = await client.list<{ id: number }>('/projects/1/issues', { state: 'all' })

    expect(items).toEqual([{ id: 1 }, { id: 2 }])
    expect(sent).toHaveLength(2)
    expect(sent[0].headers.Authorization).toBe('Bearer glpat-pasted')
    expect(sent[0].url).toBe(
      `https://gitlab.com/api/v4/projects/1/issues?state=all&per_page=${MAX_PAGE_SIZE}&page=1`
    )
    expect(sent[1].url).toContain('page=2')
  })

  it('stops once it holds as many items as the caller can use', async () => {
    const { fetchImpl, sent } = fetchReplying({
      body: [{ id: 1 }, { id: 2 }],
      headers: { 'x-next-page': '2' }
    })
    const client = createGitLabClient({ config, fetch: fetchImpl })

    await client.list('/projects/1/issues', {}, { limit: 2 })

    expect(sent).toHaveLength(1)
  })

  it('stops at the page bound rather than walking a source forever', async () => {
    let page = 0
    const fetchImpl = vi.fn(async () => {
      page += 1
      return new Response(JSON.stringify([{ id: page }]), {
        headers: { 'content-type': 'application/json', 'x-next-page': String(page + 1) }
      })
    }) as unknown as typeof fetch
    const client = createGitLabClient({ config, fetch: fetchImpl })

    const items = await client.list('/projects/1/issues', {})

    expect(items).toHaveLength(MAX_LIST_PAGES)
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_LIST_PAGES)
  })

  it('ignores a next-page header that does not move forward', async () => {
    const { fetchImpl, sent } = fetchReplying({ body: [{ id: 1 }], headers: { 'x-next-page': '1' } })
    const client = createGitLabClient({ config, fetch: fetchImpl })

    await client.list('/projects/1/issues', {})

    expect(sent).toHaveLength(1)
  })

  it('refuses a list endpoint that answered with something else', async () => {
    const { fetchImpl } = fetchReplying({ body: { message: 'surprise' } })
    const client = createGitLabClient({ config, fetch: fetchImpl })

    await expect(client.list('/projects/1/issues', {})).rejects.toThrow(
      'GitLab answered /projects/1/issues with something other than a list'
    )
  })

  it('re-reads a borrowed token once when GitLab rejects it', async () => {
    const { glab, calls } = glabReturning('stale', 'fresh')
    const { fetchImpl, sent } = fetchReplying(
      { status: 401, body: { message: '401 Unauthorized' } },
      { body: [{ id: 1 }] }
    )
    const client = createGitLabClient({ config: { baseUrl: 'https://gitlab.com' }, fetch: fetchImpl, glab })

    const items = await client.list('/projects/1/issues', {})

    expect(items).toEqual([{ id: 1 }])
    expect(sent.map((call) => call.headers.Authorization)).toEqual(['Bearer stale', 'Bearer fresh'])
    expect(calls).toHaveLength(2)
  })

  it('reports a borrowed token rejected twice as signed out', async () => {
    const { glab } = glabReturning('stale')
    const { fetchImpl } = fetchReplying({ status: 401, body: { message: '401 Unauthorized' } })
    const client = createGitLabClient({ config: {}, fetch: fetchImpl, glab })

    const error = await client.list('/projects/1/issues', {}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GlabSignedOutError)
    expect((error as Error).message).toContain('rejected twice')
  })

  it('does not retry a pasted token, which would only be the same token', async () => {
    const { fetchImpl, sent } = fetchReplying({ status: 401, body: { message: '401 Unauthorized' } })
    const client = createGitLabClient({ config, fetch: fetchImpl })

    await expect(client.list('/projects/1/issues', {})).rejects.toThrow(
      /rejected the personal access token \(401\)/
    )
    expect(sent).toHaveLength(1)
  })

  it('quotes what GitLab said when a call fails', async () => {
    const { fetchImpl } = fetchReplying({ status: 403, body: { message: 'insufficient_scope' } })
    const client = createGitLabClient({ config, fetch: fetchImpl })

    await expect(client.list('/projects/1/issues', {})).rejects.toThrow('GitLab API 403: insufficient_scope')
  })

  it('reads the error key too, and structured messages as JSON', async () => {
    const withError = createGitLabClient({
      config,
      fetch: fetchReplying({ status: 400, body: { error: 'ref is invalid' } }).fetchImpl
    })
    await expect(withError.list('/p', {})).rejects.toThrow('GitLab API 400: ref is invalid')

    const structured = createGitLabClient({
      config,
      fetch: fetchReplying({ status: 400, body: { message: { title: ['is missing'] } } }).fetchImpl
    })
    await expect(structured.list('/p', {})).rejects.toThrow('GitLab API 400: {"title":["is missing"]}')
  })

  it('falls back to the raw body, or nothing, when the failure is not JSON', async () => {
    const html = createGitLabClient({
      config,
      fetch: fetchReplying({ status: 502, text: '<html>bad gateway</html>' }).fetchImpl
    })
    await expect(html.list('/p', {})).rejects.toThrow('GitLab API 502: <html>bad gateway</html>')

    const empty = createGitLabClient({ config, fetch: fetchReplying({ status: 500, text: '' }).fetchImpl })
    await expect(empty.list('/p', {})).rejects.toThrow(/^GitLab API 500$/)
  })

  it('truncates a long error body rather than quoting all of it', async () => {
    const { fetchImpl } = fetchReplying({ status: 400, body: { message: 'x'.repeat(400) } })
    const client = createGitLabClient({ config, fetch: fetchImpl })

    const error = await client.list('/p', {}).catch((caught: unknown) => caught as Error)
    expect((error as Error).message).toMatch(/x{300}…$/)
  })

  it('exposes the normalized base URL it was built on', () => {
    const client = createGitLabClient({
      config: { baseUrl: 'https://gitlab.example.com/' },
      fetch: fetchReplying({}).fetchImpl
    })
    expect(client.baseUrl).toBe('https://gitlab.example.com')
  })
})

describe('gitlabPreflight', () => {
  it('is ready when a token is in hand', async () => {
    const { glab, calls } = glabReturning('glpat-x')
    expect(await gitlabPreflight({ glab })).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
  })

  it('says what to run when glab is signed out', async () => {
    const { glab } = glabReturning('')
    const result = await gitlabPreflight({ glab })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('glab auth login')
  })

  it('reports the install hint when glab is missing', async () => {
    const glab = async () => {
      throw new GlabNotFoundError()
    }
    const result = await gitlabPreflight({ glab })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('glab) not found on PATH')
  })

  it('reports anything else verbatim rather than guessing', async () => {
    const glab = async () => {
      throw 'config is unreadable'
    }
    expect(await gitlabPreflight({ glab })).toEqual({ ok: false, message: 'config is unreadable' })
  })
})

describe('runGlab', () => {
  /**
   * Driven against a stub `glab` on PATH rather than the real one. The failure
   * translation is what matters here, and depending on the machine having the
   * CLI installed — and signed in — would make this pass or fail for reasons
   * that have nothing to do with the code.
   */
  async function withFakeGlab<T>(script: string, run: () => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'glab-stub-'))
    const bin = join(dir, 'glab')
    writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = dir
    try {
      // Awaited inside the try: restoring PATH before the spawn resolves would
      // mean the stub is gone by the time `glab` is actually looked up.
      return await run()
    } finally {
      process.env.PATH = path
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('returns what glab printed', async () => {
    await expect(
      withFakeGlab("echo 'glpat-token'", () => runGlab(['config', 'get', 'token']))
    ).resolves.toBe('glpat-token\n')
  })

  // ENOENT is the only signal that `glab` is absent; there is no probe that
  // does not itself cost a process spawn.
  it('reports the install hint when glab is not on PATH', async () => {
    const path = process.env.PATH
    process.env.PATH = '/nonexistent'
    try {
      await expect(runGlab(['--version'])).rejects.toBeInstanceOf(GlabNotFoundError)
    } finally {
      process.env.PATH = path
    }
  })

  // glab writes the useful part to stderr and exits non-zero. Surfacing only
  // "Command failed" would throw the reason away.
  it('surfaces what glab printed on stderr when it fails', async () => {
    await expect(
      withFakeGlab("echo 'no GitLab instances have been authenticated' >&2; exit 1", () =>
        runGlab(['auth', 'status'])
      )
    ).rejects.toThrow('no GitLab instances have been authenticated')
  })

  it('falls back to the error itself when glab printed nothing', async () => {
    await expect(withFakeGlab('exit 3', () => runGlab(['auth', 'status']))).rejects.toThrow(/3|failed/i)
  })
})

describe('glabInstallHint', () => {
  it('names the package manager for each platform', () => {
    expect(glabInstallHint('darwin')).toContain('brew install glab')
    expect(glabInstallHint('win32')).toContain('winget')
    expect(glabInstallHint('linux')).toContain('gitlab.com/gitlab-org/cli')
  })

  it('defaults to the platform this is running on', () => {
    expect(glabInstallHint()).toBe(glabInstallHint(process.platform))
  })
})

describe('the errors a user can act on', () => {
  it('say what to run', () => {
    expect(new GlabNotFoundError().message).toMatch(/glab\) not found on PATH/)
    expect(new GlabSignedOutError().message).toBe('Not signed in to GitLab. Run `glab auth login`.')
    expect(new GlabSignedOutError('because').message).toContain('\nbecause')
  })

  it('carry a code a caller can switch on', () => {
    expect(new GlabNotFoundError().code).toBe('GLAB_NOT_FOUND')
    expect(new GlabSignedOutError().code).toBe('GLAB_SIGNED_OUT')
  })
})
