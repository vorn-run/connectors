import {
  defineConnector,
  type ConnectorConfigField,
  type ConnectorItem,
  type PollContext,
  type PollOutcome
} from '@vornrun/connector-sdk'
import { parseConnectionString, SSL_MODES, type ConnectionOptions } from './connection-string'
import { clientFrom, PoolRegistry, type MysqlClient, type QueryResult, type SqlPool } from './driver'
import {
  buildCount,
  buildDelete,
  buildInsert,
  buildNewRows,
  buildSelect,
  buildUpdate,
  buildUpdatedRows,
  DESCRIBE_TABLE_SQL,
  jsonArray,
  jsonObject,
  LIST_TABLES_SQL,
  splitTable,
  type Row,
  type Statement
} from './sql'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000
const CURSOR_VERSION = 1
const SAMPLE_TABLE = 'information_schema.TABLES'

// Each field states its env name once; an error about a missing one reads it back from here.
const CONFIG_FIELDS: ConnectorConfigField[] = [
  {
    key: 'connectionString',
    env: 'MYSQL_URL',
    label: 'Connection URL',
    secret: true,
    required: true,
    description:
      'mysql://user:password@host:3306/database. Your provider shows it on the database page; otherwise ask your DBA. ' +
      'The user needs SELECT, INSERT, UPDATE or DELETE on the tables the workflow touches, as the steps demand.',
    builderHint:
      'Percent-encode @ / : ? # and % in the password. The port defaults to 3306; the database after the slash is the default schema. ' +
      'An ssl-mode=… attribute is honoured when the ssl setting is blank.'
  },
  {
    key: 'ssl',
    env: 'MYSQL_SSL',
    label: 'TLS',
    description: `One of ${SSL_MODES.join(', ')}. Default disabled. "required" encrypts without checking the certificate, which the driver strongly discourages; "verify-full" checks the chain and host name.`,
    builderHint: 'Cloud providers usually want verify-full with their CA bundle in sslCa, or required when the bundle is unavailable.'
  },
  {
    key: 'sslCa',
    env: 'MYSQL_SSL_CA',
    label: 'CA bundle path',
    description: 'Path to a PEM CA bundle for verify-full against a private CA. Blank uses Node\'s roots.'
  },
  {
    key: 'table',
    env: 'MYSQL_TABLE',
    label: 'Table',
    description: 'For both triggers: table or db.table to watch.',
    builderHint: 'Used by the triggers only; actions take the table as an argument.'
  },
  {
    key: 'orderingColumn',
    env: 'MYSQL_ORDERING_COLUMN',
    label: 'Ordering column',
    description: 'For "new rows": a column that only grows, such as an AUTO_INCREMENT id or created_at.',
    builderHint: 'The cursor is this column\'s last seen value; an updated_at that moves backwards will miss rows.'
  },
  {
    key: 'keyColumn',
    env: 'MYSQL_KEY_COLUMN',
    label: 'Key column',
    description: 'The primary key column. Defaults to the ordering column for "new rows"; required for "updated rows".'
  },
  {
    key: 'updatedAtColumn',
    env: 'MYSQL_UPDATED_AT_COLUMN',
    label: 'Updated-at column',
    description: 'For "updated rows": a DATETIME or TIMESTAMP column, ideally ON UPDATE CURRENT_TIMESTAMP.'
  },
  {
    key: 'where',
    env: 'MYSQL_WHERE',
    label: 'Where',
    description: 'Optional SQL placed after WHERE to narrow the rows a trigger watches, e.g. status = \'open\'. No placeholders.'
  },
  {
    key: 'startFrom',
    env: 'MYSQL_START_FROM',
    label: 'Start from',
    description: 'Value of the ordering column to start after ("new rows") or of updated_at to start at ("updated rows"). Blank means the newest page.'
  },
  {
    key: 'titleColumn',
    env: 'MYSQL_TITLE_COLUMN',
    label: 'Title column',
    description: 'Column to use as the item title. Blank uses the table and key.'
  },
  {
    key: 'limit',
    env: 'MYSQL_LIMIT',
    label: 'Rows per poll',
    default: String(DEFAULT_LIMIT),
    description: `Default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}.`
  }
]

export interface MysqlConnectorOptions {
  version?: string
  /** Replaced in tests, so no socket is ever opened. */
  openPool?: (options: ConnectionOptions) => SqlPool
}

type Config = Record<string, unknown>

