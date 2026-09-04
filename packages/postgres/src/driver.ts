// The `postgres` driver behind the smallest surface this connector uses; inlined by tsup, injected in tests.
import { readFileSync } from 'node:fs'
import postgres from 'postgres'
import type { ConnectionOptions } from './connection-string'
import type { Row } from './sql'

export interface SqlColumn {
  name: string
}

/** What the driver resolves a query to: the rows, with the command tag's parts alongside. */
export type SqlResult = Row[] & {
  count: number | null
  command: string | null
  columns: SqlColumn[] | null
}

export interface SqlClient {
  unsafe(text: string, params?: unknown[]): Promise<SqlResult | SqlResult[]>
  end(options?: { timeout?: number }): Promise<void>
}

export interface QueryResult {
  /** The last result set's rows, decoded by the driver. */
  rows: Row[]
  /** Its column names, so a column the config asks for but the query never returned can be named. */
  columns: string[]
  /** The last command tag's first word, e.g. `SELECT`, `INSERT`. */
  command: string
  /** The row count the tag carried, or 0 when it carried none. */
  rowCount: number
}

export interface PgClient {
  query(sql: string, params?: unknown[]): Promise<QueryResult>
  close(): Promise<void>
}

/** What `ssl` is set to for each sslmode, following the manual's table. */
export function sslSetting(options: ConnectionOptions, readFile: (path: string) => Buffer = readFileSync): unknown {
  if (options.sslMode === 'disable') return false
  // An approximation: the manual has allow and prefer try encryption in the opposite order, not accept different outcomes.
  if (options.sslMode === 'allow') return 'prefer'
  if (options.sslMode !== 'verify-ca' && options.sslMode !== 'verify-full') return options.sslMode
  const ca = options.sslRootCert && options.sslRootCert !== 'system' ? readFile(options.sslRootCert) : undefined
  return {
    rejectUnauthorized: true,
    ...(ca && { ca }),
    // verify-ca checks the chain but not the name, which is the manual's definition of it.
    ...(options.sslMode === 'verify-ca' && { checkServerIdentity: () => undefined })
  }
}

export function driverOptions(options: ConnectionOptions, readFile?: (path: string) => Buffer): Record<string, unknown> {
  return {
    host: options.host,
    port: options.port,
    user: options.user,
    ...(options.password !== undefined && { pass: options.password }),
    database: options.database,
    ssl: sslSetting(options, readFile),
    connect_timeout: options.connectTimeoutS,
    // One connection per call, never reused, so preparing a statement would only cost a round trip.
    max: 1,
    prepare: false,
    // Fetching array element types would cost a catalogue query on connect; an array column arrives as its text form instead.
    fetch_types: false,
    // A notice would otherwise be printed to stdout, where the connector speaks its own protocol.
    onnotice: () => {},
    connection: { application_name: options.applicationName }
  }
}

/** `undefined` is NULL, and an object or array is JSON, which the driver would otherwise send as `[object Object]`. */
export function toParam(value: unknown): unknown {
  if (value === undefined || value === null) return null
  return typeof value === 'object' ? JSON.stringify(value) : value
}

/** Several statements resolve to an array of results; the last one is the answer, as libpq reports it. */
export function lastResult(resolved: SqlResult | SqlResult[]): SqlResult {
  return 'command' in resolved ? resolved : (resolved[resolved.length - 1] as SqlResult)
}

export function clientFrom(sql: SqlClient): PgClient {
  return {
    async query(text, params = []) {
      const result = lastResult(await sql.unsafe(text, params.map(toParam)))
      return {
        rows: [...result],
        columns: (result.columns ?? []).map((column) => column.name),
        command: result.command ?? '',
        rowCount: result.count ?? 0
      }
    },
    async close() {
      await sql.end({ timeout: 5 })
    }
  }
}

export function openConnection(options: ConnectionOptions): PgClient {
  return clientFrom(postgres(driverOptions(options)) as unknown as SqlClient)
}
