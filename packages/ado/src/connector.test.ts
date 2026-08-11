import { describe, it, expect, vi } from 'vitest'
import { createConnectorHarness, connectionSetup } from '@vornrun/connector-sdk'
import { createAdoConnector } from './connector'
import type { WitApi, WorkItem } from './client'

const NOW = '2026-08-05T12:00:00.000Z'

const CONFIG = {
  organization: 'contoso',
  project: 'proj',
  query: "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'New'"
}

const getToken = async () => 'token'

interface Call {
  wiql: { query: string }
  team: { project?: string } | undefined
  top: number | undefined
  ids: number[][]
  wrote?: Record<string, unknown>
}

/** A stand-in for the SDK's WorkItemTracking API, returning fixed work items. */
function respondWith(items: WorkItem[]) {
  const call: Call = { wiql: { query: '' }, team: undefined, top: undefined, ids: [] }
  const wit: WitApi = {
    queryByWiql: vi.fn(async (wiql, team, _precision, top) => {
      call.wiql = wiql
      call.team = team
      call.top = top
      return { workItems: items.map((item) => ({ id: item.id })) }
    }),
    getWorkItems: vi.fn(async (ids: number[]) => {
      call.ids.push(ids)
      return items.filter((item) => ids.includes(item.id ?? -1))
    }),
    createWorkItem: vi.fn(async (_headers, document, project, type) => {
      call.wrote = { document, project, type }
      return { id: 101, fields: { 'System.Title': 'Created', 'System.State': 'New' } }
    }),
    updateWorkItem: vi.fn(async (_headers, document, id) => {
      call.wrote = { document, id }
      return { id, fields: { 'System.Title': 'Updated', 'System.State': 'Closed' } }
    })
  }
  return { wit, call }
}

function harness(wit: WitApi, config: Record<string, string | undefined> = CONFIG) {
  const connector = createAdoConnector({ getToken, connectImpl: async () => wit })
  return createConnectorHarness(connector, { config, now: () => NOW })
}

function workItem(id: number, fields: Record<string, unknown> = {}): WorkItem {
  return {
    id,
    fields: {
      'System.Title': `Item ${id}`,
      'System.State': 'New',
      'System.WorkItemType': 'Bug',
      'System.ChangedDate': NOW,
      ...fields
    }
  }
}

