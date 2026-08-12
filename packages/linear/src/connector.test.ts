import { describe, it, expect, vi } from 'vitest'
import { createConnectorHarness, connectionSetup } from '@vornrun/connector-sdk'
import { createLinearConnector } from './connector'
import type { FetchLike, LinearIssue } from './client'

const NOW = '2026-08-11T12:00:00.000Z'
const CONFIG = { apiKey: 'lin_api_secret' }

interface Sent {
  query: string
  variables: Record<string, unknown>
  headers: Record<string, string>
}

/**
 * A fake Linear endpoint driven by the mutation or query being sent.
 *
 * The connector makes two calls for several actions (resolve, then mutate), so
 * responses are chosen by matching the document rather than by call order —
 * an order-indexed fake silently passes the wrong body when a resolve is added.
 */
function linearResponding(
  routes: Array<{ when: string; data: unknown }>
): { fetchImpl: FetchLike; sent: Sent[] } {
  const sent: Sent[] = []
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body ?? '{}'))
    sent.push({
      query: parsed.query,
      variables: parsed.variables,
      headers: (init?.headers ?? {}) as Record<string, string>
    })
    const route = routes.find((r) => parsed.query.includes(r.when))
    if (!route) throw new Error(`No fake route matched: ${String(parsed.query).slice(0, 80)}`)
    return { ok: true, status: 200, json: async () => ({ data: route.data }), text: async () => '' } as Response
  }) as unknown as FetchLike
  return { fetchImpl, sent }
}

function issue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'uuid-1',
    identifier: 'ENG-123',
    title: 'Disk full',
    description: 'It is full.',
    url: 'https://linear.app/acme/issue/ENG-123',
    createdAt: '2026-08-10T09:00:00.000Z',
    updatedAt: NOW,
    state: { name: 'In Progress', type: 'started' },
    labels: { nodes: [{ name: 'bug' }, { name: 'urgent' }] },
    assignee: { name: 'Ada' },
    team: { key: 'ENG' },
    ...overrides
  }
}

/** A harness over issues the fake returns from the list query. */
function harness(issues: LinearIssue[], config: Record<string, string | undefined> = CONFIG) {
  const { fetchImpl, sent } = linearResponding([{ when: 'ListIssues', data: { issues: { nodes: issues } } }])
  const connector = createLinearConnector({ fetchImpl })
  return { h: createConnectorHarness(connector, { config, now: () => NOW }), sent }
}

