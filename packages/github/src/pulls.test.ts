import { describe, expect, it, vi } from 'vitest'
import type { GitHubApi } from './client'
import {
  comment,
  getPull,
  inlineComments,
  latestVerdicts,
  listComments,
  listFiles,
  merge,
  requestReviewers,
  review,
  splitReviewers
} from './pulls'

const WHERE = { owner: 'vorn-run', repo: 'vorn' }

const PULL = {
  number: 42,
  html_url: 'https://github.com/vorn-run/vorn/pull/42',
  title: 'Add caching',
  body: 'Why',
  state: 'open',
  draft: false,
  merged: false,
  mergeable: true,
  mergeable_state: 'clean',
  user: { login: 'ana' },
  head: { ref: 'feature/cache', sha: 'abc123', repo: { full_name: 'vorn-run/vorn' } },
  base: { ref: 'main' },
  additions: 10,
  deletions: 2,
  changed_files: 3
}

/** An Octokit stand-in: every method is a spy, `paginate` answers with the method's data. */
function fakeApi(over: Record<string, Record<string, unknown>> = {}) {
  const spy = (data: unknown) => vi.fn(async () => ({ data }))
  const rest = {
    pulls: {
      get: spy(PULL),
      listReviews: spy([]),
      listFiles: spy([]),
      listReviewComments: spy([]),
      createReplyForReviewComment: spy({ id: 7, html_url: 'u7' }),
      createReviewComment: spy({ id: 8, html_url: 'u8' }),
      createReview: spy({ id: 9, state: 'APPROVED', html_url: 'u9' }),
      requestReviewers: spy({ requested_reviewers: [{ login: 'bo' }], requested_teams: [{ slug: 'platform' }] }),
      merge: spy({ merged: true, sha: 'merge-sha' }),
      ...over.pulls
    },
    issues: {
      listComments: spy([]),
      createComment: spy({ id: 10, html_url: 'u10' }),
      ...over.issues
    },
    git: { deleteRef: spy(undefined), ...over.git }
  }
  const paginate = vi.fn(async (method: (params: unknown) => Promise<{ data: unknown }>, params: unknown) =>
    (await method(params)).data
  )
  return { api: { rest, paginate } as unknown as GitHubApi, rest, paginate }
}

function failing(status: number, message: string) {
  return vi.fn(async () => {
    throw Object.assign(new Error(message), { status })
  })
}

describe('latestVerdicts', () => {
  it("keeps each reviewer's latest decision, which a later comment does not withdraw", () => {
    expect(
      latestVerdicts([
        { user: { login: 'bo' }, state: 'CHANGES_REQUESTED' },
        { user: { login: 'bo' }, state: 'APPROVED' },
        { user: { login: 'bo' }, state: 'COMMENTED' },
        { user: { login: 'cy' }, state: 'PENDING' },
        { user: null, state: 'APPROVED' },
        {}
      ])
    ).toEqual([{ author: 'bo', state: 'APPROVED' }])
  })
})

describe('getPull', () => {
  it('reads the pull request and every verdict', async () => {
    const { api, rest } = fakeApi({
      pulls: { listReviews: vi.fn(async () => ({ data: [{ user: { login: 'bo' }, state: 'APPROVED' }] })) }
    })
    await expect(getPull(api, WHERE, 42)).resolves.toEqual({
      number: 42,
      url: PULL.html_url,
      title: 'Add caching',
      body: 'Why',
      state: 'open',
      draft: false,
      merged: false,
      mergeable: true,
      mergeableState: 'clean',
      author: 'ana',
      headBranch: 'feature/cache',
      headSha: 'abc123',
      baseBranch: 'main',
      additions: 10,
      deletions: 2,
      changedFiles: 3,
      reviews: [{ author: 'bo', state: 'APPROVED' }]
    })
    expect(rest.pulls.get).toHaveBeenCalledWith({ ...WHERE, pull_number: 42 })
  })

  it('renders a bare answer as blanks, keeping "not worked out yet" as null', async () => {
    const { api } = fakeApi({
      pulls: { get: vi.fn(async () => ({})), listReviews: vi.fn(async () => ({})) }
    })
    await expect(getPull(api, WHERE, 42)).resolves.toMatchObject({
      number: 42,
      url: '',
      body: '',
      mergeable: null,
      author: '',
      headSha: '',
      changedFiles: 0,
      reviews: []
    })
  })
})

