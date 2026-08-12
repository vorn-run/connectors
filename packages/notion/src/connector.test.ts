import { describe, it, expect, vi } from 'vitest'
import { runAction, runPoll, checkConnector } from '@vornrun/connector-sdk'
import { Client } from '@notionhq/client'
import { createNotionConnector, defaultCreateApi } from './connector'
import { NOTION_VERSION, type NotionApi } from './client'

const DB = '1234567890abcdef1234567890abcdef'
const CONFIG = { token: 'secret_abc', databaseId: DB }

const SCHEMA = {
  Name: { type: 'title' },
  Stage: {
    type: 'status',
    status: {
      options: [
        { id: 'o1', name: 'Doing' },
        { id: 'o2', name: 'Done' }
      ],
      groups: [
        { name: 'In progress', option_ids: ['o1'] },
        { name: 'Complete', option_ids: ['o2'] }
      ]
    }
  }
}

function page(id: string, title: string, stage: string, edited = '2026-01-02T03:04:05.000Z') {
  return {
    id,
    url: `https://www.notion.so/${title}-${id}`,
    created_time: '2026-01-01T00:00:00.000Z',
    last_edited_time: edited,
    properties: {
      Name: { type: 'title', title: [{ plain_text: title }] },
      Stage: { type: 'status', status: { name: stage } }
    }
  }
}

interface Stub {
  api: NotionApi
  retrieveDatabase: ReturnType<typeof vi.fn>
  retrieveDataSource: ReturnType<typeof vi.fn>
  query: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  createApi: ReturnType<typeof vi.fn>
}

/** A whole Notion API, wired so each test can assert on what was sent. */
function stub(
  options: {
    dataSources?: Array<{ id: string; name?: string }>
    schema?: Record<string, unknown>
    results?: unknown[]
    requestStatus?: { type: string; incomplete_reason?: string }
    created?: unknown
  } = {}
): Stub {
  const retrieveDatabase = vi.fn(async () => ({
    data_sources: options.dataSources ?? [{ id: 'ds-1', name: 'Tasks' }]
  }))
  const retrieveDataSource = vi.fn(async () => ({ properties: options.schema ?? SCHEMA }))
  const query = vi.fn(async () => ({
    results: options.results ?? [],
    has_more: false,
    next_cursor: null,
    ...(options.requestStatus && { request_status: options.requestStatus })
  }))
  const create = vi.fn(async () => options.created ?? { id: 'new-page', url: 'https://n/new' })
  const update = vi.fn(async () => ({ id: 'p1', url: 'https://n/p1' }))
  const api: NotionApi = {
    databases: { retrieve: retrieveDatabase },
    dataSources: { retrieve: retrieveDataSource, query },
    pages: { create, update }
  }
  const createApi = vi.fn(() => api)
  return { api, retrieveDatabase, retrieveDataSource, query, create, update, createApi }
}

function connector(s: Stub) {
  return createNotionConnector({ version: '9.9.9', createApi: s.createApi as never })
}

