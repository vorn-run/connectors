import { explain, organizationUrl } from './client'

/**
 * Azure Repos pull requests: what a code review needs to read and to say.
 *
 * Every call here names a pull request by its number alone. The number is
 * unique across a project, and the repository a call also needs is read off
 * the pull request itself, so a workflow can go from "review #412" to a
 * comment without anyone typing the repository's name or GUID.
 */

type Identity = { id?: string; displayName?: string; uniqueName?: string }

export type PullRequest = {
  pullRequestId?: number
  title?: string
  description?: string
  /** 1 active, 2 abandoned, 3 completed. */
  status?: number
  isDraft?: boolean
  sourceRefName?: string
  targetRefName?: string
  creationDate?: Date | string
  createdBy?: Identity
  mergeStatus?: number
  lastMergeSourceCommit?: { commitId?: string }
  lastMergeTargetCommit?: { commitId?: string }
  autoCompleteSetBy?: Identity
  labels?: { name?: string }[]
  reviewers?: (Identity & { vote?: number; isRequired?: boolean })[]
  repository?: { id?: string; name?: string; project?: { name?: string } }
}

export type ThreadComment = {
  id?: number
  parentCommentId?: number
  content?: string
  commentType?: number
  author?: Identity
  publishedDate?: Date | string
  isDeleted?: boolean
}

type FilePosition = { line: number; offset: number }

export type Thread = {
  id?: number
  status?: number
  isDeleted?: boolean
  comments?: ThreadComment[]
  threadContext?: {
    filePath?: string
    rightFileStart?: FilePosition
    rightFileEnd?: FilePosition
  } | null
}

export type ChangeEntry = {
  changeType?: number
  item?: { path?: string }
  originalPath?: string
}

/**
 * The slice of the SDK's Git API this connector uses, declared structurally
 * for the same reason `WitApi` is: a test supplies a fake, and the surface
 * actually depended upon is visible in one place.
 */
export type GitApi = {
  getPullRequestById(pullRequestId: number, project?: string): Promise<PullRequest>
  getPullRequests(
    repositoryId: string,
    searchCriteria: { status?: number },
    project?: string,
    maxCommentLength?: number,
    skip?: number,
    top?: number
  ): Promise<PullRequest[]>
  getPullRequestsByProject(
    project: string,
    searchCriteria: { status?: number },
    maxCommentLength?: number,
    skip?: number,
    top?: number
  ): Promise<PullRequest[]>
  createPullRequest(
    pullRequest: Record<string, unknown>,
    repositoryId: string,
    project?: string
  ): Promise<PullRequest>
  getRepository(repositoryId: string, project?: string): Promise<{ defaultBranch?: string }>
  getPullRequestIterations(
    repositoryId: string,
    pullRequestId: number,
    project?: string
  ): Promise<{ id?: number }[]>
  getPullRequestIterationChanges(
    repositoryId: string,
    pullRequestId: number,
    iterationId: number,
    project?: string,
    top?: number,
    skip?: number
  ): Promise<{ changeEntries?: ChangeEntry[]; nextSkip?: number }>
  getThreads(repositoryId: string, pullRequestId: number, project?: string): Promise<Thread[]>
  createThread(
    thread: Thread,
    repositoryId: string,
    pullRequestId: number,
    project?: string
  ): Promise<Thread>
  createComment(
    comment: ThreadComment,
    repositoryId: string,
    pullRequestId: number,
    threadId: number,
    project?: string
  ): Promise<ThreadComment>
  updateThread(
    thread: Thread,
    repositoryId: string,
    pullRequestId: number,
    threadId: number,
    project?: string
  ): Promise<Thread>
  updatePullRequest(
    pullRequest: Record<string, unknown>,
    repositoryId: string,
    pullRequestId: number,
    project?: string
  ): Promise<PullRequest>
  createPullRequestReviewer(
    reviewer: { vote: number },
    repositoryId: string,
    pullRequestId: number,
    reviewerId: string,
    project?: string
  ): Promise<{ vote?: number }>
}

/** PullRequestStatus.Active in the SDK's enum. */
export const ACTIVE = 1

const PULL_REQUEST_STATUS: Record<number, string> = { 1: 'active', 2: 'abandoned', 3: 'completed' }

const MERGE_STATUS: Record<number, string> = {
  1: 'queued',
  2: 'conflicts',
  3: 'succeeded',
  4: 'rejectedByPolicy',
  5: 'failure'
}

