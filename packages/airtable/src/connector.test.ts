import { describe, expect, it, vi } from 'vitest'
import { createConnectorHarness, type ConnectorConfig } from '@vornrun/connector-sdk'
import {
  connector as packaged,
  count,
  createAirtableConnector,
  fieldsArg,
  modifiedAt,
  namesArg,
  recordsArg,
  sortArg
} from './connector'
import { API_ROOT, LOCKOUT_MS } from './client'
import { SAMPLE_BASE_ID, SAMPLE_RECORD, SAMPLE_TABLE_ID } from './items'

const NOW = '2026-09-05T12:00:00.000Z'
const HOUR_BEFORE = '2026-09-05T11:00:00.000Z'
const CONFIG: ConnectorConfig = { apiKey: 'pat.test', baseId: 'appA', table: 'tblB' }

interface Sent {
  method: string
  url: string
  headers: Record<string, string>
  body?: Record<string, unknown>
}

interface Route {
  when: RegExp
  status?: number
  body?: unknown
  headers?: Record<string, string>
  /** Answers in order for repeated hits; the last one repeats. */
  bodies?: unknown[]
}

// A fake api.airtable.com driven by the URL asked for, so a test says what the base holds and asserts on what was sent.
function airtableServing(routes: Route[]) {
  const sent: Sent[] = []
  const hits = new Map<Route, number>()
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    sent.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === 'string' && { body: JSON.parse(init.body) as Record<string, unknown> })
    })
    const route = routes.find((candidate) => candidate.when.test(url))
    if (!route) throw new Error(`No fake route for ${url}`)
    const hit = hits.get(route) ?? 0
    hits.set(route, hit + 1)
    const body = route.bodies ? route.bodies[Math.min(hit, route.bodies.length - 1)] : route.body
    return new Response(JSON.stringify(body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...route.headers }
    })
  }) as unknown as typeof fetch
  return { fetchImpl, sent }
}

function harnessOver(routes: Route[], options: { config?: ConnectorConfig; env?: NodeJS.ProcessEnv } = {}) {
  const { fetchImpl, sent } = airtableServing(routes)
  const waits: number[] = []
  let clock = Date.parse(NOW)
  const connector = createAirtableConnector({
    env: options.env ?? {},
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms)
      clock += ms
    },
    random: () => 0.5
  })
  const harness = createConnectorHarness(connector, {
    config: options.config ?? CONFIG,
    now: () => NOW,
    fetchImpl,
    sleep: async () => undefined
  })
  return { connector, harness, sent, waits }
}

const record = (id: string, createdTime: string, fields: Record<string, unknown> = { Name: id }) => ({
  id,
  createdTime,
  fields
})

const LIST = /\/appA\/tblB\/listRecords$/