describe('ado connector', () => {
  describe('querying', () => {
    it('scopes the query to the project and passes the query through untouched', async () => {
      const { wit, call } = respondWith([])
      await harness(wit).poll('workItem')

      // An unscoped WIQL query searches the whole organization.
      expect(call.team).toEqual({ project: 'proj' })
      expect(call.wiql.query).toBe(CONFIG.query)
    })

    it('caps the poll at the configured maximum', async () => {
      const { wit, call } = respondWith([])
      await harness(wit, { ...CONFIG, top: '5' }).poll('workItem')
      expect(call.top).toBe(5)
    })

    it('falls back to the default when top is not a number', async () => {
      // The field is free text in the UI, and `Number('lots')` is NaN, which
      // the API would reject long after the mistake was made.
      const { wit, call } = respondWith([])
      await harness(wit, { ...CONFIG, top: 'lots' }).poll('workItem')
      expect(call.top).toBe(100)
    })

    it('reads nothing when the query matched nothing', async () => {
      const { wit, call } = respondWith([])
      const page = await harness(wit).poll('workItem')
      expect(page.items).toEqual([])
      expect(call.ids).toEqual([])
    })

    it('connects once and reuses it while the token holds', async () => {
      // Connecting asks the location service where the API lives, so a
      // connection per poll is a network round trip nobody asked for.
      const { wit } = respondWith([])
      const connectImpl = vi.fn(async () => wit)
      const h = createConnectorHarness(createAdoConnector({ getToken, connectImpl }), {
        config: CONFIG,
        now: () => NOW
      })
      await h.poll('workItem')
      await h.poll('workItem')
      expect(connectImpl).toHaveBeenCalledTimes(1)
    })

    it('reconnects when the credential hands back a new token', async () => {
      // getBearerHandler captures the token it was given, so a connection kept
      // past that token's hour would fail every poll from then on.
      const { wit } = respondWith([])
      const connectImpl = vi.fn(async () => wit)
      let issued = 0
      const h = createConnectorHarness(
        createAdoConnector({ getToken: async () => `token-${++issued}`, connectImpl }),
        { config: CONFIG, now: () => NOW }
      )
      await h.poll('workItem')
      await h.poll('workItem')
      expect(connectImpl).toHaveBeenCalledTimes(2)
      expect(connectImpl).toHaveBeenLastCalledWith('contoso', 'token-2')
    })

    it('reconnects when a second organization is polled', async () => {
      const { wit } = respondWith([])
      const connectImpl = vi.fn(async () => wit)
      const connector = createAdoConnector({ getToken, connectImpl })
      await createConnectorHarness(connector, { config: CONFIG, now: () => NOW }).poll('workItem')
      await createConnectorHarness(connector, {
        config: { ...CONFIG, organization: 'fabrikam' },
        now: () => NOW
      }).poll('workItem')
      expect(connectImpl).toHaveBeenLastCalledWith('fabrikam', 'token')
    })
  })

  describe('item mapping', () => {
    it('links to the board rather than the REST resource', async () => {
      const { wit } = respondWith([workItem(42)])
      const page = await harness(wit).poll('workItem')

      expect(page.items[0]).toMatchObject({
        externalId: '42',
        title: 'Item 42',
        status: 'New',
        updatedAt: NOW,
        url: 'https://dev.azure.com/contoso/proj/_workitems/edit/42'
      })
    })

    it('carries the work item type as a label', async () => {
      const { wit } = respondWith([workItem(1, { 'System.WorkItemType': 'User Story' })])
      const page = await harness(wit).poll('workItem')
      expect(page.items[0].labels).toEqual(['User Story'])
    })

    it('drops the label rather than emitting an empty one', async () => {
      const { wit } = respondWith([workItem(1, { 'System.WorkItemType': '' })])
      const page = await harness(wit).poll('workItem')
      expect(page.items[0].labels).toEqual([])
    })

    it('names an item whose query did not project a title', async () => {
      // WIQL lets the author pick columns, so a title is never guaranteed.
      const { wit } = respondWith([{ id: 7, fields: { 'System.ChangedDate': NOW } }])
      const page = await harness(wit).poll('workItem')
      expect(page.items[0].title).toBe('Work item 7')
    })

    it('refuses a work item with no id rather than dedupe them together', async () => {
      // Vorn dedupes on externalId, so a placeholder would collapse every such
      // item into a single event.
      const { wit } = respondWith([{ fields: {} }])
      wit.queryByWiql = async () => ({ workItems: [{ id: 1 }] })
      wit.getWorkItems = async () => [{ fields: {} }]
      await expect(harness(wit).poll('workItem')).rejects.toThrow(/no id/)
    })

    it('survives an item with no fields at all', async () => {
      const { wit } = respondWith([{ id: 9 }])
      const page = await harness(wit).poll('workItem')
      expect(page.items[0]).toMatchObject({ externalId: '9', title: 'Work item 9' })
      // The epoch sorts below every real timestamp, so a missing changed date
      // cannot drag the watermark forward past items that do have one.
      expect(page.items[0].updatedAt).toBe('1970-01-01T00:00:00.000Z')
    })
  })

  describe('dedupe', () => {
    it('does not redeliver work items Vorn has already seen', async () => {
      // A WIQL query has no notion of the caller's watermark, so it keeps
      // returning everything it matches; the cursor has to absorb that.
      const { wit } = respondWith([
        workItem(1, { 'System.ChangedDate': '2026-08-05T11:00:00.000Z' }),
        workItem(2, { 'System.ChangedDate': '2026-08-05T11:30:00.000Z' })
      ])
      expect(await harness(wit).pollTwice('workItem')).toEqual([])
    })
  })

  describe('missing configuration', () => {
    it('names the environment variable that is missing', async () => {
      const { wit } = respondWith([])
      await expect(
        harness(wit, { project: 'proj', query: 'q' }).poll('workItem')
      ).rejects.toThrow('ADO_ORGANIZATION is required')
      await expect(
        harness(wit, { organization: 'contoso', query: 'q' }).poll('workItem')
      ).rejects.toThrow('ADO_PROJECT is required')
      await expect(
        harness(wit, { organization: 'contoso', project: 'proj' }).poll('workItem')
      ).rejects.toThrow('ADO_QUERY is required')
    })

    it('treats whitespace as missing rather than sending it', async () => {
      const { wit } = respondWith([])
      await expect(harness(wit, { ...CONFIG, project: '   ' }).poll('workItem')).rejects.toThrow(
        'ADO_PROJECT is required'
      )
    })
  })

  describe('credentials', () => {
    it('asks for a token once per poll and hands it to the connection', async () => {
      const { wit } = respondWith([])
      const connectImpl = vi.fn(async () => wit)
      const h = createConnectorHarness(
        createAdoConnector({ getToken: async () => 'entra-token', connectImpl }),
        { config: CONFIG, now: () => NOW }
      )
      await h.poll('workItem')
      expect(connectImpl).toHaveBeenCalledWith('contoso', 'entra-token')
    })
  })

  describe('setup', () => {
    it('exposes the environment variables Vorn must prompt for', () => {
      const setup = connectionSetup(createAdoConnector({ getToken }), 'workItem')
      const names = setup.env.map((entry) => entry.name)
      expect(names).toContain('ADO_ORGANIZATION')
      expect(names).toContain('ADO_QUERY')
      expect(setup.filters.pollTool).toBe('poll_workItem')
    })

    it('ships a glyph so the connection is not just another MCP row', () => {
      const icon = createAdoConnector({ getToken }).icon
      expect(icon?.paths.length).toBeGreaterThan(0)
      expect(icon?.viewBox).toBe('0 0 24 24')
    })
  })
})

