// SQL text builders and identifier quoting; a value never enters the text, only the parameter list.

export interface Statement {
  text: string
  params: unknown[]
}

export type Row = Record<string, unknown>

/** A LIMIT bound as a typed BIGINT, which servers that do not report parameter types need. */
export class LimitParam {
  constructor(readonly value: number) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`limit ${value} is not a whole number`)
  }
}

// The manual's unquoted-identifier alphabet, at most 64 characters.
const IDENTIFIER = /^[0-9a-zA-Z_$\u0080-\uFFFF]+$/
const MAX_IDENTIFIER_LENGTH = 64

/** Backtick an identifier after checking it against the manual's alphabet and length limit. */
export function quoteIdent(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('identifier is empty')
  if (trimmed.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(`identifier "${trimmed.slice(0, 16)}…" is longer than ${MAX_IDENTIFIER_LENGTH} characters`)
  }
  if (!IDENTIFIER.test(trimmed)) {
    throw new Error(`identifier "${trimmed}" may only hold letters, digits, _ and $`)
  }
  return `\`${trimmed.replace(/`/g, '``')}\``
}

/** Quote `table` or `db.table`, splitting at the first dot. */
export function quoteTable(ref: string): string {
  const { database, table } = splitTable(ref)
  return database === undefined ? quoteIdent(table) : `${quoteIdent(database)}.${quoteIdent(table)}`
}

/** `db.table` → its two parts; the database is absent when the reference has no dot. */
export function splitTable(ref: string): { database?: string; table: string } {
  const trimmed = ref.trim()
  if (trimmed === '') throw new Error('table is required')
  const dot = trimmed.indexOf('.')
  if (dot === -1) return { table: trimmed }
  const database = trimmed.slice(0, dot).trim()
  const table = trimmed.slice(dot + 1).trim()
  if (database === '' || table === '') throw new Error(`table "${trimmed}" is not table or db.table`)
  return { database, table }
}

/** The shape of an argument the SDK has already parsed for a `json` input. */
export function jsonArray(value: unknown, name: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${name} must be a JSON array, e.g. [1, "two"]`)
  return value
}

export function jsonObject(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) throw new Error(`${name} is required`)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object of column: value`)
  }
  return value as Record<string, unknown>
}

function whereClause(where: string | undefined): string {
  return where && where.trim() ? ` WHERE ${where.trim()}` : ''
}

export function buildSelect(input: {
  table: string
  columns?: string[]
  where?: string
  params?: unknown[]
  orderBy?: string
  descending?: boolean
  limit: number
}): Statement {
  const columns = input.columns && input.columns.length > 0 ? input.columns.map(quoteIdent).join(', ') : '*'
  let text = `SELECT ${columns} FROM ${quoteTable(input.table)}${whereClause(input.where)}`
  if (input.orderBy) text += ` ORDER BY ${quoteIdent(input.orderBy)}${input.descending ? ' DESC' : ''}`
  text += ' LIMIT ?'
  return { text, params: [...(input.params ?? []), new LimitParam(input.limit)] }
}

export function buildInsert(table: string, values: Record<string, unknown>): Statement {
  const columns = Object.keys(values)
  if (columns.length === 0) throw new Error('values must name at least one column')
  const names = columns.map(quoteIdent).join(', ')
  const placeholders = columns.map(() => '?').join(', ')
  return {
    text: `INSERT INTO ${quoteTable(table)} (${names}) VALUES (${placeholders})`,
    params: columns.map((column) => values[column])
  }
}

/** MySQL binds `?` in text order, so the SET values come first and the where params after them. */
export function buildUpdate(input: {
  table: string
  values: Record<string, unknown>
  where: string
  params?: unknown[]
}): Statement {
  const columns = Object.keys(input.values)
  if (columns.length === 0) throw new Error('values must name at least one column')
  if (!input.where.trim()) throw new Error('where is required, so a step cannot update every row by omission')
  const assignments = columns.map((column) => `${quoteIdent(column)} = ?`)
  return {
    text: `UPDATE ${quoteTable(input.table)} SET ${assignments.join(', ')} WHERE ${input.where.trim()}`,
    params: [...columns.map((column) => input.values[column]), ...(input.params ?? [])]
  }
}

