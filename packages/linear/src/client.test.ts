import { describe, it, expect, vi } from 'vitest'
import {
  ISSUE_FIELDS,
  linearGraphQL,
  resolveCompletedStateId,
  resolveIssueId,
  resolveIssueWithTeam,
  resolveTeamId,
  type FetchLike
} from './client'

const API = 'https://api.linear.app/graphql'

interface Sent {
  url: string
  headers: Record<string, string>
  query: string
  variables: Record<string, unknown>
  signal: AbortSignal | null | undefined
}

/**
 * A stand-in for `fetch` that records what the client sent.
 *
 * The tests assert the request this connector builds — the part we own — rather
 * than reimplementing Linear's GraphQL server. `sent` is populated on every
 * call, so a test can check the query and variables that actually went out.
 */
function fakeFetch(
  respond: () => { status?: number; body?: unknown; text?: string }
): { fetchImpl: FetchLike; sent: Sent[]; calls: () => number } {
  const sent: Sent[] = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body ?? '{}'))
    sent.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      query: parsed.query,
      variables: parsed.variables,
      signal: init?.signal
    })
    const { status = 200, body, text } = respond()
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => text ?? ''
    } as Response
  }) as unknown as FetchLike
  return { fetchImpl, sent, calls: () => (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length }
}

/** The common case: one successful GraphQL response. */
function respondingWith(data: unknown) {
  return fakeFetch(() => ({ body: { data } }))
}

describe('linearGraphQL', () => {
  it('posts the query and variables to Linear with the key as Authorization', async () => {
    const { fetchImpl, sent } = respondingWith({ ok: true })

    await linearGraphQL({
      apiKey: 'lin_api_secret',
      query: 'query Whoami { viewer { id } }',
      variables: { a: 1 },
      fetchImpl
    })

    expect(sent[0].url).toBe(API)
    // Linear takes the raw key, not a Bearer prefix — sending `Bearer <key>`
    // is rejected as unauthenticated.
    expect(sent[0].headers.Authorization).toBe('lin_api_secret')
    expect(sent[0].headers['Content-Type']).toBe('application/json')
    expect(sent[0].query).toBe('query Whoami { viewer { id } }')
    expect(sent[0].variables).toEqual({ a: 1 })
  })

  it('sends an empty variables object when the caller passes none', async () => {
    // `variables: undefined` serializes the key away entirely, and Linear
    // rejects a document with declared variables and no values.
    const { fetchImpl, sent } = respondingWith({ ok: true })
    await linearGraphQL({ apiKey: 'k', query: 'query Q { viewer { id } }', fetchImpl })
    expect(sent[0].variables).toEqual({})
  })

  it('abandons a call that hangs rather than blocking the poll forever', async () => {
    const { fetchImpl, sent } = respondingWith({ ok: true })
    await linearGraphQL({ apiKey: 'k', query: 'q', fetchImpl })
    expect(sent[0].signal).toBeInstanceOf(AbortSignal)
  })

  it('returns the data payload on success', async () => {
    const { fetchImpl } = respondingWith({ viewer: { id: 'u1' } })
    const data = await linearGraphQL<{ viewer: { id: string } }>({
      apiKey: 'k',
      query: 'q',
      fetchImpl
    })
    expect(data).toEqual({ viewer: { id: 'u1' } })
  })

  it('throws with the status and body when the transport fails', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 401, text: 'unauthenticated' }))
    await expect(linearGraphQL({ apiKey: 'bad', query: 'q', fetchImpl })).rejects.toThrow(
      /Linear API 401: unauthenticated/
    )
  })

  it('truncates a long error body so a stack trace stays readable', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 500, text: 'x'.repeat(500) }))
    await expect(linearGraphQL({ apiKey: 'k', query: 'q', fetchImpl })).rejects.toThrow(
      /Linear API 500: x{200}$/
    )
  })

  it('still throws when the failing body cannot be read', async () => {
    // `.text()` rejecting must not replace the HTTP error with an unrelated one.
    const fetchImpl = (async () => ({
      ok: false,
      status: 503,
      text: async () => {
        throw new Error('socket closed')
      },
      json: async () => ({})
    })) as unknown as FetchLike
    await expect(linearGraphQL({ apiKey: 'k', query: 'q', fetchImpl })).rejects.toThrow(
      /Linear API 503/
    )
  })

  it('throws on a GraphQL error even though the status was 200', async () => {
    // This is the case a plain `res.ok` check misses: Linear answers 200 with
    // an errors array, and the caller would read a missing field much later.
    const { fetchImpl } = fakeFetch(() => ({
      body: { errors: [{ message: 'Entity not found' }] }
    }))
    await expect(linearGraphQL({ apiKey: 'k', query: 'q', fetchImpl })).rejects.toThrow(
      /Linear GraphQL error: Entity not found/
    )
  })

  it('joins several GraphQL errors into one message', async () => {
    const { fetchImpl } = fakeFetch(() => ({
      body: { errors: [{ message: 'first' }, { message: 'second' }] }
    }))
    await expect(linearGraphQL({ apiKey: 'k', query: 'q', fetchImpl })).rejects.toThrow(
      /first; second/
    )
  })

  it('throws when the response carries neither data nor errors', async () => {
    const { fetchImpl } = fakeFetch(() => ({ body: {} }))
    await expect(linearGraphQL({ apiKey: 'k', query: 'q', fetchImpl })).rejects.toThrow(
      /Linear API returned no data/
    )
  })

  it('uses the global fetch when no implementation is injected', async () => {
    // Guards the `?? fetch` default: the connector relies on it in production,
    // where nothing passes fetchImpl.
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: { ok: 1 } }) } as Response)
    try {
      const data = await linearGraphQL<{ ok: number }>({ apiKey: 'k', query: 'q' })
      expect(data).toEqual({ ok: 1 })
      expect(globalFetch).toHaveBeenCalledWith(API, expect.objectContaining({ method: 'POST' }))
    } finally {
      globalFetch.mockRestore()
    }
  })
})

