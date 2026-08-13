import { describe, expect, it } from 'vitest'
import {
  GITHUB_POLL_PAGE_SIZE,
  GITHUB_SEARCH_INDEX_OVERLAP_MS,
  GITHUB_SEARCH_MAX_PAGE,
  assertCompleteSearch,
  buildSearchQuery,
  githubSearchTimestamp,
  nextSearchCursor,
  parsePollCursor,
  searchCursor,
  type GitHubIssue,
  type GitHubSearchResponse
} from './search'

function issue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 1,
    html_url: 'https://github.com/o/r/issues/1',
    title: 'Something',
    state: 'open',
    created_at: '2026-08-01T12:00:00.000Z',
    updated_at: '2026-08-01T12:00:00.000Z',
    ...overrides
  }
}

function response(overrides: Partial<GitHubSearchResponse> = {}): GitHubSearchResponse {
  return { total_count: 1, incomplete_results: false, items: [issue()], ...overrides }
}

describe('parsePollCursor', () => {
  it('reads the {since, page} form it writes', () => {
    expect(parsePollCursor('{"since":"2026-08-01T00:00:00.000Z","page":3}')).toEqual({
      since: '2026-08-01T00:00:00.000Z',
      page: 3
    })
  })

  // Connections created before the cursor became an object still hold a bare
  // timestamp. Reading it as page 1 keeps them polling instead of restarting.
  it('accepts a legacy bare timestamp', () => {
    expect(parsePollCursor('2026-08-01T00:00:00.000Z')).toEqual({
      since: '2026-08-01T00:00:00.000Z',
      page: 1
    })
  })

  it('falls back to page 1 when the object is malformed', () => {
    for (const bad of ['{"since":"x"}', '{"page":2}', '{"since":"x","page":0}', '{"since":"x","page":1.5}']) {
      expect(parsePollCursor(bad)).toEqual({ since: bad, page: 1 })
    }
  })

  it('starts a minute back when there is no cursor at all', () => {
    const now = Date.parse('2026-08-01T12:00:00.000Z')
    expect(parsePollCursor(undefined, () => now)).toEqual({
      since: '2026-08-01T11:59:00.000Z',
      page: 1
    })
  })

  it('round-trips through searchCursor', () => {
    const cursor = { since: '2026-08-01T00:00:00.000Z', page: 4 }
    expect(parsePollCursor(searchCursor(cursor))).toEqual(cursor)
  })
})

describe('githubSearchTimestamp', () => {
  /**
   * `created:>X` is strict and compares at second precision, so passing the
   * cursor unchanged drops every item created in the cursor's own second.
   */
  it('rewinds a second and drops milliseconds', () => {
    expect(githubSearchTimestamp('2026-08-01T12:00:05.400Z')).toBe('2026-08-01T12:00:04Z')
  })

  it('refuses a timestamp it cannot parse rather than searching from Invalid Date', () => {
    expect(() => githubSearchTimestamp('not a date')).toThrow(/Invalid GitHub poll cursor/)
  })
})

describe('buildSearchQuery', () => {
  const cursor = { since: '2026-08-01T12:00:05.000Z', page: 1 }

  it('scopes to the repo and kind, from one second before the cursor', () => {
    expect(buildSearchQuery('vorn-run', 'vorn', 'issue', cursor)).toBe(
      'repo:vorn-run/vorn is:issue created:>2026-08-01T12:00:04Z'
    )
  })

  it('asks for pull requests with is:pr', () => {
    expect(buildSearchQuery('o', 'r', 'pr', cursor)).toContain('is:pr')
  })

  it('adds one term per label, trimming and ignoring blanks', () => {
    expect(buildSearchQuery('o', 'r', 'issue', cursor, 'bug, enhancement ,,')).toBe(
      'repo:o/r is:issue created:>2026-08-01T12:00:04Z label:"bug" label:"enhancement"'
    )
  })

  it('escapes a quote in a label rather than ending the term early', () => {
    expect(buildSearchQuery('o', 'r', 'issue', cursor, 'say "hi"')).toContain('label:"say \\"hi\\""')
  })

  // The label field is described on the form as filtering issues. Narrowing
  // pull requests by it too would be a surprise nothing explains.
  it('ignores labels for pull requests', () => {
    expect(buildSearchQuery('o', 'r', 'pr', cursor, 'bug')).not.toContain('label:')
  })

  it('ignores a labels value that is not a string', () => {
    expect(buildSearchQuery('o', 'r', 'issue', cursor, ['bug'])).not.toContain('label:')
  })
})

