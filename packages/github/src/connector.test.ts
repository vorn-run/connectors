import { describe, expect, it, vi } from 'vitest'
import { createConnectorHarness, runAction } from '@vornrun/connector-sdk'
import { createGitHubConnector, issueNumber, issueToItem, requiredArg } from './connector'
import type { GitHubApi, GitHubClient } from './client'
import { GITHUB_SEARCH_INDEX_OVERLAP_MS, type GitHubIssue } from './search'

const NOW = '2026-08-13T12:00:00.000Z'
const CONFIG = { owner: 'vorn-run', repo: 'vorn' }

function issue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 7,
    html_url: 'https://github.com/vorn-run/vorn/issues/7',
    title: 'Something broke',
    body: 'Details',
    state: 'open',
    labels: [{ name: 'bug' }],
    assignee: { login: 'javier' },
    created_at: '2026-08-13T11:00:00.000Z',
    updated_at: '2026-08-13T11:30:00.000Z',
    ...overrides
  }
}

/**
 * A client that records what the connector asked for and answers with a
 * canned payload. The connector never builds a real Octokit, so nothing
 * spawns `gh` and no request leaves the process.
 */
function fakeClient(handlers: Record<string, unknown> = {}) {
  const searches: Array<Record<string, unknown>> = []
  const created: Array<Record<string, unknown>> = []
  const updated: Array<Record<string, unknown>> = []
  const comments: Array<Record<string, unknown>> = []
  const pulls: Array<Record<string, unknown>> = []

  const api = {
    rest: {
      search: {
        issuesAndPullRequests: async (params: Record<string, unknown>) => {
          searches.push(params)
          return {
            data: handlers.search ?? { total_count: 1, incomplete_results: false, items: [issue()] }
          }
        }
      },
      issues: {
        create: async (params: Record<string, unknown>) => {
          created.push(params)
          return { data: { number: 12, html_url: 'https://github.com/vorn-run/vorn/issues/12' } }
        },
        update: async (params: Record<string, unknown>) => {
          updated.push(params)
          return { data: { number: 7, html_url: 'https://github.com/vorn-run/vorn/issues/7' } }
        },
        createComment: async (params: Record<string, unknown>) => {
          comments.push(params)
          return {
            data: { html_url: 'https://github.com/vorn-run/vorn/issues/7#issuecomment-1' }
          }
        }
      },
      pulls: {
        create: async (params: Record<string, unknown>) => {
          pulls.push(params)
          return { data: { number: 42, html_url: 'https://github.com/vorn-run/vorn/pull/42' } }
        }
      }
    }
  } as unknown as GitHubApi

  const client: GitHubClient = { run: (call) => call(api) }
  return { client, searches, created, updated, comments, pulls }
}

function connector(over: { client: GitHubClient }) {
  return createGitHubConnector({ client: over.client, now: () => NOW })
}

describe('issueToItem', () => {
  it('maps the fields Vorn indexes, and keeps the rest in data', () => {
    expect(issueToItem(issue())).toEqual({
      externalId: '7',
      title: 'Something broke',
      url: 'https://github.com/vorn-run/vorn/issues/7',
      description: 'Details',
      status: 'open',
      updatedAt: '2026-08-13T11:30:00.000Z',
      data: {
        labels: ['bug'],
        assignee: 'javier',
        createdAt: '2026-08-13T11:00:00.000Z'
      }
    })
  })

  it('survives an issue with no body, labels or assignee', () => {
    const item = issueToItem(
      issue({ body: null, labels: undefined, assignee: null })
    )
    expect(item.description).toBe('')
    expect(item.data).toMatchObject({ labels: [] })
    expect(item.data).not.toHaveProperty('assignee')
  })
})