describe('polling issues', () => {
  it('sends the API key and asks for the fields the mapping needs', async () => {
    const { h, sent } = harness([issue()])
    await h.poll('issueCreated')

    expect(sent[0].headers.Authorization).toBe('lin_api_secret')
    expect(sent[0].query).toContain('state { name type }')
  })

  it('refuses to poll without an API key rather than calling Linear anonymously', async () => {
    const { h } = harness([], { apiKey: '' })
    await expect(h.poll('issueCreated')).rejects.toThrow(/LINEAR_API_KEY is required/)
  })

  it('treats a whitespace-only key as missing', async () => {
    const { h } = harness([], { apiKey: '   ' })
    await expect(h.poll('issueCreated')).rejects.toThrow(/LINEAR_API_KEY is required/)
  })

  it('sends no filter at all when nothing is configured', async () => {
    // An empty filter object is not the same as none: Linear treats `{}` as a
    // constraint and it is clearer to omit it.
    const { h, sent } = harness([])
    await h.poll('issueCreated')
    expect(sent[0].variables.filter).toBeUndefined()
    expect(sent[0].variables.first).toBe(50)
  })

  it('scopes to a team when one is configured', async () => {
    const { h, sent } = harness([], { ...CONFIG, teamKey: 'ENG' })
    await h.poll('issueCreated')
    expect(sent[0].variables.filter).toEqual({ team: { key: { eq: 'ENG' } } })
  })

  it('scopes to a state type when one is configured', async () => {
    const { h, sent } = harness([], { ...CONFIG, stateType: 'started' })
    await h.poll('issueCreated')
    expect(sent[0].variables.filter).toEqual({ state: { type: { eq: 'started' } } })
  })

  it('combines team and state into a single filter', async () => {
    const { h, sent } = harness([], { ...CONFIG, teamKey: 'ENG', stateType: 'backlog' })
    await h.poll('issueCreated')
    expect(sent[0].variables.filter).toEqual({
      team: { key: { eq: 'ENG' } },
      state: { type: { eq: 'backlog' } }
    })
  })

  it('ignores blank configuration rather than filtering on an empty string', async () => {
    // The fields are free text in the UI; `teamKey: ''` must mean "every team",
    // not a team whose key is the empty string, which matches nothing.
    const { h, sent } = harness([], { ...CONFIG, teamKey: '  ', stateType: '' })
    expect(await h.poll('issueCreated')).toBeDefined()
    expect(sent[0].variables.filter).toBeUndefined()
  })

  it('caps the page at the configured maximum', async () => {
    const { h, sent } = harness([], { ...CONFIG, limit: '5' })
    await h.poll('issueCreated')
    expect(sent[0].variables.first).toBe(5)
  })

  it('falls back to the default when the limit is not a number', async () => {
    // Free text again: `Number('lots')` is NaN, which Linear would reject long
    // after the mistake was made.
    const { h, sent } = harness([], { ...CONFIG, limit: 'lots' })
    await h.poll('issueCreated')
    expect(sent[0].variables.first).toBe(50)
  })

  it('falls back to the default when the limit is zero', async () => {
    // `Number('0') || DEFAULT` — zero would otherwise ask for no issues at all
    // and the trigger would never fire.
    const { h, sent } = harness([], { ...CONFIG, limit: '0' })
    await h.poll('issueCreated')
    expect(sent[0].variables.first).toBe(50)
  })

  it('asks only for issues changed since the watermark', async () => {
    const { fetchImpl, sent } = linearResponding([
      { when: 'ListIssues', data: { issues: { nodes: [] } } }
    ])
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), {
      config: CONFIG,
      now: () => NOW
    })
    await h.poll('issueCreated', { since: '2026-08-01T00:00:00.000Z' })

    expect(sent[0].variables.filter).toEqual({
      updatedAt: { gte: '2026-08-01T00:00:00.000Z' }
    })
  })

  it('does not re-deliver an issue that has not changed since the watermark', async () => {
    // The classic connector bug: a poll that ignores its lower bound re-fires
    // the whole backlog every interval. The watermark advances to the newest
    // updatedAt, so the same issue must not come back a second time.
    const { fetchImpl } = linearResponding([
      { when: 'ListIssues', data: { issues: { nodes: [issue()] } } }
    ])
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), {
      config: CONFIG,
      now: () => NOW
    })
    expect(await h.pollTwice('issueCreated')).toEqual([])
  })

  it('delivers an issue that changed after the watermark', async () => {
    // The other half of the same guarantee: filtering on the watermark must not
    // be so eager that a genuinely updated issue is dropped.
    let call = 0
    const { fetchImpl } = linearResponding([
      {
        when: 'ListIssues',
        get data() {
          call += 1
          return call === 1
            ? { issues: { nodes: [issue()] } }
            : { issues: { nodes: [issue({ updatedAt: '2026-08-11T13:00:00.000Z' })] } }
        }
      }
    ])
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), {
      config: CONFIG,
      now: () => NOW
    })
    const fresh = await h.pollTwice('issueCreated')
    expect(fresh.map((i) => i.externalId)).toEqual(['ENG-123'])
  })
})

