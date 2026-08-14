/**
 * GitHub's issue search, and the cursor arithmetic that makes polling it safe.
 *
 * This is the part of the connector that is not obvious, so it is kept apart
 * from anything that talks to the network and is tested directly. Three
 * properties of the search API drive all of it:
 *
 *  - `created:>X` is a *strict* lower bound compared at second precision, so a
 *    cursor used verbatim skips every item created in the cursor's own second.
 *  - The search index lags writes by minutes. An item created before the poll
 *    ran can appear only after it, so a watermark set to "now" loses it.
 *  - Search returns at most 1,000 results (10 pages of 100), whatever
 *    `total_count` claims.
 *
 * Ported unchanged from the connector that used to live inside Vorn. Each
 * constant below was a bug once.
 */

export interface GitHubIssue {
  number: number
  html_url: string
  title: string
  body?: string | null
  state: string
  labels?: Array<{ name: string }>
  assignee?: { login: string } | null
  created_at: string
  updated_at: string
  pull_request?: unknown
}

export interface GitHubSearchResponse {
  total_count: number
  incomplete_results: boolean
  items: GitHubIssue[]
}

export interface GitHubPollCursor {
  since: string
  page: number
}

export const GITHUB_POLL_PAGE_SIZE = 100

/**
 * Sorted by creation, ascending, so a poll cut short by the page cap resumes
 * from where it stopped instead of re-reading the newest items forever.
 */
export const issueSort = 'created' as const

/** Search will not serve past page 10; the 1,000th result is the last one. */
export const GITHUB_SEARCH_MAX_PAGE = 10

/**
 * How far behind the poll's start the watermark is left when a pass finishes.
 *
 * The search index is eventually consistent. Setting the watermark to the
 * moment the poll began would step over anything indexed a few seconds later,
 * and nothing would ever report it missing.
 */
export const GITHUB_SEARCH_INDEX_OVERLAP_MS = 5 * 60_000

/**
 * Read a stored cursor. Accepts the `{since, page}` object this writes, and a
 * bare ISO string, which is what older connections still hold.
 */
export function parsePollCursor(cursor: string | undefined, now: () => number = Date.now): GitHubPollCursor {
  if (cursor) {
    try {
      const parsed = JSON.parse(cursor) as Partial<GitHubPollCursor>
      if (
        typeof parsed.since === 'string' &&
        typeof parsed.page === 'number' &&
        Number.isInteger(parsed.page) &&
        parsed.page > 0
      ) {
        return { since: parsed.since, page: parsed.page }
      }
    } catch {
      // Legacy cursors were plain ISO timestamps.
    }
    return { since: cursor, page: 1 }
  }
  return { since: new Date(now() - 60_000).toISOString(), page: 1 }
}

export function searchCursor(cursor: GitHubPollCursor): string {
  return JSON.stringify(cursor)
}

/**
 * The timestamp to put in `created:>`.
 *
 * Rewound a second because the comparison is strict and second-precision:
 * passing the cursor unchanged drops every item sharing its second.
 */
export function githubSearchTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid GitHub poll cursor timestamp: ${value}`)
  }
  return new Date(date.getTime() - 1_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Build the `q` for one search page. */
export function buildSearchQuery(
  owner: string,
  repo: string,
  kind: 'issue' | 'pr',
  cursor: GitHubPollCursor,
  labels?: unknown
): string {
  const terms = [`repo:${owner}/${repo}`, `is:${kind}`, `created:>${githubSearchTimestamp(cursor.since)}`]
  if (kind === 'issue' && typeof labels === 'string') {
    for (const label of labels
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)) {
      terms.push(`label:"${label.replaceAll('"', '\\"')}"`)
    }
  }
  return terms.join(' ')
}

/**
 * Where the next poll should resume.
 *
 * Finished the result set → drop the watermark back by the index-lag overlap
 * and stop. More pages available → take the next one. Out of pages with
 * results remaining → the 1,000 cap has been hit, so move the time window to
 * just before the last item seen and start again, replaying one second so
 * items sharing that boundary are re-delivered rather than skipped. Vorn
 * de-duplicates; it cannot recover something never returned.
 */
export function nextSearchCursor(
  current: GitHubPollCursor,
  response: GitHubSearchResponse,
  pollStartedAt: string
): { cursor: string; hasMore: boolean } {
  const hasAnotherSearchPage = response.total_count > current.page * GITHUB_POLL_PAGE_SIZE
  if (!hasAnotherSearchPage) {
    return {
      cursor: new Date(
        new Date(pollStartedAt).getTime() - GITHUB_SEARCH_INDEX_OVERLAP_MS
      ).toISOString(),
      hasMore: false
    }
  }

  if (current.page < GITHUB_SEARCH_MAX_PAGE) {
    return { cursor: searchCursor({ since: current.since, page: current.page + 1 }), hasMore: true }
  }

  const lastTimestamp = response.items.at(-1)?.created_at
  if (!lastTimestamp) {
    throw new Error('GitHub search reported more results but returned an empty page')
  }
  const overlap = new Date(new Date(lastTimestamp).getTime() - 1_000).toISOString()
  if (new Date(overlap).getTime() <= new Date(current.since).getTime()) {
    // Advancing would mean re-reading the same window forever. Better to stop
    // loudly than to spin, or to skip ahead and lose whatever is in between.
    throw new Error(
      'GitHub search returned more than 1,000 items at one timestamp; cannot advance safely'
    )
  }
  return { cursor: searchCursor({ since: overlap, page: 1 }), hasMore: true }
}

/**
 * Refuse a page GitHub itself says is partial.
 *
 * `incomplete_results` means the query timed out server-side and the response
 * is a subset with no indication of what is missing. Advancing the cursor past
 * it would lose those items permanently, so this throws and the poll retries
 * from the same place.
 */
export function assertCompleteSearch(response: GitHubSearchResponse): void {
  if (response.incomplete_results) {
    throw new Error('GitHub search returned incomplete results; retrying without advancing cursor')
  }
}
