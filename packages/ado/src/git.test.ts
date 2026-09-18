import { describe, it, expect, vi } from 'vitest'
import {
  branchName,
  branchRef,
  changeTypeNames,
  comment,
  completePullRequest,
  createPullRequest,
  describePullRequest,
  findPullRequest,
  listActivePullRequests,
  listChanges,
  listThreads,
  pullRequestUrl,
  setThreadStatus,
  threadStatusName,
  vote,
  voteName,
  type GitApi,
  type PullRequest
} from './git'

const PR: PullRequest & { repository: { id: string } } = {
  pullRequestId: 412,
  title: 'Add caching',
  status: 1,
  sourceRefName: 'refs/heads/feature/cache',
  targetRefName: 'refs/heads/main',
  lastMergeSourceCommit: { commitId: 'abc' },
  lastMergeTargetCommit: { commitId: 'def' },
  repository: { id: 'repo-guid', name: 'web', project: { name: 'My Project' } }
}

/** A Git API that fails loudly on any call a test did not expect. */
function fakeGit(overrides: Partial<GitApi> = {}): GitApi {
  const unexpected = (name: string) =>
    vi.fn(async () => {
      throw new Error(`unexpected call to ${name}`)
    })
  const names = [
    'getPullRequestById',
    'getPullRequests',
    'getPullRequestsByProject',
    'createPullRequest',
    'getRepository',
    'getPullRequestIterations',
    'getPullRequestIterationChanges',
    'getThreads',
    'createThread',
    'createComment',
    'updateThread',
    'updatePullRequest',
    'createPullRequestReviewer'
  ]
  return {
    ...Object.fromEntries(names.map((name) => [name, unexpected(name)])),
    ...overrides
  } as GitApi
}

describe('names', () => {
  it('reads votes the way the web UI labels them', () => {
    expect(voteName(10)).toBe('approve')
    expect(voteName(-10)).toBe('reject')
    expect(voteName(-5)).toBe('waitForAuthor')
    expect(voteName(undefined)).toBe('reset')
  })

  it('names thread statuses, and says so when it does not know one', () => {
    expect(threadStatusName(2)).toBe('fixed')
    expect(threadStatusName(6)).toBe('unknown')
  })

  it('names every flag of a change, since a rename can also be an edit', () => {
    expect(changeTypeNames(2)).toBe('edit')
    expect(changeTypeNames(8 | 2)).toBe('edit, rename')
    expect(changeTypeNames(undefined)).toBe('other')
  })

  it('shows a branch as people say it, and sends it as the API wants it', () => {
    expect(branchName('refs/heads/feature/x')).toBe('feature/x')
    expect(branchName(undefined)).toBe('')
    expect(branchRef('feature/x')).toBe('refs/heads/feature/x')
    expect(branchRef('refs/heads/main')).toBe('refs/heads/main')
  })
})

describe('pullRequestUrl', () => {
  it('points at the pull request page, encoding the project', () => {
    expect(pullRequestUrl('contoso', PR)).toBe(
      'https://dev.azure.com/contoso/My%20Project/_git/web/pullrequest/412'
    )
  })

  it('still builds something for a bare response', () => {
    expect(pullRequestUrl('contoso', {})).toBe('https://dev.azure.com/contoso//_git//pullrequest/0')
  })
})

describe('describePullRequest', () => {
  it('reads names rather than the numbers the API stores', () => {
    const described = describePullRequest('contoso', {
      ...PR,
      mergeStatus: 2,
      creationDate: new Date('2026-09-01T10:00:00Z'),
      createdBy: { displayName: 'Ana' },
      reviewers: [{ displayName: 'Bo', vote: 10, isRequired: true }, {}]
    })
    expect(described).toMatchObject({
      id: 412,
      status: 'active',
      sourceBranch: 'feature/cache',
      targetBranch: 'main',
      mergeStatus: 'conflicts',
      author: 'Ana',
      createdAt: '2026-09-01T10:00:00.000Z',
      sourceCommit: 'abc',
      targetCommit: 'def',
      reviewers: [
        { name: 'Bo', vote: 'approve', isRequired: true },
        { name: '', vote: 'reset', isRequired: false }
      ]
    })
  })

  it('renders a bare response as blanks rather than "undefined"', () => {
    expect(describePullRequest('contoso', { creationDate: '2026-09-01' })).toMatchObject({
      id: 0,
      title: '',
      status: 'unknown',
      mergeStatus: 'notSet',
      createdAt: '2026-09-01',
      reviewers: []
    })
    expect(describePullRequest('contoso', {}).createdAt).toBe('')
  })
})