describe('mapping an issue to an item', () => {
  it('keys on the identifier people recognise, not the internal uuid', async () => {
    const { h } = harness([issue()])
    const page = await h.poll('issueCreated')

    expect(page.items[0]).toMatchObject({
      externalId: 'ENG-123',
      title: 'Disk full',
      description: 'It is full.',
      url: 'https://linear.app/acme/issue/ENG-123',
      assignee: 'Ada',
      updatedAt: NOW
    })
  })

  it('carries the state type as status, so a renamed state still maps', async () => {
    const { h } = harness([issue({ state: { name: 'Cooking', type: 'started' } })])
    const page = await h.poll('issueCreated')
    expect(page.items[0].status).toBe('started')
  })

  it('keeps the human state name where a workflow can template it', async () => {
    // The SDK flattens `data` to the top level, which is what makes these
    // reachable as {{trigger.item.stateName}} rather than a nested lookup.
    const { h } = harness([issue({ state: { name: 'Cooking', type: 'started' } })])
    const page = await h.poll('issueCreated')
    expect(page.items[0]).toMatchObject({
      stateName: 'Cooking',
      teamKey: 'ENG',
      createdAt: '2026-08-10T09:00:00.000Z'
    })
  })

  it('flattens labels to their names', async () => {
    const { h } = harness([issue()])
    const page = await h.poll('issueCreated')
    expect(page.items[0].labels).toEqual(['bug', 'urgent'])
  })

  it('substitutes an empty description rather than passing null through', async () => {
    const { h } = harness([issue({ description: null })])
    const page = await h.poll('issueCreated')
    expect(page.items[0].description).toBe('')
  })

  it('omits the assignee entirely when the issue has none', async () => {
    // Present-but-undefined and absent read differently downstream, so an
    // unassigned issue must not claim an assignee key at all.
    const { h } = harness([issue({ assignee: null })])
    const page = await h.poll('issueCreated')
    expect(page.items[0].assignee).toBeUndefined()
  })

  it('maps every issue the query returned', async () => {
    const { h } = harness([issue(), issue({ id: 'uuid-2', identifier: 'ENG-124' })])
    const page = await h.poll('issueCreated')
    expect(page.items.map((i) => i.externalId)).toEqual(['ENG-123', 'ENG-124'])
  })
})

describe('connection setup', () => {
  it('exposes the environment variables Vorn must prompt for', () => {
    const setup = connectionSetup(createLinearConnector(), 'issueCreated')
    const names = setup.env.map((entry) => entry.name)

    expect(names).toContain('LINEAR_API_KEY')
    expect(names).toContain('LINEAR_TEAM_KEY')
    expect(setup.filters.pollTool).toBe('poll_issueCreated')
  })

  it('marks the API key secret so it is never printed', () => {
    const setup = connectionSetup(createLinearConnector(), 'issueCreated')
    const apiKey = setup.env.find((entry) => entry.name === 'LINEAR_API_KEY')
    expect(apiKey).toMatchObject({ required: true, secret: true })
  })

  it('dedupes on the timestamp field the issues actually carry', () => {
    const setup = connectionSetup(createLinearConnector(), 'issueCreated')
    expect(setup.filters.timestampField).toBe('updatedAt')
    expect(setup.filters.idField).toBe('externalId')
  })

  it('suggests a local status for every Linear state type', () => {
    // Without these every issue imports as `todo`, including ones closed a year
    // ago. Linear defines exactly these five types.
    const trigger = createLinearConnector().triggers[0]
    expect(trigger.statusMapping).toEqual([
      { upstream: 'backlog', suggestedLocal: 'todo' },
      { upstream: 'unstarted', suggestedLocal: 'todo' },
      { upstream: 'started', suggestedLocal: 'in_progress' },
      { upstream: 'completed', suggestedLocal: 'done' },
      { upstream: 'canceled', suggestedLocal: 'cancelled' }
    ])
  })

  it('seeds a polling workflow so connecting lands on a working default', () => {
    const trigger = createLinearConnector().triggers[0]
    expect(trigger.defaultWorkflow).toEqual({
      name: 'Linear: issues',
      defaultCronFromMinutes: 5
    })
  })

  it('carries the status mapping and seeded workflow through to the manifest', () => {
    // The app reads these off the manifest, not off the definition — a field
    // the SDK fails to serialize is invisible until someone connects it.
    const manifest = createConnectorHarness(createLinearConnector(), { config: CONFIG }).manifest()
    const trigger = manifest.triggers.find((t) => t.type === 'issueCreated')

    expect(trigger?.statusMapping).toHaveLength(5)
    expect(trigger?.defaultWorkflow?.defaultCronFromMinutes).toBe(5)
  })

  it('ships a glyph so the connection is not just another MCP row', () => {
    const icon = createLinearConnector().icon
    expect(icon?.paths.length).toBeGreaterThan(0)
    expect(icon?.viewBox).toBe('0 0 24 24')
  })

  it('reports the version it was built with', () => {
    expect(createLinearConnector({ version: '9.9.9' }).version).toBe('9.9.9')
  })

  it('falls back to a placeholder version when none is given', () => {
    // index.ts reads the real one from package.json; the default only shows up
    // when a caller constructs the connector directly, as these tests do.
    expect(createLinearConnector().version).toBe('0.0.0')
  })
})