describe('listFiles', () => {
  it('returns every file with its diff, blank where GitHub has none', async () => {
    const { api, paginate } = fakeApi({
      pulls: {
        listFiles: vi.fn(async () => ({
          data: [
            { filename: 'a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@' },
            { filename: 'b.png', status: 'renamed', previous_filename: 'old.png' },
            {}
          ]
        }))
      }
    })
    await expect(listFiles(api, WHERE, 42)).resolves.toEqual([
      { filename: 'a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@' },
      { filename: 'b.png', status: 'renamed', additions: 0, deletions: 0, patch: '', previousFilename: 'old.png' },
      { filename: '', status: '', additions: 0, deletions: 0, patch: '' }
    ])
    expect(paginate).toHaveBeenCalledWith(expect.any(Function), { ...WHERE, pull_number: 42, per_page: 100 })
  })

  it('reads an empty answer as no files', async () => {
    const { api } = fakeApi({ pulls: { listFiles: vi.fn(async () => ({})) } })
    await expect(listFiles(api, WHERE, 42)).resolves.toEqual([])
  })
})

describe('listComments', () => {
  it('reads both the line comments and the conversation', async () => {
    const { api } = fakeApi({
      pulls: {
        listReviewComments: vi.fn(async () => ({
          data: [
            { id: 1, user: { login: 'bo' }, body: 'Off by one', path: 'a.ts', line: 4, html_url: 'u1', created_at: 't1' },
            { id: 2, path: 'a.ts', line: null, original_line: 3, in_reply_to_id: 1 },
            { line: null }
          ]
        }))
      },
      issues: {
        listComments: vi.fn(async () => ({ data: [{ id: 5, user: { login: 'cy' }, body: 'LGTM', html_url: 'u5' }, {}] }))
      }
    })
    await expect(listComments(api, WHERE, 42)).resolves.toEqual({
      inline: [
        { id: 1, author: 'bo', body: 'Off by one', path: 'a.ts', line: 4, url: 'u1', createdAt: 't1' },
        { id: 2, author: '', body: '', path: 'a.ts', line: 3, inReplyTo: 1, url: '', createdAt: '' },
        { id: 0, author: '', body: '', path: '', line: 0, url: '', createdAt: '' }
      ],
      conversation: [
        { id: 5, author: 'cy', body: 'LGTM', url: 'u5', createdAt: '' },
        { id: 0, author: '', body: '', url: '', createdAt: '' }
      ]
    })
  })

  it('reads empty answers as no comments', async () => {
    const { api } = fakeApi({
      pulls: { listReviewComments: vi.fn(async () => ({})) },
      issues: { listComments: vi.fn(async () => ({})) }
    })
    await expect(listComments(api, WHERE, 42)).resolves.toEqual({ inline: [], conversation: [] })
  })
})

describe('comment', () => {
  it('comments on the conversation when no file is named', async () => {
    const { api, rest } = fakeApi()
    await expect(comment(api, WHERE, 42, { body: 'Nice' })).resolves.toEqual({ id: 10, url: 'u10' })
    expect(rest.issues.createComment).toHaveBeenCalledWith({ ...WHERE, issue_number: 42, body: 'Nice' })
  })

  it('pins a line comment to the head commit, on the new side', async () => {
    const { api, rest } = fakeApi()
    await expect(
      comment(api, WHERE, 42, { body: 'Off by one', path: '/src/a.ts', line: 12 })
    ).resolves.toEqual({ id: 8, url: 'u8' })
    expect(rest.pulls.createReviewComment).toHaveBeenCalledWith({
      ...WHERE,
      pull_number: 42,
      commit_id: 'abc123',
      path: 'src/a.ts',
      body: 'Off by one',
      line: 12,
      side: 'RIGHT'
    })
  })

  it('comments on a whole file when no line is given', async () => {
    const { api, rest } = fakeApi()
    await comment(api, WHERE, 42, { body: 'Split this file', path: 'a.ts' })
    expect(rest.pulls.createReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'a.ts', subject_type: 'file' })
    )
  })

  it('replies to an inline comment', async () => {
    const { api, rest } = fakeApi()
    await expect(comment(api, WHERE, 42, { body: 'Fixed', replyTo: 1 })).resolves.toEqual({ id: 7, url: 'u7' })
    expect(rest.pulls.createReplyForReviewComment).toHaveBeenCalledWith({
      ...WHERE,
      pull_number: 42,
      comment_id: 1,
      body: 'Fixed'
    })
  })

  it('refuses a line with no file, and a pull request with no head', async () => {
    const { api } = fakeApi({ pulls: { get: vi.fn(async () => ({ data: {} })) } })
    await expect(comment(api, WHERE, 42, { body: 'x', line: 3 })).rejects.toThrow(/needs a path/)
    await expect(comment(api, WHERE, 42, { body: 'x', path: 'a.ts' })).rejects.toThrow(/no head commit/)
  })

  it('reads an empty answer as comment 0', async () => {
    const empty = vi.fn(async () => ({}))
    const { api } = fakeApi({
      pulls: { createReplyForReviewComment: empty, createReviewComment: empty },
      issues: { createComment: empty }
    })
    await expect(comment(api, WHERE, 42, { body: 'x' })).resolves.toEqual({ id: 0, url: '' })
    await expect(comment(api, WHERE, 42, { body: 'x', path: 'a' })).resolves.toEqual({ id: 0, url: '' })
    await expect(comment(api, WHERE, 42, { body: 'x', replyTo: 1 })).resolves.toEqual({ id: 0, url: '' })
  })
})