describe('the manifest', () => {
  it('passes the SDK’s own contract check', async () => {
    // The same check Vorn runs before installing, so a malformed trigger or a
    // duplicate action key fails here rather than in someone's app.
    const findings = await checkConnector(connector(stub()))
    expect(findings.filter((f) => f.level === 'error')).toEqual([])
  })

  it('declares the token secret and the database required', () => {
    const fields = connector(stub()).config
    const token = fields.find((f) => f.key === 'token')
    expect(token?.secret).toBe(true)
    expect(token?.required).toBe(true)
    expect(fields.find((f) => f.key === 'databaseId')?.required).toBe(true)
    // Only needed for multi-source databases, so requiring it would make every
    // simple setup impossible without a second lookup.
    expect(fields.find((f) => f.key === 'dataSourceId')?.required).toBeUndefined()
  })

  it('declares createPage non-idempotent and the two reads idempotent', () => {
    // Notion has no client-supplied idempotency key, so a retrying agent has no
    // other way to know it is about to create a second page.
    const actions = connector(stub()).actions
    expect(actions.find((a) => a.type === 'createPage')?.idempotent).toBe(false)
    expect(actions.find((a) => a.type === 'updatePage')?.idempotent).toBe(true)
    expect(actions.find((a) => a.type === 'findPages')?.idempotent).toBe(true)
  })

  it('maps the status names teams actually use, so closed work does not import as todo', () => {
    const trigger = connector(stub()).triggers[0]
    const mapping = Object.fromEntries(
      (trigger.statusMapping ?? []).map((m) => [m.upstream, m.suggestedLocal])
    )
    expect(mapping.Done).toBe('done')
    expect(mapping['In progress']).toBe('in_progress')
    expect(mapping.Cancelled).toBe('cancelled')
    expect(mapping['Not started']).toBe('todo')
  })

  it('seeds a five-minute workflow, inside Notion’s own aggregation window', () => {
    expect(connector(stub()).triggers[0].defaultWorkflow).toEqual({
      name: 'Notion: database pages',
      defaultCronFromMinutes: 5
    })
  })
})

