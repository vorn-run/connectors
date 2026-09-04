import { describe, expect, it, vi } from 'vitest'
import { parseConnectionString } from './connection-string'
import { clientFrom, driverOptions, lastResult, openConnection, sslSetting, toParam, type SqlClient, type SqlResult } from './driver'
import type { Row } from './sql'

const options = (dsn: string) => parseConnectionString(dsn)
const BASE = 'postgres://alice:pencil@db.example.com:5432/app'

function result(columns: string[], rows: Row[], command: string | null = 'SELECT', count: number | null = rows.length): SqlResult {
  return Object.assign([...rows], { count, command, columns: columns.map((name) => ({ name })) }) as SqlResult
}

describe('sslSetting', () => {
  it('turns TLS off for disable and asks the driver for the rest', () => {
    expect(sslSetting(options(`${BASE}?sslmode=disable`))).toBe(false)
    expect(sslSetting(options(`${BASE}?sslmode=require`))).toBe('require')
    expect(sslSetting(options(`${BASE}?sslmode=prefer`))).toBe('prefer')
  })

  it('treats allow as prefer, the only mode the driver falls back from', () => {
    expect(sslSetting(options(`${BASE}?sslmode=allow`))).toBe('prefer')
  })

  it('verifies the chain for verify-ca and verify-full, reading the named root', () => {
    const readFile = vi.fn(() => Buffer.from('PEM'))
    const full = sslSetting(options(`${BASE}?sslmode=verify-full&sslrootcert=/tmp/ca.pem`), readFile) as Record<string, unknown>
    expect(full).toEqual({ rejectUnauthorized: true, ca: Buffer.from('PEM') })
    expect(readFile).toHaveBeenCalledWith('/tmp/ca.pem')

    const ca = sslSetting(options(`${BASE}?sslmode=verify-ca`), readFile) as { checkServerIdentity: () => undefined }
    expect(ca).toMatchObject({ rejectUnauthorized: true })
    expect(ca.checkServerIdentity()).toBeUndefined()
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it('leaves the roots to Node when sslrootcert is system', () => {
    const readFile = vi.fn(() => Buffer.from('PEM'))
    expect(sslSetting(options(`${BASE}?sslmode=verify-full&sslrootcert=system`), readFile)).toEqual({ rejectUnauthorized: true })
    expect(readFile).not.toHaveBeenCalled()
  })
})

describe('driverOptions', () => {
  it('carries the connection string across, in seconds and with one connection', () => {
    expect(driverOptions(options(`${BASE}?sslmode=disable&connect_timeout=3`))).toMatchObject({
      host: 'db.example.com',
      port: 5432,
      user: 'alice',
      pass: 'pencil',
      database: 'app',
      ssl: false,
      connect_timeout: 3,
      max: 1,
      prepare: false,
      fetch_types: false,
      connection: { application_name: 'vorn-connector-postgres' }
    })
  })

  it('omits a password the string did not carry and swallows a notice', () => {
    const withoutPassword = driverOptions(options('postgres://alice@db.example.com/app'))
    expect('pass' in withoutPassword).toBe(false)
    expect((withoutPassword.onnotice as () => void)()).toBeUndefined()
  })
})

describe('toParam', () => {
  it('sends undefined as NULL and an object or array as JSON', () => {
    expect(toParam(undefined)).toBeNull()
    expect(toParam(null)).toBeNull()
    expect(toParam({ a: 1 })).toBe('{"a":1}')
    expect(toParam([1, 2])).toBe('[1,2]')
  })

  it('leaves alone the shapes the driver types for itself', () => {
    const when = new Date('2026-09-04T12:00:00Z')
    const bytes = Buffer.from('hi')
    expect(toParam(when)).toBe(when)
    expect(toParam(bytes)).toBe(bytes)
    expect(toParam('text')).toBe('text')
    expect(toParam(7)).toBe(7)
    expect(toParam(true)).toBe(true)
  })
})

describe('lastResult', () => {
  it('takes the one result as it is', () => {
    const one = result(['a'], [{ a: 1 }])
    expect(lastResult(one)).toBe(one)
  })

  it('takes the last of several, as libpq reports a multi-statement query', () => {
    const second = result(['b'], [{ b: 2 }])
    expect(lastResult([result(['a'], [{ a: 1 }]), second])).toBe(second)
  })
})

describe('clientFrom', () => {
  function fake(answer: SqlResult | SqlResult[]) {
    const calls: Array<{ text: string; params: unknown[] }> = []
    const end = vi.fn(async () => {})
    const sql: SqlClient = {
      async unsafe(text, params = []) {
        calls.push({ text, params })
        return answer
      },
      end
    }
    return { client: clientFrom(sql), calls, end }
  }

  it('reports the rows, their column names, the tag and the count', async () => {
    const f = fake(result(['id', 'ref'], [{ id: 1, ref: 'A' }], 'SELECT', 1))
    await expect(f.client.query('SELECT * FROM t WHERE a = $1', [{ a: 1 }])).resolves.toEqual({
      rows: [{ id: 1, ref: 'A' }],
      columns: ['id', 'ref'],
      command: 'SELECT',
      rowCount: 1
    })
    expect(f.calls[0]).toEqual({ text: 'SELECT * FROM t WHERE a = $1', params: ['{"a":1}'] })
  })

  it('reads a tagless result, as an empty query gives back', async () => {
    const f = fake(result([], [], null, null))
    await expect(f.client.query('')).resolves.toEqual({ rows: [], columns: [], command: '', rowCount: 0 })
  })

  it('reads a result the driver described no columns for', async () => {
    const bare = Object.assign([], { count: 2, command: 'UPDATE', columns: null }) as SqlResult
    await expect(fake(bare).client.query('UPDATE t SET a = 1')).resolves.toMatchObject({ columns: [], rowCount: 2 })
  })

  it('ends the driver when the connection is closed', async () => {
    const f = fake(result([], []))
    await f.client.close()
    expect(f.end).toHaveBeenCalledWith({ timeout: 5 })
  })
})

describe('openConnection', () => {
  it('builds a client without reaching for the network', async () => {
    const client = openConnection(options(`${BASE}?sslmode=disable&connect_timeout=1`))
    expect(typeof client.query).toBe('function')
    await expect(client.close()).resolves.toBeUndefined()
  })
})
