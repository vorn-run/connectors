import { describe, expect, it, vi } from 'vitest'
import { createConnectorHarness, type ConnectorConfig, type ConnectorItem } from '@vornrun/connector-sdk'
import { createGitLabConnector } from './connector'
import { SAMPLE_ISSUE, SAMPLE_MERGE_REQUEST, SAMPLE_PIPELINE } from './items'

const NOW = '2026-09-04T04:00:00.000Z'
const CONFIG: ConnectorConfig = {
  baseUrl: 'https://gitlab.com',
  project: 'gitlab-org/gitlab',
  token: 'glpat-pasted'
}

interface Sent {
  method: string
  url: string
  headers: Record<string, string>
  body?: unknown
}

interface Route {
  /** Matched against the whole URL. */
  when: RegExp
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

/**
 * A fake gitlab.com driven by the URL being asked for.
 *
 * Responses are chosen by matching the URL rather than by call order, so a
 * test says what the service holds and then asserts on what the connector
 * asked and what it made of the answer.
 */
function gitlabServing(routes: Route[]) {
  const sent: Sent[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    sent.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      url,
      headers,
      ...(typeof init?.body === 'string' && { body: JSON.parse(init.body) })
    })
    const route = routes.find((candidate) => candidate.when.test(url))
    if (!route) throw new Error(`No fake route for ${url}`)
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...route.headers }
    })
  }) as unknown as typeof fetch
  return { fetchImpl, sent }
}

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

function harnessOver(
  routes: Route[],
  options: { config?: ConnectorConfig; glab?: (args: string[]) => Promise<string> } = {}
) {
  const { fetchImpl, sent } = gitlabServing(routes)
  const connector = createGitLabConnector({ ...(options.glab && { glab: options.glab }) })
  const harness = createConnectorHarness(connector, {
    config: options.config ?? CONFIG,
    now: () => NOW,
    fetchImpl
  })
  return { connector, harness, sent }
}

const query = (url: string) => Object.fromEntries(new URL(url).searchParams)