describe('polling', () => {
  it('searches the connected repo for issues and returns them as items', async () => {
    const { client, searches } = fakeClient()
    const h = createConnectorHarness(connector({ client }), { config: CONFIG })
    const result = await h.poll('issueCreated')

    expect(searches[0]).toMatchObject({
      // A minute back for the default cursor, then one more second because
      // `created:>` is strict — otherwise items in the cursor's own second are
      // skipped. Both rewinds are the built-in connector's behaviour.
      q: 'repo:vorn-run/vorn is:issue created:>2026-08-13T11:58:59Z',
      sort: 'created',
      order: 'asc',
      page: 1
    })
    expect(result.items.map((i) => i.externalId)).toEqual(['7'])
  })

  it('searches for pull requests on the other trigger', async () => {
    const { client, searches } = fakeClient()
    const h = createConnectorHarness(connector({ client }), { config: CONFIG })
    await h.poll('prOpened')
    expect(searches[0].q).toContain('is:pr')
  })

  it('applies the label filter to issues', async () => {
    const { client, searches } = fakeClient()
    const h = createConnectorHarness(connector({ client }), {
      config: { ...CONFIG, labels: 'bug' }
    })
    await h.poll('issueCreated')
    expect(searches[0].q).toContain('label:"bug"')
  })

  // Described on the form as an issue filter. Narrowing pull requests by it
  // too would be a surprise nothing on the form explains.
  it('does not apply the label filter to pull requests', async () => {
    const { client, searches } = fakeClient()
    const h = createConnectorHarness(connector({ client }), {
      config: { ...CONFIG, labels: 'bug' }
    })
    await h.poll('prOpened')
    expect(searches[0].q).not.toContain('label:')
  })

  it('leaves the watermark behind the poll start so the lagging index is re-read', async () => {
    const { client } = fakeClient()
    const h = createConnectorHarness(connector({ client }), { config: CONFIG })
    const result = await h.poll('issueCreated')
    expect(Date.parse(result.nextCursor!)).toBe(Date.parse(NOW) - GITHUB_SEARCH_INDEX_OVERLAP_MS)
    expect(result.hasMore).toBe(false)
  })

  it('threads the cursor it was given into the next page', async () => {
    const { client, searches } = fakeClient({
      search: { total_count: 250, incomplete_results: false, items: [issue()] }
    })
    const h = createConnectorHarness(connector({ client }), { config: CONFIG })
    const first = await h.poll('issueCreated')
    expect(first.hasMore).toBe(true)

    const second = await h.poll('issueCreated', { cursor: first.nextCursor })
    expect(second).toBeTruthy()
    expect(searches[1]).toMatchObject({ page: 2 })
  })

  it('refuses a page GitHub says is incomplete rather than advancing over it', async () => {
    const { client } = fakeClient({
      search: { total_count: 1, incomplete_results: true, items: [] }
    })
    const h = createConnectorHarness(connector({ client }), { config: CONFIG })
    await expect(h.poll('issueCreated')).rejects.toThrow(/incomplete results/)
  })

  it('names the missing setting rather than searching a repo called undefined', async () => {
    const { client } = fakeClient()
    const h = createConnectorHarness(connector({ client }), { config: { owner: 'vorn-run' } })
    await expect(h.poll('issueCreated')).rejects.toThrow(/GITHUB_REPO is required/)
  })
})