describe('findPullRequest', () => {
  it('finds a pull request by number within the project', async () => {
    const git = fakeGit({ getPullRequestById: vi.fn(async () => PR) })
    await expect(findPullRequest(git, 'proj', 412)).resolves.toBe(PR)
    expect(git.getPullRequestById).toHaveBeenCalledWith(412, 'proj')
  })

  it('says it was not found rather than failing on a property of null', async () => {
    // The SDK answers a missing pull request with null, not a 404.
    const git = fakeGit({ getPullRequestById: vi.fn(async () => null as unknown as PullRequest) })
    await expect(findPullRequest(git, 'proj', 9)).rejects.toThrow(
      'Pull request 9 was not found in project proj.'
    )
  })

  it('explains a sign-in page', async () => {
    const git = fakeGit({
      getPullRequestById: vi.fn(async () => {
        throw new Error('Unexpected token <')
      })
    })
    await expect(findPullRequest(git, 'proj', 1)).rejects.toThrow(/sign-in page/)
  })
})

describe('listActivePullRequests', () => {
  it('reads one repository when one is named', async () => {
    const git = fakeGit({ getPullRequests: vi.fn(async () => [PR]) })
    await expect(
      listActivePullRequests(git, { project: 'proj', repository: 'web', top: 5 })
    ).resolves.toEqual([PR])
    expect(git.getPullRequests).toHaveBeenCalledWith('web', { status: 1 }, 'proj', undefined, 0, 5)
  })

  it('reads the whole project otherwise', async () => {
    const git = fakeGit({ getPullRequestsByProject: vi.fn(async () => null as unknown as []) })
    await expect(listActivePullRequests(git, { project: 'proj', top: 5 })).resolves.toEqual([])
    expect(git.getPullRequestsByProject).toHaveBeenCalledWith('proj', { status: 1 }, undefined, 0, 5)
  })
})

describe('createPullRequest', () => {
  const base = {
    project: 'proj',
    repository: 'web',
    sourceBranch: 'feature/x',
    title: 'Do x',
    isDraft: false,
    workItems: [] as string[]
  }

  it('targets the default branch when none is named', async () => {
    const git = fakeGit({
      getRepository: vi.fn(async () => ({ defaultBranch: 'refs/heads/develop' })),
      createPullRequest: vi.fn(async () => PR)
    })
    await createPullRequest(git, base)
    expect(git.createPullRequest).toHaveBeenCalledWith(
      {
        sourceRefName: 'refs/heads/feature/x',
        targetRefName: 'refs/heads/develop',
        title: 'Do x',
        isDraft: false
      },
      'web',
      'proj'
    )
  })

  it('sends the description, draft flag and work item links it was given', async () => {
    const git = fakeGit({ createPullRequest: vi.fn(async () => PR) })
    await createPullRequest(git, {
      ...base,
      targetBranch: 'main',
      description: 'Why',
      isDraft: true,
      workItems: ['7', '8']
    })
    expect(git.createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        targetRefName: 'refs/heads/main',
        description: 'Why',
        isDraft: true,
        workItemRefs: [{ id: '7' }, { id: '8' }]
      }),
      'web',
      'proj'
    )
  })

  it('asks for a target when the repository has no default branch', async () => {
    const git = fakeGit({ getRepository: vi.fn(async () => ({})) })
    await expect(createPullRequest(git, base)).rejects.toThrow(/no default branch/)
  })
})