describe('inlineComments', () => {
  it('takes a list, a single object, or JSON text', () => {
    const one = { path: '/a.ts', line: '4', body: 'Why?' }
    expect(inlineComments([one])).toEqual([{ path: 'a.ts', line: 4, body: 'Why?' }])
    expect(inlineComments(one)).toEqual([{ path: 'a.ts', line: 4, body: 'Why?' }])
    expect(inlineComments(JSON.stringify([one]))).toHaveLength(1)
  })

  it('reads nothing as no comments', () => {
    expect(inlineComments(undefined)).toEqual([])
    expect(inlineComments(null)).toEqual([])
    expect(inlineComments('')).toEqual([])
  })

  it('names the entry that is wrong', () => {
    expect(() => inlineComments([{ path: 'a', line: 1, body: 'ok' }, { path: 'a', line: 0, body: 'x' }])).toThrow(
      'comments[1] needs a path, a positive line and a body.'
    )
    expect(() => inlineComments([null])).toThrow(/comments\[0\]/)
    expect(() => inlineComments({ path: ' ', line: 1, body: 'x' })).toThrow(/comments\[0\]/)
    expect(() => inlineComments({ path: 'a', line: 1, body: ' ' })).toThrow(/comments\[0\]/)
  })
})

describe('review', () => {
  it('approves, with line comments on the new side', async () => {
    const { api, rest } = fakeApi()
    await expect(
      review(api, WHERE, 42, { event: 'approve', comments: [{ path: 'a.ts', line: 4, body: 'Nit' }] })
    ).resolves.toEqual({ id: 9, state: 'APPROVED', url: 'u9' })
    expect(rest.pulls.createReview).toHaveBeenCalledWith({
      ...WHERE,
      pull_number: 42,
      event: 'APPROVE',
      comments: [{ path: 'a.ts', line: 4, body: 'Nit', side: 'RIGHT' }]
    })
  })

  it('requests changes with a body saying why', async () => {
    const { api, rest } = fakeApi()
    await review(api, WHERE, 42, { event: 'requestChanges', body: 'Needs tests', comments: [] })
    expect(rest.pulls.createReview).toHaveBeenCalledWith({
      ...WHERE,
      pull_number: 42,
      event: 'REQUEST_CHANGES',
      body: 'Needs tests'
    })
  })

  it('refuses to request changes without saying why', async () => {
    const { api } = fakeApi()
    await expect(review(api, WHERE, 42, { event: 'requestChanges', comments: [] })).rejects.toThrow(
      /needs a body/
    )
  })

  it('reads an empty answer as blanks', async () => {
    const { api } = fakeApi({ pulls: { createReview: vi.fn(async () => ({})) } })
    await expect(review(api, WHERE, 42, { event: 'approve', comments: [] })).resolves.toEqual({
      id: 0,
      state: '',
      url: ''
    })
  })
})

describe('reviewers', () => {
  it('splits users from org/teams', () => {
    expect(splitReviewers('@bo, acme/platform, ,cy')).toEqual({ reviewers: ['bo', 'cy'], teams: ['platform'] })
    expect(splitReviewers(undefined)).toEqual({ reviewers: [], teams: [] })
  })

  it('asks for both and reports everyone now asked', async () => {
    const { api, rest } = fakeApi()
    await expect(
      requestReviewers(api, WHERE, 42, { reviewers: ['bo'], teams: ['platform'] })
    ).resolves.toEqual({ requested: ['bo', 'platform'] })
    expect(rest.pulls.requestReviewers).toHaveBeenCalledWith({
      ...WHERE,
      pull_number: 42,
      reviewers: ['bo'],
      team_reviewers: ['platform']
    })
  })

  it('sends only the kind it was given, and survives an empty answer', async () => {
    const { api, rest } = fakeApi({
      pulls: { requestReviewers: vi.fn(async () => ({ data: { requested_reviewers: [null], requested_teams: [{}] } })) }
    })
    await expect(requestReviewers(api, WHERE, 42, { reviewers: [], teams: ['platform'] })).resolves.toEqual({
      requested: []
    })
    expect(rest.pulls.requestReviewers).toHaveBeenCalledWith({ ...WHERE, pull_number: 42, team_reviewers: ['platform'] })
    rest.pulls.requestReviewers.mockResolvedValueOnce({} as never)
    await expect(requestReviewers(api, WHERE, 42, { reviewers: ['bo'], teams: [] })).resolves.toEqual({
      requested: []
    })
  })

  it('refuses to ask nobody', async () => {
    const { api } = fakeApi()
    await expect(requestReviewers(api, WHERE, 42, { reviewers: [], teams: [] })).rejects.toThrow(
      /reviewers is required/
    )
  })
})