describe('commentOnIssue', () => {
  function commenting(overrides: { issueNodes?: unknown; success?: boolean } = {}) {
    const { fetchImpl, sent } = linearResponding([
      {
        when: 'IssueIdByIdentifier',
        data: { issues: { nodes: overrides.issueNodes ?? [{ id: 'uuid-1' }] } }
      },
      {
        when: 'CreateComment',
        data: {
          commentCreate: {
            success: overrides.success ?? true,
            comment: { id: 'c1', url: 'https://linear.app/acme/issue/ENG-123#comment-c1' }
          }
        }
      }
    ])
    return {
      h: createConnectorHarness(createLinearConnector({ fetchImpl }), { config: CONFIG }),
      sent
    }
  }

  it('resolves the identifier then comments on the issue it found', async () => {
    const { h, sent } = commenting()
    const result = await h.execute('commentOnIssue', { identifier: 'ENG-123', body: 'Looking.' })

    expect(sent[1].variables).toEqual({ input: { issueId: 'uuid-1', body: 'Looking.' } })
    expect(result.url).toBe('https://linear.app/acme/issue/ENG-123#comment-c1')
  })

  it('names the issue the user typed when it does not exist', async () => {
    const { h } = commenting({ issueNodes: [] })
    await expect(
      h.execute('commentOnIssue', { identifier: 'ENG-404', body: 'Hello' })
    ).rejects.toThrow(/Issue ENG-404 not found/)
  })

  it('throws when Linear answers success=false', async () => {
    // Linear reports refusal in the body with a 200, so a step that only
    // caught throws would report a comment nobody posted.
    const { h } = commenting({ success: false })
    await expect(
      h.execute('commentOnIssue', { identifier: 'ENG-123', body: 'Hello' })
    ).rejects.toThrow(/refused to create the comment/)
  })

  it('requires an identifier', async () => {
    const { h } = commenting()
    await expect(h.execute('commentOnIssue', { body: 'Hello' })).rejects.toThrow(
      /requires "identifier"/
    )
  })

  it('rejects a whitespace-only identifier, which the SDK check lets through', async () => {
    // `required` only sees a non-empty string, so the connector's own guard is
    // what stops a blank identifier reaching Linear as a lookup for "".
    const { h } = commenting()
    await expect(
      h.execute('commentOnIssue', { identifier: '   ', body: 'Hello' })
    ).rejects.toThrow(/identifier is required/)
  })

  it('requires a body, and treats whitespace as empty', async () => {
    // Posting a blank comment is worse than failing: it is visible to everyone
    // watching the issue.
    const { h } = commenting()
    await expect(
      h.execute('commentOnIssue', { identifier: 'ENG-123', body: '   ' })
    ).rejects.toThrow(/body is required/)
  })

  it('refuses to run without an API key', async () => {
    const { fetchImpl } = linearResponding([])
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), { config: { apiKey: '' } })
    await expect(
      h.execute('commentOnIssue', { identifier: 'ENG-123', body: 'Hello' })
    ).rejects.toThrow(/LINEAR_API_KEY is required/)
  })
})

