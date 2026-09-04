import { createConnectorHarness } from '@vornrun/connector-sdk'
import { describe, expect, it, vi } from 'vitest'
import { createPostgresConnector } from './connector'
import { clientFrom, type SqlClient, type SqlResult } from './driver'
import type { Row } from './sql'

const DSN = 'postgres://alice:pencil@db.example.com:5432/app?sslmode=disable'

/** A result as the driver resolves one: the rows, with the command tag's parts attached. */
function result(columns: string[], rows: Row[], command = 'SELECT', count = rows.length): SqlResult {
  return Object.assign([...rows], { count, command, columns: columns.map((name) => ({ name })) }) as SqlResult
}

type Answer = SqlResult | SqlResult[] | Error | ((text: string, params: unknown[]) => SqlResult)

/** A driver that answers each query from a script and records what it was asked. */
function fake(answers: Answer[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const queue = [...answers]
  const end = vi.fn(async () => {})
  const sql: SqlClient = {
    async unsafe(text, params = []) {
      calls.push({ sql: text, params })
      const next = queue.shift()
      if (next === undefined) throw new Error(`no scripted answer for: ${text}`)
      if (next instanceof Error) throw next
      return typeof next === 'function' ? next(text, params) : next
    },
    end
  }
  const open = vi.fn((_connectionString: string) => clientFrom(sql))
  const connector = createPostgresConnector({ version: '0.1.0', open })
  return { connector, end, open, calls, harness: (config: Record<string, string>) => createConnectorHarness(connector, { config }) }
}

const ORDERS = ['id', 'reference', 'created_at']
const at = (text: string): Date => new Date(text)

describe('definition', () => {
  const { connector } = fake()

  it('signs in with the connection string, kept secret', () => {
    expect(connector.auth).toEqual({ rung: 'key', keys: ['connectionString'] })
    const field = connector.config.find((entry) => entry.key === 'connectionString')
    expect(field).toMatchObject({ env: 'DATABASE_URL', secret: true, required: true })
    expect(connector.version).toBe('0.1.0')
    expect(connector.id).toBe('postgres')
  })

  it('offers two poll triggers and six actions, the reads with samples', () => {
    expect(connector.triggers.map((t) => t.type)).toEqual(['newRows', 'queryRows'])
    expect(connector.triggers.every((t) => typeof t.poll === 'function')).toBe(true)
    const actions = Object.fromEntries(connector.actions.map((a) => [a.type, a]))
    expect(Object.keys(actions)).toEqual(['runQuery', 'selectRows', 'insertRow', 'updateRows', 'listTables', 'describeTable'])
    expect(actions.selectRows?.idempotent).toBe(true)
    expect(actions.listTables?.idempotent).toBe(true)
    expect(actions.describeTable?.idempotent).toBe(true)
    expect(actions.runQuery?.idempotent).toBe(false)
    expect(actions.selectRows?.sample).toEqual({ table: 'pg_catalog.pg_tables', limit: '1' })
    expect(actions.describeTable?.sample).toEqual({ table: 'pg_catalog.pg_tables' })
    expect(actions.listTables?.sample).toEqual({ schema: 'public' })
  })

  it('parses the connection string before any socket opens', async () => {
    const real = createConnectorHarness(createPostgresConnector(), { config: { connectionString: 'mock-connectionString' } })
    await expect(real.execute('listTables')).rejects.toThrow(/libpq URI/)
  })

  it('requires DATABASE_URL', async () => {
    const { harness } = fake()
    await expect(harness({}).execute('listTables')).rejects.toThrow('DATABASE_URL is required')
  })

  it('closes the connection whether the query succeeds or fails, ignoring a failed close', async () => {
    const f = fake([new Error('boom'), result(['one'], [{ one: 1 }])])
    f.end.mockRejectedValueOnce(new Error('already gone'))
    const harness = f.harness({ connectionString: DSN })
    await expect(harness.execute('runQuery', { sql: 'SELECT 1' })).rejects.toThrow('boom')
    await expect(harness.execute('runQuery', { sql: 'SELECT 1' })).resolves.toMatchObject({ rowCount: 1 })
    expect(f.end).toHaveBeenCalledTimes(2)
    expect(f.open).toHaveBeenCalledWith(DSN)
  })
})

describe('newRows', () => {
  const config = { connectionString: DSN, table: 'orders', orderingColumn: 'created_at', keyColumn: 'id' }

  it('reads the newest page first and starts tracking there', async () => {
    const f = fake([
      result(ORDERS, [
        { id: 3, reference: 'C', created_at: at('2026-09-04T12:00:02Z') },
        { id: 2, reference: 'B', created_at: at('2026-09-04T12:00:01Z') },
        { id: 1, reference: 'A', created_at: at('2026-09-04T12:00:00Z') }
      ])
    ])
    const page = await f.harness({ ...config, titleColumn: 'reference' }).poll('newRows', { limit: 3 })
    expect(f.calls[0]).toEqual({
      sql: 'SELECT * FROM "orders" ORDER BY "created_at" DESC, "id" DESC LIMIT $1',
      params: [3]
    })
    expect(page.items.map((item) => item.externalId)).toEqual(['1', '2', '3'])
    expect(page.items[0]).toMatchObject({
      title: 'A',
      updatedAt: '2026-09-04T12:00:00.000Z',
      id: 1,
      reference: 'A',
      created_at: at('2026-09-04T12:00:00Z')
    })
    expect(page.nextCursor).toBe('{"v":1,"o":"2026-09-04T12:00:02.000Z","k":"3"}')
    expect(page.hasMore).toBe(false)
  })

  it('continues after the cursor with a row-wise comparison and says when the page was full', async () => {
    const f = fake([
      result(ORDERS, [
        { id: 4, reference: 'D', created_at: at('2026-09-04T12:00:02Z') },
        { id: 5, reference: null, created_at: at('2026-09-04T12:00:03Z') }
      ])
    ])
    const page = await f.harness({ ...config, limit: '2' }).poll('newRows', {
      cursor: '{"v":1,"o":"2026-09-04T12:00:02.000Z","k":"3"}'
    })
    expect(f.calls[0]).toEqual({
      sql: 'SELECT * FROM "orders" WHERE ("created_at", "id") > ($1, $2) ORDER BY "created_at", "id" LIMIT $3',
      params: ['2026-09-04T12:00:02.000Z', '3', 2]
    })
    expect(page.items.map((item) => item.title)).toEqual(['orders 4', 'orders 5'])
    expect(page.nextCursor).toBe('{"v":1,"o":"2026-09-04T12:00:03.000Z","k":"5"}')
    expect(page.hasMore).toBe(true)
  })

  it('keeps the cursor when nothing is new', async () => {
    const f = fake([result(ORDERS, [])])
    const cursor = '{"v":1,"o":"2026-09-04T12:00:03.000Z","k":"5"}'
    expect(await f.harness(config).poll('newRows', { cursor })).toEqual({ items: [], nextCursor: cursor, hasMore: false })
    const fresh = fake([result(ORDERS, [])])
    expect(await fresh.harness(config).poll('newRows')).toEqual({ items: [], hasMore: false })
  })

  it('starts after startFrom on the first poll, with the ordering column as the key by default', async () => {
    const f = fake([result(['id'], [{ id: 11 }])])
    const page = await f.harness({ connectionString: DSN, table: 'sales.orders', orderingColumn: 'id', startFrom: '10' }).poll('newRows')
    expect(f.calls[0]).toEqual({ sql: 'SELECT * FROM "sales"."orders" WHERE "id" > $1 ORDER BY "id" LIMIT $2', params: ['10', 100] })
    expect(page.items[0]).toMatchObject({ externalId: '11', title: 'sales.orders 11', id: 11 })
    expect(page.nextCursor).toBe('{"v":1,"o":"11","k":"11"}')
  })

  it('delivers nothing twice across a drain', async () => {
    const f = fake([
      result(['id'], [{ id: 2 }, { id: 1 }]),
      result(['id'], [{ id: 3 }, { id: 4 }]),
      result(['id'], [])
    ])
    const harness = f.harness({ connectionString: DSN, table: 't', orderingColumn: 'id', limit: '2' })
    const first = await harness.poll('newRows')
    const second = await harness.poll('newRows', { cursor: first.nextCursor })
    const third = await harness.poll('newRows', { cursor: second.nextCursor })
    expect([...first.items, ...second.items, ...third.items].map((i) => i.externalId)).toEqual(['1', '2', '3', '4'])
    expect(f.calls[1]?.params).toEqual(['2', 2])
  })

  it('names a column that is missing or NULL', async () => {
    const missing = fake([result(['id'], [{ id: 1 }])])
    await expect(missing.harness(config).poll('newRows')).rejects.toThrow(/ordering column "created_at" is not among the columns returned: id/)
    const nullKey = fake([result(ORDERS, [{ id: null, reference: 'A', created_at: at('2026-09-04T12:00:00Z') }])])
    await expect(nullKey.harness(config).poll('newRows')).rejects.toThrow(/key column "id" is NULL/)
    const nullOrd = fake([result(ORDERS, [{ id: 1, reference: 'A', created_at: null }])])
    await expect(nullOrd.harness(config).poll('newRows')).rejects.toThrow(/ordering column "created_at" is NULL/)
  })

  it('refuses a cursor it did not write', async () => {
    const f = fake()
    await expect(f.harness(config).poll('newRows', { cursor: 'not json' })).rejects.toThrow(/not JSON/)
    await expect(f.harness(config).poll('newRows', { cursor: '{"v":2}' })).rejects.toThrow(/not one this connector wrote/)
    await expect(f.harness(config).poll('newRows', { cursor: '{"v":1,"o":"x"}' })).rejects.toThrow(/incomplete/)
  })

  it('requires the table and ordering column', async () => {
    const f = fake()
    await expect(f.harness({ connectionString: DSN }).poll('newRows')).rejects.toThrow('PG_TABLE is required')
    await expect(f.harness({ connectionString: DSN, table: 't' }).poll('newRows')).rejects.toThrow('PG_ORDERING_COLUMN is required')
  })
})

describe('queryRows', () => {
  const TICKETS = ['id', 'title', 'updated_at']
  const config = {
    connectionString: DSN,
    query: 'SELECT id, title, updated_at FROM tickets WHERE updated_at >= $1 ORDER BY updated_at LIMIT $2',
    cursorColumn: 'updated_at',
    keyColumn: 'id',
    titleColumn: 'title',
    startFrom: '2026-01-01'
  }

  it('binds startFrom and the limit on the first poll and remembers the ties at the cursor', async () => {
    const f = fake([
      result(TICKETS, [
        { id: 1, title: 'One', updated_at: at('2026-09-04T09:00:00Z') },
        { id: 2, title: 'Two', updated_at: at('2026-09-04T09:30:00Z') },
        { id: 3, title: 'Three', updated_at: at('2026-09-04T09:30:00Z') }
      ])
    ])
    const page = await f.harness(config).poll('queryRows', { limit: 3 })
    expect(f.calls[0]?.params).toEqual(['2026-01-01', 3])
    expect(page.items.map((item) => item.title)).toEqual(['One', 'Two', 'Three'])
    expect(page.items[1]).toMatchObject({ externalId: '2', updatedAt: '2026-09-04T09:30:00.000Z' })
    expect(page.nextCursor).toBe('{"v":1,"c":"2026-09-04T09:30:00.000Z","keys":["2","3"]}')
    expect(page.hasMore).toBe(true)
  })

  it('drops the rows already delivered at the cursor value and keeps the rest', async () => {
    const f = fake([
      result(TICKETS, [
        { id: 2, title: 'Two', updated_at: at('2026-09-04T09:30:00Z') },
        { id: 3, title: 'Three', updated_at: at('2026-09-04T09:30:00Z') },
        { id: 4, title: 'Four', updated_at: at('2026-09-04T09:30:00Z') },
        { id: 5, title: 'Five', updated_at: at('2026-09-04T10:00:00Z') }
      ])
    ])
    const page = await f.harness(config).poll('queryRows', {
      cursor: '{"v":1,"c":"2026-09-04T09:30:00.000Z","keys":["2","3"]}',
      limit: 10
    })
    expect(f.calls[0]?.params).toEqual(['2026-09-04T09:30:00.000Z', 10])
    expect(page.items.map((item) => item.externalId)).toEqual(['4', '5'])
    expect(page.nextCursor).toBe('{"v":1,"c":"2026-09-04T10:00:00.000Z","keys":["5"]}')
    expect(page.hasMore).toBe(false)
  })

  it('keeps the cursor and its keys when only known rows come back', async () => {
    const f = fake([result(TICKETS, [{ id: 2, title: 'Two', updated_at: at('2026-09-04T09:30:00Z') }])])
    const cursor = '{"v":1,"c":"2026-09-04T09:30:00.000Z","keys":["2"]}'
    const page = await f.harness(config).poll('queryRows', { cursor })
    expect(page.items).toEqual([])
    expect(page.nextCursor).toBe(cursor)
  })

  it('binds only $1 when the query has no $2, and never reports more pages', async () => {
    const f = fake([result(['id', 'n'], [{ id: 1, n: 5 }, { id: 2, n: 5 }])])
    const page = await f
      .harness({ ...config, titleColumn: '', query: 'SELECT id, n FROM t WHERE n >= $1 ORDER BY n', cursorColumn: 'n', startFrom: '0', limit: '2' })
      .poll('queryRows')
    expect(f.calls[0]?.params).toEqual(['0'])
    expect(page.items.map((item) => item.title)).toEqual(['id 1', 'id 2'])
    expect(page.nextCursor).toBe('{"v":1,"c":"5","keys":["1","2"]}')
    expect(page.hasMore).toBe(false)
  })

  it('requires a start value, the query and its columns', async () => {
    const f = fake()
    const { startFrom: _omitted, ...withoutStart } = config
    await expect(f.harness(withoutStart).poll('queryRows')).rejects.toThrow('PG_START_FROM is required')
    await expect(f.harness({ connectionString: DSN }).poll('queryRows')).rejects.toThrow('PG_QUERY is required')
    await expect(f.harness({ connectionString: DSN, query: 'x' }).poll('queryRows')).rejects.toThrow('PG_CURSOR_COLUMN is required')
    await expect(f.harness({ connectionString: DSN, query: 'x', cursorColumn: 'c' }).poll('queryRows')).rejects.toThrow('PG_KEY_COLUMN is required')
  })

  it('names a missing or NULL cursor or key column', async () => {
    const missing = fake([result(['id'], [{ id: 1 }])])
    await expect(missing.harness(config).poll('queryRows')).rejects.toThrow(/cursor column "updated_at" is not among/)
    const nullCursor = fake([result(TICKETS, [{ id: 1, title: 'One', updated_at: null }])])
    await expect(nullCursor.harness(config).poll('queryRows')).rejects.toThrow(/cursor column "updated_at" is NULL/)
    const nullKey = fake([result(TICKETS, [{ id: null, title: 'One', updated_at: at('2026-09-04T09:00:00Z') }])])
    await expect(nullKey.harness(config).poll('queryRows')).rejects.toThrow(/key column "id" is NULL/)
    await expect(fake().harness(config).poll('queryRows', { cursor: '{"v":1,"c":"x"}' })).rejects.toThrow(/incomplete/)
  })

  it('builds a cursor from a json column without stringifying it as an object', async () => {
    const f = fake([result(['id', 'at'], [{ id: 1, at: { seq: 7 } }])])
    const page = await f
      .harness({ ...config, query: 'SELECT id, at FROM t WHERE at >= $1', cursorColumn: 'at', startFrom: '{}' })
      .poll('queryRows')
    expect(page.nextCursor).toBe('{"v":1,"c":"{\\"seq\\":7}","keys":["1"]}')
  })
})

describe('actions', () => {
  const config = { connectionString: DSN }

  it('runQuery returns the driver rows, the count and the command', async () => {
    const f = fake([
      result(['one', 'ok', 'doc'], [{ one: 1, ok: true, doc: { a: 1 } }]),
      result([], [], 'UPDATE', 4)
    ])
    const harness = f.harness(config)
    expect(await harness.execute('runQuery', { sql: 'SELECT 1 AS one' })).toEqual({
      rows: [{ one: 1, ok: true, doc: { a: 1 } }],
      rowCount: 1,
      command: 'SELECT'
    })
    expect(await harness.execute('runQuery', { sql: 'UPDATE t SET a = $1', params: '[2]' })).toEqual({
      rows: [],
      rowCount: 4,
      command: 'UPDATE'
    })
    expect(f.calls[1]).toEqual({ sql: 'UPDATE t SET a = $1', params: [2] })
    await expect(harness.execute('runQuery', {})).rejects.toThrow(/requires "sql"/)
    await expect(harness.execute('runQuery', { sql: 'SELECT 1', params: '{' })).rejects.toThrow(/Expected JSON/)
  })

  it('runQuery answers with the last result set when the text held several statements', async () => {
    const f = fake([[result(['a'], [{ a: 1 }]), result(['b'], [{ b: 2 }], 'SELECT', 1)]])
    expect(await f.harness(config).execute('runQuery', { sql: 'SELECT 1 AS a; SELECT 2 AS b' })).toEqual({
      rows: [{ b: 2 }],
      rowCount: 1,
      command: 'SELECT'
    })
  })

  it('selectRows builds the statement and clamps the limit', async () => {
    const f = fake([result(['id'], [{ id: 1 }]), result(['id'], [])])
    const harness = f.harness(config)
    expect(await harness.execute('selectRows', { table: 'orders', where: 'status = $1', params: '["new"]', orderBy: 'id', limit: '5000' })).toEqual({
      rows: [{ id: 1 }],
      rowCount: 1
    })
    expect(f.calls[0]).toEqual({ sql: 'SELECT * FROM "orders" WHERE status = $1 ORDER BY "id" LIMIT $2', params: ['new', 1000] })
    await harness.execute('selectRows', { table: 'pg_catalog.pg_tables', limit: '1' })
    expect(f.calls[1]).toEqual({ sql: 'SELECT * FROM "pg_catalog"."pg_tables" LIMIT $1', params: [1] })
    await expect(harness.execute('selectRows', {})).rejects.toThrow(/requires "table"/)
  })

  it('insertRow returns the row RETURNING * gave back', async () => {
    const f = fake([result(['id', 'ref'], [{ id: 9, ref: 'A-9' }], 'INSERT', 1), result([], [], 'INSERT', 0)])
    const harness = f.harness(config)
    expect(await harness.execute('insertRow', { table: 'orders', values: '{"ref":"A-9"}' })).toEqual({
      row: { id: 9, ref: 'A-9' },
      rowCount: 1
    })
    expect(f.calls[0]).toEqual({ sql: 'INSERT INTO "orders" ("ref") VALUES ($1) RETURNING *', params: ['A-9'] })
    expect(await harness.execute('insertRow', { table: 'orders', values: {} })).toEqual({ row: null, rowCount: 0 })
    await expect(harness.execute('insertRow', { values: '{}' })).rejects.toThrow(/requires "table"/)
    await expect(harness.execute('insertRow', { table: 'orders' })).rejects.toThrow(/requires "values"/)
  })

  it('updateRows returns the count and insists on a where', async () => {
    const f = fake([result([], [], 'UPDATE', 2)])
    const harness = f.harness(config)
    expect(await harness.execute('updateRows', { table: 'orders', set: '{"status":"done"}', where: 'id = $1', params: '[7]' })).toEqual({
      rowCount: 2
    })
    expect(f.calls[0]).toEqual({ sql: 'UPDATE "orders" SET "status" = $2 WHERE id = $1', params: [7, 'done'] })
    await expect(harness.execute('updateRows', { table: 'orders', set: '{"a":1}' })).rejects.toThrow(/requires "where"/)
    await expect(harness.execute('updateRows', { set: '{"a":1}', where: 'true' })).rejects.toThrow(/requires "table"/)
  })

  it('listTables reads information_schema.tables for the schema', async () => {
    const f = fake([
      result(
        ['table_schema', 'table_name', 'table_type'],
        [
          { table_schema: 'public', table_name: 'orders', table_type: 'BASE TABLE' },
          { table_schema: 'public', table_name: 'v', table_type: 'VIEW' }
        ]
      )
    ])
    const harness = f.harness(config)
    expect(await harness.execute('listTables', {})).toEqual({
      tables: [
        { schema: 'public', name: 'orders', type: 'BASE TABLE' },
        { schema: 'public', name: 'v', type: 'VIEW' }
      ],
      count: 2
    })
    expect(f.calls[0]?.params).toEqual(['public'])
    expect(f.calls[0]?.sql).toContain('information_schema.tables')
  })

  it('describeTable reads information_schema.columns and refuses an empty answer', async () => {
    const COLUMNS = ['column_name', 'data_type', 'udt_name', 'is_nullable', 'column_default', 'ordinal_position']
    const f = fake([
      result(COLUMNS, [
        // ordinal_position is the cardinal_number domain, which has no parser of its own, so it arrives as text.
        { column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: "nextval('orders_id_seq')", ordinal_position: '1' },
        { column_name: 'tags', data_type: 'ARRAY', udt_name: '_text', is_nullable: 'YES', column_default: null, ordinal_position: '2' }
      ]),
      result(COLUMNS, [])
    ])
    const harness = f.harness(config)
    expect(await harness.execute('describeTable', { table: 'orders' })).toEqual({
      columns: [
        { name: 'id', type: 'integer', udtName: 'int4', nullable: false, default: "nextval('orders_id_seq')", position: 1 },
        { name: 'tags', type: 'ARRAY', udtName: '_text', nullable: true, default: null, position: 2 }
      ],
      count: 2
    })
    expect(f.calls[0]?.params).toEqual(['public', 'orders'])
    await expect(harness.execute('describeTable', { table: 'pg_catalog.nope' })).rejects.toThrow('no such table as pg_catalog.nope, or no privilege on it')
    expect(f.calls[1]?.params).toEqual(['pg_catalog', 'nope'])
    await expect(harness.execute('describeTable', {})).rejects.toThrow(/requires "table"/)
  })
})