describe('createWorkItem action', () => {
  it('creates on the configured project and returns a link to the board', async () => {
    const { wit, call } = respondWith([])
    const result = await harness(wit).execute('createWorkItem', {
      title: 'Disk full',
      type: 'Bug',
      description: 'It is full.',
      assignedTo: 'someone@example.com'
    })

    expect(call.wrote).toMatchObject({ project: 'proj', type: 'Bug' })
    expect(call.wrote?.document).toEqual([
      { op: 'add', path: '/fields/System.Title', value: 'Disk full' },
      { op: 'add', path: '/fields/System.Description', value: 'It is full.' },
      { op: 'add', path: '/fields/System.AssignedTo', value: 'someone@example.com' }
    ])
    // The board url, not the REST resource: a step templating {{...url}} into a
    // message wants something a person can follow.
    expect(result).toMatchObject({
      id: 101,
      url: 'https://dev.azure.com/contoso/proj/_workitems/edit/101',
      state: 'New'
    })
  })

  it('defaults the type, so the simplest call is title only', async () => {
    const { wit, call } = respondWith([])
    await harness(wit).execute('createWorkItem', { title: 'Just this' })

    expect(call.wrote).toMatchObject({ type: 'Task' })
    // Fields nobody supplied are left out rather than sent empty.
    expect(call.wrote?.document).toEqual([
      { op: 'add', path: '/fields/System.Title', value: 'Just this' }
    ])
  })

  it('describes a bare response rather than rendering "undefined" into a message', async () => {
    // A create can come back with only an id when the type has no default
    // title rule, and String(undefined) in a Slack message reads as a bug.
    const { wit } = respondWith([])
    wit.createWorkItem = vi.fn(async () => ({}))
    const result = await harness(wit).execute('createWorkItem', { title: 'x' })

    expect(result).toMatchObject({ id: 0, title: '', state: '' })
  })

  it('creates on another project when the step names one', async () => {
    const { wit, call } = respondWith([])
    await harness(wit).execute('createWorkItem', { title: 'x', project: 'Other' })
    expect(call.wrote).toMatchObject({ project: 'Other' })
  })

  it('refuses a title that is only whitespace', async () => {
    const { wit } = respondWith([])
    await expect(harness(wit).execute('createWorkItem', { title: '   ' })).rejects.toThrow(
      /title is required/
    )
  })

  it('says which setting is missing rather than failing at the API', async () => {
    const { wit } = respondWith([])
    await expect(
      harness(wit, { organization: 'contoso', query: 'q' }).execute('createWorkItem', {
        title: 'x'
      })
    ).rejects.toThrow('ADO_PROJECT is required')
  })
})