describe('listChanges', () => {
  it('lists the latest iteration, following the paging signal', async () => {
    const getPullRequestIterationChanges = vi
      .fn()
      .mockResolvedValueOnce({
        changeEntries: [{ changeType: 2, item: { path: '/a.ts' } }],
        nextSkip: 1
      })
      .mockResolvedValueOnce({
        changeEntries: [
          { changeType: 8, item: { path: '/b.ts' }, originalPath: '/old-b.ts' },
          { changeType: 1, item: {} }
        ]
      })
    const git = fakeGit({
      getPullRequestIterations: vi.fn(async () => [{ id: 1 }, { id: 3 }, {}]),
      getPullRequestIterationChanges
    })
    await expect(listChanges(git, 'proj', PR)).resolves.toEqual([
      { path: '/a.ts', changeType: 'edit' },
      { path: '/b.ts', changeType: 'rename', originalPath: '/old-b.ts' }
    ])
    expect(getPullRequestIterationChanges).toHaveBeenNthCalledWith(1, 'repo-guid', 412, 3, 'proj', 2000, 0)
    expect(getPullRequestIterationChanges).toHaveBeenNthCalledWith(2, 'repo-guid', 412, 3, 'proj', 2000, 1)
  })

  it('stops if the paging signal does not move forward', async () => {
    const getPullRequestIterationChanges = vi.fn(async () => ({ changeEntries: [], nextSkip: 0 }))
    const git = fakeGit({
      getPullRequestIterations: vi.fn(async () => [{ id: 1 }]),
      getPullRequestIterationChanges
    })
    await listChanges(git, 'proj', PR)
    expect(getPullRequestIterationChanges).toHaveBeenCalledTimes(1)
  })

  it('returns nothing for a pull request with no pushes yet', async () => {
    const git = fakeGit({ getPullRequestIterations: vi.fn(async () => null as unknown as []) })
    await expect(listChanges(git, 'proj', PR)).resolves.toEqual([])
  })
})

describe('listThreads', () => {
  it('keeps what people wrote and drops system notices and deleted comments', async () => {
    const git = fakeGit({
      getThreads: vi.fn(async () => [
        {
          id: 1,
          status: 1,
          threadContext: { filePath: '/a.ts', rightFileStart: { line: 4, offset: 1 } },
          comments: [
            {
              id: 1,
              content: 'Why?',
              author: { displayName: 'Bo' },
              publishedDate: new Date('2026-09-01T00:00:00Z')
            },
            { id: 2, content: 'gone', isDeleted: true }
          ]
        },
        { id: 2, comments: [{ id: 1, content: 'Bo voted 10', commentType: 3 }] },
        { id: 3, isDeleted: true, comments: [{ id: 1, content: 'x' }] },
        { id: 4, status: 2, threadContext: null, comments: [{ content: 'Overview note' }] },
        {}
      ])
    })
    await expect(listThreads(git, 'proj', PR)).resolves.toEqual([
      {
        id: 1,
        status: 'active',
        filePath: '/a.ts',
        line: 4,
        comments: [{ id: 1, author: 'Bo', content: 'Why?', publishedAt: '2026-09-01T00:00:00.000Z' }]
      },
      {
        id: 4,
        status: 'fixed',
        filePath: '',
        line: 0,
        comments: [{ id: 0, author: '', content: 'Overview note', publishedAt: '' }]
      }
    ])
  })

  it('reads an empty answer as no threads', async () => {
    const git = fakeGit({ getThreads: vi.fn(async () => null as unknown as []) })
    await expect(listThreads(git, 'proj', PR)).resolves.toEqual([])
  })
})

describe('comment', () => {
  it('starts an active thread on the overview', async () => {
    const git = fakeGit({ createThread: vi.fn(async () => ({ id: 7, comments: [{ id: 1 }] })) })
    await expect(comment(git, 'proj', PR, { text: 'Nice' })).resolves.toEqual({
      threadId: 7,
      commentId: 1
    })
    expect(git.createThread).toHaveBeenCalledWith(
      { comments: [{ content: 'Nice', parentCommentId: 0, commentType: 1 }], status: 1 },
      'repo-guid',
      412,
      'proj'
    )
  })

  it('pins a thread to a line of the new code, rooting the path', async () => {
    const git = fakeGit({ createThread: vi.fn(async () => ({})) })
    await expect(
      comment(git, 'proj', PR, { text: 'Off by one', filePath: 'src/a.ts', line: 12, status: 4 })
    ).resolves.toEqual({ threadId: 0, commentId: 0 })
    expect(git.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 4,
        threadContext: {
          filePath: '/src/a.ts',
          rightFileStart: { line: 12, offset: 1 },
          rightFileEnd: { line: 12, offset: 1 }
        }
      }),
      'repo-guid',
      412,
      'proj'
    )
  })

  it('comments on a whole file when no line is given', async () => {
    const git = fakeGit({ createThread: vi.fn(async () => ({ id: 1 })) })
    await comment(git, 'proj', PR, { text: 'x', filePath: '/a.ts' })
    expect(git.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ threadContext: { filePath: '/a.ts' } }),
      'repo-guid',
      412,
      'proj'
    )
  })

  it('refuses a line with no file to put it in', async () => {
    await expect(comment(fakeGit(), 'proj', PR, { text: 'x', line: 3 })).rejects.toThrow(
      /needs a filePath/
    )
  })

  it('replies in a thread, and changes its status when asked', async () => {
    const git = fakeGit({
      createComment: vi.fn(async () => ({ id: 3 })),
      updateThread: vi.fn(async () => ({}))
    })
    await expect(
      comment(git, 'proj', PR, { text: 'Fixed', threadId: 7, status: 2 })
    ).resolves.toEqual({ threadId: 7, commentId: 3 })
    expect(git.createComment).toHaveBeenCalledWith(
      { content: 'Fixed', parentCommentId: 1, commentType: 1 },
      'repo-guid',
      412,
      7,
      'proj'
    )
    expect(git.updateThread).toHaveBeenCalledWith({ status: 2 }, 'repo-guid', 412, 7, 'proj')
  })

  it('leaves the status of a thread it replies to alone unless asked', async () => {
    const git = fakeGit({ createComment: vi.fn(async () => null as unknown as {}) })
    await expect(comment(git, 'proj', PR, { text: 'Hm', threadId: 7 })).resolves.toEqual({
      threadId: 7,
      commentId: 0
    })
    expect(git.updateThread).not.toHaveBeenCalled()
  })
})