/** Trim a value, treating blank as absent. */
function text(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim()
  return trimmed === '' ? undefined : trimmed
}

function required(config: Config, key: string): string {
  const value = text(config[key])
  if (!value) throw new Error(`${CONFIG_FIELDS.find((field) => field.key === key)?.env} is required`)
  return value
}

function requiredArg(value: unknown, name: string): string {
  const trimmed = text(value)
  if (!trimmed) throw new Error(`${name} is required`)
  return trimmed
}

function clampLimit(value: unknown): number {
  const asked = Number(value ?? DEFAULT_LIMIT) || DEFAULT_LIMIT
  return Math.min(Math.max(1, Math.floor(asked)), MAX_LIMIT)
}

function pageLimit(config: Config, context: { limit?: number }): number {
  return clampLimit(context.limit && context.limit > 0 ? context.limit : config.limit)
}

/** A column's value as it came from the driver, refusing NULL or a column the row lacks. */
function cell(row: Row, column: string, what: string): unknown {
  const value = row[column]
  if (value === null || value === undefined) throw new Error(`the ${what} "${column}" is NULL in a row, so it cannot identify it`)
  return value
}

function cellText(row: Row, column: string, what: string): string {
  const value = cell(row, column, what)
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

// The server's DATE, DATETIME and TIMESTAMP text, which becomes ISO 8601 with a T.
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2}(\.\d+)?)?$/

function isoFrom(value: unknown): string | undefined {
  return typeof value === 'string' && DATE_TEXT.test(value) ? value.replace(' ', 'T') : undefined
}