describe('updateWorkItem action', () => {
  it('changes only the fields the step supplied', async () => {
    const { wit, call } = respondWith([])
    const result = await harness(wit).execute('updateWorkItem', { id: 42, state: 'Closed' })

    expect(call.wrote).toMatchObject({ id: 42 })
    expect(call.wrote?.document).toEqual([
      { op: 'add', path: '/fields/System.State', value: 'Closed' }
    ])
    expect(result).toMatchObject({ id: 42, state: 'Closed' })
  })

  it('takes an id that arrived as text, the way a template renders it', async () => {
    // {{trigger.item.externalId}} is a string; requiring a number would make
    // the obvious wiring fail.
    const { wit, call } = respondWith([])
    await harness(wit).execute('updateWorkItem', { id: '42', title: 'Renamed' })
    expect(call.wrote).toMatchObject({ id: 42 })
  })

  it('lets the SDK reject an id that is not a number at all', async () => {
    // Declaring the input as a number means this never reaches the action, and
    // the message names the argument.
    const { wit } = respondWith([])
    await expect(
      harness(wit).execute('updateWorkItem', { id: 'the disk one', title: 'x' })
    ).rejects.toThrow(/argument "id".*Expected a number/)
  })

  it('refuses a number that is not a work item id', async () => {
    // 0 and -1 are numbers, so nothing upstream stops them; PATCH on
    // /workitems/0 fails with something about a malformed url.
    const { wit } = respondWith([])
    await expect(harness(wit).execute('updateWorkItem', { id: 0, title: 'x' })).rejects.toThrow(
      /must be a work item number/
    )
    await expect(harness(wit).execute('updateWorkItem', { id: 1.5, title: 'x' })).rejects.toThrow(
      /must be a work item number/
    )
  })

  it('refuses an update that would change nothing', async () => {
    const { wit } = respondWith([])
    await expect(harness(wit).execute('updateWorkItem', { id: 42 })).rejects.toThrow(
      /No fields to update/
    )
  })
})

describe('what the manifest promises', () => {
  it('marks creating as not repeatable and updating as repeatable', () => {
    // An agent retrying a failed step has no other way to know that calling
    // create twice makes two work items.
    const actions = createAdoConnector({ getToken }).actions ?? []
    expect(actions.find((a) => a.type === 'createWorkItem')?.idempotent).toBe(false)
    expect(actions.find((a) => a.type === 'updateWorkItem')?.idempotent).toBe(true)
  })

  it('ships the Azure DevOps mark rather than something board-shaped', () => {
    const icon = createAdoConnector({ getToken }).icon
    expect(icon?.viewBox).toBe('0 0 24 24')
    expect(icon?.paths).toHaveLength(1)
    expect(icon?.paths[0]).toMatch(/^M0 8\.877L2\.247 5\.91/)
  })
})