describe('createIssue', () => {
  function creating(overrides: { teamNodes?: unknown; success?: boolean } = {}) {
    const { fetchImpl, sent } = linearResponding([
      {
        when: 'TeamIdByKey',
        data: { teams: { nodes: overrides.teamNodes ?? [{ id: 'team-1' }] } }
      },
      {
        when: 'CreateIssue',
        data: {
          issueCreate: {
            success: overrides.success ?? true,
            issue: { id: 'uuid-9', identifier: 'ENG-900', url: 'https://linear.app/acme/issue/ENG-900' }
          }
        }
      }
    ])
    return { fetchImpl, sent }
  }

  it('creates on the team passed to the action', async () => {
    const { fetchImpl, sent } = creating()
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), { config: CONFIG })
    const result = await h.execute('createIssue', { title: 'Disk full', teamKey: 'OPS' })

    expect(sent[0].variables).toEqual({ key: 'OPS' })
    expect(sent[1].variables).toEqual({ input: { teamId: 'team-1', title: 'Disk full' } })
    expect(result).toEqual({
      identifier: 'ENG-900',
      url: 'https://linear.app/acme/issue/ENG-900'
    })
  })

  it("falls back to the connection's team when the action names none", async () => {
    const { fetchImpl, sent } = creating()
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), {
      config: { ...CONFIG, teamKey: 'ENG' }
    })
    await h.execute('createIssue', { title: 'Disk full' })
    expect(sent[0].variables).toEqual({ key: 'ENG' })
  })

  it('prefers the team on the action over the one on the connection', async () => {
    const { fetchImpl, sent } = creating()
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), {
      config: { ...CONFIG, teamKey: 'ENG' }
    })
    await h.execute('createIssue', { title: 'Disk full', teamKey: 'OPS' })
    expect(sent[0].variables).toEqual({ key: 'OPS' })
  })

  it('includes the description only when one was given', async () => {
    const { fetchImpl, sent } = creating()
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), { config: CONFIG })
    await h.execute('createIssue', { title: 'T', teamKey: 'ENG', description: 'Body' })
    expect(sent[1].variables).toEqual({
      input: { teamId: 'team-1', title: 'T', description: 'Body' }
    })
  })

  it('omits a blank description rather than clearing the field', async () => {
    const { fetchImpl, sent } = creating()
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), { config: CONFIG })
    await h.execute('createIssue', { title: 'T', teamKey: 'ENG', description: '   ' })
    expect((sent[1].variables.input as Record<string, unknown>).description).toBeUndefined()
  })

  it('requires a title', async () => {
    const { fetchImpl } = creating()
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), { config: CONFIG })
    await expect(h.execute('createIssue', { teamKey: 'ENG' })).rejects.toThrow(/requires "title"/)
  })

  it('rejects a whitespace-only title, which the SDK check lets through', async () => {
    const { fetchImpl } = creating()
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), { config: CONFIG })
    await expect(h.execute('createIssue', { title: '   ', teamKey: 'ENG' })).rejects.toThrow(
      /title is required/
    )
  })

  it('explains where a team key can come from when there is none', async () => {
    const { fetchImpl } = creating()
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), { config: CONFIG })
    await expect(h.execute('createIssue', { title: 'T' })).rejects.toThrow(
      /teamKey is required: set one on the connection or pass it here/
    )
  })

  it('names the team key when no team matches it', async () => {
    const { fetchImpl } = creating({ teamNodes: [] })
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), { config: CONFIG })
    await expect(h.execute('createIssue', { title: 'T', teamKey: 'NOPE' })).rejects.toThrow(
      /Team NOPE not found/
    )
  })

  it('throws when Linear answers success=false', async () => {
    const { fetchImpl } = creating({ success: false })
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), { config: CONFIG })
    await expect(h.execute('createIssue', { title: 'T', teamKey: 'ENG' })).rejects.toThrow(
      /refused to create the issue/
    )
  })

  it('refuses to run without an API key', async () => {
    const { fetchImpl } = creating()
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), { config: { apiKey: '' } })
    await expect(h.execute('createIssue', { title: 'T', teamKey: 'ENG' })).rejects.toThrow(
      /LINEAR_API_KEY is required/
    )
  })
})