export function buildDelete(input: { table: string; where: string; params?: unknown[] }): Statement {
  if (!input.where.trim()) throw new Error('where is required, so a step cannot delete every row by omission')
  return {
    text: `DELETE FROM ${quoteTable(input.table)} WHERE ${input.where.trim()}`,
    params: [...(input.params ?? [])]
  }
}

export function buildCount(input: { table: string; where?: string; params?: unknown[] }): Statement {
  return {
    text: `SELECT COUNT(*) AS count FROM ${quoteTable(input.table)}${whereClause(input.where)}`,
    params: [...(input.params ?? [])]
  }
}

export const LIST_TABLES_SQL =
  'SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS FROM information_schema.TABLES ' +
  'WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME'

export const DESCRIBE_TABLE_SQL =
  'SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, ORDINAL_POSITION ' +
  'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION'

function andWhere(where: string | undefined): string {
  return where && where.trim() ? ` AND (${where.trim()})` : ''
}

/** The `newRows` page: the newest rows, or those past the values a cursor or start carries. */
export function buildNewRows(input: {
  table: string
  orderingColumn: string
  keyColumn: string
  where?: string
  limit: number
  cursor?: { ordering: unknown; key: unknown }
  startFrom?: string
}): Statement {
  const table = quoteTable(input.table)
  const ord = quoteIdent(input.orderingColumn)
  const key = quoteIdent(input.keyColumn)
  const sameColumn = input.orderingColumn.trim() === input.keyColumn.trim()
  const limit = new LimitParam(input.limit)

  if (input.cursor === undefined && input.startFrom === undefined) {
    const newestFirst = sameColumn ? `${ord} DESC` : `${ord} DESC, ${key} DESC`
    const filter = input.where && input.where.trim() ? ` WHERE (${input.where.trim()})` : ''
    return { text: `SELECT * FROM ${table}${filter} ORDER BY ${newestFirst} LIMIT ?`, params: [limit] }
  }
  const order = sameColumn ? ord : `${ord}, ${key}`
  const rowWise = input.cursor !== undefined && !sameColumn
  const past = rowWise ? `(${ord} > ? OR (${ord} = ? AND ${key} > ?))` : `${ord} > ?`
  const after = input.cursor === undefined ? [input.startFrom] : rowWise
    ? [input.cursor.ordering, input.cursor.ordering, input.cursor.key]
    : [input.cursor.ordering]
  return {
    text: `SELECT * FROM ${table} WHERE ${past}${andWhere(input.where)} ORDER BY ${order} LIMIT ?`,
    params: [...after, limit]
  }
}

/**
 * The `updatedRows` page: rows at or past the newest updated_at seen, or the newest page.
 * The keys already delivered at `since` are excluded by the server, so a page of ties still advances.
 */
export function buildUpdatedRows(input: {
  table: string
  updatedAtColumn: string
  keyColumn: string
  where?: string
  limit: number
  since?: string
  exceptKeys?: string[]
}): Statement {
  const table = quoteTable(input.table)
  const upd = quoteIdent(input.updatedAtColumn)
  const key = quoteIdent(input.keyColumn)
  const limit = new LimitParam(input.limit)
  if (input.since === undefined) {
    const filter = input.where && input.where.trim() ? ` WHERE (${input.where.trim()})` : ''
    return { text: `SELECT * FROM ${table}${filter} ORDER BY ${upd} DESC, ${key} DESC LIMIT ?`, params: [limit] }
  }
  const except = input.exceptKeys ?? []
  const known = except.length > 0 ? ` AND NOT (${upd} = ? AND ${key} IN (${except.map(() => '?').join(', ')}))` : ''
  return {
    text: `SELECT * FROM ${table} WHERE ${upd} >= ?${known}${andWhere(input.where)} ORDER BY ${upd}, ${key} LIMIT ?`,
    params: [input.since, ...(known ? [input.since, ...except] : []), limit]
  }
}