/**
 * The votes a reviewer can cast, by the names the web UI gives them.
 *
 * Azure DevOps stores a vote as a number; a workflow author writing
 * "reject" should not need to know it is -10.
 */
export const VOTES = {
  approve: 10,
  approveWithSuggestions: 5,
  reset: 0,
  waitForAuthor: -5,
  reject: -10
} as const

export type VoteName = keyof typeof VOTES

export function voteName(vote: number | undefined): string {
  const found = Object.entries(VOTES).find(([, value]) => value === vote)
  return found ? found[0] : 'reset'
}

/** CommentThreadStatus, by name. `pending` is left out: it is the UI's draft state. */
export const THREAD_STATUSES = {
  active: 1,
  fixed: 2,
  wontFix: 3,
  closed: 4,
  byDesign: 5
} as const

export type ThreadStatusName = keyof typeof THREAD_STATUSES

export function threadStatusName(status: number | undefined): string {
  const found = Object.entries(THREAD_STATUSES).find(([, value]) => value === status)
  return found ? found[0] : 'unknown'
}

/**
 * VersionControlChangeType is a set of flags — a renamed file that was also
 * edited is both — so every flag that is set is named.
 */
const CHANGE_FLAGS: [number, string][] = [
  [1, 'add'],
  [2, 'edit'],
  [8, 'rename'],
  [16, 'delete'],
  [32, 'undelete']
]

export function changeTypeNames(changeType: number | undefined): string {
  const names = CHANGE_FLAGS.filter(([flag]) => ((changeType ?? 0) & flag) !== 0).map(
    ([, name]) => name
  )
  return names.join(', ') || 'other'
}