describe('actions', () => {
  const run = (client: GitHubClient, type: string, args: Record<string, unknown>) =>
    runAction(connector({ client }), type, args, { config: CONFIG })

  it('creates an issue in the connected repo', async () => {
    const { client, created } = fakeClient()
    const result = await run(client, 'createIssue', {
      title: 'New',
      body: 'Body',
      labels: 'bug, ux'
    })
    expect(created[0]).toEqual({
      owner: 'vorn-run',
      repo: 'vorn',
      title: 'New',
      body: 'Body',
      labels: ['bug', 'ux']
    })
    expect(result).toEqual({ number: 12, url: 'https://github.com/vorn-run/vorn/issues/12' })
  })

  it('omits body and labels rather than sending empty ones', async () => {
    const { client, created } = fakeClient()
    // Absent, not merely blank: a template that resolved to nothing at all.
    await run(client, 'createIssue', { title: 'New' })
    expect(created[0]).not.toHaveProperty('body')
    expect(created[0]).not.toHaveProperty('labels')

    await run(client, 'createIssue', { title: 'New', body: '  ', labels: ' , ' })
    expect(created[0]).not.toHaveProperty('body')
    expect(created[0]).not.toHaveProperty('labels')
  })

  it('closes an issue', async () => {
    const { client, updated } = fakeClient()
    await run(client, 'closeIssue', { number: '7' })
    expect(updated[0]).toMatchObject({ issue_number: 7, state: 'closed' })
  })

  it('comments on an issue', async () => {
    const { client, comments } = fakeClient()
    const result = await run(client, 'commentOnIssue', { number: '7', body: 'Looking at it' })
    expect(comments[0]).toMatchObject({ issue_number: 7, body: 'Looking at it' })
    expect(result.url).toContain('#issuecomment-')
  })

  it('opens a pull request into main unless told otherwise', async () => {
    const { client, pulls } = fakeClient()
    const result = await run(client, 'createPullRequest', {
      head: 'connector/s3',
      title: 'Add the s3 connector',
      body: 'Built by the factory.'
    })
    expect(pulls[0]).toEqual({
      owner: 'vorn-run',
      repo: 'vorn',
      head: 'connector/s3',
      base: 'main',
      title: 'Add the s3 connector',
      body: 'Built by the factory.',
      draft: false
    })
    expect(result).toEqual({ number: 42, url: 'https://github.com/vorn-run/vorn/pull/42' })

    await run(client, 'createPullRequest', { head: 'x', base: 'release', title: 'T', draft: 'true' })
    expect(pulls[1]).toMatchObject({ base: 'release', draft: true })
    expect(pulls[1]).not.toHaveProperty('body')
  })

  it('names a missing required argument', async () => {
    const { client } = fakeClient()
    await expect(run(client, 'commentOnIssue', { number: '7', body: '  ' })).rejects.toThrow(
      /body is required/
    )
  })

  it('declares createIssue non-idempotent and closeIssue idempotent', () => {
    const { client } = fakeClient()
    const actions = connector({ client }).actions
    expect(actions.find((a) => a.type === 'createIssue')?.idempotent).toBe(false)
    expect(actions.find((a) => a.type === 'closeIssue')?.idempotent).toBe(true)
  })
})

describe('issueNumber', () => {
  it('reads the number Vorn renders from a template', () => {
    expect(issueNumber('7')).toBe(7)
    expect(issueNumber(' 7 ')).toBe(7)
    expect(issueNumber('#7')).toBe(7)
    expect(issueNumber(7)).toBe(7)
  })

  // A mistyped template renders to empty or to the literal text. Failing here
  // names the argument; sending it would return a 404 about a repo instead.
  it('refuses anything that is not a positive integer', () => {
    for (const bad of ['', '  ', 'abc', '0', '-1', '1.5', undefined, null, '{{item.number}}']) {
      expect(() => issueNumber(bad)).toThrow(/positive integer/)
    }
  })
})

describe('requiredArg', () => {
  it('returns trimmed text', () => {
    expect(requiredArg('  hello  ', 'body')).toBe('hello')
  })

  it('names the argument when it is blank', () => {
    expect(() => requiredArg('   ', 'title')).toThrow(/title is required/)
  })

  it('treats absent and blank the same', () => {
    expect(() => requiredArg(undefined, 'title')).toThrow(/title is required/)
    expect(() => requiredArg(null, 'title')).toThrow(/title is required/)
  })
})