describe('the definition', () => {
  const connector = createAirtableConnector({ version: '1.2.3', env: {} })

  it('asks for a key exactly as the spec declares it', () => {
    expect(connector.auth).toEqual({ rung: 'key', keys: ['apiKey'] })
    const apiKey = connector.config.find((field) => field.key === 'apiKey')
    expect(apiKey).toMatchObject({ env: 'AIRTABLE_API_KEY', secret: true, required: true })
  })

  it('reads its settings from the documented variables', () => {
    expect(connector.config.map((field) => field.env)).toEqual([
      'AIRTABLE_API_KEY',
      'AIRTABLE_BASE_ID',
      'AIRTABLE_TABLE',
      'AIRTABLE_VIEW',
      'AIRTABLE_FILTER_BY_FORMULA',
      'AIRTABLE_LAST_MODIFIED_FIELD'
    ])
  })

  it('leaves a hint for whoever builds on it, on every setting and every input', () => {
    for (const field of connector.config) expect(field.builderHint, field.key).toBeTruthy()
    for (const action of connector.actions) {
      expect(typeof action.idempotent, action.type).toBe('boolean')
      expect(action.outputs?.length, action.type).toBeGreaterThan(0)
      for (const input of action.inputs ?? []) {
        expect(input.builderHint, `${action.type}.${input.key}`).toBeTruthy()
        expect(input.description, `${action.type}.${input.key}`).toBeTruthy()
      }
    }
  })

  it('offers the triggers and actions the spec lists', () => {
    expect(connector.triggers.map((trigger) => trigger.type)).toEqual(['newRecord', 'updatedRecord'])
    expect(connector.actions.map((action) => action.type)).toEqual([
      'createRecord',
      'updateRecord',
      'upsertRecords',
      'deleteRecord',
      'getRecord',
      'listRecords',
      'listBases',
      'getBaseSchema'
    ])
    const idempotent = connector.actions.filter((action) => action.idempotent).map((action) => action.type)
    expect(idempotent).toEqual(['updateRecord', 'getRecord', 'listRecords', 'listBases', 'getBaseSchema'])
  })

  it('draws the three plates of Airtable’s mark', () => {
    expect(connector.icon?.viewBox).toBe('0 0 24 24')
    expect(connector.icon?.paths).toHaveLength(3)
    for (const path of connector.icon?.paths ?? []) expect(path).toMatch(/^M[\d.]+ [\d.]+.*z$/)
  })

  it('names the version it was built with, and the package version otherwise', () => {
    expect(connector.version).toBe('1.2.3')
    expect(packaged.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('replays a sample item through each trigger without redelivery', async () => {
    for (const trigger of connector.triggers) {
      expect(trigger.sample?.[0]).toMatchObject({ externalId: SAMPLE_RECORD.id, title: 'Union Square' })
    }
    expect(connector.triggers[1].sample?.[0].updatedAt).toBe('2022-09-13T08:15:02.000Z')
  })

  it('uses placeholder ids in samples until the environment names real ones', () => {
    const byType = Object.fromEntries(connector.actions.map((action) => [action.type, action.sample]))
    expect(byType.listRecords).toEqual({ baseId: 'appXXXXXXXXXXXXXX', table: 'tblXXXXXXXXXXXXXX', maxRecords: '5' })
    expect(byType.getBaseSchema).toEqual({ baseId: 'appXXXXXXXXXXXXXX' })
    expect(byType.listBases).toEqual({})
    expect(byType.getRecord).toBeUndefined()

    const live = createAirtableConnector({
      env: { AIRTABLE_BASE_ID: 'appReal', AIRTABLE_TABLE: 'Places', AIRTABLE_RECORD_ID: 'recReal' }
    })
    const liveByType = Object.fromEntries(live.actions.map((action) => [action.type, action.sample]))
    expect(liveByType.getRecord).toEqual({ baseId: 'appReal', table: 'Places', recordId: 'recReal' })
    expect(liveByType.listRecords).toEqual({ baseId: 'appReal', table: 'Places', maxRecords: '5' })
    expect(createAirtableConnector().version).toBe(packaged.version)
  })
})

describe('argument helpers', () => {
  it('reads fields as an object, parsed or as text', () => {
    expect(fieldsArg({ Name: 'A' })).toEqual({ Name: 'A' })
    expect(fieldsArg('{"Name":"A"}')).toEqual({ Name: 'A' })
    expect(() => fieldsArg('[]')).toThrow('fields must be a JSON object')
    expect(() => fieldsArg('{nope')).toThrow('fields must be JSON')
  })

  it('reads records as up to ten entries, wrapping bare fields', () => {
    expect(recordsArg([{ fields: { Name: 'A' } }, { Name: 'B' }])).toEqual([{ fields: { Name: 'A' } }, { fields: { Name: 'B' } }])
    expect(recordsArg({ Name: 'A' })).toEqual([{ fields: { Name: 'A' } }])
    expect(recordsArg('[{"fields":{}}]')).toEqual([{ fields: {} }])
    expect(() => recordsArg([1])).toThrow('records[0] must be an object')
    expect(() => recordsArg(new Array(11).fill({}))).toThrow('at most 10 entries per call, got 11')
  })

  it('reads field names from a list or a line', () => {
    expect(namesArg('Name, Address ,', 'fields')).toEqual(['Name', 'Address'])
    expect(namesArg('["Name","Address"]', 'fields')).toEqual(['Name', 'Address'])
    expect(namesArg(undefined, 'fields')).toEqual([])
    expect(() => namesArg('[1]', 'fields')).toThrow('fields must be a JSON array of field names')
  })

  it('reads sort as a list of objects', () => {
    expect(sortArg(undefined)).toBeUndefined()
    expect(sortArg({ field: 'Name' })).toEqual([{ field: 'Name' }])
    expect(sortArg('[{"field":"Name","direction":"desc"}]')).toEqual([{ field: 'Name', direction: 'desc' }])
    expect(() => sortArg(['Name'])).toThrow('sort must be a JSON array')
  })

  it('bounds a count', () => {
    expect(count(undefined, 'n')).toBeUndefined()
    expect(count('', 'n')).toBeUndefined()
    expect(count('7', 'n', 100)).toBe(7)
    expect(() => count(0, 'n')).toThrow('n must be a whole number of at least 1, got "0"')
    expect(() => count(101, 'n', 100)).toThrow('n must be a whole number from 1 to 100, got "101"')
  })

  it('takes a last-modified cell as the time, else the created time', () => {
    expect(modifiedAt(record('rec1', 't0', { M: '2026-01-01T00:00:00.000Z' }), 'M')).toBe('2026-01-01T00:00:00.000Z')
    expect(modifiedAt(record('rec1', 't0', { M: 'never' }), 'M')).toBe('t0')
    expect(modifiedAt(record('rec1', 't0', {}), 'M')).toBe('t0')
  })
})

describe('newRecord', () => {
  it('asks for records created since the watermark and delivers them oldest first', async () => {
    const { harness, sent } = harnessOver([
      {
        when: LIST,
        body: { records: [record('rec2', '2026-09-05T11:30:00.000Z'), record('rec1', '2026-09-05T11:20:00.000Z')] }
      }
    ])
    const page = await harness.poll('newRecord', { since: '2026-09-05T11:10:00.000Z' })
    expect(page.items.map((item) => item.externalId)).toEqual(['rec1', 'rec2'])
    expect(page.items[0]).toMatchObject({
      title: 'rec1',
      url: 'https://airtable.com/appA/tblB/rec1',
      updatedAt: '2026-09-05T11:20:00.000Z'
    })
    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: `${API_ROOT}/appA/tblB/listRecords`,
      headers: { Authorization: 'Bearer pat.test' },
      body: {
        filterByFormula: 'NOT(IS_BEFORE(CREATED_TIME(), DATETIME_PARSE("2026-09-05T11:10:00.000Z")))',
        pageSize: 100
      }
    })
  })

  it('starts an hour back on the first poll, and ANDs the view and filter from the settings', async () => {
    const { harness, sent } = harnessOver([{ when: LIST, body: { records: [] } }], {
      config: { ...CONFIG, view: 'Grid view', filterByFormula: '{Visited}' }
    })
    expect((await harness.poll('newRecord')).items).toEqual([])
    expect(sent[0].body).toEqual({
      filterByFormula: `AND(NOT(IS_BEFORE(CREATED_TIME(), DATETIME_PARSE("${HOUR_BEFORE}"))), {Visited})`,
      view: 'Grid view',
      pageSize: 100
    })
  })

  it('does not deliver the same record twice', async () => {
    const { harness } = harnessOver([{ when: LIST, body: { records: [record('rec1', '2026-09-05T11:20:00.000Z')] } }])
    expect(await harness.pollTwice('newRecord')).toEqual([])
  })

  it('walks offset across pages', async () => {
    const { harness, sent } = harnessOver([
      {
        when: LIST,
        bodies: [
          { records: [record('rec1', '2026-09-05T11:20:00.000Z')], offset: 'itr/rec1' },
          { records: [record('rec2', '2026-09-05T11:21:00.000Z')] }
        ]
      }
    ])
    const page = await harness.poll('newRecord')
    expect(page.items).toHaveLength(2)
    expect(sent[1].body?.offset).toBe('itr/rec1')
  })

  it('needs the base and table settings', async () => {
    const { harness } = harnessOver([], { config: { apiKey: 'pat.test' } })
    await expect(harness.poll('newRecord')).rejects.toThrow('AIRTABLE_BASE_ID is required')
    const noTable = harnessOver([], { config: { apiKey: 'pat.test', baseId: 'appA' } })
    await expect(noTable.harness.poll('newRecord')).rejects.toThrow('AIRTABLE_TABLE is required')
    const noKey = harnessOver([], { config: { baseId: 'appA', table: 'tblB' } })
    await expect(noKey.harness.poll('newRecord')).rejects.toThrow('AIRTABLE_API_KEY is required')
  })

  it('waits the lockout on a 429 and polls once more', async () => {
    const { harness, sent, waits } = harnessOver([
      { when: LIST, status: 429, body: { error: { type: 'RATE_LIMIT_REACHED', message: 'wait' } } }
    ])
    await expect(harness.poll('newRecord')).rejects.toThrow('RATE_LIMIT_REACHED: wait')
    expect(sent.length).toBeGreaterThanOrEqual(2)
    expect(waits).toContain(LOCKOUT_MS)
  })
})

describe('updatedRecord', () => {
  // A record without the cell falls back to its created time, which the watermark then rules out, as the formula's own {field} clause does server-side.
  it('filters and sorts on the named last-modified field and stamps items with its value', async () => {
    const { harness, sent } = harnessOver(
      [
        {
          when: LIST,
          body: {
            records: [
              record('rec1', '2026-09-01T00:00:00.000Z', { Name: 'A', 'Last modified': '2026-09-05T11:30:00.000Z' }),
              record('rec2', '2026-09-01T00:00:00.000Z', { Name: 'B' })
            ]
          }
        }
      ],
      { config: { ...CONFIG, lastModifiedField: 'Last modified' } }
    )
    const page = await harness.poll('updatedRecord', { since: '2026-09-05T11:10:00.000Z' })
    expect(page.items.map((item) => [item.externalId, item.updatedAt])).toEqual([['rec1', '2026-09-05T11:30:00.000Z']])
    expect(sent[0].body).toEqual({
      filterByFormula:
        'AND({Last modified}, NOT(IS_BEFORE({Last modified}, DATETIME_PARSE("2026-09-05T11:10:00.000Z"))))',
      sort: [{ field: 'Last modified', direction: 'asc' }],
      pageSize: 100
    })
    expect(page.nextCursor).toContain('2026-09-05T11:30:00.000Z')
  })

  it('falls back to LAST_MODIFIED_TIME() and the poll time without a field', async () => {
    const { harness, sent } = harnessOver([
      { when: LIST, body: { records: [record('rec1', '2026-09-01T00:00:00.000Z'), record('rec2', '2026-09-02T00:00:00.000Z')] } }
    ])
    const page = await harness.poll('updatedRecord')
    expect(page.items.map((item) => item.updatedAt)).toEqual([NOW, NOW])
    expect(sent[0].body).toEqual({
      filterByFormula: `NOT(IS_BEFORE(LAST_MODIFIED_TIME(), DATETIME_PARSE("${HOUR_BEFORE}")))`,
      pageSize: 100
    })
    expect(page.nextCursor).toContain(NOW)
  })

  it('fires a record again only when it is touched in a later poll', async () => {
    const { harness } = harnessOver([{ when: LIST, body: { records: [record('rec1', '2026-09-01T00:00:00.000Z')] } }])
    const first = await harness.poll('updatedRecord')
    expect(first.items).toHaveLength(1)
    const again = await harness.poll('updatedRecord', { cursor: first.nextCursor })
    expect(again.items).toHaveLength(0)
  })

  it('ANDs the view and the user filter with the field clause', async () => {
    const { harness, sent } = harnessOver([{ when: LIST, body: { records: [] } }], {
      config: { ...CONFIG, view: 'Grid', filterByFormula: '{Visited}', lastModifiedField: 'M' }
    })
    await harness.poll('updatedRecord')
    expect(sent[0].body?.view).toBe('Grid')
    expect(sent[0].body?.filterByFormula).toBe(`AND({M}, NOT(IS_BEFORE({M}, DATETIME_PARSE("${HOUR_BEFORE}"))), {Visited})`)
    const plain = harnessOver([{ when: LIST, body: { records: [] } }], { config: { ...CONFIG, view: 'Grid' } })
    await plain.harness.poll('updatedRecord')
    expect(plain.sent[0].body?.view).toBe('Grid')
  })

  it('refuses a field name that cannot be written into a formula', async () => {
    const { harness } = harnessOver([], { config: { ...CONFIG, lastModifiedField: 'a}b' } })
    await expect(harness.poll('updatedRecord')).rejects.toThrow('may not contain braces')
  })
})

describe('record actions', () => {
  const saved = record('rec1', '2026-09-05T11:20:00.000Z', { Name: 'Union Square' })

  it('creates a record with fields, typecast and the URL to open it', async () => {
    const { harness, sent } = harnessOver([{ when: /\/appA\/tblB$/, body: saved }])
    const output = await harness.execute('createRecord', {
      baseId: 'appA',
      table: 'tblB',
      fields: '{"Name":"Union Square"}',
      typecast: 'true'
    })
    expect(output).toEqual({
      id: 'rec1',
      createdTime: '2026-09-05T11:20:00.000Z',
      fields: { Name: 'Union Square' },
      url: 'https://airtable.com/appA/tblB/rec1'
    })
    expect(sent[0]).toMatchObject({ method: 'POST', body: { fields: { Name: 'Union Square' }, typecast: true } })
    expect(sent[0].body).not.toHaveProperty('returnFieldsByFieldId')
  })

  it('refuses a create without fields before any call', async () => {
    const { harness, sent } = harnessOver([])
    await expect(harness.execute('createRecord', { baseId: 'appA', table: 'tblB' })).rejects.toThrow(/requires "fields"/)
    await expect(harness.execute('createRecord', { baseId: 'appA', table: 'tblB', fields: 'nope' })).rejects.toThrow(/Expected JSON/)
    expect(sent).toEqual([])
  })

  it('patches a record and keys the fields by id when asked', async () => {
    const { harness, sent } = harnessOver([{ when: /\/appA\/Places\/rec1$/, body: { ...saved, fields: { fld1: 'B' } } }])
    const output = await harness.execute('updateRecord', {
      baseId: 'appA',
      table: 'Places',
      recordId: 'rec1',
      fields: '{"fld1":"B"}',
      returnFieldsByFieldId: 'true'
    })
    expect(output).toEqual({ id: 'rec1', createdTime: '2026-09-05T11:20:00.000Z', fields: { fld1: 'B' } })
    expect(sent[0]).toMatchObject({
      method: 'PATCH',
      url: `${API_ROOT}/appA/Places/rec1`,
      body: { fields: { fld1: 'B' }, returnFieldsByFieldId: true }
    })
  })

  it('upserts up to ten records on the merge fields', async () => {
    const { harness, sent } = harnessOver([
      {
        when: /\/appA\/tblB$/,
        body: { records: [saved], createdRecords: ['rec1'], updatedRecords: [] }
      }
    ])
    const output = await harness.execute('upsertRecords', {
      baseId: 'appA',
      table: 'tblB',
      records: '[{"fields":{"Name":"Union Square"}}]',
      fieldsToMergeOn: 'Name',
      typecast: 'false'
    })
    expect(output).toEqual({ records: [saved], createdRecords: ['rec1'], updatedRecords: [] })
    expect(sent[0]).toMatchObject({
      method: 'PATCH',
      body: { performUpsert: { fieldsToMergeOn: ['Name'] }, records: [{ fields: { Name: 'Union Square' } }] }
    })
    expect(sent[0].body).not.toHaveProperty('typecast')
  })

  it('refuses an upsert with no merge field, too many, or too many records', async () => {
    const { harness, sent } = harnessOver([])
    const base = { baseId: 'appA', table: 'tblB', records: '[]' }
    await expect(harness.execute('upsertRecords', { ...base, fieldsToMergeOn: ' , ' })).rejects.toThrow('must name 1 to 3 fields, got 0')
    await expect(harness.execute('upsertRecords', { ...base, fieldsToMergeOn: 'a,b,c,d' })).rejects.toThrow('got 4')
    await expect(
      harness.execute('upsertRecords', { ...base, fieldsToMergeOn: 'a', records: JSON.stringify(new Array(11).fill({})) })
    ).rejects.toThrow('at most 10 entries')
    expect(sent).toEqual([])
  })

  it('reads an empty upsert answer as no records', async () => {
    const { harness } = harnessOver([{ when: /\/appA\/tblB$/, body: {} }])
    const output = await harness.execute('upsertRecords', { baseId: 'appA', table: 'tblB', records: '{}', fieldsToMergeOn: 'Name' })
    expect(output).toEqual({ records: [], createdRecords: [], updatedRecords: [] })
  })

  it('deletes a record', async () => {
    const { harness, sent } = harnessOver([{ when: /\/appA\/tblB\/rec1$/, body: { deleted: true, id: 'rec1' } }])
    expect(await harness.execute('deleteRecord', { baseId: 'appA', table: 'tblB', recordId: 'rec1' })).toEqual({
      id: 'rec1',
      deleted: true
    })
    expect(sent[0].method).toBe('DELETE')
    const silent = harnessOver([{ when: /\/appA\/tblB\/rec1$/, body: {} }])
    expect(await silent.harness.execute('deleteRecord', { baseId: 'appA', table: 'tblB', recordId: 'rec1' })).toEqual({
      id: 'rec1',
      deleted: false
    })
  })

  it('gets a record', async () => {
    const { harness, sent } = harnessOver([{ when: /\/appA\/tblB\/rec1/, body: saved }])
    const output = await harness.execute('getRecord', { baseId: 'appA', table: 'tblB', recordId: 'rec1', returnFieldsByFieldId: 'true' })
    expect(output).toMatchObject({ id: 'rec1', url: 'https://airtable.com/appA/tblB/rec1' })
    expect(sent[0]).toMatchObject({ method: 'GET', url: `${API_ROOT}/appA/tblB/rec1?returnFieldsByFieldId=true` })
  })

  it('surfaces what Airtable said when a call fails', async () => {
    const { harness } = harnessOver([
      { when: /\/appA\/tblB\/rec1/, status: 404, body: { error: { type: 'NOT_FOUND', message: 'Could not find what you are looking for' } } }
    ])
    await expect(harness.execute('getRecord', { baseId: 'appA', table: 'tblB', recordId: 'rec1' })).rejects.toThrow(
      'NOT_FOUND: Could not find what you are looking for'
    )
  })

  it('lists records with every parameter and counts them', async () => {
    const { harness, sent } = harnessOver([{ when: LIST, body: { records: [saved] } }])
    const output = await harness.execute('listRecords', {
      baseId: 'appA',
      table: 'tblB',
      filterByFormula: '{Visited}',
      view: 'Grid',
      maxRecords: '250',
      pageSize: '50',
      fields: 'Name, Address',
      sort: '[{"field":"Name","direction":"asc"}]',
      returnFieldsByFieldId: 'false'
    })
    expect(output).toEqual({
      records: [{ id: 'rec1', createdTime: '2026-09-05T11:20:00.000Z', fields: { Name: 'Union Square' }, url: 'https://airtable.com/appA/tblB/rec1' }],
      count: 1
    })
    expect(sent[0].body).toEqual({
      filterByFormula: '{Visited}',
      view: 'Grid',
      maxRecords: 250,
      pageSize: 50,
      fields: ['Name', 'Address'],
      sort: [{ field: 'Name', direction: 'asc' }]
    })
  })

  it('lists a hundred records by default and bounds the page size', async () => {
    const { harness, sent } = harnessOver([{ when: LIST, body: {} }])
    expect(await harness.execute('listRecords', { baseId: 'appA', table: 'tblB' })).toEqual({ records: [], count: 0 })
    expect(sent[0].body).toEqual({ maxRecords: 100, pageSize: 100 })
    await expect(harness.execute('listRecords', { baseId: 'appA', table: 'tblB', pageSize: '101' })).rejects.toThrow('pageSize must be a whole number from 1 to 100')
  })
})

describe('meta actions', () => {
  it('lists bases with the offset passed through', async () => {
    const { harness, sent } = harnessOver([
      { when: /\/meta\/bases/, body: { bases: [{ id: 'appA', name: 'Places', permissionLevel: 'create' }], offset: 'next', extra: 1 } }
    ])
    expect(await harness.execute('listBases', {})).toEqual({
      bases: [{ id: 'appA', name: 'Places', permissionLevel: 'create' }],
      offset: 'next'
    })
    expect(sent[0]).toMatchObject({ method: 'GET', url: `${API_ROOT}/meta/bases`, headers: { Authorization: 'Bearer pat.test' } })
    await harness.execute('listBases', { offset: 'next' })
    expect(sent[1].url).toBe(`${API_ROOT}/meta/bases?offset=next`)
  })

  it('reads a base schema', async () => {
    const tables = [{ id: 'tblB', name: 'Places', primaryFieldId: 'fld1', fields: [], views: [] }]
    const { harness, sent } = harnessOver([{ when: /\/meta\/bases\/appA\/tables$/, body: { tables } }])
    expect(await harness.execute('getBaseSchema', { baseId: 'appA' })).toEqual({ tables })
    expect(sent[0].url).toBe(`${API_ROOT}/meta/bases/appA/tables`)
  })
})

describe('the conformance run', () => {
  it('runs every action against served HTTP with placeholder arguments', async () => {
    const { harness } = harnessOver([{ when: /.*/, body: {} }])
    const args: Record<string, Record<string, string>> = {
      createRecord: { baseId: 'check', table: 'check', fields: '{}' },
      updateRecord: { baseId: 'check', table: 'check', recordId: 'check', fields: '{}' },
      upsertRecords: { baseId: 'check', table: 'check', records: '{}', fieldsToMergeOn: 'check' },
      deleteRecord: { baseId: 'check', table: 'check', recordId: 'check' },
      getRecord: { baseId: 'check', table: 'check', recordId: 'check' },
      listRecords: { baseId: 'check', table: 'check', maxRecords: '1', pageSize: '1', fields: 'check', sort: '{}' },
      listBases: { offset: 'check' },
      getBaseSchema: { baseId: 'check' }
    }
    for (const [type, input] of Object.entries(args)) {
      await expect(harness.execute(type, input), type).resolves.toBeDefined()
    }
  })

  it('names the sample base and table the spec quotes', () => {
    expect(SAMPLE_BASE_ID).toBe('appLkNDICXNqxSDhG')
    expect(SAMPLE_TABLE_ID).toBe('tbltp8DGLhqbUmjK1')
  })
})