describe('merge', () => {
  const options = { method: 'squash' as const, deleteBranch: true }

  it('merges only the commit it read, then deletes the branch', async () => {
    const { api, rest } = fakeApi()
    await expect(merge(api, WHERE, 42, { ...options, title: 'T', message: 'M' })).resolves.toEqual({
      merged: true,
      sha: 'merge-sha',
      branchDeleted: true
    })
    expect(rest.pulls.merge).toHaveBeenCalledWith({
      ...WHERE,
      pull_number: 42,
      sha: 'abc123',
      merge_method: 'squash',
      commit_title: 'T',
      commit_message: 'M'
    })
    expect(rest.git.deleteRef).toHaveBeenCalledWith({ ...WHERE, ref: 'heads/feature/cache' })
  })

  it('keeps the branch when asked', async () => {
    const { api, rest } = fakeApi()
    await merge(api, WHERE, 42, { method: 'rebase', deleteBranch: false })
    expect(rest.git.deleteRef).not.toHaveBeenCalled()
  })

  it("leaves a fork's branch alone", async () => {
    const { api, rest } = fakeApi({
      pulls: { get: vi.fn(async () => ({ data: { ...PULL, head: { ...PULL.head, repo: null } } })) }
    })
    await expect(merge(api, WHERE, 42, options)).resolves.toMatchObject({ branchDeleted: false })
    expect(rest.git.deleteRef).not.toHaveBeenCalled()
  })

  it('counts a branch the repository already deleted as deleted', async () => {
    const { api } = fakeApi({ git: { deleteRef: failing(422, 'Reference does not exist') } })
    await expect(merge(api, WHERE, 42, options)).resolves.toMatchObject({ branchDeleted: true })
  })

  it('surfaces any other failure to delete', async () => {
    const { api } = fakeApi({ git: { deleteRef: failing(403, 'Forbidden') } })
    await expect(merge(api, WHERE, 42, options)).rejects.toThrow('Forbidden')
  })

  it("says why GitHub refused, in GitHub's words", async () => {
    const blocked = fakeApi({ pulls: { merge: failing(405, 'At least 1 approving review is required') } })
    await expect(merge(blocked.api, WHERE, 42, options)).rejects.toThrow(
      'Pull request #42 cannot be merged: At least 1 approving review is required'
    )
    const moved = fakeApi({ pulls: { merge: failing(409, 'Head branch was modified') } })
    await expect(merge(moved.api, WHERE, 42, options)).rejects.toThrow(/cannot be merged: Head branch was modified/)
  })

  it('passes other failures through untouched', async () => {
    const { api } = fakeApi({ pulls: { merge: failing(500, 'boom') } })
    await expect(merge(api, WHERE, 42, options)).rejects.toThrow(/^boom$/)
  })

  it('refuses a pull request with no head, and reads an empty answer as not merged', async () => {
    const headless = fakeApi({ pulls: { get: vi.fn(async () => ({ data: {} })) } })
    await expect(merge(headless.api, WHERE, 42, options)).rejects.toThrow(/no head commit/)
    const empty = fakeApi({ pulls: { merge: vi.fn(async () => ({})) } })
    await expect(merge(empty.api, WHERE, 42, { ...options, deleteBranch: false })).resolves.toEqual({
      merged: false,
      sha: '',
      branchDeleted: false
    })
  })

  it('reports a thrown non-Error in its own words', async () => {
    const { api } = fakeApi({
      pulls: {
        merge: vi.fn(async () => {
          throw { status: 405, toString: () => 'not mergeable' }
        })
      }
    })
    await expect(merge(api, WHERE, 42, options)).rejects.toThrow(/cannot be merged: not mergeable/)
  })
})
