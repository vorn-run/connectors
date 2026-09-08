import { createConnectorHarness } from '@vornrun/connector-sdk'
import { describe, expect, it, vi } from 'vitest'
import { createMysqlConnector } from './connector'
import type { DriverResult, ResultHeader, SqlPool } from './driver'
import type { Row } from './sql'

const DSN = 'mysql://alice:pencil@db.example.com:3306/app'

/** `[rows, fields]` as the driver resolves a read. */
const rows = (list: Row[]): DriverResult => [list, list[0] ? Object.keys(list[0]).map((name) => ({ name })) : []]
/** `[header]` as the driver resolves a write. */
const header = (h: ResultHeader): DriverResult => [h]

type Answer = DriverResult | Error

/** A pool that answers each statement from a script and records what it was asked. */
function fake(answers: Answer[] = []) {
  const calls: Array<{ method: 'query' | 'execute'; sql: string; params?: unknown[] }> = []
  const queue = [...answers]
  const answer = async (method: 'query' | 'execute', sql: string, params?: unknown[]): Promise<DriverResult> => {
    calls.push({ method, sql, ...(params !== undefined && { params: params.map((p) => (typeof p === 'object' && p !== null && 'value' in p ? Number(p.value) : p)) }) })
    const next = queue.shift()
    if (next === undefined) throw new Error(`no scripted answer for: ${sql}`)
    if (next instanceof Error) throw next
    return next
  }
  const pool: SqlPool = {
    query: (sql, params) => answer('query', sql, params),
    execute: (sql, params) => answer('execute', sql, params),
    end: vi.fn(async () => {}),
    on: vi.fn()
  }
  const openPool = vi.fn(() => pool)
  const connector = createMysqlConnector({ version: '0.1.0', openPool })
  /** The trigger's own answer, before the harness rewrites a zone-less updatedAt into the machine's zone. */
  const raw = (type: string, config: Record<string, string>, options: { cursor?: string; limit?: number } = {}) =>
    connector.triggers.find((t) => t.type === type)!.poll!({ config, ...options, now: () => '2026-09-06T00:00:00Z', fetch })
  return { connector, pool, openPool, calls, raw, harness: (config: Record<string, string>) => createConnectorHarness(connector, { config }) }
}