/** `refs/heads/feature/x` → `feature/x`, which is what people call a branch. */
export function branchName(ref: string | undefined): string {
  return (ref ?? '').replace(/^refs\/heads\//, '')
}

/** A branch as the API wants it: fully qualified. */
export function branchRef(branch: string): string {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`
}

/** Where a person reviewing the pull request should land. */
export function pullRequestUrl(organization: string, pr: PullRequest): string {
  const project = pr.repository?.project?.name ?? ''
  const repository = pr.repository?.name ?? ''
  return (
    `${organizationUrl(organization)}/${encodeURIComponent(project)}` +
    `/_git/${encodeURIComponent(repository)}/pullrequest/${pr.pullRequestId ?? 0}`
  )
}

function iso(date: Date | string | undefined): string {
  if (date === undefined) return ''
  return date instanceof Date ? date.toISOString() : String(date)
}

/** What a step reads back about a pull request. */
export function describePullRequest(organization: string, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.pullRequestId ?? 0,
    url: pullRequestUrl(organization, pr),
    title: pr.title ?? '',
    description: pr.description ?? '',
    status: PULL_REQUEST_STATUS[pr.status ?? 0] ?? 'unknown',
    isDraft: pr.isDraft === true,
    repository: pr.repository?.name ?? '',
    sourceBranch: branchName(pr.sourceRefName),
    targetBranch: branchName(pr.targetRefName),
    author: pr.createdBy?.displayName ?? '',
    createdAt: iso(pr.creationDate),
    mergeStatus: MERGE_STATUS[pr.mergeStatus ?? 0] ?? 'notSet',
    sourceCommit: pr.lastMergeSourceCommit?.commitId ?? '',
    targetCommit: pr.lastMergeTargetCommit?.commitId ?? '',
    reviewers: (pr.reviewers ?? []).map((reviewer) => ({
      name: reviewer.displayName ?? '',
      vote: voteName(reviewer.vote),
      isRequired: reviewer.isRequired === true
    }))
  }
}

async function attempt<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    explain(error)
  }
}

/**
 * Look up a pull request, and with it the repository every other call needs.
 *
 * The SDK answers a missing pull request with null rather than a 404, which
 * would otherwise surface several lines later as a property read on nothing.
 */
export async function findPullRequest(
  git: GitApi,
  project: string,
  id: number
): Promise<PullRequest & { repository: { id: string } }> {
  const pr = await attempt(() => git.getPullRequestById(id, project))
  const repositoryId = pr?.repository?.id
  if (!repositoryId) throw new Error(`Pull request ${id} was not found in project ${project}.`)
  return pr as PullRequest & { repository: { id: string } }
}

/** Active pull requests, newest first, in one repository or across the project. */
export async function listActivePullRequests(
  git: GitApi,
  opts: { project: string; repository?: string; top: number }
): Promise<PullRequest[]> {
  const criteria = { status: ACTIVE }
  const found = await attempt(() =>
    opts.repository
      ? git.getPullRequests(opts.repository, criteria, opts.project, undefined, 0, opts.top)
      : git.getPullRequestsByProject(opts.project, criteria, undefined, 0, opts.top)
  )
  return found ?? []
}

export async function createPullRequest(
  git: GitApi,
  opts: {
    project: string
    repository: string
    sourceBranch: string
    targetBranch?: string
    title: string
    description?: string
    isDraft: boolean
    workItems: string[]
  }
): Promise<PullRequest> {
  // Unnamed, the target is whatever the repository calls its default branch,
  // which is `main` in some and `master` or `develop` in others.
  const target =
    opts.targetBranch ??
    (await attempt(() => git.getRepository(opts.repository, opts.project))).defaultBranch
  if (!target) {
    throw new Error(`Repository ${opts.repository} has no default branch; name targetBranch.`)
  }
  return attempt(() =>
    git.createPullRequest(
      {
        sourceRefName: branchRef(opts.sourceBranch),
        targetRefName: branchRef(target),
        title: opts.title,
        ...(opts.description && { description: opts.description }),
        isDraft: opts.isDraft,
        ...(opts.workItems.length > 0 && { workItemRefs: opts.workItems.map((id) => ({ id })) })
      },
      opts.repository,
      opts.project
    )
  )
}

/** Per request; the API's own ceiling for iteration changes. */
const CHANGES_PAGE = 2000

/**
 * The files the pull request changes, as of its latest push.
 *
 * Azure DevOps has no unified diff endpoint. The list of paths plus the two
 * commits is what a reviewer needs: `git diff <targetCommit> <sourceCommit>`
 * in a checkout, or a file read at either side.
 */
export async function listChanges(
  git: GitApi,
  project: string,
  pr: PullRequest & { repository: { id: string } }
): Promise<{ path: string; changeType: string; originalPath?: string }[]> {
  const repositoryId = pr.repository.id
  const id = pr.pullRequestId ?? 0
  const iterations = await attempt(() => git.getPullRequestIterations(repositoryId, id, project))
  const latest = Math.max(0, ...(iterations ?? []).map((iteration) => iteration.id ?? 0))
  if (latest === 0) return []

  const entries: ChangeEntry[] = []
  let skip = 0
  for (;;) {
    const page = await attempt(() =>
      git.getPullRequestIterationChanges(repositoryId, id, latest, project, CHANGES_PAGE, skip)
    )
    entries.push(...(page?.changeEntries ?? []))
    // nextSkip is only set while there is more; the API's own paging signal.
    if (!page?.nextSkip || page.nextSkip <= skip) break
    skip = page.nextSkip
  }
  return entries
    .filter((entry) => entry.item?.path)
    .map((entry) => ({
      path: entry.item?.path ?? '',
      changeType: changeTypeNames(entry.changeType),
      ...(entry.originalPath && { originalPath: entry.originalPath })
    }))
}

/**
 * The review discussion so far.
 *
 * System threads — "Jane voted", "policy passed" — are dropped: they are not
 * something a reviewer answers, and they outnumber the real ones.
 */
export async function listThreads(
  git: GitApi,
  project: string,
  pr: PullRequest & { repository: { id: string } }
): Promise<Record<string, unknown>[]> {
  const threads = await attempt(() =>
    git.getThreads(pr.repository.id, pr.pullRequestId ?? 0, project)
  )
  return (threads ?? [])
    .filter((thread) => !thread.isDeleted)
    .map((thread) => ({
      thread,
      comments: (thread.comments ?? []).filter(
        // CommentType.Text is 1; 2 and 3 are code-change and system notices.
        (comment) => !comment.isDeleted && (comment.commentType ?? 1) === 1
      )
    }))
    .filter(({ comments }) => comments.length > 0)
    .map(({ thread, comments }) => ({
      id: thread.id ?? 0,
      status: threadStatusName(thread.status),
      filePath: thread.threadContext?.filePath ?? '',
      line: thread.threadContext?.rightFileStart?.line ?? 0,
      comments: comments.map((comment) => ({
        id: comment.id ?? 0,
        author: comment.author?.displayName ?? '',
        content: comment.content ?? '',
        publishedAt: iso(comment.publishedDate)
      }))
    }))
}

/**
 * Start a thread, or reply in one.
 *
 * With a file and line the thread is pinned to that line of the new code,
 * where it shows beside the diff; without, it goes on the overview.
 */
export async function comment(
  git: GitApi,
  project: string,
  pr: PullRequest & { repository: { id: string } },
  opts: { text: string; filePath?: string; line?: number; threadId?: number; status?: number }
): Promise<{ threadId: number; commentId: number }> {
  const repositoryId = pr.repository.id
  const id = pr.pullRequestId ?? 0

  if (opts.threadId !== undefined) {
    const threadId = opts.threadId
    const reply = await attempt(() =>
      // Parent 1 is the thread's opening comment: a reply to the thread, not
      // to whichever reply came last.
      git.createComment(
        { content: opts.text, parentCommentId: 1, commentType: 1 },
        repositoryId,
        id,
        threadId,
        project
      )
    )
    if (opts.status !== undefined) {
      await attempt(() => git.updateThread({ status: opts.status }, repositoryId, id, threadId, project))
    }
    return { threadId, commentId: reply?.id ?? 0 }
  }

  if (opts.line !== undefined && !opts.filePath) {
    throw new Error('A line needs a filePath to say which file it is in.')
  }
  const thread = await attempt(() =>
    git.createThread(
      {
        comments: [{ content: opts.text, parentCommentId: 0, commentType: 1 }],
        status: opts.status ?? THREAD_STATUSES.active,
        ...(opts.filePath && {
          threadContext: {
            // The API wants a rooted path and gives a thread without one no file.
            filePath: opts.filePath.startsWith('/') ? opts.filePath : `/${opts.filePath}`,
            ...(opts.line !== undefined && {
              rightFileStart: { line: opts.line, offset: 1 },
              rightFileEnd: { line: opts.line, offset: 1 }
            })
          }
        })
      },
      repositoryId,
      id,
      project
    )
  )
  return { threadId: thread?.id ?? 0, commentId: thread?.comments?.[0]?.id ?? 0 }
}

export async function setThreadStatus(
  git: GitApi,
  project: string,
  pr: PullRequest & { repository: { id: string } },
  threadId: number,
  status: number
): Promise<Thread> {
  return attempt(() =>
    git.updateThread({ status }, pr.repository.id, pr.pullRequestId ?? 0, threadId, project)
  )
}

/**
 * Cast the signed-in identity's vote.
 *
 * Voting is adding yourself as a reviewer with a vote, which is what the web
 * UI's Approve button does too — so it works on a pull request nobody asked
 * you to review.
 */
export async function vote(
  git: GitApi,
  project: string,
  pr: PullRequest & { repository: { id: string } },
  userId: string,
  value: number
): Promise<{ vote?: number }> {
  return attempt(() =>
    git.createPullRequestReviewer(
      { vote: value },
      pr.repository.id,
      pr.pullRequestId ?? 0,
      userId,
      project
    )
  )
}

/** GitPullRequestMergeStrategy, by the names the web UI's complete dialog uses. */
export const MERGE_STRATEGIES = {
  squash: 2,
  noFastForward: 1,
  rebase: 3,
  rebaseMerge: 4
} as const

export type MergeStrategyName = keyof typeof MERGE_STRATEGIES

/**
 * Complete (merge) a pull request, or set it to complete itself.
 *
 * Completing now pins `lastMergeSourceCommit` to the commit the step read:
 * Azure DevOps refuses the merge if the branch moved since, so a push that
 * lands between a review and its merge is never merged unreviewed.
 *
 * Auto-complete is the other shape, and the one that fits required
 * approvals: the pull request merges itself, as the signed-in identity, the
 * moment every policy passes. A policy that blocks an immediate completion is
 * reported in the API's own words by `explain`.
 */
export async function completePullRequest(
  git: GitApi,
  project: string,
  pr: PullRequest & { repository: { id: string } },
  userId: string,
  opts: {
    autoComplete: boolean
    mergeStrategy: number
    deleteSourceBranch: boolean
    transitionWorkItems: boolean
    message?: string
  }
): Promise<PullRequest> {
  const completionOptions = {
    mergeStrategy: opts.mergeStrategy,
    deleteSourceBranch: opts.deleteSourceBranch,
    transitionWorkItems: opts.transitionWorkItems,
    ...(opts.message && { mergeCommitMessage: opts.message })
  }
  const update = opts.autoComplete
    ? { autoCompleteSetBy: { id: userId }, completionOptions }
    : {
        status: 3,
        lastMergeSourceCommit: { commitId: pr.lastMergeSourceCommit?.commitId },
        completionOptions
      }
  return attempt(() =>
    git.updatePullRequest(update, pr.repository.id, pr.pullRequestId ?? 0, project)
  )
}
