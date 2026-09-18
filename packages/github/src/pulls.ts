/**
 * Pull request review, through Octokit: read what changed, say something about
 * it, decide, and merge.
 *
 * Kept apart from connector.ts so each call's shape — which endpoint, which
 * fields come back — is testable without a harness, and the connector is left
 * describing actions rather than building request bodies.
 */

import type { GitHubApi } from './client'

export type Repo = { owner: string; repo: string }

type User = { login?: string } | null | undefined

/** What a step reads back about a pull request. */
export type PullSummary = {
  number: number
  url: string
  title: string
  body: string
  state: string
  draft: boolean
  merged: boolean
  mergeable: boolean | null
  mergeableState: string
  author: string
  headBranch: string
  headSha: string
  baseBranch: string
  additions: number
  deletions: number
  changedFiles: number
  reviews: { author: string; state: string }[]
}

type RawPull = {
  number?: number
  html_url?: string
  title?: string
  body?: string | null
  state?: string
  draft?: boolean
  merged?: boolean
  mergeable?: boolean | null
  mergeable_state?: string
  user?: User
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null }
  base?: { ref?: string }
  additions?: number
  deletions?: number
  changed_files?: number
}

type RawReview = { user?: User; state?: string; submitted_at?: string }

async function readPull(api: GitHubApi, where: Repo, number: number): Promise<RawPull> {
  const response = await api.rest.pulls.get({ ...where, pull_number: number })
  return (response?.data ?? {}) as RawPull
}

/**
 * Each reviewer's standing verdict.
 *
 * GitHub keeps every review ever submitted; what matters for "is this
 * approved" is each person's latest one that decided something. A later
 * plain comment does not withdraw an approval, so COMMENTED reviews are
 * passed over rather than counted as the latest.
 */
export function latestVerdicts(reviews: RawReview[]): { author: string; state: string }[] {
  const byAuthor = new Map<string, string>()
  for (const review of reviews) {
    const author = review.user?.login ?? ''
    const state = review.state ?? ''
    if (!author || state === 'COMMENTED' || state === 'PENDING') continue
    byAuthor.set(author, state)
  }
  return [...byAuthor].map(([author, state]) => ({ author, state }))
}

export async function getPull(api: GitHubApi, where: Repo, number: number): Promise<PullSummary> {
  const pull = await readPull(api, where, number)
  const reviews = (await api.paginate(api.rest.pulls.listReviews, {
    ...where,
    pull_number: number,
    per_page: 100
  })) as RawReview[]
  return {
    number: pull.number ?? number,
    url: pull.html_url ?? '',
    title: pull.title ?? '',
    body: pull.body ?? '',
    state: pull.state ?? '',
    draft: pull.draft === true,
    merged: pull.merged === true,
    // null means GitHub has not worked it out yet, which is not the same as no.
    mergeable: pull.mergeable ?? null,
    mergeableState: pull.mergeable_state ?? '',
    author: pull.user?.login ?? '',
    headBranch: pull.head?.ref ?? '',
    headSha: pull.head?.sha ?? '',
    baseBranch: pull.base?.ref ?? '',
    additions: pull.additions ?? 0,
    deletions: pull.deletions ?? 0,
    changedFiles: pull.changed_files ?? 0,
    reviews: latestVerdicts(reviews ?? [])
  }
}

type RawFile = {
  filename?: string
  status?: string
  additions?: number
  deletions?: number
  patch?: string
  previous_filename?: string
}

/**
 * The changed files with their diffs.
 *
 * `patch` is the unified diff GitHub renders on the Files tab, which is what
 * a reviewer reads. It is absent for binaries and for files too large to
 * diff, and blank rather than missing here so a template can test it.
 */
export async function listFiles(api: GitHubApi, where: Repo, number: number) {
  const files = (await api.paginate(api.rest.pulls.listFiles, {
    ...where,
    pull_number: number,
    per_page: 100
  })) as RawFile[]
  return (files ?? []).map((file) => ({
    filename: file.filename ?? '',
    status: file.status ?? '',
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    patch: file.patch ?? '',
    ...(file.previous_filename && { previousFilename: file.previous_filename })
  }))
}

type RawComment = {
  id?: number
  user?: User
  body?: string
  html_url?: string
  path?: string
  line?: number | null
  original_line?: number | null
  in_reply_to_id?: number
  created_at?: string
}