describe('the definition', () => {
  const connector = createGitLabConnector({ version: '1.2.3' })

  it('borrows the GitLab CLI login exactly as the spec declares it', () => {
    expect(connector.auth).toEqual({
      rung: 'cli',
      probe: { command: 'glab', args: ['auth', 'status'] },
      borrow: {
        env: ['GITLAB_TOKEN'],
        tokenArgs: ['glab', 'config', 'get', 'token'],
        tokenEnv: 'GITLAB_TOKEN'
      }
    })
  })

  it('reads the borrowed variable as its own token field, marked secret', () => {
    const token = connector.config.find((field) => field.key === 'token')
    expect(token).toMatchObject({ env: 'GITLAB_TOKEN', secret: true })
    expect(token?.required).not.toBe(true)
    expect(connector.config.map((field) => field.env)).toEqual([
      'GITLAB_BASE_URL',
      'GITLAB_PROJECT',
      'GITLAB_TOKEN',
      'GITLAB_REF'
    ])
    expect(connector.config.find((field) => field.key === 'baseUrl')?.default).toBe('https://gitlab.com')
  })

  it('leaves a hint for whoever builds on it, on every setting and every input', () => {
    for (const field of connector.config) expect(field.builderHint).toBeTruthy()
    const hinted = connector.actions.flatMap((action) => action.inputs ?? []).filter((input) => input.builderHint)
    expect(hinted.map((input) => input.key)).toEqual(
      expect.arrayContaining(['project', 'labels', 'internal', 'limit'])
    )
  })

  it('names the version it was built with', () => {
    expect(connector.version).toBe('1.2.3')
    expect(createGitLabConnector().version).toBe('0.0.0')
  })

  it('polls three things and dedupes each on a timestamp', () => {
    expect(connector.triggers.map((trigger) => [trigger.type, trigger.dedupe])).toEqual([
      ['issueCreated', 'timestamp'],
      ['mergeRequestOpened', 'timestamp'],
      ['pipelineFinished', 'timestamp']
    ])
    for (const trigger of connector.triggers) expect(trigger.sample).toHaveLength(1)
  })

  it('marks the reads idempotent and gives each a real sample to call with', () => {
    const byType = Object.fromEntries(connector.actions.map((action) => [action.type, action]))
    expect(byType.getProject.sample).toEqual({ project: 'gitlab-org/gitlab' })
    expect(byType.listOpenMergeRequests.sample).toEqual({ project: 'gitlab-org/gitlab' })
    expect(byType.getIssue.sample).toEqual({ project: 'gitlab-org/gitlab', iid: '1' })
    expect(
      connector.actions.map((action) => [action.type, action.idempotent, action.sample !== undefined])
    ).toEqual([
      ['createIssue', false, false],
      ['commentOnIssue', false, false],
      ['commentOnMergeRequest', false, false],
      ['getProject', true, true],
      ['listOpenMergeRequests', true, true],
      ['getIssue', true, true]
    ])
  })

  it('declares every action but the merge request list as a request the SDK sends', () => {
    for (const action of connector.actions) {
      if (action.type === 'listOpenMergeRequests') {
        // Hand-written: a declared request cannot count what it returns.
        expect(action.request).toBeUndefined()
        expect(typeof action.run).toBe('function')
        continue
      }
      expect(action.request?.url).toMatch(/^\{\{config\.baseUrl\}\}\/api\/v4\//)
      expect(action.request?.headers).toEqual({ Authorization: 'Bearer {{config.token}}' })
      expect(action.postReceive?.length).toBeGreaterThan(0)
    }
  })
})

describe('polling issues', () => {
  const issues = (body: unknown, headers?: Record<string, string>): Route[] => [
    { when: /\/issues\?/, body, ...(headers && { headers }) }
  ]

  it('asks for every issue created in the project, oldest first, with the bearer token', async () => {
    const { harness, sent } = harnessOver(issues([SAMPLE_ISSUE]))

    const page = await harness.poll('issueCreated')

    expect(sent).toHaveLength(1)
    expect(sent[0].url).toMatch(/^https:\/\/gitlab\.com\/api\/v4\/projects\/gitlab-org%2Fgitlab\/issues\?/)
    expect(query(sent[0].url)).toEqual({
      state: 'all',
      order_by: 'created_at',
      sort: 'asc',
      created_after: '2026-09-04T03:59:00.000Z',
      per_page: '100',
      page: '1'
    })
    expect(sent[0].headers.Authorization).toBe('Bearer glpat-pasted')
    expect(page.items.map((item) => item.externalId)).toEqual(['627684'])
    expect(page.items[0].updatedAt).toBe('2026-09-04T02:23:26.054Z')
    expect(page.nextCursor).toBeDefined()
  })

  it('does not deliver the same issue twice, even though GitLab returns it on the boundary', async () => {
    const { harness, sent } = harnessOver(issues([SAMPLE_ISSUE]))

    expect(await harness.pollTwice('issueCreated')).toEqual([])
    // The second poll carried the watermark as the inclusive lower bound.
    expect(query(sent[1].url).created_after).toBe('2026-09-04T02:23:26.054Z')
  })

  it('bounds the very first poll to the minute before it rather than replaying the project', async () => {
    const { harness, sent } = harnessOver(issues([]))

    const page = await harness.poll('issueCreated')

    expect(query(sent[0].url).created_after).toBe('2026-09-04T03:59:00.000Z')
    expect(page.items).toEqual([])
  })

  it('passes the host-supplied lower bound as created_after', async () => {
    const { harness, sent } = harnessOver(issues([]))

    await harness.poll('issueCreated', { since: '2026-09-01T00:00:00.000Z' })

    expect(query(sent[0].url).created_after).toBe('2026-09-01T00:00:00.000Z')
  })

  it('stops paging once it holds as many as the host asked for', async () => {
    const { harness, sent } = harnessOver(issues([SAMPLE_ISSUE, { ...SAMPLE_ISSUE, iid: 1 }], { 'x-next-page': '2' }))

    const page = await harness.poll('issueCreated', { limit: 1 })

    expect(sent).toHaveLength(1)
    expect(page.items).toHaveLength(1)
  })

  it('follows x-next-page when there is more', async () => {
    const { harness, sent } = harnessOver([
      { when: /&page=1$/, body: [SAMPLE_ISSUE], headers: { 'x-next-page': '2' } },
      { when: /&page=2$/, body: [{ ...SAMPLE_ISSUE, iid: 627685, created_at: '2026-09-04T02:30:00.000Z' }] }
    ])

    const page = await harness.poll('issueCreated')

    expect(sent).toHaveLength(2)
    expect(page.items.map((item) => item.externalId)).toEqual(['627684', '627685'])
  })

  it('refuses to poll without a project rather than asking GitLab for nothing', async () => {
    const { harness, sent } = harnessOver(issues([]), { config: { ...CONFIG, project: ' ' } })

    await expect(harness.poll('issueCreated')).rejects.toThrow('GITLAB_PROJECT is required')
    expect(sent).toHaveLength(0)
  })

  it('accepts a numeric project id and a self-managed instance', async () => {
    const { harness, sent } = harnessOver(issues([]), {
      config: { baseUrl: 'https://gitlab.example.com/', project: '278964', token: 't' }
    })

    await harness.poll('issueCreated')

    expect(sent[0].url).toMatch(/^https:\/\/gitlab\.example\.com\/api\/v4\/projects\/278964\/issues\?/)
  })
})

describe('polling merge requests', () => {
  it('asks for every merge request created in the project and keys on its iid', async () => {
    const { harness, sent } = harnessOver([{ when: /\/merge_requests\?/, body: [SAMPLE_MERGE_REQUEST] }])

    const page = await harness.poll('mergeRequestOpened')

    expect(sent[0].url).toMatch(/\/projects\/gitlab-org%2Fgitlab\/merge_requests\?/)
    expect(query(sent[0].url)).toMatchObject({ state: 'all', order_by: 'created_at', sort: 'asc' })
    expect(page.items[0]).toMatchObject({
      externalId: '253583',
      status: 'opened',
      sourceBranch: 'wt/telemetry-zero-result',
      updatedAt: '2026-09-04T03:07:05.722Z'
    })
    expect(await harness.pollTwice('mergeRequestOpened')).toEqual([])
  })

  it('honours the limit the host asks for', async () => {
    const { harness, sent } = harnessOver([
      { when: /\/merge_requests\?/, body: [SAMPLE_MERGE_REQUEST], headers: { 'x-next-page': '2' } }
    ])

    await harness.poll('mergeRequestOpened', { limit: 1 })

    expect(sent).toHaveLength(1)
  })
})

describe('polling pipelines', () => {
  const running = { ...SAMPLE_PIPELINE, id: 1, status: 'running', updated_at: '2026-09-04T03:20:00.000Z' }
  const failed = { ...SAMPLE_PIPELINE, id: 2, status: 'failed', updated_at: '2026-09-04T03:15:00.000Z' }

  it('delivers only finished pipelines, with the status on the item', async () => {
    const { harness, sent } = harnessOver([{ when: /\/pipelines\?/, body: [SAMPLE_PIPELINE, running, failed] }])

    const page = await harness.poll('pipelineFinished')

    expect(query(sent[0].url)).toEqual({
      order_by: 'updated_at',
      sort: 'asc',
      updated_after: '2026-09-04T03:59:00.000Z',
      per_page: '100',
      page: '1'
    })
    expect(page.items.map((item) => [item.externalId, item.status])).toEqual([
      ['2818962738', 'success'],
      ['2', 'failed']
    ])
  })

  it('fires for a pipeline once it finishes, without having remembered it while running', async () => {
    let finished = false
    const { fetchImpl, sent } = gitlabServing([])
    const fetchWhenAsked = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void fetchImpl
      sent.push({ method: 'GET', url: String(input), headers: (init?.headers ?? {}) as Record<string, string> })
      const body = finished ? [{ ...running, status: 'success', updated_at: '2026-09-04T03:30:00.000Z' }] : [running]
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const harness = createConnectorHarness(createGitLabConnector(), { config: CONFIG, now: () => NOW, fetchImpl: fetchWhenAsked })

    const first = await harness.poll('pipelineFinished')
    expect(first.items).toEqual([])

    finished = true
    const second = await harness.poll('pipelineFinished', { cursor: first.nextCursor })
    expect(second.items.map((item) => item.status)).toEqual(['success'])
  })

  it('narrows to one ref when the connection names it, and not otherwise', async () => {
    const withRef = harnessOver([{ when: /\/pipelines\?/, body: [] }], { config: { ...CONFIG, ref: 'main' } })
    await withRef.harness.poll('pipelineFinished')
    expect(query(withRef.sent[0].url).ref).toBe('main')

    const blank = harnessOver([{ when: /\/pipelines\?/, body: [] }], { config: { ...CONFIG, ref: '  ' } })
    await blank.harness.poll('pipelineFinished')
    expect(query(blank.sent[0].url).ref).toBeUndefined()
  })

  it('passes the watermark as updated_after on the next poll', async () => {
    const { harness, sent } = harnessOver([{ when: /\/pipelines\?/, body: [failed] }])

    expect(await harness.pollTwice('pipelineFinished')).toEqual([])
    expect(query(sent[1].url).updated_after).toBe('2026-09-04T03:15:00.000Z')
  })
})

describe('borrowing the token from glab', () => {
  const noToken: ConnectorConfig = { baseUrl: 'https://gitlab.example.com', project: 'g/p' }

  it('asks glab for the host the connection points at, once, and reuses the answer', async () => {
    const { glab, calls } = glabReturning('glpat-borrowed')
    const { harness, sent } = harnessOver([{ when: /\/issues\?/, body: [] }], { config: noToken, glab })

    await harness.poll('issueCreated')
    await harness.poll('mergeRequestOpened' as never).catch(() => undefined)
    await harness.poll('issueCreated')

    expect(calls).toEqual([['config', 'get', 'token', '--host', 'gitlab.example.com']])
    expect(sent[0].headers.Authorization).toBe('Bearer glpat-borrowed')
  })

  it('keeps one token per instance when connections differ', async () => {
    const { glab, calls } = glabReturning('one', 'two')
    const { fetchImpl } = gitlabServing([{ when: /\/issues\?/, body: [] }])
    const connector = createGitLabConnector({ glab })

    await createConnectorHarness(connector, { config: noToken, fetchImpl }).poll('issueCreated')
    await createConnectorHarness(connector, { config: { ...noToken, baseUrl: 'https://gitlab.com' }, fetchImpl }).poll(
      'issueCreated'
    )

    expect(calls.map((args) => args.at(-1))).toEqual(['gitlab.example.com', 'gitlab.com'])
  })

  it('reads the token again when GitLab stops accepting it', async () => {
    const { glab, calls } = glabReturning('stale', 'fresh')
    const { harness, sent } = harnessOver(
      [
        { when: /\/issues\?/, status: 401, body: { message: '401 Unauthorized' } }
      ],
      { config: noToken, glab }
    )
    // The first answer is a 401 and so is the second: the error names the cause.
    await expect(harness.poll('issueCreated')).rejects.toThrow(/Not signed in to GitLab/)
    expect(calls).toHaveLength(2)
    expect(sent.map((call) => call.headers.Authorization)).toEqual(['Bearer stale', 'Bearer fresh'])
  })

  it('says what to run when glab has nothing for the host', async () => {
    const { glab } = glabReturning('')
    const { harness } = harnessOver([{ when: /\/issues\?/, body: [] }], { config: noToken, glab })

    await expect(harness.poll('issueCreated')).rejects.toThrow(/Run `glab auth login`/)
  })
})

describe('preflight', () => {
  it('is ready when GITLAB_TOKEN is set, without running glab', async () => {
    const { glab, calls } = glabReturning('unused')
    const connector = createGitLabConnector({ glab, env: { GITLAB_TOKEN: 'glpat-x' } })

    expect(await connector.preflight!()).toEqual({ ok: true })
    expect(calls).toEqual([])
  })

  it('asks glab for the instance GITLAB_BASE_URL names when there is no token', async () => {
    const { glab, calls } = glabReturning('glpat-borrowed')
    const connector = createGitLabConnector({
      glab,
      env: { GITLAB_TOKEN: '  ', GITLAB_BASE_URL: 'https://gitlab.example.com/' }
    })

    expect(await connector.preflight!()).toEqual({ ok: true })
    expect(calls).toEqual([['config', 'get', 'token', '--host', 'gitlab.example.com']])
  })

  it('defaults to gitlab.com and says what to do when signed out', async () => {
    const { glab, calls } = glabReturning('')
    const connector = createGitLabConnector({ glab, env: {} })

    const result = await connector.preflight!()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('glab auth login')
    expect(calls[0]).toEqual(['config', 'get', 'token', '--host', 'gitlab.com'])
  })

  it('reads the process environment when none is given', async () => {
    const connector = createGitLabConnector({ glab: glabReturning('').glab })
    const before = process.env.GITLAB_TOKEN
    process.env.GITLAB_TOKEN = 'glpat-from-env'
    try {
      expect(await connector.preflight!()).toEqual({ ok: true })
    } finally {
      if (before === undefined) delete process.env.GITLAB_TOKEN
      else process.env.GITLAB_TOKEN = before
    }
  })
})

describe('actions', () => {
  const project = { id: 278964, name: 'GitLab', path: 'gitlab', path_with_namespace: 'gitlab-org/gitlab', name_with_namespace: 'GitLab.org / GitLab', default_branch: 'master', visibility: 'public', web_url: 'https://gitlab.com/gitlab-org/gitlab', http_url_to_repo: 'https://gitlab.com/gitlab-org/gitlab.git', ssh_url_to_repo: 'git@gitlab.com:gitlab-org/gitlab.git', created_at: '2015-05-20T10:47:11.949Z', last_activity_at: '2026-09-04T02:39:11.259Z', archived: false, namespace: { id: 9970, name: 'GitLab.org', path: 'gitlab-org', kind: 'group', full_path: 'gitlab-org', avatar_url: null }, star_count: 6130, forks_count: 12375, topics: ['hacktoberfest', 'javascript', 'ruby', 'vue.js'], open_issues_count: 50000 }
  const note = { id: 301, body: 'Comment text', author: { id: 1, username: 'pipin', name: 'Pipin', state: 'active' }, created_at: '2013-10-02T08:57:14Z', updated_at: '2013-10-02T08:57:14Z', system: false, noteable_id: 2, noteable_type: 'MergeRequest', noteable_iid: 2, internal: false, resolvable: false }

  it('reads a project by its encoded path and returns it under readable names', async () => {
    const { harness, sent } = harnessOver([{ when: /\/projects\/gitlab-org%2Fgitlab$/, body: project }])

    const result = await harness.execute('getProject', { project: 'gitlab-org/gitlab' })

    expect(sent[0]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer glpat-pasted' } })
    expect(result).toEqual({
      id: 278964,
      name: 'GitLab',
      path: 'gitlab',
      pathWithNamespace: 'gitlab-org/gitlab',
      defaultBranch: 'master',
      visibility: 'public',
      url: 'https://gitlab.com/gitlab-org/gitlab',
      httpUrlToRepo: 'https://gitlab.com/gitlab-org/gitlab.git',
      sshUrlToRepo: 'git@gitlab.com:gitlab-org/gitlab.git',
      createdAt: '2015-05-20T10:47:11.949Z',
      lastActivityAt: '2026-09-04T02:39:11.259Z',
      archived: false,
      namespace: { id: 9970, name: 'GitLab.org', path: 'gitlab-org', fullPath: 'gitlab-org', kind: 'group' },
      starCount: 6130,
      forksCount: 12375,
      topics: ['hacktoberfest', 'javascript', 'ruby', 'vue.js']
    })
  })

  it('lists open merge requests newest-updated first, bounded and narrowed as asked', async () => {
    const { harness, sent } = harnessOver([{ when: /\/merge_requests\?/, body: [SAMPLE_MERGE_REQUEST] }])

    const result = await harness.execute('listOpenMergeRequests', {
      project: 'gitlab-org/gitlab',
      limit: '5',
      targetBranch: 'master'
    })

    expect(query(sent[0].url)).toEqual({
      state: 'opened',
      order_by: 'updated_at',
      sort: 'desc',
      per_page: '5',
      target_branch: 'master'
    })
    expect(sent[0].headers.Authorization).toBe('Bearer glpat-pasted')
    expect(result.count).toBe(1)
    const items = result.items as ConnectorItem[]
    expect(items).toHaveLength(1)
    // The same shape the merge request trigger delivers.
    expect(items[0]).toMatchObject({
      externalId: '253583',
      status: 'opened',
      url: 'https://gitlab.com/gitlab-org/gitlab/-/merge_requests/253583',
      updatedAt: '2026-09-04T03:07:05.722Z',
      data: {
        iid: 253583,
        projectId: 278964,
        sourceBranch: 'wt/telemetry-zero-result',
        targetBranch: 'master',
        author: 'johnmason',
        detailedMergeStatus: 'not_approved'
      }
    })
    expect(items[0]).not.toHaveProperty('web_url')
  })

  it('leaves the optional list filters out when they are blank', async () => {
    const { harness, sent } = harnessOver([{ when: /\/merge_requests\?/, body: [] }])

    const result = await harness.execute('listOpenMergeRequests', { project: 'gitlab-org/gitlab' })

    expect(query(sent[0].url)).toEqual({ state: 'opened', order_by: 'updated_at', sort: 'desc' })
    expect(result).toEqual({ count: 0, items: [] })
  })

  it('keeps per_page within the documented 1 to 100, and counts nothing when the answer is not a list', async () => {
    const { harness, sent } = harnessOver([{ when: /\/merge_requests\?/, body: { message: 'not a list' } }])

    const result = await harness.execute('listOpenMergeRequests', { project: 'gitlab-org/gitlab', limit: '500' })
    await harness.execute('listOpenMergeRequests', { project: 'gitlab-org/gitlab', limit: '0' })

    expect(query(sent[0].url).per_page).toBe('100')
    expect(query(sent[1].url).per_page).toBe('1')
    expect(result).toEqual({ count: 0, items: [] })
  })

  it('reads an issue by its iid', async () => {
    const { harness, sent } = harnessOver([{ when: /\/issues\/627684$/, body: SAMPLE_ISSUE }])

    const result = await harness.execute('getIssue', { project: 'gitlab-org/gitlab', iid: '627684' })

    expect(sent[0].url).toBe('https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab/issues/627684')
    expect(result).toMatchObject({
      id: 201377309,
      iid: 627684,
      projectId: 278964,
      state: 'opened',
      url: 'https://gitlab.com/gitlab-org/gitlab/-/work_items/627684',
      author: { id: 32685309, username: 'azaydan', name: 'Ahmad Zaydan' },
      assignees: [],
      createdAt: '2026-09-04T02:23:26.054Z',
      closedAt: null,
      issueType: 'issue'
    })
  })

  it('refuses an issue number that is not a number, naming the argument', async () => {
    const { harness, sent } = harnessOver([])

    await expect(harness.execute('getIssue', { project: 'g/p', iid: '{{steps.x.iid}}' })).rejects.toThrow(
      /argument "iid": Expected a number/
    )
    expect(sent).toHaveLength(0)
  })

  it('creates an issue and returns where it went', async () => {
    const { harness, sent } = harnessOver([
      { when: /\/issues$/, body: { ...SAMPLE_ISSUE, id: 5, iid: 6, title: 'Disk full', state: 'opened' } }
    ])

    const result = await harness.execute('createIssue', {
      project: 'gitlab-org/gitlab',
      title: 'Disk full',
      labels: 'ops, urgent'
    })

    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: 'https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab/issues',
      headers: { Authorization: 'Bearer glpat-pasted', 'content-type': 'application/json' },
      // An argument nobody supplied is left out rather than sent as "".
      body: { title: 'Disk full', labels: 'ops, urgent' }
    })
    expect(result).toEqual({
      id: 5,
      iid: 6,
      url: SAMPLE_ISSUE.web_url,
      title: 'Disk full',
      state: 'opened',
      createdAt: SAMPLE_ISSUE.created_at
    })
  })

  it('comments on an issue, with internal as a real boolean', async () => {
    const { harness, sent } = harnessOver([{ when: /\/issues\/12\/notes$/, body: { ...note, noteable_type: 'Issue', noteable_iid: 12 } }])

    const result = await harness.execute('commentOnIssue', {
      project: 'g/p',
      iid: '12',
      body: 'Comment text',
      internal: 'true'
    })

    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: 'https://gitlab.com/api/v4/projects/g%2Fp/issues/12/notes',
      body: { body: 'Comment text', internal: true }
    })
    expect(result).toEqual({
      id: 301,
      body: 'Comment text',
      author: { id: 1, username: 'pipin', name: 'Pipin' },
      createdAt: '2013-10-02T08:57:14Z',
      noteableIid: 12,
      noteableType: 'Issue',
      internal: false
    })
  })

  it('comments on a merge request', async () => {
    const { harness, sent } = harnessOver([{ when: /\/merge_requests\/2\/notes$/, body: note }])

    const result = await harness.execute('commentOnMergeRequest', { project: 'g/p', iid: '2', body: 'Comment text' })

    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: 'https://gitlab.com/api/v4/projects/g%2Fp/merge_requests/2/notes',
      body: { body: 'Comment text' }
    })
    expect(result).toMatchObject({ id: 301, noteableType: 'MergeRequest', noteableIid: 2 })
  })

  it('insists on the arguments an action cannot do without', async () => {
    const { harness } = harnessOver([])
    await expect(harness.execute('createIssue', { project: 'g/p' })).rejects.toThrow('requires "title"')
    await expect(harness.execute('commentOnIssue', { project: 'g/p', iid: '1' })).rejects.toThrow('requires "body"')
    await expect(harness.execute('getProject', {})).rejects.toThrow('requires "project"')
  })

  it('names the action and quotes GitLab when a call fails', async () => {
    const { harness } = harnessOver([{ when: /\/projects\//, status: 404, body: { message: '404 Project Not Found' } }])

    await expect(harness.execute('getProject', { project: 'nobody/nothing' })).rejects.toThrow(
      /Action getProject: Request failed with 404.*404 Project Not Found/
    )
  })
})