describe('nextSearchCursor', () => {
  const pollStartedAt = '2026-08-01T12:00:00.000Z'
  const cursor = { since: '2026-08-01T00:00:00.000Z', page: 1 }

  /**
   * The search index lags writes, so an item created before the poll ran can
   * be indexed after it. Leaving the watermark at "now" would step over it and
   * nothing would ever report it missing.
   */
  it('leaves the watermark behind the poll start when the set is exhausted', () => {
    const next = nextSearchCursor(cursor, response({ total_count: 1 }), pollStartedAt)
    expect(next.hasMore).toBe(false)
    expect(Date.parse(next.cursor)).toBe(Date.parse(pollStartedAt) - GITHUB_SEARCH_INDEX_OVERLAP_MS)
  })

  it('takes the next page while the result set has more', () => {
    const next = nextSearchCursor(cursor, response({ total_count: 250 }), pollStartedAt)
    expect(next).toEqual({
      cursor: searchCursor({ since: cursor.since, page: 2 }),
      hasMore: true
    })
  })

  it('keeps paging up to the last page search will serve', () => {
    const atLast = { since: cursor.since, page: GITHUB_SEARCH_MAX_PAGE - 1 }
    const next = nextSearchCursor(atLast, response({ total_count: 5_000 }), pollStartedAt)
    expect(next.cursor).toBe(searchCursor({ since: cursor.since, page: GITHUB_SEARCH_MAX_PAGE }))
  })

  /**
   * Search serves at most 1,000 results whatever total_count claims. Rather
   * than ask for page 11 and get an error, move the window to just before the
   * last item seen and start again — overlapping a second so items sharing
   * that boundary are replayed into a de-duplicating consumer rather than
   * skipped.
   */
  it('advances the time window instead of asking for a page search will not serve', () => {
    const atCap = { since: cursor.since, page: GITHUB_SEARCH_MAX_PAGE }
    const next = nextSearchCursor(
      atCap,
      response({
        total_count: 5_000,
        items: [issue({ created_at: '2026-08-01T06:00:10.000Z' })]
      }),
      pollStartedAt
    )
    expect(next.hasMore).toBe(true)
    expect(parsePollCursor(next.cursor)).toEqual({
      since: '2026-08-01T06:00:09.000Z',
      page: 1
    })
  })

  it('refuses to advance when the whole capped page shares the cursor second', () => {
    const atCap = { since: '2026-08-01T06:00:00.000Z', page: GITHUB_SEARCH_MAX_PAGE }
    expect(() =>
      nextSearchCursor(
        atCap,
        response({ total_count: 5_000, items: [issue({ created_at: '2026-08-01T06:00:00.000Z' })] }),
        pollStartedAt
      )
    ).toThrow(/more than 1,000 items at one timestamp/)
  })

  it('refuses a page that claims more results but returned nothing', () => {
    const atCap = { since: cursor.since, page: GITHUB_SEARCH_MAX_PAGE }
    expect(() =>
      nextSearchCursor(atCap, response({ total_count: 5_000, items: [] }), pollStartedAt)
    ).toThrow(/empty page/)
  })

  it('counts a full page as exhausted only when total_count agrees', () => {
    const full = Array.from({ length: GITHUB_POLL_PAGE_SIZE }, (_, i) => issue({ number: i + 1 }))
    const next = nextSearchCursor(
      cursor,
      response({ total_count: GITHUB_POLL_PAGE_SIZE, items: full }),
      pollStartedAt
    )
    expect(next.hasMore).toBe(false)
  })
})

describe('assertCompleteSearch', () => {
  it('passes a complete response', () => {
    expect(() => assertCompleteSearch(response())).not.toThrow()
  })

  /**
   * `incomplete_results` means the query timed out server-side and the page is
   * a subset with no indication of what is missing. Advancing past it would
   * lose those items for good, so the poll must fail and retry in place.
   */
  it('throws on a partial response rather than advancing over the gap', () => {
    expect(() => assertCompleteSearch(response({ incomplete_results: true }))).toThrow(
      /incomplete results/
    )
  })
})
