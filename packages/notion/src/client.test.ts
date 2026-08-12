import { describe, it, expect, vi } from 'vitest'
import {
  MAX_PAGE_SIZE,
  NOTION_VERSION,
  assertKnownProperties,
  buildQueryBody,
  explainNotionError,
  findStatusProperty,
  isFullPage,
  markdownToBlocks,
  normalizeId,
  pageProperties,
  pageTitle,
  pageUrl,
  parseJsonArg,
  plainText,
  propertyValue,
  queryDataSource,
  resolveDataSource,
  retryDelayMs,
  richText,
  statusGroups,
  withExplanation,
  type NotionApi
} from './client'

/** A Notion API stub. Every test supplies only the endpoints it exercises. */
function api(overrides: {
  retrieveDatabase?: (args: { database_id: string }) => Promise<unknown>
  retrieveDataSource?: (args: { data_source_id: string }) => Promise<unknown>
  query?: (args: Record<string, unknown>) => Promise<unknown>
}): NotionApi {
  return {
    databases: {
      retrieve: overrides.retrieveDatabase ?? (async () => ({ data_sources: [] }))
    },
    dataSources: {
      retrieve: overrides.retrieveDataSource ?? (async () => ({ properties: {} })),
      query: overrides.query ?? (async () => ({ results: [], has_more: false }))
    },
    pages: {
      create: async () => ({ id: 'x' }),
      update: async () => ({ id: 'x' })
    }
  }
}

function httpError(status: number, message = 'boom'): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

describe('the pinned API version', () => {
  it('is the data-source version this connector was written against', () => {
    // Pinned rather than inherited: the version we tested against is the
    // version we send, and a bump is this line plus a failing test.
    expect(NOTION_VERSION).toBe('2025-09-03')
  })
})

describe('normalizeId', () => {
  it('accepts the URL people actually have in their clipboard', () => {
    expect(normalizeId('https://www.notion.so/team/Roadmap-1234567890abcdef1234567890abcdef')).toBe(
      '12345678-90ab-cdef-1234-567890abcdef'
    )
  })

  it('ignores the view id a database URL carries after ?v=', () => {
    // The `?v=` id is also 32 hex characters, so a naive "last hex run" match
    // would silently point every poll at the wrong object.
    expect(
      normalizeId(
        'https://www.notion.so/1234567890abcdef1234567890abcdef?v=ffffffffffffffffffffffffffffffff'
      )
    ).toBe('12345678-90ab-cdef-1234-567890abcdef')
  })

  it('accepts a bare id in either form and lower-cases it', () => {
    expect(normalizeId('1234567890ABCDEF1234567890ABCDEF')).toBe(
      '12345678-90ab-cdef-1234-567890abcdef'
    )
    expect(normalizeId('12345678-90AB-CDEF-1234-567890ABCDEF')).toBe(
      '12345678-90ab-cdef-1234-567890abcdef'
    )
  })

  it('refuses anything else by name, rather than sending it to Notion', () => {
    expect(() => normalizeId('', 'databaseId')).toThrow(/databaseId is required/)
    expect(() => normalizeId('my database', 'databaseId')).toThrow(/does not look like a Notion id/)
  })
})

describe('explainNotionError', () => {
  it('turns a 404 into the sharing step, which is what is actually wrong', () => {
    // The expected first-run state: a valid token that has been shared with
    // nothing. The raw error sends people to re-check their id instead.
    const message = explainNotionError(httpError(404), 'database abc').message
    expect(message).toContain('Add connections')
    expect(message).toContain('database abc')
  })

  it('calls a 403 a capabilities problem, not a sharing one', () => {
    const message = explainNotionError(httpError(403), 'page create').message
    expect(message).toContain('capabilities')
    expect(message).toContain('insert content')
  })

  it('says a 401 means the token, and a 429 may be someone else', () => {
    expect(explainNotionError(httpError(401), 'x').message).toContain('NOTION_TOKEN')
    expect(explainNotionError(httpError(429), 'x').message).toContain('shared across every')
  })

  it('passes an unrecognised Error through unchanged', () => {
    const original = new Error('socket hang up')
    expect(explainNotionError(original, 'x')).toBe(original)
  })

  it('wraps a non-Error throw so the caller still gets a message', () => {
    expect(explainNotionError('nope', 'query').message).toContain('nope')
  })
})