describe('ISSUE_FIELDS', () => {
  it('selects the state type, which every status mapping is written against', () => {
    // A team renames "In Progress" freely; the type stays `started`. Selecting
    // only the name would leave the mapping with nothing to match on.
    expect(ISSUE_FIELDS).toContain('state { name type }')
    expect(ISSUE_FIELDS).toContain('updatedAt')
    expect(ISSUE_FIELDS).toContain('team { key }')
  })
})

describe('resolveIssueId', () => {
  it('looks the issue up by the identifier people paste, not an internal id', async () => {
    const { fetchImpl, sent } = respondingWith({ issues: { nodes: [{ id: 'uuid-1' }] } })
    const id = await resolveIssueId('k', 'ENG-123', fetchImpl)

    expect(id).toBe('uuid-1')
    expect(sent[0].variables).toEqual({ identifier: 'ENG-123' })
    expect(sent[0].query).toContain('identifier: { eq: $identifier }')
  })

  it('returns null when no issue carries that identifier', async () => {
    // Null rather than a throw: the caller turns it into "Issue X not found",
    // which names the issue the user actually typed.
    const { fetchImpl } = respondingWith({ issues: { nodes: [] } })
    expect(await resolveIssueId('k', 'ENG-404', fetchImpl)).toBeNull()
  })
})

describe('resolveIssueWithTeam', () => {
  it('returns the issue id alongside the team that owns it', async () => {
    const { fetchImpl, sent } = respondingWith({
      issues: { nodes: [{ id: 'uuid-1', team: { id: 'team-1', key: 'ENG' } }] }
    })
    const issue = await resolveIssueWithTeam('k', 'ENG-123', fetchImpl)

    // Closing needs the team: the completed state is defined per team.
    expect(issue).toEqual({ id: 'uuid-1', teamId: 'team-1', teamKey: 'ENG' })
    expect(sent[0].variables).toEqual({ identifier: 'ENG-123' })
  })

  it('returns null when the issue does not exist', async () => {
    const { fetchImpl } = respondingWith({ issues: { nodes: [] } })
    expect(await resolveIssueWithTeam('k', 'ENG-404', fetchImpl)).toBeNull()
  })
})

describe('resolveTeamId', () => {
  it('resolves the team key to the id mutations need', async () => {
    const { fetchImpl, sent } = respondingWith({ teams: { nodes: [{ id: 'team-1' }] } })
    expect(await resolveTeamId('k', 'ENG', fetchImpl)).toBe('team-1')
    expect(sent[0].variables).toEqual({ key: 'ENG' })
  })

  it('returns null for a key no team uses', async () => {
    const { fetchImpl } = respondingWith({ teams: { nodes: [] } })
    expect(await resolveTeamId('k', 'NOPE', fetchImpl)).toBeNull()
  })
})

describe('resolveCompletedStateId', () => {
  it('asks only for the completed states of that team', async () => {
    const { fetchImpl, sent } = respondingWith({
      workflowStates: { nodes: [{ id: 's1', type: 'completed', position: 0 }] }
    })
    await resolveCompletedStateId('k', 'team-1', fetchImpl)

    expect(sent[0].variables).toEqual({ teamId: 'team-1' })
    expect(sent[0].query).toContain('type: { eq: "completed" }')
  })

  it('picks the lowest position when a team defines several completed states', async () => {
    // Merged/Released/Shipped are all completed. The lowest position is the one
    // that reads as done, and it is sorted here rather than trusted from the
    // server.
    const { fetchImpl } = respondingWith({
      workflowStates: {
        nodes: [
          { id: 'shipped', type: 'completed', position: 3 },
          { id: 'done', type: 'completed', position: 1 },
          { id: 'released', type: 'completed', position: 2 }
        ]
      }
    })
    expect(await resolveCompletedStateId('k', 'team-1', fetchImpl)).toBe('done')
  })

  it('does not reorder the caller-visible array in place', async () => {
    const nodes = [
      { id: 'b', type: 'completed', position: 2 },
      { id: 'a', type: 'completed', position: 1 }
    ]
    const { fetchImpl } = respondingWith({ workflowStates: { nodes } })
    await resolveCompletedStateId('k', 'team-1', fetchImpl)
    // `.slice()` before sort: mutating a response another caller holds is the
    // kind of bug that only shows up once something else reads it.
    expect(nodes.map((n) => n.id)).toEqual(['b', 'a'])
  })

  it('returns null when the team has no completed state at all', async () => {
    const { fetchImpl } = respondingWith({ workflowStates: { nodes: [] } })
    expect(await resolveCompletedStateId('k', 'team-1', fetchImpl)).toBeNull()
  })
})
