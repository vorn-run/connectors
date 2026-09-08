import { describe, expect, it, vi } from 'vitest'
import { parseConnectionString } from './connection-string'
import { clientFrom, normalize, openPool, poolOptions, PoolRegistry, refSocket, sslSetting, toParam, unrefSocket, type SqlPool } from './driver'
import { LimitParam } from './sql'

const options = (dsn: string, settings?: { ssl?: string; sslCa?: string }) => parseConnectionString(dsn, settings)
const BASE = 'mysql://alice:pencil@db.example.com:3307/app'

describe('sslSetting', () => {
  it('turns TLS off for disabled and skips verification for required', () => {
    expect(sslSetting(options(BASE))).toBe(false)
    expect(sslSetting(options(BASE, { ssl: 'required' }))).toEqual({ rejectUnauthorized: false })
  })

  it('verifies the chain and the host name for verify-full, reading the named CA bundle', () => {
    const readFile = vi.fn(() => Buffer.from('PEM'))
    expect(sslSetting(options(BASE, { ssl: 'verify-full', sslCa: '/tmp/ca.pem' }), readFile)).toEqual({
      rejectUnauthorized: true,
      verifyIdentity: true,
      ca: Buffer.from('PEM')
    })
    expect(readFile).toHaveBeenCalledWith('/tmp/ca.pem')
    expect(sslSetting(options(BASE, { ssl: 'verify-full' }), readFile)).toEqual({ rejectUnauthorized: true, verifyIdentity: true })
    expect(readFile).toHaveBeenCalledTimes(1)
  })
})

describe('poolOptions', () => {
  it('hands the driver the parts of the URL, never the string, with the row-shape options', () => {
    expect(poolOptions(options(BASE))).toEqual({
      host: 'db.example.com',
      port: 3307,
      user: 'alice',
      password: 'pencil',
      database: 'app',
      ssl: false,
      connectTimeout: 10000,
      connectionLimit: 2,
      maxIdle: 2,
      waitForConnections: true,
      queueLimit: 0,
      multipleStatements: false,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: false
    })
  })

  it('omits a password and database the URL did not carry', () => {
    const bare = poolOptions(options('mysql://alice@db.example.com'))
    expect('password' in bare).toBe(false)
    expect('database' in bare).toBe(false)
  })
})

describe('toParam', () => {
  it('sends undefined as NULL, an object or array as JSON, and a limit as a typed BIGINT', () => {
    expect(toParam(undefined)).toBeNull()
    expect(toParam(null)).toBeNull()
    expect(toParam({ a: 1 })).toBe('{"a":1}')
    expect(toParam([1, 2])).toBe('[1,2]')
    expect(toParam(new LimitParam(5))).toMatchObject({ value: 5n, type: expect.any(Number) })
  })

  it('passes a scalar or a Buffer through as it is', () => {
    expect(toParam('text')).toBe('text')
    expect(toParam(7)).toBe(7)
    expect(toParam(true)).toBe(true)
    const bytes = Buffer.from('ab')
    expect(toParam(bytes)).toBe(bytes)
  })
})

describe('normalize', () => {
  it('reads rows from a read and the counts from a write', () => {
    expect(normalize([[{ id: 1 }, { id: 2 }], [{ name: 'id' }]])).toEqual({
      rows: [{ id: 1 }, { id: 2 }],
      rowCount: 2,
      affectedRows: 0,
      insertId: 0,
      warningStatus: 0,
      info: ''
    })
    expect(normalize([{ affectedRows: 3, insertId: 9, warningStatus: 1, info: 'Rows matched: 3  Changed: 2  Warnings: 1' }])).toEqual({
      rows: [],
      rowCount: 3,
      affectedRows: 3,
      insertId: 9,
      warningStatus: 1,
      info: 'Rows matched: 3  Changed: 2  Warnings: 1'
    })
    expect(normalize([{}])).toMatchObject({ rows: [], rowCount: 0, affectedRows: 0, insertId: 0 })
  })
})

describe('clientFrom', () => {
  function fake() {
    const calls: Array<{ method: string; sql: string; params?: unknown[] }> = []
    const pool: SqlPool = {
      async query(sql, params) {
        calls.push({ method: 'query', sql, params })
        return [[{ ok: 1 }], []]
      },
      async execute(sql, params) {
        calls.push({ method: 'execute', sql, params })
        return [{ affectedRows: 1, insertId: 4 }]
      },
      end: vi.fn(async () => {}),
      on: vi.fn()
    }
    return { client: clientFrom(pool), calls, pool }
  }

  it('runs a parameter-less statement through query and a bound one through execute', async () => {
    const f = fake()
    await expect(f.client.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }], rowCount: 1 })
    await expect(f.client.execute('INSERT INTO t (a) VALUES (?)', [{ a: 1 }])).resolves.toMatchObject({ insertId: 4, affectedRows: 1 })
    expect(f.calls).toEqual([
      { method: 'query', sql: 'SELECT 1 AS ok', params: undefined },
      { method: 'execute', sql: 'INSERT INTO t (a) VALUES (?)', params: ['{"a":1}'] }
    ])
  })
})

describe('refSocket and unrefSocket', () => {
  it('find the stream on either shape of connection, and tolerate neither', () => {
    const ref = vi.fn()
    const unref = vi.fn()
    refSocket({ stream: { ref, unref } })
    refSocket({ connection: { stream: { ref, unref } } })
    unrefSocket({ stream: { ref, unref } })
    unrefSocket({ connection: { stream: { ref, unref } } })
    for (const nothing of [{}, { stream: {} }, undefined]) {
      refSocket(nothing)
      unrefSocket(nothing)
    }
    expect(ref).toHaveBeenCalledTimes(2)
    expect(unref).toHaveBeenCalledTimes(2)
  })
})

describe('PoolRegistry', () => {
  function pool(): SqlPool {
    return { query: vi.fn(), execute: vi.fn(), end: vi.fn(async () => {}), on: vi.fn() }
  }

  it('opens one pool per distinct connection and reuses it', () => {
    const open = vi.fn(pool)
    const registry = new PoolRegistry(open)
    const a = registry.get(options(BASE))
    expect(registry.get(options(BASE))).toBe(a)
    expect(registry.get(options(BASE, { ssl: 'required' }))).not.toBe(a)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('ends every pool on closeAll, tolerating a failed end, and opens afresh afterwards', async () => {
    const open = vi.fn(pool)
    const registry = new PoolRegistry(open)
    const a = registry.get(options(BASE))
    const b = registry.get(options(BASE, { ssl: 'required' }))
    vi.mocked(b.end).mockRejectedValueOnce(new Error('gone'))
    await expect(registry.closeAll()).resolves.toBeUndefined()
    expect(a.end).toHaveBeenCalledTimes(1)
    expect(b.end).toHaveBeenCalledTimes(1)
    expect(registry.get(options(BASE))).not.toBe(a)
  })
})

describe('openPool', () => {
  it('builds a pool without reaching for the network, refs a socket while acquired, and ends it', async () => {
    const p = openPool(options(BASE))
    expect(typeof p.execute).toBe('function')
    const stream = { ref: vi.fn(), unref: vi.fn() }
    ;(p as unknown as { emit(event: string, payload: unknown): void }).emit('acquire', { stream })
    ;(p as unknown as { emit(event: string, payload: unknown): void }).emit('release', { stream })
    expect(stream.ref).toHaveBeenCalledTimes(1)
    expect(stream.unref).toHaveBeenCalledTimes(1)
    await expect(p.end()).resolves.toBeUndefined()
  })
})