describe('closeIssue', () => {
  function closing(
    overrides: { issueNodes?: unknown; states?: unknown; success?: boolean } = {}
  ) {
    const { fetchImpl, sent } = linearResponding([
      {
        when: 'IssueWithTeam',
        data: {
          issues: {
            nodes: overrides.issueNodes ?? [{ id: 'uuid-1', team: { id: 'team-1', key: 'ENG' } }]
          }
        }
      },
      {
        when: 'CompletedStates',
        data: {
          workflowStates: {
            nodes: overrides.states ?? [{ id: 'state-done', type: 'completed', position: 0 }]
          }
        }
      },
      {
        when: 'CloseIssue',
        data: {
          issueUpdate: {
            success: overrides.success ?? true,
            issue: { id: 'uuid-1', state: { name: 'Done' } }
          }
        }
      }
    ])
    return { fetchImpl, sent }
  }

  it('moves the issue to its team’s completed state and reports where it landed', async () => {
    const { fetchImpl, sent } = closing()
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), { config: CONFIG })
    const result = await h.execute('closeIssue', { identifier: 'ENG-123' })

    expect(sent[1].variables).toEqual({ teamId: 'team-1' })
    expect(sent[2].variables).toEqual({ id: 'uuid-1', input: { stateId: 'state-done' } })
    expect(result).toEqual({ state: 'Done' })
  })

  it('names the issue when it does not exist', async () => {
    const { fetchImpl } = closing({ issueNodes: [] })
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), { config: CONFIG })
    await expect(h.execute('closeIssue', { identifier: 'ENG-404' })).rejects.toThrow(
      /Issue ENG-404 not found/
    )
  })

  it('names the team when it defines no completed state to move to', async () => {
    const { fetchImpl } = closing({ states: [] })
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), { config: CONFIG })
    await expect(h.execute('closeIssue', { identifier: 'ENG-123' })).rejects.toThrow(
      /Team ENG has no completed state to move it to/
    )
  })

  it('throws when Linear answers success=false', async () => {
    const { fetchImpl } = closing({ success: false })
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), { config: CONFIG })
    await expect(h.execute('closeIssue', { identifier: 'ENG-123' })).rejects.toThrow(
      /refused to close the issue/
    )
  })

  it('requires an identifier', async () => {
    const { fetchImpl } = closing()
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), { config: CONFIG })
    await expect(h.execute('closeIssue', {})).rejects.toThrow(/requires "identifier"/)
  })

  it('rejects a whitespace-only identifier, which the SDK check lets through', async () => {
    const { fetchImpl } = closing()
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), { config: CONFIG })
    await expect(h.execute('closeIssue', { identifier: '  ' })).rejects.toThrow(
      /identifier is required/
    )
  })

  it('refuses to run without an API key', async () => {
    const { fetchImpl } = closing()
    const h = createConnectorHarness(createLinearConnector({ fetchImpl }), { config: { apiKey: '' } })
    await expect(h.execute('closeIssue', { identifier: 'ENG-123' })).rejects.toThrow(
      /LINEAR_API_KEY is required/
    )
  })

  it('is declared idempotent, unlike commenting', async () => {
    // Closing a closed issue lands in the same place; two comments are two
    // comments. Vorn retries on the strength of this flag.
    const connector = createLinearConnector()
    const close = connector.actions.find((a) => a.type === 'closeIssue')
    const comment = connector.actions.find((a) => a.type === 'commentOnIssue')
    expect(close?.idempotent).toBe(true)
    expect(comment?.idempotent).toBe(false)
  })
})
