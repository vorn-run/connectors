import { defineConnector, type ConnectorItem, type PollContext, type PollOutcome } from '@vornrun/connector-sdk'
import { parseConnectionString } from './connection-string'
import {
  buildInsert,
  buildNewRows,
  buildSelect,
  buildUpdate,
  DESCRIBE_TABLE_SQL,
  isDateTime,
  jsonArray,
  jsonObject,
  LIST_TABLES_SQL,
  rowToObject,
  splitTable,
  timestampToIso,
  type Field,
  type RawRow,
  type Row
} from './sql'
import { openConnection, type PgClient, type QueryResult } from './wire'

const DEFAULT_LIMIT = 100
const MAX_SELECT_LIMIT = 1000
const CURSOR_VERSION = 1

export interface PostgresConnectorOptions {
  version?: string
  /** Replaced in tests, so no socket is ever opened. */
  open?: (connectionString: string) => Promise<PgClient>
}

type Config = Record<string, unknown>

function required(config: Config, key: string, env: string): string {
  const value = String(config[key] ?? '').trim()
  if (!value) throw new Error(`${env} is required`)
  return value
}

/** Trim a value, treating blank as absent. */
function text(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim()
  return trimmed === '' ? undefined : trimmed
}

function pageLimit(config: Config, context: { limit?: number }, max = Number.MAX_SAFE_INTEGER): number {
  const configured = Number(config.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT
  const asked = context.limit && context.limit > 0 ? context.limit : configured
  return Math.min(Math.max(1, Math.floor(asked)), max)
}

function columnIndex(fields: Field[], column: string, what: string): number {
  const index = fields.findIndex((field) => field.name === column)
  if (index === -1) {
    throw new Error(`the ${what} "${column}" is not among the columns returned: ${fields.map((f) => f.name).join(', ')}`)
  }
  return index
}

/** A column's text for a row, refusing NULL because a cursor or an id cannot be built from one. */
function cellText(raw: RawRow, index: number, column: string, what: string): string {
  const value = raw[index]
  if (value === null || value === undefined) throw new Error(`the ${what} "${column}" is NULL in a row, so it cannot identify it`)
  return value
}

function toItem(input: {
  fields: Field[]
  raw: RawRow
  key: string
  titleColumn?: string
  fallbackTitle: string
  timeIndex: number
}): ConnectorItem {
  const row = rowToObject(input.fields, input.raw)
  const titleValue = input.titleColumn !== undefined ? row[input.titleColumn] : undefined
  const title = titleValue === null || titleValue === undefined ? input.fallbackTitle : String(titleValue)
  const timeField = input.fields[input.timeIndex]
  const timeText = input.raw[input.timeIndex]
  const item: ConnectorItem = { externalId: input.key, title, data: row }
  if (timeField && isDateTime(timeField.typeOid) && typeof timeText === 'string') {
    item.updatedAt = timestampToIso(timeText)
  }
  return item
}

function parseCursor<T>(cursor: string | undefined, shape: (parsed: Record<string, unknown>) => T | undefined): T | undefined {
  if (cursor === undefined || cursor === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(cursor)
  } catch {
    throw new Error('the poll cursor is not JSON; clear it to start over')
  }
  if (typeof parsed !== 'object' || parsed === null || (parsed as Record<string, unknown>).v !== CURSOR_VERSION) {
    throw new Error('the poll cursor is not one this connector wrote; clear it to start over')
  }
  const shaped = shape(parsed as Record<string, unknown>)
  if (shaped === undefined) throw new Error('the poll cursor is incomplete; clear it to start over')
  return shaped
}

export function createPostgresConnector(options: PostgresConnectorOptions = {}) {
  const open =
    options.open ?? ((connectionString: string) => openConnection(parseConnectionString(connectionString)))

  /** One connection per call: open, run, terminate, whatever happens in between. */
  async function withClient<T>(config: Config, work: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await open(required(config, 'connectionString', 'DATABASE_URL'))
    try {
      return await work(client)
    } finally {
      await client.close().catch(() => undefined)
    }
  }

  async function pollNewRows(context: PollContext): Promise<PollOutcome> {
    const config = context.config as Config
    const table = required(config, 'table', 'PG_TABLE')
    const orderingColumn = required(config, 'orderingColumn', 'PG_ORDERING_COLUMN')
    const keyColumn = text(config.keyColumn) ?? orderingColumn
    const titleColumn = text(config.titleColumn)
    const startFrom = text(config.startFrom)
    const limit = pageLimit(config, context)
    const cursor = parseCursor(context.cursor, (parsed) =>
      typeof parsed.o === 'string' && typeof parsed.k === 'string' ? { ordering: parsed.o, key: parsed.k } : undefined
    )

    const statement = buildNewRows({
      table,
      orderingColumn,
      keyColumn,
      limit,
      ...(cursor && { cursor }),
      ...(startFrom !== undefined && { startFrom })
    })
    const result = await withClient(config, (client) => client.query(statement.text, statement.params))
    if (result.rows.length === 0) {
      return { items: [], ...(context.cursor !== undefined && { nextCursor: context.cursor }), hasMore: false }
    }

    const forward = cursor !== undefined || startFrom !== undefined
    const rows = forward ? result.rows : [...result.rows].reverse()
    const ordIndex = columnIndex(result.fields, orderingColumn, 'ordering column')
    const keyIndex = columnIndex(result.fields, keyColumn, 'key column')
    const items = rows.map((raw) => {
      const key = cellText(raw, keyIndex, keyColumn, 'key column')
      cellText(raw, ordIndex, orderingColumn, 'ordering column')
      return toItem({ fields: result.fields, raw, key, titleColumn, fallbackTitle: `${table} ${key}`, timeIndex: ordIndex })
    })
    const last = rows[rows.length - 1] as RawRow
    const nextCursor = JSON.stringify({ v: CURSOR_VERSION, o: last[ordIndex], k: last[keyIndex] })
    return { items, nextCursor, hasMore: forward && rows.length >= limit }
  }

  async function pollQueryRows(context: PollContext): Promise<PollOutcome> {
    const config = context.config as Config
    const query = required(config, 'query', 'PG_QUERY')
    const cursorColumn = required(config, 'cursorColumn', 'PG_CURSOR_COLUMN')
    const keyColumn = required(config, 'keyColumn', 'PG_KEY_COLUMN')
    const titleColumn = text(config.titleColumn)
    const limit = pageLimit(config, context)
    const cursor = parseCursor(context.cursor, (parsed) =>
      typeof parsed.c === 'string' && Array.isArray(parsed.keys)
        ? { value: parsed.c, keys: parsed.keys.map(String) }
        : undefined
    )
    const since = cursor?.value ?? text(config.startFrom)
    if (since === undefined) {
      throw new Error('PG_START_FROM is required for the first poll: the value $1 starts from, e.g. 0 or 2026-01-01')
    }
    // $2 is bound only when the text mentions it; the server rejects a parameter no placeholder uses.
    const paged = /\$2\b/.test(query)
    const params: unknown[] = paged ? [since, limit] : [since]

    const result = await withClient(config, (client) => client.query(query, params))
    const cursorIndex = columnIndex(result.fields, cursorColumn, 'cursor column')
    const keyIndex = columnIndex(result.fields, keyColumn, 'key column')

    const items: ConnectorItem[] = []
    let newest = cursor ?? { value: since, keys: [] as string[] }
    for (const raw of result.rows) {
      const key = cellText(raw, keyIndex, keyColumn, 'key column')
      const value = cellText(raw, cursorIndex, cursorColumn, 'cursor column')
      if (cursor && value === cursor.value && cursor.keys.includes(key)) continue
      items.push(toItem({ fields: result.fields, raw, key, titleColumn, fallbackTitle: `${keyColumn} ${key}`, timeIndex: cursorIndex }))
      newest = value === newest.value ? { value, keys: [...newest.keys, key] } : { value, keys: [key] }
    }
    return {
      items,
      nextCursor: JSON.stringify({ v: CURSOR_VERSION, c: newest.value, keys: newest.keys }),
      hasMore: paged && result.rows.length >= limit
    }
  }

  function rowsOf(result: QueryResult): Row[] {
    return result.rows.map((raw) => rowToObject(result.fields, raw))
  }

  return defineConnector({
    id: 'postgres',
    name: 'PostgreSQL',
    ...(options.version && { version: options.version }),
    description: 'Trigger workflows from new rows in a PostgreSQL database, and query or write to it from a step.',
    // A database cylinder: a lid and two bands.
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M12 3c-4.97 0-9 1.34-9 3s4.03 3 9 3 9-1.34 9-3-4.03-3-9-3z',
        'M3 8v3c0 1.66 4.03 3 9 3s9-1.34 9-3V8c0 1.66-4.03 3-9 3S3 9.66 3 8z',
        'M3 13v3c0 1.66 4.03 3 9 3s9-1.34 9-3v-3c0 1.66-4.03 3-9 3s-9-1.34-9-3z'
      ]
    },
    auth: { rung: 'key', keys: ['connectionString'] },
    config: [
      {
        key: 'connectionString',
        env: 'DATABASE_URL',
        label: 'Connection string',
        secret: true,
        required: true,
        description:
          'libpq URI: postgres://user:password@host:5432/database?sslmode=require. ' +
          'Your provider shows it on the database page; otherwise ask your DBA. A read-only role is enough for triggers.',
        builderHint:
          'Percent-encode reserved characters in the password. sslmode defaults to prefer; ' +
          'verify-full also needs sslrootcert=<path> or sslrootcert=system.'
      },
      {
        key: 'table',
        env: 'PG_TABLE',
        label: 'Table',
        description: 'For "new rows": table or schema.table to watch.',
        builderHint: 'Used by the newRows trigger only; actions take the table as an argument.'
      },
      {
        key: 'orderingColumn',
        env: 'PG_ORDERING_COLUMN',
        label: 'Ordering column',
        description: 'For "new rows": a column that only grows, such as id or created_at.',
        builderHint: 'The cursor is this column\'s last seen value; an updated_at that moves backwards will miss rows.'
      },
      {
        key: 'keyColumn',
        env: 'PG_KEY_COLUMN',
        label: 'Key column',
        description: 'The column that identifies a row, usually the primary key. Defaults to the ordering column for "new rows"; required for "rows matching a query".'
      },
      {
        key: 'query',
        env: 'PG_QUERY',
        label: 'Query',
        description:
          'For "rows matching a query": a SELECT with $1 where the cursor goes and, optionally, $2 for the limit, ordered by the cursor column ascending.',
        builderHint:
          "e.g. SELECT id, title, updated_at FROM tickets WHERE status = 'open' AND updated_at >= $1 ORDER BY updated_at LIMIT $2"
      },
      {
        key: 'cursorColumn',
        env: 'PG_CURSOR_COLUMN',
        label: 'Cursor column',
        description: 'For "rows matching a query": the result column the cursor advances from.'
      },
      {
        key: 'startFrom',
        env: 'PG_START_FROM',
        label: 'Start from',
        description:
          'Value of the ordering or cursor column to start after. Required for "rows matching a query"; for "new rows", blank means the newest page.'
      },
      {
        key: 'titleColumn',
        env: 'PG_TITLE_COLUMN',
        label: 'Title column',
        description: 'Column to use as the item title. Blank uses the table and key.'
      },
      {
        key: 'limit',
        env: 'PG_LIMIT',
        label: 'Rows per poll',
        default: String(DEFAULT_LIMIT)
      }
    ],
    triggers: [
      {
        type: 'newRows',
        label: 'New rows in a table',
        description: 'Fires once per row inserted after the last seen value of the ordering column.',
        defaultWorkflow: { name: 'PostgreSQL: new rows', defaultCronFromMinutes: 5 },
        poll: pollNewRows
      },
      {
        type: 'queryRows',
        label: 'Rows matching a query',
        description: 'Fires once per row your SELECT returns beyond the cursor value it was last run with.',
        defaultWorkflow: { name: 'PostgreSQL: query rows', defaultCronFromMinutes: 5 },
        poll: pollQueryRows
      }
    ],
    actions: [
      {
        type: 'runQuery',
        label: 'Run a query',
        description: 'Run SQL text with positional parameters and return its rows and row count.',
        // The text can write, so a retry can write twice.
        idempotent: false,
        inputs: [
          {
            key: 'sql',
            label: 'SQL',
            required: true,
            description: 'SQL text; several statements are allowed when there are no params.',
            builderHint: 'Values go in params as $1, $2 …; never interpolate them into the text.'
          },
          {
            key: 'params',
            label: 'Parameters',
            type: 'json',
            description: 'Positional values for $1…, as a JSON array.'
          }
        ],
        outputs: [
          { key: 'rows', description: 'The rows of the last result set' },
          { key: 'rowCount', type: 'number', description: 'Rows the last statement touched or returned' },
          { key: 'command', type: 'string', description: 'The command tag, e.g. SELECT or UPDATE' }
        ],
        async run(args, { config }) {
          const sql = text(args.sql)
          if (!sql) throw new Error('sql is required')
          const params = jsonArray(args.params, 'params')
          const result = await withClient(config as Config, (client) => client.query(sql, params))
          return { rows: rowsOf(result), rowCount: result.rowCount, command: result.command }
        }
      },
      {
        type: 'selectRows',
        label: 'Select rows',
        description: 'Read rows from a table, with an optional parameterised WHERE.',
        idempotent: true,
        sample: { table: 'pg_catalog.pg_tables', limit: '1' },
        inputs: [
          { key: 'table', label: 'Table', required: true, description: 'table or schema.table' },
          {
            key: 'where',
            label: 'Where',
            description: 'SQL placed after WHERE, with $1… placeholders, e.g. status = $1'
          },
          { key: 'params', label: 'Parameters', type: 'json', description: 'Values for the placeholders, a JSON array.' },
          { key: 'orderBy', label: 'Order by', description: 'Column name to order by, ascending.' },
          {
            key: 'limit',
            label: 'Limit',
            type: 'number',
            description: `Default ${DEFAULT_LIMIT}, at most ${MAX_SELECT_LIMIT}.`
          }
        ],
        outputs: [
          { key: 'rows', description: 'The rows' },
          { key: 'rowCount', type: 'number', description: 'How many came back' }
        ],
        async run(args, { config }) {
          const table = text(args.table)
          if (!table) throw new Error('table is required')
          const limitArg = Number(args.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT
          const statement = buildSelect({
            table,
            ...(text(args.where) && { where: text(args.where) }),
            params: jsonArray(args.params, 'params'),
            ...(text(args.orderBy) && { orderBy: text(args.orderBy) }),
            limit: Math.min(Math.max(1, Math.floor(limitArg)), MAX_SELECT_LIMIT)
          })
          const result = await withClient(config as Config, (client) => client.query(statement.text, statement.params))
          return { rows: rowsOf(result), rowCount: result.rows.length }
        }
      },
      {
        type: 'insertRow',
        label: 'Insert a row',
        description: 'Insert one row and return it as stored.',
        idempotent: false,
        inputs: [
          { key: 'table', label: 'Table', required: true, description: 'table or schema.table' },
          {
            key: 'values',
            label: 'Values',
            type: 'json',
            required: true,
            description: 'JSON object of column: value.',
            builderHint: 'An array column takes its PostgreSQL text form, e.g. "{1,2}"; a json column takes any JSON.'
          }
        ],
        outputs: [
          { key: 'row', description: 'The inserted row, from RETURNING *' },
          { key: 'rowCount', type: 'number', description: '1 when a row was inserted' }
        ],
        async run(args, { config }) {
          const table = text(args.table)
          if (!table) throw new Error('table is required')
          const statement = buildInsert(table, jsonObject(args.values, 'values'))
          const result = await withClient(config as Config, (client) => client.query(statement.text, statement.params))
          return { row: rowsOf(result)[0] ?? null, rowCount: result.rowCount }
        }
      },
      {
        type: 'updateRows',
        label: 'Update rows',
        description: 'Set columns on the rows a WHERE matches and return how many changed.',
        // The rows a where matches can change between retries.
        idempotent: false,
        inputs: [
          { key: 'table', label: 'Table', required: true, description: 'table or schema.table' },
          { key: 'set', label: 'Set', type: 'json', required: true, description: 'JSON object of column: new value.' },
          {
            key: 'where',
            label: 'Where',
            required: true,
            description: 'SQL placed after WHERE, with $1… placeholders. Required, so a step cannot update every row by omission.'
          },
          { key: 'params', label: 'Parameters', type: 'json', description: 'Values for the where placeholders, a JSON array.' }
        ],
        outputs: [{ key: 'rowCount', type: 'number', description: 'Rows updated' }],
        async run(args, { config }) {
          const table = text(args.table)
          if (!table) throw new Error('table is required')
          const statement = buildUpdate({
            table,
            set: jsonObject(args.set, 'set'),
            where: text(args.where) ?? '',
            params: jsonArray(args.params, 'params')
          })
          const result = await withClient(config as Config, (client) => client.query(statement.text, statement.params))
          return { rowCount: result.rowCount }
        }
      },
      {
        type: 'listTables',
        label: 'List tables',
        description: 'List the tables and views in a schema that the role can see.',
        idempotent: true,
        sample: { schema: 'public' },
        inputs: [{ key: 'schema', label: 'Schema', description: 'Defaults to public.' }],
        outputs: [
          { key: 'tables', description: 'Array of { schema, name, type }' },
          { key: 'count', type: 'number', description: 'How many' }
        ],
        async run(args, { config }) {
          const schema = text(args.schema) ?? 'public'
          const result = await withClient(config as Config, (client) => client.query(LIST_TABLES_SQL, [schema]))
          const tables = rowsOf(result).map((row) => ({
            schema: row.table_schema,
            name: row.table_name,
            type: row.table_type
          }))
          return { tables, count: tables.length }
        }
      },
      {
        type: 'describeTable',
        label: 'Describe a table',
        description: 'List the columns of a table with their types and nullability.',
        idempotent: true,
        sample: { table: 'pg_catalog.pg_tables' },
        inputs: [{ key: 'table', label: 'Table', required: true, description: 'table (schema public) or schema.table' }],
        outputs: [
          { key: 'columns', description: 'Array of { name, type, udtName, nullable, default, position }' },
          { key: 'count', type: 'number', description: 'How many' }
        ],
        async run(args, { config }) {
          const ref = text(args.table)
          if (!ref) throw new Error('table is required')
          const { schema, table } = splitTable(ref)
          const result = await withClient(config as Config, (client) => client.query(DESCRIBE_TABLE_SQL, [schema, table]))
          const columns = rowsOf(result).map((row) => ({
            name: row.column_name,
            type: row.data_type,
            udtName: row.udt_name,
            nullable: row.is_nullable === 'YES',
            default: row.column_default,
            position: row.ordinal_position
          }))
          // The view hides a missing table and a table without privilege the same way: no rows.
          if (columns.length === 0) throw new Error(`no such table as ${schema}.${table}, or no privilege on it`)
          return { columns, count: columns.length }
        }
      }
    ]
  })
}
