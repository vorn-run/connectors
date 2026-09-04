/**
 * SQL text builders, identifier quoting and text-to-value decoding.
 *
 * Every builder returns the statement and its parameters separately: a value
 * never enters the text, so nothing a workflow passes can become SQL.
 */

export interface Field {
  name: string
  /** Type OID from RowDescription, which decides how the text is read. */
  typeOid: number
}

/** One row as the server sent it: text per column, or null. */
export type RawRow = (string | null)[]

export interface Statement {
  text: string
  params: unknown[]
}

export type Row = Record<string, unknown>

/** Type OIDs from pg_type that the decoder gives a JavaScript shape. */
export const OID = {
  bool: 16,
  int8: 20,
  int2: 21,
  int4: 23,
  oid: 26,
  json: 114,
  float4: 700,
  float8: 701,
  date: 1082,
  timestamp: 1114,
  timestamptz: 1184,
  numeric: 1700,
  jsonb: 3802
} as const

const DATE_TIME_OIDS: ReadonlySet<number> = new Set([OID.date, OID.timestamp, OID.timestamptz])

/** Double-quote an identifier, doubling embedded quotes, per the manual's lexical rules. */
export function quoteIdent(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('identifier is empty')
  if (trimmed.includes('\0')) throw new Error('identifier contains a NUL character')
  return `"${trimmed.replace(/"/g, '""')}"`
}

/** Quote `table` or `schema.table`, splitting at the first dot. */
export function quoteTable(ref: string): string {
  const trimmed = ref.trim()
  const dot = trimmed.indexOf('.')
  if (dot === -1) return quoteIdent(trimmed)
  return `${quoteIdent(trimmed.slice(0, dot))}.${quoteIdent(trimmed.slice(dot + 1))}`
}

/** `schema.table` → its two parts, with `public` when no schema was given. */
export function splitTable(ref: string): { schema: string; table: string } {
  const trimmed = ref.trim()
  if (trimmed === '') throw new Error('table is required')
  const dot = trimmed.indexOf('.')
  if (dot === -1) return { schema: 'public', table: trimmed }
  const schema = trimmed.slice(0, dot).trim()
  const table = trimmed.slice(dot + 1).trim()
  if (schema === '' || table === '') throw new Error(`table "${trimmed}" is not table or schema.table`)
  return { schema, table }
}

/** Turn a JavaScript value into the text the server casts to the column's type. */
export function encodeParam(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cannot bind ${value} as a parameter`)
    return String(value)
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('cannot bind an invalid Date as a parameter')
    return value.toISOString()
  }
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`
  return JSON.stringify(value)
}

/** `2026-09-04 12:00:00.5+00` → `2026-09-04T12:00:00.5Z`; anything else stays as sent. */
export function timestampToIso(text: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}:\d{2}(?:\.\d+)?))?([+-]\d{2}(?::?\d{2})?)?$/.exec(text)
  if (!match) return text
  const [, date, time, zone] = match
  if (!time) return date as string
  let offset = 'Z'
  if (zone && zone !== '+00' && zone !== '+00:00' && zone !== '+0000') {
    const sign = zone[0]
    const digits = zone.slice(1).replace(':', '')
    offset = `${sign}${digits.slice(0, 2)}:${digits.length > 2 ? digits.slice(2) : '00'}`
  }
  return `${date}T${time}${offset}`
}

/** Read one column's text by its type OID. */
export function decodeValue(typeOid: number, text: string | null): unknown {
  if (text === null) return null
  switch (typeOid) {
    case OID.bool:
      return text === 't'
    case OID.int2:
    case OID.int4:
    case OID.oid:
    case OID.float4:
    case OID.float8:
      return Number(text)
    case OID.int8: {
      const n = Number(text)
      return Number.isSafeInteger(n) ? n : text
    }
    case OID.json:
    case OID.jsonb:
      return JSON.parse(text)
    case OID.timestamp:
    case OID.timestamptz:
      return timestampToIso(text)
    default:
      return text
  }
}

export function isDateTime(typeOid: number): boolean {
  return DATE_TIME_OIDS.has(typeOid)
}

export function rowToObject(fields: Field[], raw: RawRow): Row {
  const row: Row = {}
  fields.forEach((field, index) => {
    row[field.name] = decodeValue(field.typeOid, raw[index] ?? null)
  })
  return row
}

