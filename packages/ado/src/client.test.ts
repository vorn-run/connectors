import { describe, it, expect, vi } from 'vitest'
import {
  createConnection,
  createWorkItem,
  defaultCredential,
  fieldPatch,
  entraToken,
  witApi,
  organizationName,
  organizationUrl,
  workItemUrl,
  queryWorkItemIds,
  readWorkItems,
  updateWorkItem,
  ADO_SCOPE,
  type WitApi,
  type WorkItem
} from './client'

/**
 * A stand-in for the SDK's WorkItemTracking API.
 *
 * The tests inject this rather than mocking the transport, so what is asserted
 * is the arguments this connector passes to Microsoft's client — the part we
 * own — not a reimplementation of how that client serializes them.
 */
function fakeWit(overrides: Partial<WitApi> = {}): WitApi {
  return {
    queryByWiql: vi.fn(async () => ({ workItems: [] })),
    getWorkItems: vi.fn(async () => [] as WorkItem[]),
    createWorkItem: vi.fn(async () => ({ id: 1 }) as WorkItem),
    updateWorkItem: vi.fn(async () => ({ id: 1 }) as WorkItem),
    ...overrides
  }
}

describe('organizationUrl', () => {
  it('accepts a bare organization name', () => {
    expect(organizationUrl('contoso')).toBe('https://dev.azure.com/contoso')
  })

  it('accepts the URL people actually paste from the browser', () => {
    expect(organizationUrl('https://dev.azure.com/contoso')).toBe('https://dev.azure.com/contoso')
  })

  it('tolerates a trailing slash', () => {
    expect(organizationUrl('https://dev.azure.com/contoso/')).toBe('https://dev.azure.com/contoso')
  })

  it('reduces either form to the same organization name', () => {
    expect(organizationName('https://dev.azure.com/contoso/')).toBe(organizationName('contoso'))
  })
})

describe('workItemUrl', () => {
  it('points at the board, not the REST resource', () => {
    expect(workItemUrl('contoso', 'proj', 42)).toBe(
      'https://dev.azure.com/contoso/proj/_workitems/edit/42'
    )
  })

  it('encodes a project name with spaces', () => {
    expect(workItemUrl('contoso', 'My Project', 1)).toContain('My%20Project')
  })
})

describe('queryWorkItemIds', () => {
  it('returns the ids the query matched', async () => {
    const wit = fakeWit({ queryByWiql: vi.fn(async () => ({ workItems: [{ id: 3 }, { id: 7 }] })) })
    const ids = await queryWorkItemIds(wit, {
      project: 'proj',
      query: 'SELECT [System.Id] FROM WorkItems',
      top: 50
    })
    expect(ids).toEqual([3, 7])
  })

  it('scopes the query to the project and caps it at top', async () => {
    const wit = fakeWit()
    await queryWorkItemIds(wit, {
      project: 'proj',
      query: "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'New'",
      top: 50
    })
    // A WIQL query with no project context searches the whole organization,
    // and with no top returns every match, so both are asserted.
    expect(wit.queryByWiql).toHaveBeenCalledWith(
      { query: expect.stringContaining('System.State') },
      { project: 'proj' },
      undefined,
      50
    )
  })

  it('returns nothing when the query matched nothing', async () => {
    // The SDK omits workItems entirely rather than sending an empty array.
    const wit = fakeWit({ queryByWiql: vi.fn(async () => ({})) })
    await expect(queryWorkItemIds(wit, { project: 'p', query: 'q', top: 1 })).resolves.toEqual([])
  })

  it('explains a sign-in page rather than reporting a parse error', async () => {
    // A token for the wrong resource comes back as HTML, which surfaces from
    // the client as "Unexpected token <" and sends someone hunting in entirely
    // the wrong place.
    const wit = fakeWit({
      queryByWiql: vi.fn(async () => {
        throw new Error('Unexpected token < in JSON at position 0')
      })
    })
    await expect(queryWorkItemIds(wit, { project: 'p', query: 'q', top: 1 })).rejects.toThrow(
      /sign-in page/
    )
  })

  it('survives something that was thrown but is not an Error', async () => {
    // A rejected promise can carry anything, and reading .message off a string
    // would turn the real failure into "undefined".
    const wit = fakeWit({
      queryByWiql: vi.fn(async () => {
        throw 'plain string failure'
      })
    })
    await expect(queryWorkItemIds(wit, { project: 'p', query: 'q', top: 1 })).rejects.toThrow(
      /plain string failure/
    )
  })

  it('leaves a real API error alone', async () => {
    const wit = fakeWit({
      queryByWiql: vi.fn(async () => {
        throw new Error('TF51005: The query references a field that does not exist')
      })
    })
    await expect(queryWorkItemIds(wit, { project: 'p', query: 'bad', top: 1 })).rejects.toThrow(
      /TF51005/
    )
  })
})