function itemFrom(
  row: Row,
  options: { externalId: string; key: string; titleColumn?: string; fallbackPrefix: string; timeColumn: string }
): ConnectorItem {
  const titleValue = options.titleColumn !== undefined ? row[options.titleColumn] : undefined
  const title =
    titleValue === null || titleValue === undefined ? `${options.fallbackPrefix} ${options.key}` : String(titleValue)
  const item: ConnectorItem = { externalId: options.externalId, title, data: row }
  const updatedAt = isoFrom(row[options.timeColumn])
  if (updatedAt !== undefined) item.updatedAt = updatedAt
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

const isScalar = (value: unknown): value is string | number => typeof value === 'string' || typeof value === 'number'

export function createMysqlConnector(options: MysqlConnectorOptions = {}) {
  const registry = new PoolRegistry(options.openPool)

  function connection(config: Config): ConnectionOptions {
    return parseConnectionString(required(config, 'connectionString'), { ssl: config.ssl, sslCa: config.sslCa })
  }

  function client(config: unknown): MysqlClient {
    return clientFrom(registry.get(connection(config as Config)))
  }

  function run(config: unknown, statement: Statement): Promise<QueryResult> {
    const c = client(config)
    return statement.params.length === 0 ? c.query(statement.text) : c.execute(statement.text, statement.params)
  }

  async function pollNewRows(context: PollContext): Promise<PollOutcome> {
    const config = context.config as Config
    const table = required(config, 'table')
    const orderingColumn = required(config, 'orderingColumn')
    const keyColumn = text(config.keyColumn) ?? orderingColumn
    const titleColumn = text(config.titleColumn)
    const where = text(config.where)
    const startFrom = text(config.startFrom)
    const limit = pageLimit(config, context)
    const cursor = parseCursor(context.cursor, (parsed) =>
      isScalar(parsed.o) && isScalar(parsed.k) ? { ordering: parsed.o, key: parsed.k } : undefined
    )

    const statement = buildNewRows({
      table,
      orderingColumn,
      keyColumn,
      limit,
      ...(where && { where }),
      ...(cursor && { cursor }),
      ...(startFrom !== undefined && { startFrom })
    })
    const result = await run(config, statement)
    if (result.rows.length === 0) {
      return { items: [], ...(context.cursor !== undefined && { nextCursor: context.cursor }), hasMore: false }
    }

    const forward = cursor !== undefined || startFrom !== undefined
    const rows = forward ? result.rows : [...result.rows].reverse()
    const items = rows.map((row) => {
      const key = cellText(row, keyColumn, 'key column')
      cell(row, orderingColumn, 'ordering column')
      return itemFrom(row, { externalId: key, key, titleColumn, fallbackPrefix: table, timeColumn: orderingColumn })
    })
    const last = rows[rows.length - 1] as Row
    const nextCursor = JSON.stringify({
      v: CURSOR_VERSION,
      o: cell(last, orderingColumn, 'ordering column'),
      k: cell(last, keyColumn, 'key column')
    })
    return { items, nextCursor, hasMore: forward && rows.length >= limit }
  }

  async function pollUpdatedRows(context: PollContext): Promise<PollOutcome> {
    const config = context.config as Config
    const table = required(config, 'table')
    const updatedAtColumn = required(config, 'updatedAtColumn')
    const keyColumn = required(config, 'keyColumn')
    const titleColumn = text(config.titleColumn)
    const where = text(config.where)
    const limit = pageLimit(config, context)
    const cursor = parseCursor(context.cursor, (parsed) =>
      typeof parsed.c === 'string' && Array.isArray(parsed.keys) ? { value: parsed.c, keys: parsed.keys.map(String) } : undefined
    )
    const since = cursor?.value ?? text(config.startFrom)

    // The rows already delivered at the cursor value are excluded by the server, so a page of ties still advances.
    const result = await run(
      config,
      buildUpdatedRows({
        table,
        updatedAtColumn,
        keyColumn,
        limit,
        ...(where && { where }),
        ...(since !== undefined && { since }),
        ...(cursor && { exceptKeys: cursor.keys })
      })
    )
    const rows = since === undefined ? [...result.rows].reverse() : result.rows

    const items: ConnectorItem[] = []
    let newestValue = cursor?.value
    let newestKeys = cursor ? [...cursor.keys] : []
    for (const row of rows) {
      const key = cellText(row, keyColumn, 'key column')
      const value = cellText(row, updatedAtColumn, 'updated-at column')
      items.push(itemFrom(row, { externalId: `${key}@${value}`, key, titleColumn, fallbackPrefix: table, timeColumn: updatedAtColumn }))
      if (value === newestValue) newestKeys.push(key)
      else {
        newestValue = value
        newestKeys = [key]
      }
    }
    if (newestValue === undefined) return { items, ...(context.cursor !== undefined && { nextCursor: context.cursor }), hasMore: false }
    return {
      items,
      nextCursor: JSON.stringify({ v: CURSOR_VERSION, c: newestValue, keys: newestKeys }),
      hasMore: since !== undefined && rows.length >= limit
    }
  }

  const TABLE_INPUT = { key: 'table', label: 'Table', required: true, description: 'table or db.table' }
  const WHERE_INPUT = { key: 'where', label: 'Where', description: 'SQL placed after WHERE, with ? placeholders, e.g. status = ?' }
  const PARAMS_INPUT = { key: 'params', label: 'Parameters', type: 'json' as const, description: 'Values for the placeholders, a JSON array.' }

  const connector = defineConnector({
    id: 'mysql',
    name: 'MySQL',
    ...(options.version && { version: options.version }),
    description: 'Trigger workflows from new or updated rows in a MySQL or MariaDB database, and query or write to it from a step.',
    // A database cylinder with a stylised M: the dolphin is a trademark.
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M12 3c-4.97 0-9 1.34-9 3s4.03 3 9 3 9-1.34 9-3-4.03-3-9-3z',
        'M3 8v9c0 1.66 4.03 3 9 3s9-1.34 9-3V8h-2v9c0 .35-2.6 1-7 1s-7-.65-7-1V8z',
        'M7.5 16.5v-6h1.6l2.9 3.6 2.9-3.6h1.6v6h-1.6v-3.6L12 15.6l-2.9-2.7v3.6z'
      ]
    },
    auth: { rung: 'key', keys: ['connectionString'] },
    config: CONFIG_FIELDS,
    triggers: [
      {
        type: 'newRows',
        label: 'New rows in a table',
        description: 'Fires once per row inserted after the last seen value of the ordering column.',
        defaultWorkflow: { name: 'MySQL: new rows', defaultCronFromMinutes: 5 },
        poll: pollNewRows
      },
      {
        type: 'updatedRows',
        label: 'Updated rows in a table',
        description: 'Fires once per change to a row, tracked by its updated_at column and primary key.',
        defaultWorkflow: { name: 'MySQL: updated rows', defaultCronFromMinutes: 5 },
        poll: pollUpdatedRows
      }
    ],
    actions: [
      {
        type: 'runQuery',
        label: 'Run a query',
        description: 'Run one SQL statement with positional parameters; returns rows for a read and the counts for a write.',
        // The text can write, so a retry can write twice.
        idempotent: false,
        inputs: [
          {
            key: 'sql',
            label: 'SQL',
            required: true,
            description: 'One SQL statement, with ? placeholders.',
            builderHint: 'Values go in params; never interpolate them into the text.'
          },
          { key: 'params', label: 'Parameters', type: 'json', description: 'Positional values for the placeholders, a JSON array.' }
        ],
        outputs: [
          { key: 'rows', description: 'The rows of a read, empty for a write' },
          { key: 'rowCount', type: 'number', description: 'Rows returned, or rows a write touched' },
          { key: 'affectedRows', type: 'number', description: 'Rows a write touched, 0 for a read' },
          { key: 'insertId', type: 'number', description: 'The AUTO_INCREMENT value of an insert, else 0' },
          { key: 'warningStatus', type: 'number', description: 'How many warnings the server raised' }
        ],
        async run(args, { config }) {
          const result = await run(config, { text: requiredArg(args.sql, 'sql'), params: jsonArray(args.params, 'params') })
          const { rows, rowCount, affectedRows, insertId, warningStatus } = result
          return { rows, rowCount, affectedRows, insertId, warningStatus }
        }
      },
      {
        type: 'selectRows',
        label: 'Select rows',
        description: 'Read rows from a table, with an optional parameterised WHERE.',
        idempotent: true,
        sample: { table: SAMPLE_TABLE, limit: '1' },
        inputs: [
          TABLE_INPUT,
          { key: 'columns', label: 'Columns', type: 'json', description: 'JSON array of column names; all columns when omitted.' },
          WHERE_INPUT,
          PARAMS_INPUT,
          { key: 'orderBy', label: 'Order by', description: 'Column name to order by.' },
          { key: 'descending', label: 'Descending', type: 'boolean', description: 'Order descending; default ascending.' },
          { key: 'limit', label: 'Limit', type: 'number', description: `Default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}.` }
        ],
        outputs: [
          { key: 'rows', description: 'The rows' },
          { key: 'rowCount', type: 'number', description: 'How many came back' }
        ],
        async run(args, { config }) {
          const where = text(args.where)
          const orderBy = text(args.orderBy)
          const columns = jsonArray(args.columns, 'columns').map((column) => requiredArg(column, 'columns entry'))
          const statement = buildSelect({
            table: requiredArg(args.table, 'table'),
            columns,
            ...(where && { where }),
            params: jsonArray(args.params, 'params'),
            ...(orderBy && { orderBy }),
            descending: args.descending === true,
            limit: clampLimit(args.limit)
          })
          const result = await run(config, statement)
          return { rows: result.rows, rowCount: result.rows.length }
        }
      },
      {
        type: 'insertRow',
        label: 'Insert a row',
        description: 'Insert one row and return its AUTO_INCREMENT id.',
        idempotent: false,
        inputs: [
          TABLE_INPUT,
          {
            key: 'values',
            label: 'Values',
            type: 'json',
            required: true,
            description: 'JSON object of column: value, non-empty.',
            builderHint: 'An object or array value is sent as JSON text, so a JSON column takes any JSON.'
          }
        ],
        outputs: [
          { key: 'insertId', type: 'number', description: 'The AUTO_INCREMENT value, or 0' },
          { key: 'affectedRows', type: 'number', description: '1 when a row was inserted' }
        ],
        async run(args, { config }) {
          const result = await run(config, buildInsert(requiredArg(args.table, 'table'), jsonObject(args.values, 'values')))
          return { insertId: result.insertId, affectedRows: result.affectedRows }
        }
      },
      {
        type: 'updateRows',
        label: 'Update rows',
        description: 'Set columns on the rows a WHERE matches and return how many matched.',
        // The rows a where matches can change between retries.
        idempotent: false,
        inputs: [
          TABLE_INPUT,
          { key: 'values', label: 'Values', type: 'json', required: true, description: 'JSON object of column: new value, non-empty.' },
          {
            key: 'where',
            label: 'Where',
            required: true,
            description: 'SQL placed after WHERE, with ? placeholders. Required, so a step cannot update every row by omission.'
          },
          { ...PARAMS_INPUT, description: 'Values for the where placeholders, a JSON array; bound after the SET values.' }
        ],
        outputs: [
          { key: 'affectedRows', type: 'number', description: 'Rows matched' },
          { key: 'info', type: 'string', description: 'The server\'s Rows matched / Changed / Warnings text' }
        ],
        async run(args, { config }) {
          const statement = buildUpdate({
            table: requiredArg(args.table, 'table'),
            values: jsonObject(args.values, 'values'),
            where: requiredArg(args.where, 'where'),
            params: jsonArray(args.params, 'params')
          })
          const result = await run(config, statement)
          return { affectedRows: result.affectedRows, info: result.info }
        }
      },
      {
        type: 'deleteRows',
        label: 'Delete rows',
        description: 'Delete the rows a WHERE matches and return how many went.',
        idempotent: false,
        inputs: [
          TABLE_INPUT,
          {
            key: 'where',
            label: 'Where',
            required: true,
            description: 'SQL placed after WHERE, with ? placeholders. Required, so a step cannot delete every row by omission.'
          },
          PARAMS_INPUT
        ],
        outputs: [{ key: 'affectedRows', type: 'number', description: 'Rows deleted' }],
        async run(args, { config }) {
          const statement = buildDelete({
            table: requiredArg(args.table, 'table'),
            where: requiredArg(args.where, 'where'),
            params: jsonArray(args.params, 'params')
          })
          return { affectedRows: (await run(config, statement)).affectedRows }
        }
      },
      {
        type: 'listTables',
        label: 'List tables',
        description: 'List the tables and views in a database that the user can see.',
        idempotent: true,
        sample: {},
        inputs: [{ key: 'database', label: 'Database', description: 'Defaults to the database in the connection URL.' }],
        outputs: [
          { key: 'tables', description: 'Array of { name, type, engine, rows }' },
          { key: 'count', type: 'number', description: 'How many' }
        ],
        async run(args, { config }) {
          const database = text(args.database) ?? connection(config as Config).database
          if (!database) throw new Error('database is required when the connection URL names none')
          const result = await run(config, { text: LIST_TABLES_SQL, params: [database] })
          const tables = result.rows.map((row) => ({
            name: row.TABLE_NAME,
            type: row.TABLE_TYPE,
            engine: row.ENGINE ?? null,
            rows: row.TABLE_ROWS ?? null
          }))
          return { tables, count: tables.length }
        }
      },
      {
        type: 'describeTable',
        label: 'Describe a table',
        description: 'List the columns of a table with their types, nullability, keys and defaults.',
        idempotent: true,
        sample: { table: SAMPLE_TABLE },
        inputs: [{ key: 'table', label: 'Table', required: true, description: 'table (the URL\'s database) or db.table' }],
        outputs: [
          { key: 'columns', description: 'Array of { name, type, dataType, nullable, key, default, extra, position }' },
          { key: 'count', type: 'number', description: 'How many' }
        ],
        async run(args, { config }) {
          const ref = splitTable(requiredArg(args.table, 'table'))
          const database = ref.database ?? connection(config as Config).database
          if (!database) throw new Error('table must be db.table when the connection URL names no database')
          const result = await run(config, { text: DESCRIBE_TABLE_SQL, params: [database, ref.table] })
          const columns = result.rows.map((row) => ({
            name: row.COLUMN_NAME,
            type: row.COLUMN_TYPE,
            dataType: row.DATA_TYPE,
            nullable: row.IS_NULLABLE === 'YES',
            key: row.COLUMN_KEY ?? '',
            default: row.COLUMN_DEFAULT ?? null,
            extra: row.EXTRA ?? '',
            position: Number(row.ORDINAL_POSITION)
          }))
          // The view hides a missing table and a table without privilege the same way: no rows.
          if (columns.length === 0) throw new Error(`no such table as ${database}.${ref.table}, or no privilege on it`)
          return { columns, count: columns.length }
        }
      },
      {
        type: 'countRows',
        label: 'Count rows',
        description: 'Count the rows in a table, optionally those a WHERE matches.',
        idempotent: true,
        sample: { table: SAMPLE_TABLE },
        inputs: [TABLE_INPUT, WHERE_INPUT, PARAMS_INPUT],
        outputs: [{ key: 'count', type: 'number', description: 'The row count' }],
        async run(args, { config }) {
          const where = text(args.where)
          const statement = buildCount({
            table: requiredArg(args.table, 'table'),
            ...(where && { where }),
            params: jsonArray(args.params, 'params')
          })
          const result = await run(config, statement)
          return { count: Number(result.rows[0]?.count ?? 0) }
        }
      }
    ]
  })

  return Object.assign(connector, { closePools: () => registry.closeAll() })
}
