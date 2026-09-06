// The `mysql2` driver behind the smallest surface this connector uses; inlined by tsup, replaced in tests.
import { readFileSync } from 'node:fs'
import mysql from 'mysql2/promise'
import type { ConnectionOptions } from './connection-string'
import { LimitParam, type Row } from './sql'

const { TypedParameter: T } = mysql

/** A write's header, as the driver reports it. */
export interface ResultHeader {
  affectedRows?: number
  insertId?: number
  warningStatus?: number
  info?: string
}

/** `[rows, fields]` from a read, `[header]` from a write. */
export type DriverResult = [Row[] | ResultHeader, unknown?]

export interface SqlPool {
  query(sql: string, params?: unknown[]): Promise<DriverResult>
  execute(sql: string, params?: unknown[]): Promise<DriverResult>
  end(): Promise<void>
  on(event: 'connection', listener: (connection: unknown) => void): unknown
}

export interface QueryResult {
  /** The rows of a read, empty for a write. */
  rows: Row[]
  /** Rows returned, or rows a write touched. */
  rowCount: number
  affectedRows: number
  insertId: number
  warningStatus: number
  /** The server's text for an UPDATE: `Rows matched: … Changed: … Warnings: …`. */
  info: string
}

export interface MysqlClient {
  /** Client-side substitution, for a statement with no parameters at all. */
  query(sql: string): Promise<QueryResult>
  /** A server-side prepared statement, for anything with parameters. */
  execute(sql: string, params: unknown[]): Promise<QueryResult>
}

/** What the driver's `ssl` option is set to for each setting, following the driver's SSL page. */
export function sslSetting(options: ConnectionOptions, readFile: (path: string) => Buffer = readFileSync): unknown {
  if (options.sslMode === 'disabled') return false
  if (options.sslMode === 'required') return { rejectUnauthorized: false }
  const ca = options.sslCa ? readFile(options.sslCa) : undefined
  // verifyIdentity is what the driver reads to run tls.checkServerIdentity; it skips the check when falsy.
  return { rejectUnauthorized: true, verifyIdentity: true, ...(ca && { ca }) }
}

export function poolOptions(options: ConnectionOptions, readFile?: (path: string) => Buffer): Record<string, unknown> {
  return {
    host: options.host,
    port: options.port,
    user: options.user,
    ...(options.password !== undefined && { password: options.password }),
    ...(options.database !== undefined && { database: options.database }),
    ssl: sslSetting(options, readFile),
    connectTimeout: 10000,
    connectionLimit: 2,
    // Equal to the limit, so the driver never arms the idle sweep timer that would hold a one-shot process open.
    maxIdle: 2,
    waitForConnections: true,
    queueLimit: 0,
    multipleStatements: false,
    // Dates arrive as the server's own text, so a cursor built from one binds back unchanged.
    dateStrings: true,
    // A BIGINT is a number when it fits one and its digits otherwise.
    supportBigNumbers: true,
    bigNumberStrings: false
  }
}

/** `undefined` is NULL, an object or array is JSON, and a LIMIT is a typed BIGINT. */
export function toParam(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (value instanceof LimitParam) return T.BIGINT(value.value)
  return typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) : value
}

export function normalize(resolved: DriverResult): QueryResult {
  const [result] = resolved
  if (Array.isArray(result)) {
    const rows = result.map((row) => ({ ...row }))
    return { rows, rowCount: rows.length, affectedRows: 0, insertId: 0, warningStatus: 0, info: '' }
  }
  const affectedRows = Number(result?.affectedRows ?? 0)
  return {
    rows: [],
    rowCount: affectedRows,
    affectedRows,
    insertId: Number(result?.insertId ?? 0),
    warningStatus: Number(result?.warningStatus ?? 0),
    info: String(result?.info ?? '')
  }
}

export function clientFrom(pool: SqlPool): MysqlClient {
  return {
    async query(sql) {
      return normalize(await pool.query(sql))
    },
    async execute(sql, params) {
      return normalize(await pool.execute(sql, params.map(toParam)))
    }
  }
}

/** Let an idle pooled socket stop holding the process open; the driver's typings do not name the stream, so it is felt for. */
export function unrefSocket(connection: unknown): void {
  const core = connection as { stream?: { unref?: () => void }; connection?: { stream?: { unref?: () => void } } }
  const stream = core?.stream ?? core?.connection?.stream
  stream?.unref?.()
}

export function openPool(options: ConnectionOptions): SqlPool {
  const pool = mysql.createPool(poolOptions(options)) as unknown as SqlPool
  pool.on('connection', unrefSocket)
  return pool
}

/** One pool per distinct connection, created on first use and ended together when the connector stops. */
export class PoolRegistry {
  private readonly pools = new Map<string, SqlPool>()

  constructor(private readonly open: (options: ConnectionOptions) => SqlPool = openPool) {}

  get(options: ConnectionOptions): SqlPool {
    const key = JSON.stringify(options)
    let pool = this.pools.get(key)
    if (!pool) {
      pool = this.open(options)
      this.pools.set(key, pool)
    }
    return pool
  }

  async closeAll(): Promise<void> {
    const pools = [...this.pools.values()]
    this.pools.clear()
    await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)))
  }
}