describe('setThreadStatus', () => {
  it('changes only the status', async () => {
    const git = fakeGit({ updateThread: vi.fn(async () => ({ status: 3 })) })
    await expect(setThreadStatus(git, 'proj', PR, 7, 3)).resolves.toEqual({ status: 3 })
    expect(git.updateThread).toHaveBeenCalledWith({ status: 3 }, 'repo-guid', 412, 7, 'proj')
  })
})

describe('vote', () => {
  it('votes as the signed-in identity', async () => {
    const git = fakeGit({ createPullRequestReviewer: vi.fn(async () => ({ vote: -10 })) })
    await expect(vote(git, 'proj', PR, 'me-guid', -10)).resolves.toEqual({ vote: -10 })
    expect(git.createPullRequestReviewer).toHaveBeenCalledWith(
      { vote: -10 },
      'repo-guid',
      412,
      'me-guid',
      'proj'
    )
  })
})

describe('completePullRequest', () => {
  const options = {
    autoComplete: false,
    mergeStrategy: 2,
    deleteSourceBranch: true,
    transitionWorkItems: false
  }

  it('merges now, pinned to the commit that was reviewed', async () => {
    // A push between a review and its merge must not be merged unreviewed;
    // Azure DevOps refuses the completion when the branch has moved.
    const git = fakeGit({ updatePullRequest: vi.fn(async () => ({ status: 3 })) })
    await completePullRequest(git, 'proj', PR, 'me-guid', { ...options, message: 'Ship it' })
    expect(git.updatePullRequest).toHaveBeenCalledWith(
      {
        status: 3,
        lastMergeSourceCommit: { commitId: 'abc' },
        completionOptions: {
          mergeStrategy: 2,
          deleteSourceBranch: true,
          transitionWorkItems: false,
          mergeCommitMessage: 'Ship it'
        }
      },
      'repo-guid',
      412,
      'proj'
    )
  })

  it('pins the merge to the commit a review step read, not the head now', async () => {
    const git = fakeGit({ updatePullRequest: vi.fn(async () => ({})) })
    await completePullRequest(git, 'proj', PR, 'me-guid', { ...options, commitId: 'reviewed' })
    expect(git.updatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ lastMergeSourceCommit: { commitId: 'reviewed' } }),
      'repo-guid',
      412,
      'proj'
    )
  })

  it('sets auto-complete as the signed-in identity rather than merging now', async () => {
    const git = fakeGit({ updatePullRequest: vi.fn(async () => ({})) })
    await completePullRequest(git, 'proj', PR, 'me-guid', { ...options, autoComplete: true })
    expect(git.updatePullRequest).toHaveBeenCalledWith(
      {
        autoCompleteSetBy: { id: 'me-guid' },
        completionOptions: { mergeStrategy: 2, deleteSourceBranch: true, transitionWorkItems: false }
      },
      'repo-guid',
      412,
      'proj'
    )
  })

  it("reports a policy block in the API's own words", async () => {
    const git = fakeGit({
      updatePullRequest: vi.fn(async () => {
        throw new Error('TF401181: The pull request cannot be completed: required reviewers')
      })
    })
    await expect(completePullRequest(git, 'proj', PR, 'me-guid', options)).rejects.toThrow(
      /TF401181/
    )
  })
})
