// SQL text builders and identifier quoting; a value never enters the text, only the parameter list.

export interface Statement {
  text: string
  params: unknown[]
}

export type Row = Record<string, unknown>

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

/** The `newRows` trigger's page: the newest rows, or those past the values a cursor or start carries. */
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

  const after = input.cursor
    ? sameColumn
      ? [input.cursor.ordering]
      : [input.cursor.ordering, input.cursor.key]
    : input.startFrom !== undefined
      ? [input.startFrom]
      : undefined
  if (after === undefined) {
    const newestFirst = sameColumn ? `${ord} DESC` : `${ord} DESC, ${key} DESC`
    return { text: `SELECT * FROM ${table} ORDER BY ${newestFirst} LIMIT $1`, params: [input.limit] }
  }
  const past = after.length === 1 ? `${ord} > $1` : `(${ord}, ${key}) > ($1, $2)`
  return {
    text: `SELECT * FROM ${table} WHERE ${past} ORDER BY ${order} LIMIT $${after.length + 1}`,
    params: [...after, input.limit]
  }
}