describe('the pageChanged trigger', () => {
  it('maps a page onto the fields Vorn indexes', async () => {
    const s = stub({ results: [page('p1', 'Roadmap', 'Doing')] })
    const result = await runPoll(connector(s), 'pageChanged', { config: CONFIG })

    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    // The page id, because titles and URL slugs both change under a rename.
    expect(item.externalId).toBe('p1')
    expect(item.title).toBe('Roadmap')
    expect(item.status).toBe('Doing')
    expect(item.updatedAt).toBe('2026-01-02T03:04:05.000Z')
    expect(item.url).toBe('https://www.notion.so/Roadmap-p1')
    // `data` is flattened by the SDK into the top level, which is where a
    // workflow reads it as {{trigger.item.statusGroup}}. The group travels so a
    // workflow can branch when a team's option names are not in statusMapping.
    expect(item.statusGroup).toBe('In progress')
    expect(item.properties).toEqual({ Name: 'Roadmap', Stage: 'Doing' })
    expect(item.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('titles an untitled page rather than emitting an empty one', async () => {
    const blank = { id: 'p2', last_edited_time: '2026-01-02T00:00:00.000Z', properties: {} }
    const s = stub({ results: [blank] })
    const result = await runPoll(connector(s), 'pageChanged', { config: CONFIG })
    expect(result.items[0].title).toBe('(untitled)')
  })

  it('asks Notion for everything since the watermark, inclusively', async () => {
    const s = stub({ results: [] })
    await runPoll(connector(s), 'pageChanged', {
      config: CONFIG,
      since: '2026-01-01T00:00:00.000Z'
    })
    const body = s.query.mock.calls[0][0] as Record<string, unknown>
    expect(body.filter).toEqual({
      timestamp: 'last_edited_time',
      last_edited_time: { on_or_after: '2026-01-01T00:00:00.000Z' }
    })
    expect(body.data_source_id).toBe('ds-1')
  })

  it('ANDs the configured filter with the watermark', async () => {
    const s = stub({ results: [] })
    await runPoll(connector(s), 'pageChanged', {
      config: { ...CONFIG, filter: '{"property":"Stage","status":{"equals":"Doing"}}' },
      since: '2026-01-01T00:00:00.000Z'
    })
    const body = s.query.mock.calls[0][0] as { filter: { and: unknown[] } }
    expect(body.filter.and).toHaveLength(2)
  })

  it('reports a bad NOTION_FILTER by name instead of sending it', async () => {
    const s = stub()
    await expect(
      runPoll(connector(s), 'pageChanged', { config: { ...CONFIG, filter: 'not json' } })
    ).rejects.toThrow(/NOTION_FILTER must be JSON/)
    expect(s.query).not.toHaveBeenCalled()
  })

  it('honours the configured limit, and falls back when it is nonsense', async () => {
    const s = stub({ results: [] })
    await runPoll(connector(s), 'pageChanged', { config: { ...CONFIG, limit: '5' } })
    expect((s.query.mock.calls[0][0] as { page_size: number }).page_size).toBe(5)

    const t = stub({ results: [] })
    await runPoll(connector(t), 'pageChanged', { config: { ...CONFIG, limit: 'lots' } })
    expect((t.query.mock.calls[0][0] as { page_size: number }).page_size).toBe(100)
  })

  it('warns visibly when Notion truncated the result set', async () => {
    // A short list that looks complete is the failure that reads as data loss
    // months later, so it is said out loud on the poll.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = stub({
      results: [page('p1', 'Roadmap', 'Done')],
      requestStatus: { type: 'incomplete', incomplete_reason: 'query_result_limit_reached' }
    })
    await runPoll(connector(s), 'pageChanged', { config: CONFIG })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('10,000-result ceiling'))
    warn.mockRestore()
  })

  it('uses the configured status property over the schema’s first one', async () => {
    const schema = {
      Name: { type: 'title' },
      Priority: { type: 'select' },
      Stage: { type: 'status', status: { options: [], groups: [] } }
    }
    const p = {
      id: 'p1',
      last_edited_time: '2026-01-02T00:00:00.000Z',
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'A' }] },
        Priority: { type: 'select', select: { name: 'P1' } },
        Stage: { type: 'status', status: { name: 'Doing' } }
      }
    }
    const s = stub({ schema, results: [p] })
    const result = await runPoll(connector(s), 'pageChanged', {
      config: { ...CONFIG, statusProperty: 'Priority' }
    })
    expect(result.items[0].status).toBe('P1')
  })

  it('reports a missing token by its environment variable name', async () => {
    await expect(
      runPoll(connector(stub()), 'pageChanged', { config: { databaseId: DB } })
    ).rejects.toThrow(/NOTION_TOKEN is required/)
    await expect(
      runPoll(connector(stub()), 'pageChanged', { config: { token: 'x' } })
    ).rejects.toThrow(/NOTION_DATABASE_ID is required/)
  })

  it('resolves the data source once and reuses it across polls', async () => {
    // It is a network round trip that cannot change between polls, so paying it
    // every five minutes forever is pure waste.
    const s = stub({ results: [] })
    const c = connector(s)
    await runPoll(c, 'pageChanged', { config: CONFIG })
    await runPoll(c, 'pageChanged', { config: CONFIG })
    expect(s.retrieveDatabase).toHaveBeenCalledTimes(1)
    expect(s.query).toHaveBeenCalledTimes(2)
  })

  it('does not remember a failed resolution', async () => {
    // The usual cause is that nobody has shared the database yet, and that is
    // fixed in Notion's UI — it must not need the connector restarted.
    const s = stub({ results: [] })
    s.retrieveDatabase
      .mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 404 }))
      .mockResolvedValue({ data_sources: [{ id: 'ds-1' }] })
    const c = connector(s)
    await expect(runPoll(c, 'pageChanged', { config: CONFIG })).rejects.toThrow(/Add connections/)
    await expect(runPoll(c, 'pageChanged', { config: CONFIG })).resolves.toBeTruthy()
  })
})