describe('definition', () => {
  const { connector } = fake()

  it('signs in with the connection URL, kept secret, and draws its own mark', () => {
    expect(connector.auth).toEqual({ rung: 'key', keys: ['connectionString'] })
    expect(connector.config.find((entry) => entry.key === 'connectionString')).toMatchObject({ env: 'MYSQL_URL', secret: true, required: true })
    expect(connector.config.find((entry) => entry.key === 'ssl')?.description).toContain('disabled, required, verify-full')
    expect(connector.version).toBe('0.1.0')
    expect(connector.id).toBe('mysql')
    expect(connector.icon?.paths).toHaveLength(3)
  })

  it('offers two poll triggers and eight actions, the reads idempotent with samples', () => {
    expect(connector.triggers.map((t) => t.type)).toEqual(['newRows', 'updatedRows'])
    expect(connector.triggers.every((t) => typeof t.poll === 'function' && t.sample === undefined)).toBe(true)
    const actions = Object.fromEntries(connector.actions.map((a) => [a.type, a]))
    expect(Object.keys(actions)).toEqual(['runQuery', 'selectRows', 'insertRow', 'updateRows', 'deleteRows', 'listTables', 'describeTable', 'countRows'])
    for (const type of ['selectRows', 'listTables', 'describeTable', 'countRows']) {
      expect(actions[type]?.idempotent, type).toBe(true)
      expect(actions[type]?.sample, type).toBeDefined()
    }
    for (const type of ['runQuery', 'insertRow', 'updateRows', 'deleteRows']) expect(actions[type]?.idempotent, type).toBe(false)
    expect(connector.actions.every((a) => a.inputs?.every((i) => i.description))).toBe(true)
  })

  it('parses the connection URL before any socket opens', async () => {
    const real = createConnectorHarness(createMysqlConnector(), { config: { connectionString: 'mock-connectionString' } })
    await expect(real.execute('listTables')).rejects.toThrow(/starting with mysql:\/\//)
  })

  it('requires MYSQL_URL and refuses an unknown ssl setting', async () => {
    const { harness } = fake()
    await expect(harness({}).execute('listTables')).rejects.toThrow('MYSQL_URL is required')
    await expect(harness({ connectionString: DSN, ssl: 'maybe' }).execute('listTables')).rejects.toThrow(/ssl must be one of/)
  })

  it('opens one pool per connection, reuses it, and ends it on closePools', async () => {
    const f = fake([rows([{ ok: 1 }]), rows([{ ok: 1 }])])
    const harness = f.harness({ connectionString: DSN })
    await harness.execute('runQuery', { sql: 'SELECT 1 AS ok' })
    await harness.execute('runQuery', { sql: 'SELECT 1 AS ok' })
    expect(f.openPool).toHaveBeenCalledTimes(1)
    expect(f.openPool).toHaveBeenCalledWith(expect.objectContaining({ host: 'db.example.com', user: 'alice', database: 'app' }))
    await f.connector.closePools()
    expect(f.pool.end).toHaveBeenCalledTimes(1)
  })
})

describe('newRows', () => {
  const config = { connectionString: DSN, table: 'orders', orderingColumn: 'created_at', keyColumn: 'id' }

  it('reads the newest page first, reversed, and starts tracking there', async () => {
    const f = fake([
      rows([
        { id: 3, reference: 'C', created_at: '2026-09-04 12:00:02' },
        { id: 2, reference: 'B', created_at: '2026-09-04 12:00:01' },
        { id: 1, reference: 'A', created_at: '2026-09-04 12:00:00' }
      ])
    ])
    const page = await f.raw('newRows', { ...config, titleColumn: 'reference' }, { limit: 3 })
    expect(f.calls[0]).toEqual({ method: 'execute', sql: 'SELECT * FROM `orders` ORDER BY `created_at` DESC, `id` DESC LIMIT ?', params: [3] })
    expect(page.items.map((item) => item.externalId)).toEqual(['1', '2', '3'])
    expect(page.items[0]).toEqual({
      externalId: '1',
      title: 'A',
      updatedAt: '2026-09-04T12:00:00',
      data: { id: 1, reference: 'A', created_at: '2026-09-04 12:00:00' }
    })
    expect(page.nextCursor).toBe('{"v":1,"o":"2026-09-04 12:00:02","k":3}')
    expect(page.hasMore).toBe(false)
  })

  it('continues after the cursor with the row-wise comparison and the where, and says when the page was full', async () => {
    const f = fake([rows([{ id: 4, reference: 'D', created_at: '2026-09-04 12:00:02' }, { id: 5, reference: null, created_at: '2026-09-04 12:00:03' }])])
    const page = await f.harness({ ...config, limit: '2', where: "status = 'new'" }).poll('newRows', { cursor: '{"v":1,"o":"2026-09-04 12:00:02","k":3}' })
    expect(f.calls[0]).toEqual({
      method: 'execute',
      sql: "SELECT * FROM `orders` WHERE (`created_at` > ? OR (`created_at` = ? AND `id` > ?)) AND (status = 'new') ORDER BY `created_at`, `id` LIMIT ?",
      params: ['2026-09-04 12:00:02', '2026-09-04 12:00:02', 3, 2]
    })
    expect(page.items.map((item) => item.title)).toEqual(['orders 4', 'orders 5'])
    expect(page.nextCursor).toBe('{"v":1,"o":"2026-09-04 12:00:03","k":5}')
    expect(page.hasMore).toBe(true)
  })

  it('keeps the cursor when nothing is new', async () => {
    const f = fake([rows([])])
    const cursor = '{"v":1,"o":"2026-09-04 12:00:03","k":5}'
    expect(await f.harness(config).poll('newRows', { cursor })).toEqual({ items: [], nextCursor: cursor, hasMore: false })
    const fresh = fake([rows([])])
    expect(await fresh.harness(config).poll('newRows')).toEqual({ items: [], hasMore: false })
  })

  it('starts after startFrom on the first poll, with the ordering column as the key by default', async () => {
    const f = fake([rows([{ id: 11 }])])
    const page = await f.raw('newRows', { connectionString: DSN, table: 'shop.orders', orderingColumn: 'id', startFrom: '10' })
    expect(f.calls[0]).toEqual({ method: 'execute', sql: 'SELECT * FROM `shop`.`orders` WHERE `id` > ? ORDER BY `id` LIMIT ?', params: ['10', 100] })
    expect(page.items[0]).toEqual({ externalId: '11', title: 'shop.orders 11', data: { id: 11 } })
    expect(page.nextCursor).toBe('{"v":1,"o":11,"k":11}')
  })

  it('delivers nothing twice across a drain and clamps the page size', async () => {
    const f = fake([rows([{ id: 2 }, { id: 1 }]), rows([{ id: 3 }, { id: 4 }]), rows([])])
    const harness = f.harness({ connectionString: DSN, table: 't', orderingColumn: 'id', limit: '2' })
    const first = await harness.poll('newRows')
    const second = await harness.poll('newRows', { cursor: first.nextCursor })
    const third = await harness.poll('newRows', { cursor: second.nextCursor })
    expect([...first.items, ...second.items, ...third.items].map((i) => i.externalId)).toEqual(['1', '2', '3', '4'])
    expect(f.calls[1]?.params).toEqual([2, 2])
    const big = fake([rows([])])
    await big.harness({ connectionString: DSN, table: 't', orderingColumn: 'id', limit: '5000' }).poll('newRows')
    expect(big.calls[0]?.params).toEqual([1000])
  })

  it('names a column that is NULL or absent', async () => {
    const nullKey = fake([rows([{ id: null, created_at: '2026-09-04 12:00:00' }])])
    await expect(nullKey.harness(config).poll('newRows')).rejects.toThrow(/key column "id" is NULL/)
    const nullOrd = fake([rows([{ id: 1, created_at: null }])])
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
    await expect(f.harness({ connectionString: DSN }).poll('newRows')).rejects.toThrow('MYSQL_TABLE is required')
    await expect(f.harness({ connectionString: DSN, table: 't' }).poll('newRows')).rejects.toThrow('MYSQL_ORDERING_COLUMN is required')
  })
})

describe('updatedRows', () => {
  const config = { connectionString: DSN, table: 'tickets', updatedAtColumn: 'updated_at', keyColumn: 'id', titleColumn: 'title' }

  it('reads the newest page first, reversed, and remembers the keys at the newest value', async () => {
    const f = fake([
      rows([
        { id: 3, title: 'Three', updated_at: '2026-09-04 09:30:00' },
        { id: 2, title: 'Two', updated_at: '2026-09-04 09:30:00' },
        { id: 1, title: 'One', updated_at: '2026-09-04 09:00:00' }
      ])
    ])
    const page = await f.raw('updatedRows', config, { limit: 3 })
    expect(f.calls[0]).toEqual({ method: 'execute', sql: 'SELECT * FROM `tickets` ORDER BY `updated_at` DESC, `id` DESC LIMIT ?', params: [3] })
    expect(page.items.map((item) => item.externalId)).toEqual(['1@2026-09-04 09:00:00', '2@2026-09-04 09:30:00', '3@2026-09-04 09:30:00'])
    expect(page.items[1]).toMatchObject({ title: 'Two', updatedAt: '2026-09-04T09:30:00' })
    expect(page.nextCursor).toBe('{"v":1,"c":"2026-09-04 09:30:00","keys":["2","3"]}')
    expect(page.hasMore).toBe(false)
  })

  it('binds startFrom on the first poll and reports more when a full page spans several values', async () => {
    const f = fake([rows([{ id: 1, title: 'One', updated_at: '2026-09-04 09:00:00' }, { id: 2, title: 'Two', updated_at: '2026-09-04 09:30:00' }])])
    const page = await f.harness({ ...config, startFrom: '2026-01-01', where: 'open = 1' }).poll('updatedRows', { limit: 2 })
    expect(f.calls[0]).toEqual({
      method: 'execute',
      sql: 'SELECT * FROM `tickets` WHERE `updated_at` >= ? AND (open = 1) ORDER BY `updated_at`, `id` LIMIT ?',
      params: ['2026-01-01', 2]
    })
    expect(page.items.map((item) => item.title)).toEqual(['One', 'Two'])
    expect(page.nextCursor).toBe('{"v":1,"c":"2026-09-04 09:30:00","keys":["2"]}')
    expect(page.hasMore).toBe(true)
  })

  it('asks the server to leave out the rows already delivered at the cursor value and keeps the rest', async () => {
    const f = fake([
      rows([
        { id: 4, title: 'Four', updated_at: '2026-09-04 09:30:00' },
        { id: 5, title: 'Five', updated_at: '2026-09-04 10:00:00' }
      ])
    ])
    const page = await f.harness(config).poll('updatedRows', { cursor: '{"v":1,"c":"2026-09-04 09:30:00","keys":["2","3"]}', limit: 10 })
    expect(f.calls[0]).toEqual({
      method: 'execute',
      sql:
        'SELECT * FROM `tickets` WHERE `updated_at` >= ? AND NOT (`updated_at` = ? AND `id` IN (?, ?)) ' +
        'ORDER BY `updated_at`, `id` LIMIT ?',
      params: ['2026-09-04 09:30:00', '2026-09-04 09:30:00', '2', '3', 10]
    })
    expect(page.items.map((item) => item.externalId)).toEqual(['4@2026-09-04 09:30:00', '5@2026-09-04 10:00:00'])
    expect(page.nextCursor).toBe('{"v":1,"c":"2026-09-04 10:00:00","keys":["5"]}')
    expect(page.hasMore).toBe(false)
  })

  it('keeps the cursor and its keys when nothing new comes back, and a full page of ties still advances', async () => {
    const known = fake([rows([])])
    const cursor = '{"v":1,"c":"2026-09-04 09:30:00","keys":["2"]}'
    const page = await known.harness(config).poll('updatedRows', { cursor })
    expect(page.items).toEqual([])
    expect(page.nextCursor).toBe(cursor)
    const ties = fake([rows([{ id: 6, title: 'Six', updated_at: '2026-09-04 09:30:00' }, { id: 7, title: 'Seven', updated_at: '2026-09-04 09:30:00' }])])
    const tied = await ties.harness(config).poll('updatedRows', { cursor, limit: 2 })
    expect(tied.items.map((item) => item.externalId)).toEqual(['6@2026-09-04 09:30:00', '7@2026-09-04 09:30:00'])
    expect(tied.nextCursor).toBe('{"v":1,"c":"2026-09-04 09:30:00","keys":["2","6","7"]}')
    expect(tied.hasMore).toBe(true)
  })

  it('answers an empty first page without a cursor', async () => {
    const f = fake([rows([])])
    expect(await f.harness(config).poll('updatedRows')).toEqual({ items: [], hasMore: false })
  })

  it('requires the table, the updated-at column and the key column, and refuses a bad cursor', async () => {
    const f = fake()
    await expect(f.harness({ connectionString: DSN }).poll('updatedRows')).rejects.toThrow('MYSQL_TABLE is required')
    await expect(f.harness({ connectionString: DSN, table: 't' }).poll('updatedRows')).rejects.toThrow('MYSQL_UPDATED_AT_COLUMN is required')
    await expect(f.harness({ connectionString: DSN, table: 't', updatedAtColumn: 'u' }).poll('updatedRows')).rejects.toThrow('MYSQL_KEY_COLUMN is required')
    await expect(f.harness(config).poll('updatedRows', { cursor: '{"v":1,"c":"x"}' })).rejects.toThrow(/incomplete/)
  })

  it('names a NULL key or updated-at column', async () => {
    const nullKey = fake([rows([{ id: null, title: 'One', updated_at: '2026-09-04 09:00:00' }])])
    await expect(nullKey.harness(config).poll('updatedRows')).rejects.toThrow(/key column "id" is NULL/)
    const nullAt = fake([rows([{ id: 1, title: 'One', updated_at: null }])])
    await expect(nullAt.harness(config).poll('updatedRows')).rejects.toThrow(/updated-at column "updated_at" is NULL/)
    const json = fake([rows([{ id: { n: 1 }, title: 'One', updated_at: '2026-09-04 09:00:00' }])])
    expect((await json.harness(config).poll('updatedRows')).items[0]?.externalId).toBe('{"n":1}@2026-09-04 09:00:00')
  })
})

describe('actions', () => {
  const config = { connectionString: DSN }

  it('runQuery uses query without params and execute with them, and reports both result shapes', async () => {
    const f = fake([rows([{ ok: 1, doc: { a: 1 } }]), header({ affectedRows: 4, insertId: 0, warningStatus: 1, info: 'Rows matched: 4' })])
    const harness = f.harness(config)
    expect(await harness.execute('runQuery', { sql: 'SELECT 1 AS ok' })).toEqual({
      rows: [{ ok: 1, doc: { a: 1 } }],
      rowCount: 1,
      affectedRows: 0,
      insertId: 0,
      warningStatus: 0
    })
    expect(await harness.execute('runQuery', { sql: 'UPDATE t SET a = ?', params: '[2]' })).toEqual({
      rows: [],
      rowCount: 4,
      affectedRows: 4,
      insertId: 0,
      warningStatus: 1
    })
    expect(f.calls).toEqual([
      { method: 'query', sql: 'SELECT 1 AS ok' },
      { method: 'execute', sql: 'UPDATE t SET a = ?', params: [2] }
    ])
    await expect(harness.execute('runQuery', {})).rejects.toThrow(/requires "sql"/)
    await expect(harness.execute('runQuery', { sql: 'SELECT 1', params: '{' })).rejects.toThrow(/Expected JSON/)
  })

  it('surfaces a driver error as it is', async () => {
    const f = fake([new Error("Unknown column 'nope' in 'field list'")])
    await expect(f.harness(config).execute('runQuery', { sql: 'SELECT nope' })).rejects.toThrow(/Unknown column/)
  })

  it('selectRows builds the statement, validates the columns and clamps the limit', async () => {
    const f = fake([rows([{ id: 1 }]), rows([]), rows([])])
    const harness = f.harness(config)
    expect(
      await harness.execute('selectRows', { table: 'orders', columns: '["id","ref"]', where: 'status = ?', params: '["new"]', orderBy: 'id', descending: true, limit: '5000' })
    ).toEqual({ rows: [{ id: 1 }], rowCount: 1 })
    expect(f.calls[0]).toEqual({
      method: 'execute',
      sql: 'SELECT `id`, `ref` FROM `orders` WHERE status = ? ORDER BY `id` DESC LIMIT ?',
      params: ['new', 1000]
    })
    await harness.execute('selectRows', { table: 'information_schema.TABLES', limit: '1' })
    expect(f.calls[1]).toEqual({ method: 'execute', sql: 'SELECT * FROM `information_schema`.`TABLES` LIMIT ?', params: [1] })
    await harness.execute('selectRows', { table: 'orders', columns: '[]', descending: 'false' })
    expect(f.calls[2]?.sql).toBe('SELECT * FROM `orders` LIMIT ?')
    await expect(harness.execute('selectRows', {})).rejects.toThrow(/requires "table"/)
    await expect(harness.execute('selectRows', { table: 'orders', columns: '[""]' })).rejects.toThrow(/columns entry is required/)
    await expect(harness.execute('selectRows', { table: 'orders', columns: '{}' })).rejects.toThrow(/columns must be a JSON array/)
    await expect(harness.execute('selectRows', { table: 'orders; drop' })).rejects.toThrow(/may only hold/)
  })

  it('insertRow returns the insert id and stringifies a JSON value', async () => {
    const f = fake([header({ affectedRows: 1, insertId: 9 })])
    const harness = f.harness(config)
    expect(await harness.execute('insertRow', { table: 'orders', values: '{"ref":"A-9","meta":{"a":1}}' })).toEqual({ insertId: 9, affectedRows: 1 })
    expect(f.calls[0]).toEqual({ method: 'execute', sql: 'INSERT INTO `orders` (`ref`, `meta`) VALUES (?, ?)', params: ['A-9', '{"a":1}'] })
    await expect(harness.execute('insertRow', { table: 'orders', values: {} })).rejects.toThrow(/at least one column/)
    await expect(harness.execute('insertRow', { values: '{}' })).rejects.toThrow(/requires "table"/)
    await expect(harness.execute('insertRow', { table: 'orders' })).rejects.toThrow(/requires "values"/)
  })

  it('updateRows returns the matched count and the info text, and insists on a where', async () => {
    const f = fake([header({ affectedRows: 2, info: 'Rows matched: 2  Changed: 1  Warnings: 0' })])
    const harness = f.harness(config)
    expect(await harness.execute('updateRows', { table: 'orders', values: '{"status":"done"}', where: 'id = ?', params: '[7]' })).toEqual({
      affectedRows: 2,
      info: 'Rows matched: 2  Changed: 1  Warnings: 0'
    })
    expect(f.calls[0]).toEqual({ method: 'execute', sql: 'UPDATE `orders` SET `status` = ? WHERE id = ?', params: ['done', 7] })
    await expect(harness.execute('updateRows', { table: 'orders', values: '{"a":1}' })).rejects.toThrow(/requires "where"/)
    await expect(harness.execute('updateRows', { values: '{"a":1}', where: '1' })).rejects.toThrow(/requires "table"/)
  })

  it('deleteRows returns the count and insists on a where', async () => {
    const f = fake([header({ affectedRows: 3 })])
    const harness = f.harness(config)
    expect(await harness.execute('deleteRows', { table: 'orders', where: 'id IN (?, ?)', params: '[1, 2]' })).toEqual({ affectedRows: 3 })
    expect(f.calls[0]).toEqual({ method: 'execute', sql: 'DELETE FROM `orders` WHERE id IN (?, ?)', params: [1, 2] })
    await expect(harness.execute('deleteRows', { table: 'orders' })).rejects.toThrow(/requires "where"/)
  })

  it('listTables reads information_schema.TABLES for the URL database or the one asked for', async () => {
    const f = fake([
      rows([
        { TABLE_NAME: 'orders', TABLE_TYPE: 'BASE TABLE', ENGINE: 'InnoDB', TABLE_ROWS: 42 },
        { TABLE_NAME: 'v', TABLE_TYPE: 'VIEW', ENGINE: null, TABLE_ROWS: null }
      ]),
      rows([])
    ])
    const harness = f.harness(config)
    expect(await harness.execute('listTables', {})).toEqual({
      tables: [
        { name: 'orders', type: 'BASE TABLE', engine: 'InnoDB', rows: 42 },
        { name: 'v', type: 'VIEW', engine: null, rows: null }
      ],
      count: 2
    })
    expect(f.calls[0]).toMatchObject({ method: 'execute', params: ['app'] })
    expect(f.calls[0]?.sql).toContain('information_schema.TABLES')
    await harness.execute('listTables', { database: 'other' })
    expect(f.calls[1]?.params).toEqual(['other'])
    const bare = fake()
    await expect(bare.harness({ connectionString: 'mysql://alice@host' }).execute('listTables', {})).rejects.toThrow(/database is required/)
  })

  it('describeTable reads information_schema.COLUMNS and refuses an empty answer', async () => {
    const f = fake([
      rows([
        { COLUMN_NAME: 'id', COLUMN_TYPE: 'int unsigned', DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_KEY: 'PRI', COLUMN_DEFAULT: null, EXTRA: 'auto_increment', ORDINAL_POSITION: 1 },
        { COLUMN_NAME: 'note', COLUMN_TYPE: 'varchar(80)', DATA_TYPE: 'varchar', IS_NULLABLE: 'YES', COLUMN_KEY: '', COLUMN_DEFAULT: 'n/a', EXTRA: '', ORDINAL_POSITION: 2 }
      ]),
      rows([]),
      rows([{ COLUMN_NAME: 'x', ORDINAL_POSITION: '1' }])
    ])
    const harness = f.harness(config)
    expect(await harness.execute('describeTable', { table: 'orders' })).toEqual({
      columns: [
        { name: 'id', type: 'int unsigned', dataType: 'int', nullable: false, key: 'PRI', default: null, extra: 'auto_increment', position: 1 },
        { name: 'note', type: 'varchar(80)', dataType: 'varchar', nullable: true, key: '', default: 'n/a', extra: '', position: 2 }
      ],
      count: 2
    })
    expect(f.calls[0]?.params).toEqual(['app', 'orders'])
    await expect(harness.execute('describeTable', { table: 'shop.nope' })).rejects.toThrow('no such table as shop.nope, or no privilege on it')
    expect(f.calls[1]?.params).toEqual(['shop', 'nope'])
    expect((await harness.execute('describeTable', { table: 'shop.t' })).columns).toEqual([
      { name: 'x', type: undefined, dataType: undefined, nullable: false, key: '', default: null, extra: '', position: 1 }
    ])
    await expect(harness.execute('describeTable', {})).rejects.toThrow(/requires "table"/)
    const bare = fake()
    await expect(bare.harness({ connectionString: 'mysql://alice@host' }).execute('describeTable', { table: 't' })).rejects.toThrow(/db.table/)
  })

  it('countRows returns the count as a number', async () => {
    const f = fake([rows([{ count: 7 }]), rows([]), rows([{ count: '9007199254740993' }])])
    const harness = f.harness(config)
    expect(await harness.execute('countRows', { table: 'orders', where: 'status = ?', params: '["new"]' })).toEqual({ count: 7 })
    expect(f.calls[0]).toEqual({ method: 'execute', sql: 'SELECT COUNT(*) AS count FROM `orders` WHERE status = ?', params: ['new'] })
    expect(await harness.execute('countRows', { table: 'orders' })).toEqual({ count: 0 })
    expect(f.calls[1]).toEqual({ method: 'query', sql: 'SELECT COUNT(*) AS count FROM `orders`' })
    expect(await harness.execute('countRows', { table: 'orders' })).toEqual({ count: 9007199254740992 })
  })
})