/**
 * The discussion so far: comments on lines of the diff, and the conversation.
 *
 * GitHub keeps these as two separate lists behind two endpoints, and a review
 * that skipped either would repeat something already said.
 */
export async function listComments(api: GitHubApi, where: Repo, number: number) {
  const inline = (await api.paginate(api.rest.pulls.listReviewComments, {
    ...where,
    pull_number: number,
    per_page: 100
  })) as RawComment[]
  const conversation = (await api.paginate(api.rest.issues.listComments, {
    ...where,
    issue_number: number,
    per_page: 100
  })) as RawComment[]
  return {
    inline: (inline ?? []).map((comment) => ({
      id: comment.id ?? 0,
      author: comment.user?.login ?? '',
      body: comment.body ?? '',
      path: comment.path ?? '',
      // `line` goes null once the line is outdated by a later push.
      line: comment.line ?? comment.original_line ?? 0,
      ...(comment.in_reply_to_id && { inReplyTo: comment.in_reply_to_id }),
      url: comment.html_url ?? '',
      createdAt: comment.created_at ?? ''
    })),
    conversation: (conversation ?? []).map((comment) => ({
      id: comment.id ?? 0,
      author: comment.user?.login ?? '',
      body: comment.body ?? '',
      url: comment.html_url ?? '',
      createdAt: comment.created_at ?? ''
    }))
  }
}

/**
 * Comment on the conversation, on a line of the diff, or in reply to an
 * inline comment.
 *
 * A line comment is pinned to the head commit read just before it, which is
 * what GitHub requires and what makes it land on the diff the reviewer saw.
 */
export async function comment(
  api: GitHubApi,
  where: Repo,
  number: number,
  opts: { body: string; path?: string; line?: number; replyTo?: number }
): Promise<{ id: number; url: string }> {
  if (opts.replyTo !== undefined) {
    const reply = await api.rest.pulls.createReplyForReviewComment({
      ...where,
      pull_number: number,
      comment_id: opts.replyTo,
      body: opts.body
    })
    return { id: reply?.data?.id ?? 0, url: reply?.data?.html_url ?? '' }
  }
  if (opts.line !== undefined && !opts.path) {
    throw new Error('A line needs a path to say which file it is in.')
  }
  if (opts.path) {
    const head = (await readPull(api, where, number)).head?.sha
    if (!head) throw new Error(`Pull request #${number} has no head commit to comment on.`)
    const posted = await api.rest.pulls.createReviewComment({
      ...where,
      pull_number: number,
      commit_id: head,
      path: opts.path.replace(/^\/+/, ''),
      body: opts.body,
      ...(opts.line !== undefined
        ? { line: opts.line, side: 'RIGHT' as const }
        : { subject_type: 'file' as const })
    })
    return { id: posted?.data?.id ?? 0, url: posted?.data?.html_url ?? '' }
  }
  const posted = await api.rest.issues.createComment({ ...where, issue_number: number, body: opts.body })
  return { id: posted?.data?.id ?? 0, url: posted?.data?.html_url ?? '' }
}

export const REVIEW_EVENTS = {
  approve: 'APPROVE',
  requestChanges: 'REQUEST_CHANGES',
  comment: 'COMMENT'
} as const

export type ReviewEventName = keyof typeof REVIEW_EVENTS

export type InlineComment = { path: string; line: number; body: string }

/**
 * Inline review comments, from the `comments` argument.
 *
 * Accepts a list or a single object, so the one-comment case needs no
 * brackets, and names the entry that is wrong rather than letting GitHub
 * answer 422 about the whole review.
 */
export function inlineComments(value: unknown): InlineComment[] {
  if (value === undefined || value === null || value === '') return []
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list.map((entry, index) => {
    const { path, line, body } = (entry ?? {}) as Record<string, unknown>
    const at = Number(line)
    if (typeof path !== 'string' || !path.trim() || !Number.isInteger(at) || at <= 0 || typeof body !== 'string' || !body.trim()) {
      throw new Error(`comments[${index}] needs a path, a positive line and a body.`)
    }
    return { path: path.replace(/^\/+/, ''), line: at, body }
  })
}

/**
 * Submit a review: a verdict, a summary, and any number of line comments,
 * delivered to the author as one notification rather than one per comment.
 */