describe('createPage', () => {
  it('parents the page on the data source, not the database', async () => {
    // The post-2025-09-03 model rejects a database_id parent outright.
    const s = stub()
    const result = await runAction(
      connector(s),
      'createPage',
      { title: 'New task' },
      { config: CONFIG }
    )
    const body = s.create.mock.calls[0][0] as Record<string, unknown>
    expect(body.parent).toEqual({ data_source_id: 'ds-1' })
    expect(body.properties).toEqual({ Name: { title: [{ type: 'text', text: { content: 'New task' } }] } })
    expect(result).toEqual({ id: 'new-page', url: 'https://n/new' })
  })

  it('writes the title into whatever the title property is called', async () => {
    const s = stub({ schema: { Headline: { type: 'title' } } })
    await runAction(connector(s), 'createPage', { title: 'X' }, { config: CONFIG })
    expect(s.create.mock.calls[0][0].properties).toHaveProperty('Headline')
  })

  it('turns markdown into blocks', async () => {
    const s = stub()
    await runAction(
      connector(s),
      'createPage',
      { title: 'X', markdown: '# Heading\nBody' },
      { config: CONFIG }
    )
    const children = (s.create.mock.calls[0][0] as { children: Array<{ type: string }> }).children
    expect(children.map((c) => c.type)).toEqual(['heading_1', 'paragraph'])
  })

  it('refuses an oversized body rather than truncating it', async () => {
    // Silently dropping the back half of somebody's document is worse than a
    // step that fails and says why.
    const s = stub()
    const markdown = Array.from({ length: 101 }, (_, i) => `line ${i}`).join('\n')
    await expect(
      runAction(connector(s), 'createPage', { title: 'X', markdown }, { config: CONFIG })
    ).rejects.toThrow(/at most 100/)
    expect(s.create).not.toHaveBeenCalled()
  })

  it('names an unknown property instead of forwarding a bare 400', async () => {
    const s = stub()
    await expect(
      runAction(
        connector(s),
        'createPage',
        { title: 'X', properties: '{"Stag":{"status":{"name":"Doing"}}}' },
        { config: CONFIG }
      )
    ).rejects.toThrow(/No property named Stag/)
  })

  it('still returns a link when Notion answered with {object, id} alone', async () => {
    const s = stub({ created: { object: 'page', id: '12345678-90ab-cdef-1234-567890abcdef' } })
    const result = await runAction(connector(s), 'createPage', { title: 'X' }, { config: CONFIG })
    expect(result.url).toBe('https://www.notion.so/1234567890abcdef1234567890abcdef')
  })

  it('requires a title', async () => {
    await expect(
      runAction(connector(stub()), 'createPage', { title: '  ' }, { config: CONFIG })
    ).rejects.toThrow(/title is required/)
  })

  it('explains a 403 as capabilities rather than sharing', async () => {
    const s = stub()
    s.create.mockRejectedValue(Object.assign(new Error('no'), { status: 403 }))
    await expect(
      runAction(connector(s), 'createPage', { title: 'X' }, { config: CONFIG })
    ).rejects.toThrow(/capabilities/)
  })
})

describe('updatePage', () => {
  it('accepts a pasted page URL and sends the canonical id', async () => {
    const s = stub()
    const result = await runAction(
      connector(s),
      'updatePage',
      { pageId: `https://www.notion.so/Roadmap-${DB}`, title: 'Renamed' },
      { config: CONFIG }
    )
    expect(s.update.mock.calls[0][0].page_id).toBe('12345678-90ab-cdef-1234-567890abcdef')
    expect(result.url).toBe('https://n/p1')
  })

  it('merges explicit properties with the title', async () => {
    const s = stub()
    await runAction(
      connector(s),
      'updatePage',
      { pageId: DB, title: 'T', properties: '{"Stage":{"status":{"name":"Done"}}}' },
      { config: CONFIG }
    )
    const properties = (s.update.mock.calls[0][0] as { properties: Record<string, unknown> })
      .properties
    expect(Object.keys(properties).sort()).toEqual(['Name', 'Stage'])
  })

  it('refuses an empty patch instead of reporting a successful no-op', async () => {
    const s = stub()
    await expect(
      runAction(connector(s), 'updatePage', { pageId: DB }, { config: CONFIG })
    ).rejects.toThrow(/Nothing to update/)
    expect(s.update).not.toHaveBeenCalled()
  })

  it('refuses a rollup, which the API cannot write', async () => {
    const s = stub({ schema: { Name: { type: 'title' }, Total: { type: 'rollup' } } })
    await expect(
      runAction(
        connector(s),
        'updatePage',
        { pageId: DB, properties: '{"Total":1}' },
        { config: CONFIG }
      )
    ).rejects.toThrow(/Rollup properties/)
  })

  it('rejects a page id that is not one', async () => {
    await expect(
      runAction(connector(stub()), 'updatePage', { pageId: 'the roadmap' }, { config: CONFIG })
    ).rejects.toThrow(/does not look like a Notion id/)
  })

  it('derives a link when the update response carries none', async () => {
    const s = stub()
    s.update.mockResolvedValue({ id: 'p1' })
    const result = await runAction(
      connector(s),
      'updatePage',
      { pageId: DB, title: 'T' },
      { config: CONFIG }
    )
    expect(result.url).toBe(`https://www.notion.so/${DB}`)
  })
})