describe('withExplanation', () => {
  it('returns the value when nothing goes wrong', async () => {
    await expect(withExplanation('x', async () => 7)).resolves.toBe(7)
  })

  it('translates whatever the call threw', async () => {
    await expect(
      withExplanation('database abc', async () => {
        throw httpError(404)
      })
    ).rejects.toThrow(/Add connections/)
  })

  it('retries a 429 and returns the answer the retry got', async () => {
    const sleep = vi.fn(async () => {})
    let calls = 0
    const value = await withExplanation(
      'query',
      async () => {
        calls++
        if (calls === 1) throw httpError(429)
        return 'ok'
      },
      { sleep, random: () => 0.5 }
    )
    expect(value).toBe('ok')
    expect(calls).toBe(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('retries Notion’s own transient failures too', async () => {
    for (const status of [503, 529]) {
      let calls = 0
      await expect(
        withExplanation(
          'query',
          async () => {
            calls++
            if (calls === 1) throw httpError(status)
            return status
          },
          { sleep: async () => {}, random: () => 0 }
        )
      ).resolves.toBe(status)
      expect(calls).toBe(2)
    }
  })

  it('never retries a 404, because the second answer is the same as the first', async () => {
    const sleep = vi.fn(async () => {})
    let calls = 0
    await expect(
      withExplanation(
        'database abc',
        async () => {
          calls++
          throw httpError(404)
        },
        { sleep }
      )
    ).rejects.toThrow(/Add connections/)
    // The point of the test: one call, and the translated message survives.
    expect(calls).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('gives up after the retry budget and still explains the error', async () => {
    const sleep = vi.fn(async () => {})
    let calls = 0
    await expect(
      withExplanation(
        'query',
        async () => {
          calls++
          throw httpError(429)
        },
        { sleep, random: () => 0.5, retries: 2 }
      )
    ).rejects.toThrow(/shared across every/)
    expect(calls).toBe(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })
  it('sleeps for real when nothing is injected', async () => {
    // Covers the default timer path; jitter of 0 keeps the wait at 0ms so the
    // test does not trade seconds for a line of coverage.
    let calls = 0
    const value = await withExplanation(
      'query',
      async () => {
        calls++
        if (calls === 1) throw httpError(429)
        return 'ok'
      },
      { random: () => 0 }
    )
    expect(value).toBe('ok')
    expect(calls).toBe(2)
  })
})

describe('retryDelayMs', () => {
  it('obeys Retry-After in seconds, because it reflects the shared workspace budget', () => {
    const error = Object.assign(new Error('slow down'), {
      status: 429,
      headers: { 'retry-after': '7' }
    })
    // Not the backoff curve: 7s, exactly as Notion asked.
    expect(retryDelayMs(error, 0, () => 0.5)).toBe(7000)
    expect(retryDelayMs(error, 3, () => 0.5)).toBe(7000)
  })

  it('reads the header whatever case Notion sent it in', () => {
    const error = Object.assign(new Error('slow down'), { headers: { 'Retry-After': '2' } })
    expect(retryDelayMs(error, 0, () => 0.5)).toBe(2000)
  })

  it('backs off exponentially with full jitter when there is no header', () => {
    // Base 500ms doubling per attempt, and the jitter multiplies rather than
    // nudges: an unjittered fleet re-collides on the shared workspace limit.
    expect(retryDelayMs(new Error('x'), 0, () => 0.5)).toBe(250)
    expect(retryDelayMs(new Error('x'), 1, () => 0.5)).toBe(500)
    expect(retryDelayMs(new Error('x'), 2, () => 0.999)).toBe(1998)
    expect(retryDelayMs(new Error('x'), 2, () => 0)).toBe(0)
  })

  it('ignores a Retry-After that is not a usable number', () => {
    for (const value of ['soon', '0', '-1', '']) {
      const error = Object.assign(new Error('x'), { headers: { 'retry-after': value } })
      expect(retryDelayMs(error, 0, () => 0.5)).toBe(250)
    }
  })
})

describe('resolveDataSource', () => {
  it('uses the only data source silently, so nobody has to paste a second id', async () => {
    const retrieveDataSource = vi.fn(async () => ({ properties: { Name: { type: 'title' } } }))
    const ref = await resolveDataSource(
      api({
        retrieveDatabase: async () => ({ data_sources: [{ id: 'ds-1', name: 'Tasks' }] }),
        retrieveDataSource
      }),
      { databaseId: '1234567890abcdef1234567890abcdef' }
    )
    expect(ref.id).toBe('ds-1')
    expect(ref.properties).toEqual({ Name: { type: 'title' } })
    expect(retrieveDataSource).toHaveBeenCalledWith({ data_source_id: 'ds-1' })
  })

  it('lists the candidates when there are several, rather than guessing one', async () => {
    // Guessing picks the wrong table on somebody's real database, and the poll
    // then looks like it is working.
    await expect(
      resolveDataSource(
        api({
          retrieveDatabase: async () => ({
            data_sources: [
              { id: 'ds-1', name: 'Tasks' },
              { id: 'ds-2', name: 'Archive' }
            ]
          })
        }),
        { databaseId: '1234567890abcdef1234567890abcdef' }
      )
    ).rejects.toThrow(/ds-1 \(Tasks\), ds-2 \(Archive\)/)
  })

  it('names an unnamed data source rather than printing undefined', async () => {
    await expect(
      resolveDataSource(
        api({ retrieveDatabase: async () => ({ data_sources: [{ id: 'a' }, { id: 'b' }] }) }),
        { databaseId: '1234567890abcdef1234567890abcdef' }
      )
    ).rejects.toThrow(/a \(unnamed\), b \(unnamed\)/)
  })

  it('says so when the id was not a database', async () => {
    await expect(
      resolveDataSource(api({ retrieveDatabase: async () => ({ data_sources: [] }) }), {
        databaseId: '1234567890abcdef1234567890abcdef'
      })
    ).rejects.toThrow(/no data sources/)
  })

  it('skips the lookup entirely when a data source id was configured', async () => {
    const retrieveDatabase = vi.fn(async () => ({ data_sources: [] }))
    const ref = await resolveDataSource(api({ retrieveDatabase }), {
      databaseId: '1234567890abcdef1234567890abcdef',
      dataSourceId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee'
    })
    expect(ref.id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(retrieveDatabase).not.toHaveBeenCalled()
  })

  it('treats a partial data source as "cannot validate", not "no properties"', async () => {
    const ref = await resolveDataSource(
      api({
        retrieveDatabase: async () => ({ data_sources: [{ id: 'ds-1' }] }),
        retrieveDataSource: async () => ({ object: 'data_source', id: 'ds-1' })
      }),
      { databaseId: '1234567890abcdef1234567890abcdef' }
    )
    expect(ref.properties).toEqual({})
  })

  it('explains a 404 on the database as the sharing step', async () => {
    await expect(
      resolveDataSource(
        api({
          retrieveDatabase: async () => {
            throw httpError(404)
          }
        }),
        { databaseId: '1234567890abcdef1234567890abcdef' }
      )
    ).rejects.toThrow(/Add connections/)
  })
})

describe('buildQueryBody', () => {
  it('sends the watermark inclusively, because the SDK’s since is a hint', () => {
    // on_or_after, not after: re-delivering an item is free, missing one is not.
    const body = buildQueryBody({ dataSourceId: 'ds', since: '2026-01-01T00:00:00Z', limit: 10 })
    expect(body.filter).toEqual({
      timestamp: 'last_edited_time',
      last_edited_time: { on_or_after: '2026-01-01T00:00:00Z' }
    })
    expect(body.sorts).toEqual([{ timestamp: 'last_edited_time', direction: 'ascending' }])
  })

  it('ANDs the user filter with the watermark rather than replacing either', () => {
    const filter = { property: 'Done', checkbox: { equals: false } }
    const body = buildQueryBody({
      dataSourceId: 'ds',
      since: '2026-01-01T00:00:00Z',
      filter,
      limit: 10
    })
    expect(body.filter).toEqual({
      and: [
        { timestamp: 'last_edited_time', last_edited_time: { on_or_after: '2026-01-01T00:00:00Z' } },
        filter
      ]
    })
  })

  it('sends the user filter alone on the first poll, when there is no watermark', () => {
    const filter = { property: 'Done', checkbox: { equals: false } }
    expect(buildQueryBody({ dataSourceId: 'ds', filter, limit: 5 }).filter).toEqual(filter)
  })

  it('omits the filter entirely when there is nothing to filter on', () => {
    expect(buildQueryBody({ dataSourceId: 'ds', limit: 5 }).filter).toBeUndefined()
  })

  it('always sends an explicit page_size, clamped to what Notion accepts', () => {
    // Notion's docs disagree with themselves about the default, so we never
    // inherit it.
    expect(buildQueryBody({ dataSourceId: 'ds', limit: 5 }).page_size).toBe(5)
    expect(buildQueryBody({ dataSourceId: 'ds', limit: 5000 }).page_size).toBe(MAX_PAGE_SIZE)
    expect(buildQueryBody({ dataSourceId: 'ds', limit: 0 }).page_size).toBe(1)
  })
})

describe('isFullPage', () => {
  it('separates a full page from the {object, id} Notion may answer with', () => {
    expect(isFullPage({ id: 'a', properties: {} })).toBe(true)
    expect(isFullPage({ object: 'page', id: 'a' })).toBe(false)
    expect(isFullPage(null)).toBe(false)
    expect(isFullPage('a')).toBe(false)
  })
})

describe('queryDataSource', () => {
  it('follows has_more rather than stopping on a short page', async () => {
    // Notion can answer with fewer rows than asked for *and* a cursor, so
    // stopping on a short page silently drops the rest of the backlog.
    const query = vi
      .fn<(args: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValueOnce({
        results: [{ id: 'p1', properties: {} }],
        has_more: true,
        next_cursor: 'c1'
      })
      .mockResolvedValueOnce({
        results: [{ id: 'p2', properties: {} }],
        has_more: false,
        next_cursor: null
      })

    const result = await queryDataSource(api({ query }), { dataSourceId: 'ds', limit: 10 })
    expect(result.pages.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(query.mock.calls[1][0].start_cursor).toBe('c1')
    // The second page asks only for what is still missing.
    expect(query.mock.calls[1][0].page_size).toBe(9)
  })

  it('stops at the limit even when Notion still has more', async () => {
    const query = vi.fn(async () => ({
      results: [
        { id: 'p1', properties: {} },
        { id: 'p2', properties: {} }
      ],
      has_more: true,
      next_cursor: 'c1'
    }))
    const result = await queryDataSource(api({ query }), { dataSourceId: 'ds', limit: 2 })
    expect(result.pages).toHaveLength(2)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('stops when has_more is true but no cursor came with it', async () => {
    // A cursor-less has_more would otherwise re-request page one forever.
    const query = vi.fn(async () => ({
      results: [{ id: 'p1', properties: {} }],
      has_more: true,
      next_cursor: null
    }))
    const result = await queryDataSource(api({ query }), { dataSourceId: 'ds', limit: 10 })
    expect(result.pages).toHaveLength(1)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('drops partial rows instead of emitting items with no title', async () => {
    const query = vi.fn(async () => ({
      results: [{ object: 'page', id: 'partial' }, { id: 'p1', properties: {} }],
      has_more: false
    }))
    const result = await queryDataSource(api({ query }), { dataSourceId: 'ds', limit: 10 })
    expect(result.pages.map((p) => p.id)).toEqual(['p1'])
  })

  it('reports the 10,000-result ceiling rather than swallowing it', async () => {
    // A truncated trigger that looks complete reads as data loss months later.
    const query = vi.fn(async () => ({
      results: [{ id: 'p1', properties: {} }],
      has_more: false,
      request_status: { type: 'incomplete', incomplete_reason: 'query_result_limit_reached' }
    }))
    const result = await queryDataSource(api({ query }), { dataSourceId: 'ds', limit: 10 })
    expect(result.truncated).toBe(true)
  })

  it('reports a complete query as not truncated', async () => {
    const query = vi.fn(async () => ({ results: [], has_more: false, request_status: { type: 'complete' } }))
    expect((await queryDataSource(api({ query }), { dataSourceId: 'ds', limit: 10 })).truncated).toBe(
      false
    )
  })

  it('explains a 404 from the query the same way', async () => {
    await expect(
      queryDataSource(
        api({
          query: async () => {
            throw httpError(404)
          }
        }),
        { dataSourceId: 'ds', limit: 10 }
      )
    ).rejects.toThrow(/Add connections/)
  })
})

describe('plainText', () => {
  it('joins rich text into what a human would read', () => {
    expect(plainText([{ plain_text: 'Ship ' }, { plain_text: 'it' }])).toBe('Ship it')
  })

  it('is empty for anything that is not rich text', () => {
    expect(plainText(undefined)).toBe('')
    expect(plainText([{}])).toBe('')
  })
})

describe('propertyValue', () => {
  it('unwraps the types a workflow templates against', () => {
    expect(propertyValue({ type: 'title', title: [{ plain_text: 'Roadmap' }] })).toBe('Roadmap')
    expect(propertyValue({ type: 'rich_text', rich_text: [{ plain_text: 'note' }] })).toBe('note')
    expect(propertyValue({ type: 'status', status: { name: 'In progress' } })).toBe('In progress')
    expect(propertyValue({ type: 'select', select: { name: 'P1' } })).toBe('P1')
    expect(propertyValue({ type: 'multi_select', multi_select: [{ name: 'a' }, {}] })).toEqual([
      'a',
      ''
    ])
    expect(propertyValue({ type: 'people', people: [{ name: 'Ada' }, {}] })).toEqual(['Ada', ''])
    expect(propertyValue({ type: 'date', date: { start: '2026-01-01' } })).toBe('2026-01-01')
    expect(propertyValue({ type: 'checkbox', checkbox: true })).toBe(true)
    expect(propertyValue({ type: 'number', number: 3 })).toBe(3)
    expect(propertyValue({ type: 'url', url: 'https://x' })).toBe('https://x')
    expect(propertyValue({ type: 'email', email: 'a@b.c' })).toBe('a@b.c')
    expect(propertyValue({ type: 'phone_number', phone_number: '123' })).toBe('123')
  })

  it('renders a unique id the way Notion displays it', () => {
    expect(propertyValue({ type: 'unique_id', unique_id: { prefix: 'TASK', number: 7 } })).toBe(
      'TASK-7'
    )
    expect(propertyValue({ type: 'unique_id', unique_id: { prefix: null, number: 7 } })).toBe(7)
    expect(propertyValue({ type: 'unique_id', unique_id: null })).toBeNull()
  })

  it('is null for an empty value rather than undefined', () => {
    expect(propertyValue({ type: 'select', select: null })).toBeNull()
    expect(propertyValue({ type: 'date', date: null })).toBeNull()
    expect(propertyValue({ type: 'number', number: null })).toBeNull()
  })

  it('is null for a type it does not know, rather than leaking the wrapper', () => {
    // A template rendering [object Object] is worse than one rendering nothing.
    expect(propertyValue({ type: 'rollup', rollup: { type: 'number', number: 1 } })).toBeNull()
    expect(propertyValue(null)).toBeNull()
    expect(propertyValue({})).toBeNull()
  })
})

describe('pageProperties and pageTitle', () => {
  const page = {
    id: 'p1',
    properties: {
      Name: { type: 'title', title: [{ plain_text: 'Roadmap' }] },
      Status: { type: 'status', status: { name: 'Done' } }
    }
  }

  it('flattens every property under its own name', () => {
    expect(pageProperties(page)).toEqual({ Name: 'Roadmap', Status: 'Done' })
  })

  it('finds the title wherever the property happens to be called', () => {
    expect(pageTitle(page)).toBe('Roadmap')
  })

  it('is empty rather than throwing when a page has no title property', () => {
    expect(pageTitle({ id: 'p1', properties: { Status: { type: 'status', status: null } } })).toBe('')
    expect(pageTitle({ id: 'p1' })).toBe('')
    expect(pageProperties({ id: 'p1' })).toEqual({})
  })
})

describe('findStatusProperty', () => {
  const schema = {
    Name: { type: 'title' },
    Priority: { type: 'select' },
    Stage: { type: 'status' }
  }

  it('prefers a real status property over a select', () => {
    expect(findStatusProperty(schema)).toBe('Stage')
  })

  it('falls back to a select when there is no status property', () => {
    expect(findStatusProperty({ Name: { type: 'title' }, Priority: { type: 'select' } })).toBe(
      'Priority'
    )
  })

  it('lets an explicit name win, so property order does not decide it', () => {
    expect(findStatusProperty(schema, 'Priority')).toBe('Priority')
  })

  it('is undefined when the schema has neither', () => {
    expect(findStatusProperty({ Name: { type: 'title' } })).toBeUndefined()
  })
})

describe('statusGroups', () => {
  const schema = {
    Stage: {
      type: 'status',
      status: {
        options: [
          { id: 'o1', name: 'Doing' },
          { id: 'o2', name: 'Shipped' },
          { id: 'o3', name: 'Orphan' }
        ],
        groups: [
          { name: 'In progress', option_ids: ['o1'] },
          { name: 'Complete', option_ids: ['o2', 'missing'] }
        ]
      }
    }
  }

  it('maps each option name to its group, which is the stable part', () => {
    // Teams rename options freely; the three groups are what survive.
    expect(statusGroups(schema, 'Stage')).toEqual({ Doing: 'In progress', Shipped: 'Complete' })
  })

  it('is empty when the property is not a status property or is absent', () => {
    expect(statusGroups(schema)).toEqual({})
    expect(statusGroups({ Priority: { type: 'select' } }, 'Priority')).toEqual({})
    expect(statusGroups({ Stage: { type: 'status', status: {} } }, 'Stage')).toEqual({})
  })
})

describe('markdownToBlocks', () => {
  it('turns paragraphs and headings into blocks, and drops blank lines', () => {
    const blocks = markdownToBlocks('# Title\n\nA line\n### Small\n')
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toEqual({
      object: 'block',
      type: 'heading_1',
      heading_1: { rich_text: [{ type: 'text', text: { content: 'Title' } }] }
    })
    expect(blocks[1].type).toBe('paragraph')
    expect(blocks[2].type).toBe('heading_3')
  })

  it('is empty for empty input', () => {
    expect(markdownToBlocks('   \n\n')).toEqual([])
  })
})

describe('richText', () => {
  it('wraps a string in the request shape Notion expects', () => {
    expect(richText('hi')).toEqual([{ type: 'text', text: { content: 'hi' } }])
  })
})

describe('assertKnownProperties', () => {
  const schema = { Name: { type: 'title' }, Total: { type: 'rollup' } }

  it('names the misspelled property, which Notion’s 400 does not', () => {
    expect(() => assertKnownProperties(schema, { Nmae: {} })).toThrow(/No property named Nmae/)
    expect(() => assertKnownProperties(schema, { Nmae: {} })).toThrow(/It has: Name, Total/)
  })

  it('refuses rollups, which the API cannot write at all', () => {
    expect(() => assertKnownProperties(schema, { Total: {} })).toThrow(/Rollup properties/)
  })

  it('accepts properties that are in the schema', () => {
    expect(() => assertKnownProperties(schema, { Name: {} })).not.toThrow()
  })

  it('passes through when Notion gave us no schema to check against', () => {
    // An empty schema means "cannot validate", never "no properties exist" —
    // refusing a legitimate edit is the worse answer.
    expect(() => assertKnownProperties({}, { Anything: {} })).not.toThrow()
  })
})

describe('parseJsonArg', () => {
  it('returns the parsed object', () => {
    expect(parseJsonArg('{"a":1}', 'filter')).toEqual({ a: 1 })
  })

  it('names the field when the value is not JSON, or not an object', () => {
    expect(() => parseJsonArg('{', 'NOTION_FILTER')).toThrow(/NOTION_FILTER must be JSON/)
    expect(() => parseJsonArg('[1]', 'filter')).toThrow(/filter must be a JSON object/)
    expect(() => parseJsonArg('"x"', 'filter')).toThrow(/must be a JSON object/)
    expect(() => parseJsonArg('null', 'filter')).toThrow(/must be a JSON object/)
  })
})

describe('pageUrl', () => {
  it('uses the URL Notion gave us', () => {
    expect(pageUrl({ id: 'a', url: 'https://www.notion.so/Roadmap-abc' })).toBe(
      'https://www.notion.so/Roadmap-abc'
    )
  })

  it('derives one when Notion answered with {object, id} alone', () => {
    // POST /v1/pages may legitimately omit the URL, and a step returning no
    // link at all is worse than a derived one.
    expect(pageUrl({ id: '12345678-90ab-cdef-1234-567890abcdef' })).toBe(
      'https://www.notion.so/1234567890abcdef1234567890abcdef'
    )
  })
})