export async function review(
  api: GitHubApi,
  where: Repo,
  number: number,
  opts: { event: ReviewEventName; body?: string; comments: InlineComment[] }
): Promise<{ id: number; state: string; url: string }> {
  if (opts.event !== 'approve' && !opts.body) {
    // GitHub answers 422 without one; saying which argument is kinder.
    throw new Error(`A ${opts.event} review needs a body saying why.`)
  }
  const submitted = await api.rest.pulls.createReview({
    ...where,
    pull_number: number,
    event: REVIEW_EVENTS[opts.event],
    ...(opts.body && { body: opts.body }),
    ...(opts.comments.length > 0 && {
      comments: opts.comments.map((entry) => ({ ...entry, side: 'RIGHT' }))
    })
  })
  return {
    id: submitted?.data?.id ?? 0,
    state: submitted?.data?.state ?? '',
    url: submitted?.data?.html_url ?? ''
  }
}

/** `alice, acme/platform` → one user and one team, as the API takes them. */
export function splitReviewers(value: unknown): { reviewers: string[]; teams: string[] } {
  const names = String(value ?? '')
    .split(',')
    .map((name) => name.trim().replace(/^@/, ''))
    .filter(Boolean)
  return {
    reviewers: names.filter((name) => !name.includes('/')),
    teams: names.filter((name) => name.includes('/')).map((name) => name.split('/').pop() ?? '')
  }
}

export async function requestReviewers(
  api: GitHubApi,
  where: Repo,
  number: number,
  names: { reviewers: string[]; teams: string[] }
): Promise<{ requested: string[] }> {
  if (names.reviewers.length === 0 && names.teams.length === 0) {
    throw new Error('reviewers is required: name at least one user or org/team.')
  }
  const response = await api.rest.pulls.requestReviewers({
    ...where,
    pull_number: number,
    ...(names.reviewers.length > 0 && { reviewers: names.reviewers }),
    ...(names.teams.length > 0 && { team_reviewers: names.teams })
  })
  const data = (response?.data ?? {}) as {
    requested_reviewers?: User[]
    requested_teams?: { slug?: string }[]
  }
  return {
    requested: [
      ...(data.requested_reviewers ?? []).map((user) => user?.login ?? ''),
      ...(data.requested_teams ?? []).map((team) => team.slug ?? '')
    ].filter(Boolean)
  }
}

export const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const
export type MergeMethod = (typeof MERGE_METHODS)[number]

function status(error: unknown): unknown {
  return (error as { status?: unknown })?.status
}

/**
 * Merge a pull request, only as it was when this step read it.
 *
 * The head commit is read first and sent as `sha`: GitHub refuses the merge
 * (409) if anything was pushed since, so a commit that lands between a review
 * and its merge is never merged unreviewed. Branch protection — required
 * approvals, required checks — is GitHub's to enforce; its refusal (405)
 * comes back in its own words.
 */
export async function merge(
  api: GitHubApi,
  where: Repo,
  number: number,
  opts: { method: MergeMethod; title?: string; message?: string; deleteBranch: boolean }
): Promise<{ merged: boolean; sha: string; branchDeleted: boolean }> {
  const pull = await readPull(api, where, number)
  const head = pull.head?.sha
  if (!head) throw new Error(`Pull request #${number} has no head commit to merge.`)

  let result: { merged?: boolean; sha?: string } | undefined
  try {
    const response = await api.rest.pulls.merge({
      ...where,
      pull_number: number,
      sha: head,
      merge_method: opts.method,
      ...(opts.title && { commit_title: opts.title }),
      ...(opts.message && { commit_message: opts.message })
    })
    result = response?.data
  } catch (error) {
    const code = status(error)
    if (code === 405 || code === 409) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Pull request #${number} cannot be merged: ${reason}`)
    }
    throw error
  }

  // Deleting a branch on someone's fork is not ours to do, and the API would
  // refuse; the merge itself has already succeeded, so it is simply skipped.
  const sameRepo = pull.head?.repo?.full_name === `${where.owner}/${where.repo}`
  let branchDeleted = false
  if (opts.deleteBranch && sameRepo && pull.head?.ref) {
    try {
      await api.rest.git.deleteRef({ ...where, ref: `heads/${pull.head.ref}` })
      branchDeleted = true
    } catch (error) {
      // 422: already gone, as it is when the repository deletes merged
      // branches itself. The branch is deleted either way.
      if (status(error) !== 422) throw error
      branchDeleted = true
    }
  }
  return { merged: result?.merged === true, sha: result?.sha ?? '', branchDeleted }
}