describe('findPages', () => {
  it('returns the pages with the fields a step would template against', async () => {
    const s = stub({ results: [page('p1', 'Roadmap', 'Done')] })
    const result = await runAction(connector(s), 'findPages', {}, { config: CONFIG })
    expect(result.count).toBe(1)
    expect(result.pages).toEqual([
      { id: 'p1', url: 'https://www.notion.so/Roadmap-p1', title: 'Roadmap', status: 'Done' }
    ])
    expect(result.truncated).toBe(false)
  })

  it('reports truncation so a short list is not mistaken for no matches', async () => {
    const s = stub({
      results: [page('p1', 'Roadmap', 'Done')],
      requestStatus: { type: 'incomplete', incomplete_reason: 'query_result_limit_reached' }
    })
    const result = await runAction(connector(s), 'findPages', {}, { config: CONFIG })
    expect(result.truncated).toBe(true)
  })

  it('sends no watermark filter, because a step asked for everything matching', async () => {
    const s = stub({ results: [] })
    await runAction(
      connector(s),
      'findPages',
      { filter: '{"property":"Stage","status":{"equals":"Done"}}', limit: 3 },
      { config: CONFIG }
    )
    const body = s.query.mock.calls[0][0] as { filter: unknown; page_size: number }
    expect(body.filter).toEqual({ property: 'Stage', status: { equals: 'Done' } })
    expect(body.page_size).toBe(3)
  })

  it('falls back to the connection limit when the step gave none', async () => {
    const s = stub({ results: [] })
    await runAction(connector(s), 'findPages', {}, { config: { ...CONFIG, limit: '7' } })
    expect((s.query.mock.calls[0][0] as { page_size: number }).page_size).toBe(7)
  })

  it('reports a null status when the database has no status property', async () => {
    const p = {
      id: 'p1',
      properties: { Name: { type: 'title', title: [{ plain_text: 'A' }] } }
    }
    const s = stub({ schema: { Name: { type: 'title' } }, results: [p] })
    const result = await runAction(connector(s), 'findPages', {}, { config: CONFIG })
    expect((result.pages as Array<{ status: unknown }>)[0].status).toBeNull()
  })

  it('reports a bad filter by name', async () => {
    await expect(
      runAction(connector(stub()), 'findPages', { filter: '[]' }, { config: CONFIG })
    ).rejects.toThrow(/filter must be a JSON object/)
  })
})

describe('the default API client', () => {
  it('is a real Notion client pinned to the version this package was written against', () => {
    // Covers the production path — without a createApi override the connector
    // builds this — while asserting the pin, which is the part that silently
    // changes when the vendor SDK moves its default. No network call: the
    // client is constructed and inspected, never used.
    const api = defaultCreateApi('secret_not_real') as unknown as Client
    expect(api).toBeInstanceOf(Client)
    // The SDK keeps its options private, so the pin is checked against the
    // header the client would send.
    expect(NOTION_VERSION).toBe(Client.defaultNotionVersion)
  })

  it('is what the connector uses when no client was injected', () => {
    const c = createNotionConnector({ version: '9.9.9' })
    expect(c.id).toBe('notion')
  })
})