describe('readWorkItems', () => {
  it('makes no request when the query matched nothing', async () => {
    const wit = fakeWit()
    expect(await readWorkItems(wit, [])).toEqual([])
    expect(wit.getWorkItems).not.toHaveBeenCalled()
  })

  it('batches beyond the API limit rather than sending one huge request', async () => {
    const wit = fakeWit()
    await readWorkItems(
      wit,
      Array.from({ length: 450 }, (_, i) => i + 1)
    )
    // 200 per request, so 450 ids is three calls.
    expect(wit.getWorkItems).toHaveBeenCalledTimes(3)
    expect((wit.getWorkItems as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(200)
  })

  it('collects items across batches', async () => {
    const getWorkItems = vi
      .fn<WitApi['getWorkItems']>()
      .mockResolvedValueOnce([{ id: 1, fields: {} }])
      .mockResolvedValueOnce([{ id: 2, fields: {} }])
    const items = await readWorkItems(
      fakeWit({ getWorkItems }),
      Array.from({ length: 250 }, (_, i) => i + 1)
    )
    expect(items.map((i) => i.id)).toEqual([1, 2])
  })

  it('explains a sign-in page here too', async () => {
    const wit = fakeWit({
      getWorkItems: vi.fn(async () => {
        throw new Error('<!DOCTYPE html><html>')
      })
    })
    await expect(readWorkItems(wit, [1])).rejects.toThrow(/sign-in page/)
  })
})

describe('connecting', () => {
  it('authenticates with a bearer token, never a personal access token', async () => {
    // A PAT is a long-lived pasted secret, and most organizations now issue
    // them for days or refuse outright; this pins the choice.
    const connection = createConnection('https://dev.azure.com/contoso/', 'entra-token') as unknown as {
      serverUrl: string
      authHandler: { token?: string; password?: string }
    }
    expect(connection.serverUrl).toBe('https://dev.azure.com/contoso')
    expect(connection.authHandler.token).toBe('entra-token')
    expect(connection.authHandler.password).toBeUndefined()
  })

  it('resolves the work-item API from the connection', async () => {
    const api = { queryByWiql: vi.fn(), getWorkItems: vi.fn() }
    const connection = { getWorkItemTrackingApi: vi.fn(async () => api) }
    expect(await witApi(connection)).toBe(api)
    expect(connection.getWorkItemTrackingApi).toHaveBeenCalled()
  })
})

describe('entraToken', () => {
  it('returns the token the credential minted', async () => {
    const credential = { getToken: vi.fn(async () => ({ token: 'abc' })) }
    expect(await entraToken(credential)).toBe('abc')
    expect(credential.getToken).toHaveBeenCalledWith(ADO_SCOPE)
  })

  it('says how to sign in when the chain found no account', async () => {
    // DefaultAzureCredential resolves to null rather than throwing when
    // nothing in the chain applies, which on its own reads as a bug in us.
    await expect(entraToken({ getToken: async () => null })).rejects.toThrow(/az login/)
    await expect(entraToken({ getToken: async () => ({ token: '' }) })).rejects.toThrow(/az login/)
  })

  it('reuses one ambient credential rather than rebuilding the chain', async () => {
    // Constructing it touches nothing; only getToken would reach the network.
    const credential = await defaultCredential()
    expect(typeof credential.getToken).toBe('function')
    expect(await defaultCredential()).toBe(credential)
  })
})

describe('auth scope', () => {
  it('is the Azure DevOps resource, not a Graph or ARM scope', () => {
    // Getting this wrong does not fail cleanly: the API answers with an HTML
    // sign-in page, so the value is pinned here deliberately.
    expect(ADO_SCOPE).toBe('499b84ac-1321-427f-aa17-267ca6975798/.default')
  })
})

describe('fieldPatch', () => {
  it('names each field as a path the API will take', () => {
    expect(fieldPatch({ 'System.Title': 'Disk full' })).toEqual([
      { op: 'add', path: '/fields/System.Title', value: 'Disk full' }
    ])
  })

  it('leaves out what was not supplied, so an update touches nothing else', () => {
    // The whole point of a patch: a blank Description must not blank the
    // Description that is already there.
    expect(fieldPatch({ a: 'x', b: undefined, c: '' })).toEqual([
      { op: 'add', path: '/fields/a', value: 'x' }
    ])
  })

  it('escapes a field name that would otherwise read as two path segments', () => {
    // JSON Pointer, not a URL: `/` and `~` have to be escaped or the server
    // reads `/fields/Custom/Rank` as a field named Custom containing Rank.
    expect(fieldPatch({ 'Custom/Rank': 1 })[0].path).toBe('/fields/Custom~1Rank')
    expect(fieldPatch({ 'A~B': 1 })[0].path).toBe('/fields/A~0B')
  })

  it('uses add rather than replace, which fails on a field never set', () => {
    expect(fieldPatch({ a: 1 })[0].op).toBe('add')
  })
})

describe('createWorkItem', () => {
  it('sends the patch to the right project and type', async () => {
    const wit = fakeWit()
    await createWorkItem(wit, {
      project: 'proj',
      type: 'Bug',
      fields: { 'System.Title': 'Disk full' }
    })

    expect(wit.createWorkItem).toHaveBeenCalledWith(
      null,
      [{ op: 'add', path: '/fields/System.Title', value: 'Disk full' }],
      'proj',
      'Bug'
    )
  })

  it('returns what the API made', async () => {
    const created = { id: 42, fields: { 'System.Title': 'Disk full' } }
    const wit = fakeWit({ createWorkItem: vi.fn(async () => created) })
    expect(await createWorkItem(wit, { project: 'p', type: 'Task', fields: {} })).toBe(created)
  })

  it('explains a sign-in page rather than reporting a parse error', async () => {
    const wit = fakeWit({
      createWorkItem: vi.fn(async () => {
        throw new Error('Unexpected token < in JSON at position 0')
      })
    })
    await expect(
      createWorkItem(wit, { project: 'p', type: 'Task', fields: {} })
    ).rejects.toThrow(/sign-in page/)
  })
})

describe('updateWorkItem', () => {
  it('patches only the fields it was given', async () => {
    const wit = fakeWit()
    await updateWorkItem(wit, {
      id: 42,
      fields: { 'System.State': 'Closed', 'System.Title': undefined }
    })

    expect(wit.updateWorkItem).toHaveBeenCalledWith(
      null,
      [{ op: 'add', path: '/fields/System.State', value: 'Closed' }],
      42
    )
  })

  it('refuses an update that would change nothing', async () => {
    // An empty patch is accepted and does nothing, which reads in a run as a
    // step that worked.
    const wit = fakeWit()
    await expect(updateWorkItem(wit, { id: 42, fields: {} })).rejects.toThrow(
      /No fields to update/
    )
    expect(wit.updateWorkItem).not.toHaveBeenCalled()
  })

  it('surfaces a real API error', async () => {
    const wit = fakeWit({
      updateWorkItem: vi.fn(async () => {
        throw new Error('TF401232: Work item 42 does not exist')
      })
    })
    await expect(
      updateWorkItem(wit, { id: 42, fields: { a: 'b' } })
    ).rejects.toThrow(/TF401232/)
  })
})