/** Parse an argument that arrives as JSON text, or pass it through when already parsed. */
export function jsonArg(value: unknown, name: string): unknown {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    throw new Error(`${name} must be JSON`)
  }
}

export function jsonArray(value: unknown, name: string): unknown[] {
  const parsed = jsonArg(value, name)
  if (parsed === undefined) return []
  if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON array, e.g. [1, "two"]`)
  return parsed
}

export function jsonObject(value: unknown, name: string): Record<string, unknown> {
  const parsed = jsonArg(value, name)
  if (parsed === undefined) throw new Error(`${name} is required`)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object of column: value`)
  }
  return parsed as Record<string, unknown>
}

export function buildSelect(input: {
  table: string
  where?: string
  params?: unknown[]
  orderBy?: string
  limit: number
}): Statement {
  const params = [...(input.params ?? [])]
  let text = `SELECT * FROM ${quoteTable(input.table)}`
  if (input.where) text += ` WHERE ${input.where}`
  if (input.orderBy) text += ` ORDER BY ${quoteIdent(input.orderBy)}`
  params.push(input.limit)
  text += ` LIMIT $${params.length}`
  return { text, params }
}

export function buildInsert(table: string, values: Record<string, unknown>): Statement {
  const columns = Object.keys(values)
  const target = quoteTable(table)
  if (columns.length === 0) return { text: `INSERT INTO ${target} DEFAULT VALUES RETURNING *`, params: [] }
  const names = columns.map(quoteIdent).join(', ')
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ')
  return {
    text: `INSERT INTO ${target} (${names}) VALUES (${placeholders}) RETURNING *`,
    params: columns.map((column) => values[column])
  }
}

/** The `where` params bind first so the text the user wrote needs no renumbering. */
export function buildUpdate(input: {
  table: string
  set: Record<string, unknown>
  where: string
  params?: unknown[]
}): Statement {
  const columns = Object.keys(input.set)
  if (columns.length === 0) throw new Error('set must name at least one column')
  if (!input.where.trim()) throw new Error('where is required, so a step cannot update every row by omission')
  const params = [...(input.params ?? [])]
  const offset = params.length
  const assignments = columns.map((column, index) => `${quoteIdent(column)} = $${offset + index + 1}`)
  params.push(...columns.map((column) => input.set[column]))
  return {
    text: `UPDATE ${quoteTable(input.table)} SET ${assignments.join(', ')} WHERE ${input.where}`,
    params
  }
}

export const LIST_TABLES_SQL =
  'SELECT table_schema, table_name, table_type FROM information_schema.tables ' +
  'WHERE table_schema = $1 ORDER BY table_name'

export const DESCRIBE_TABLE_SQL =
  'SELECT column_name, data_type, udt_name, is_nullable, column_default, ordinal_position ' +
  'FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position'

/** The `newRows` trigger's page, in each of its three shapes. */
export function buildNewRows(input: {
  table: string
  orderingColumn: string
  keyColumn: string
  limit: number
  cursor?: { ordering: string; key: string }
  startFrom?: string
}): Statement {
  const table = quoteTable(input.table)
  const ord = quoteIdent(input.orderingColumn)
  const key = quoteIdent(input.keyColumn)
  const sameColumn = input.orderingColumn.trim() === input.keyColumn.trim()
  const order = sameColumn ? ord : `${ord}, ${key}`

  if (input.cursor) {
    if (sameColumn) {
      return {
        text: `SELECT * FROM ${table} WHERE ${ord} > $1 ORDER BY ${order} LIMIT $2`,
        params: [input.cursor.ordering, input.limit]
      }
    }
    return {
      text: `SELECT * FROM ${table} WHERE (${ord}, ${key}) > ($1, $2) ORDER BY ${order} LIMIT $3`,
      params: [input.cursor.ordering, input.cursor.key, input.limit]
    }
  }
  if (input.startFrom !== undefined) {
    return {
      text: `SELECT * FROM ${table} WHERE ${ord} > $1 ORDER BY ${order} LIMIT $2`,
      params: [input.startFrom, input.limit]
    }
  }
  const newestFirst = sameColumn ? `${ord} DESC` : `${ord} DESC, ${key} DESC`
  return { text: `SELECT * FROM ${table} ORDER BY ${newestFirst} LIMIT $1`, params: [input.limit] }
}