describe('the manifest', () => {
  it('offers no credential field, because gh owns the token', () => {
    const { client } = fakeClient()
    expect(connector({ client }).config.some((f) => f.secret)).toBe(false)
    expect(connector({ client }).config.map((f) => f.key)).toEqual(['owner', 'repo', 'labels'])
  })

  it('suggests where open and closed items should land', () => {
    const { client } = fakeClient()
    const trigger = connector({ client }).triggers.find((t) => t.type === 'issueCreated')
    expect(trigger?.statusMapping).toEqual([
      { upstream: 'open', suggestedLocal: 'todo' },
      { upstream: 'closed', suggestedLocal: 'done' }
    ])
  })

  it('seeds a workflow for each trigger', () => {
    const { client } = fakeClient()
    for (const trigger of connector({ client }).triggers) {
      expect(trigger.defaultWorkflow?.defaultCronFromMinutes).toBe(5)
    }
  })

  it('builds a real client when none is injected', () => {
    const built = createGitHubConnector({ gh: vi.fn(async () => 'ghp_x') })
    expect(built.id).toBe('github')
    expect(built.triggers).toHaveLength(2)
  })

  /**
   * Exercises the defaults the injected `client` and `now` normally stand in
   * for: the connector builds its own client from `gh` and reads the real
   * clock. Nothing reaches the network because `createApi` is still stubbed.
   */
  it('polls with its own client and clock when neither is injected', async () => {
    const searches: Array<Record<string, unknown>> = []
    const api = {
      rest: {
        search: {
          issuesAndPullRequests: async (params: Record<string, unknown>) => {
            searches.push(params)
            return { data: { total_count: 0, incomplete_results: false, items: [] } }
          }
        }
      }
    } as unknown as GitHubApi

    const built = createGitHubConnector({
      gh: async () => 'ghp_x',
      createApi: () => api
    })
    const h = createConnectorHarness(built, { config: CONFIG })
    const result = await h.poll('issueCreated')

    expect(searches[0].q).toContain('repo:vorn-run/vorn')
    // The watermark came from the real clock, so only its shape can be checked.
    expect(result.nextCursor).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('pull request review actions', () => {
  const calls: Array<[string, Record<string, unknown>]> = []
  const answer =
    (name: string, data: unknown) =>
    async (params: Record<string, unknown>) => {
      calls.push([name, params])
      return { data }
    }
  const api = {
    rest: {
      pulls: {
        get: answer('get', {
          number: 42,
          html_url: 'https://github.com/vorn-run/vorn/pull/42',
          head: { ref: 'feature/x', sha: 'abc', repo: { full_name: 'vorn-run/vorn' } }
        }),
        listReviews: answer('listReviews', [{ user: { login: 'bo' }, state: 'APPROVED' }]),
        listFiles: answer('listFiles', [{ filename: 'a.ts', status: 'added', patch: '+x' }]),
        listReviewComments: answer('listReviewComments', []),
        createReviewComment: answer('createReviewComment', { id: 8, html_url: 'u8' }),
        createReplyForReviewComment: answer('createReplyForReviewComment', { id: 7, html_url: 'u7' }),
        createReview: answer('createReview', { id: 9, state: 'CHANGES_REQUESTED', html_url: 'u9' }),
        requestReviewers: answer('requestReviewers', { requested_reviewers: [{ login: 'bo' }] }),
        merge: answer('merge', { merged: true, sha: 'm' })
      },
      issues: {
        listComments: answer('listComments', [{ id: 1, body: 'LGTM' }]),
        createComment: answer('createComment', { id: 10, html_url: 'u10' })
      },
      git: { deleteRef: answer('deleteRef', undefined) }
    },
    paginate: async (method: (p: unknown) => Promise<{ data: unknown }>, params: unknown) =>
      (await method(params)).data
  } as unknown as GitHubApi
  const client: GitHubClient = { run: (call) => call(api) }
  const run = (type: string, args: Record<string, unknown>) =>
    runAction(connector({ client }), type, args, { config: CONFIG })
  const last = (name: string) => [...calls].reverse().find(([n]) => n === name)?.[1]

  it('reads a pull request with its verdicts', async () => {
    await expect(run('getPullRequest', { number: '#42' })).resolves.toMatchObject({
      number: 42,
      headSha: 'abc',
      reviews: [{ author: 'bo', state: 'APPROVED' }]
    })
    expect(last('get')).toEqual({ owner: 'vorn-run', repo: 'vorn', pull_number: 42 })
  })

  it('lists files with their diffs', async () => {
    await expect(run('listPullRequestFiles', { number: 42 })).resolves.toMatchObject({
      count: 1,
      files: [{ filename: 'a.ts', patch: '+x' }]
    })
  })

  it('reads the discussion', async () => {
    await expect(run('listPullRequestComments', { number: 42 })).resolves.toMatchObject({
      inline: [],
      conversation: [{ id: 1, body: 'LGTM' }]
    })
  })

  it('comments on a line, or replies', async () => {
    await expect(
      run('commentOnPullRequest', { number: 42, body: 'Why?', path: 'a.ts', line: '3' })
    ).resolves.toEqual({ id: 8, url: 'u8' })
    expect(last('createReviewComment')).toMatchObject({ line: 3, commit_id: 'abc' })
    await expect(
      run('commentOnPullRequest', { number: 42, body: 'Done', replyTo: 5 })
    ).resolves.toEqual({ id: 7, url: 'u7' })
    await expect(run('commentOnPullRequest', { number: 42, body: 'Hi', line: '' })).resolves.toEqual({
      id: 10,
      url: 'u10'
    })
  })

  it('refuses a line that is not one', async () => {
    await expect(
      run('commentOnPullRequest', { number: 42, body: 'x', path: 'a.ts', line: -1 })
    ).rejects.toThrow(/line must be a positive whole number/)
  })

  it('submits a review with line comments', async () => {
    await expect(
      run('reviewPullRequest', {
        number: 42,
        event: 'requestChanges',
        body: 'Needs tests',
        comments: [{ path: 'a.ts', line: 1, body: 'Here' }]
      })
    ).resolves.toEqual({ id: 9, state: 'CHANGES_REQUESTED', url: 'u9' })
    expect(last('createReview')).toMatchObject({ event: 'REQUEST_CHANGES', comments: [expect.objectContaining({ path: 'a.ts' })] })
  })

  it('refuses a verdict it does not know', async () => {
    await expect(run('reviewPullRequest', { number: 42, event: 'lgtm' })).rejects.toThrow(
      /event must be one of approve, requestChanges, comment/
    )
  })

  it('requests reviewers', async () => {
    await expect(run('requestReviewers', { number: 42, reviewers: 'bo' })).resolves.toEqual({
      requested: ['bo']
    })
  })

  it('squashes and deletes the branch by default', async () => {
    await expect(run('mergePullRequest', { number: 42 })).resolves.toEqual({
      merged: true,
      sha: 'm',
      branchDeleted: true
    })
    expect(last('merge')).toMatchObject({ merge_method: 'squash', sha: 'abc' })
  })

  it('merges the way the step says, keeping the branch', async () => {
    calls.length = 0
    await expect(
      run('mergePullRequest', { number: 42, method: 'rebase', keepBranch: true, title: 'T', sha: 'r' })
    ).resolves.toMatchObject({ branchDeleted: false })
    expect(last('merge')).toMatchObject({ merge_method: 'rebase', commit_title: 'T', sha: 'r' })
    expect(last('deleteRef')).toBeUndefined()
  })

  it('refuses a merge method it does not know', async () => {
    await expect(run('mergePullRequest', { number: 42, method: 'octopus' })).rejects.toThrow(
      /method must be one of squash, merge, rebase/
    )
  })

  it('declares reads as repeatable and writes as not', () => {
    const actions = connector({ client }).actions
    const idempotent = (type: string) => actions.find((a) => a.type === type)?.idempotent
    expect(idempotent('getPullRequest')).toBe(true)
    expect(idempotent('requestReviewers')).toBe(true)
    expect(idempotent('reviewPullRequest')).toBe(false)
    expect(idempotent('mergePullRequest')).toBe(false)
  })
})
