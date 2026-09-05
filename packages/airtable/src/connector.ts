import {
  defineConnector,
  type ConnectorConfig,
  type ConnectorItem,
  type FetchContext
} from '@vornrun/connector-sdk'
import {
  API_ROOT,
  MAX_BATCH_RECORDS,
  MAX_PAGE_SIZE,
  createAirtableClient,
  createRateLimiter,
  type AirtableRecord
} from './client'
import {
  SAMPLE_BASE_ID,
  SAMPLE_RECORD,
  SAMPLE_TABLE_ID,
  SAMPLE_UPDATED_RECORD,
  andFormulas,
  fieldReference,
  recordOutput,
  recordToItem,
  sinceFormula
} from './items'
// Bundled at build time: a pack is one file, so a version read from disk is not there to read.
import pkg from '../package.json'

export interface AirtableConnectorOptions {
  version?: string
  /** Where live samples are read from; defaults to the process environment. */
  env?: NodeJS.ProcessEnv
  /** Replaced in tests so a rate-limit wait costs no real time. */
  sleep?: (ms: number) => Promise<void>
  /** The clock the rate limiter spaces calls by, in milliseconds. */
  now?: () => number
  random?: () => number
}

// How far back the very first poll looks, before any watermark exists.
const FIRST_POLL_LOOKBACK_MS = 60 * 60_000

const MAX_MERGE_FIELDS = 3

const PLACEHOLDER_BASE_ID = 'appXXXXXXXXXXXXXX'
const PLACEHOLDER_TABLE_ID = 'tblXXXXXXXXXXXXXX'

function text(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim()
  return trimmed || undefined
}

function required(config: ConnectorConfig, key: string, env: string): string {
  const value = text(config[key])
  if (value === undefined) throw new Error(`${env} is required`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A json input arrives parsed from the harness and as text from a direct call; both are read.
function parsed(value: unknown, key: string): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${key} must be JSON`)
  }
}

// Cell values keyed by field name or id, as Airtable takes `fields`.
export function fieldsArg(value: unknown, key = 'fields'): Record<string, unknown> {
  const object = parsed(value, key)
  if (!isRecord(object)) throw new Error(`${key} must be a JSON object of cell values keyed by field name`)
  return object
}

// Up to ten `{ fields }` entries; a bare object is one record, with or without its `fields` wrapper.
export function recordsArg(value: unknown): Array<{ fields: Record<string, unknown> }> {
  const raw = parsed(value, 'records')
  const entries = Array.isArray(raw) ? raw : [raw]
  if (entries.length > MAX_BATCH_RECORDS) {
    throw new Error(`records may hold at most ${MAX_BATCH_RECORDS} entries per call, got ${entries.length}`)
  }
  return entries.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`records[${index}] must be an object`)
    const fields = isRecord(entry.fields) ? entry.fields : entry
    return { fields }
  })
}

// Field names as a JSON array or one comma-separated line, whichever the step found easier to write.
export function namesArg(value: unknown, key: string): string[] {
  const raw = text(value)
  if (raw === undefined) return []
  const list = raw.startsWith('[') ? parsed(raw, key) : raw.split(',')
  if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${key} must be a JSON array of field names or a comma-separated list`)
  }
  return (list as string[]).map((entry) => entry.trim()).filter((entry) => entry !== '')
}

// One or more `{ field, direction }` entries; a single object is a list of one.
export function sortArg(value: unknown): Array<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined
  const raw = parsed(value, 'sort')
  const entries = Array.isArray(raw) ? raw : [raw]
  if (!entries.every(isRecord)) throw new Error('sort must be a JSON array of { field, direction } objects')
  return entries
}

// A whole number within Airtable's bounds; unset stays unset so the API applies its own default.
export function count(value: unknown, key: string, max?: number): number | undefined {
  if (value === undefined || value === '') return undefined
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || (max !== undefined && number > max)) {
    const bound = max === undefined ? 'of at least 1' : `from 1 to ${max}`
    throw new Error(`${key} must be a whole number ${bound}, got "${String(value)}"`)
  }
  return number
}

function flag(value: unknown): true | undefined {
  return value === true || value === 'true' ? true : undefined
}

// A last-modified cell as the item's time; the created time when the cell is empty or not a date.
export function modifiedAt(record: AirtableRecord, field: string): string {
  const value = record.fields?.[field]
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value
  return record.createdTime
}

const BASE_ID_INPUT = {
  key: 'baseId',
  label: 'Base',
  required: true,
  description: 'The base id, app…, from the base URL or listBases.',
  builderHint: 'The first path segment of every record route; the token must have been granted access to this base when it was created.'
}

const TABLE_INPUT = {
  key: 'table',
  label: 'Table',
  required: true,
  description: 'Table id (tbl…) or table name.',
  builderHint: 'Sent URL-encoded as the second path segment; a name works but only an id lets the connector build a record URL.'
}

const RECORD_ID_INPUT = {
  key: 'recordId',
  label: 'Record',
  required: true,
  description: 'The record id, rec…',
  builderHint: 'Sent URL-encoded as the last path segment; an unknown id answers 404 NOT_FOUND.'
}

const TYPECAST_INPUT = {
  key: 'typecast',
  label: 'Typecast',
  type: 'boolean' as const,
  description: 'Let Airtable convert strings to the field’s type, such as "3" into a number or a new option name into a select choice.',
  builderHint: 'Sent as typecast: true only when set; "automatic conversion is disabled by default to ensure data integrity".'
}

const RETURN_BY_ID_INPUT = {
  key: 'returnFieldsByFieldId',
  label: 'Return fields by id',
  type: 'boolean' as const,
  description: 'Key the returned fields by field id (fld…) instead of by name.',
  builderHint: 'Sent as returnFieldsByFieldId: true only when set; field ids survive a rename, names do not.'
}

const FIELDS_INPUT = (verb: string) => ({
  key: 'fields',
  label: 'Fields',
  type: 'json' as const,
  required: true,
  description: `An object of cell values keyed by field name or id ${verb}, e.g. {"Name":"Union Square","Visited":true}.`,
  builderHint: 'Sent as the fields object of the JSON body; a name Airtable does not know answers 422 UNKNOWN_FIELD_NAME, and a value of the wrong type 422 INVALID_VALUE_FOR_COLUMN unless typecast is set.'
})

const RECORD_OUTPUTS = [
  { key: 'id', description: 'Record id, rec…' },
  { key: 'createdTime', description: 'When the record was created, ISO 8601' },
  { key: 'fields', description: 'The cell values keyed by field name; empty cells are omitted' },
  { key: 'url', description: 'Where to open it, when the table was given by id' }
]

export function createAirtableConnector(options: AirtableConnectorOptions = {}) {
  const env = options.env ?? process.env
  const clock = options.now ?? Date.now

  // One bucket per base for the whole process, so a poll and a step on the same base share the five per second.
  const limiter = createRateLimiter({
    now: clock,
    ...(options.sleep && { sleep: options.sleep })
  })

  function client(context: { config: ConnectorConfig; fetch: typeof fetch }) {
    return createAirtableClient({
      apiKey: required(context.config, 'apiKey', 'AIRTABLE_API_KEY'),
      fetch: context.fetch,
      limiter,
      now: clock,
      ...(options.sleep && { sleep: options.sleep }),
      ...(options.random && { random: options.random })
    })
  }

  function scope(config: ConnectorConfig) {
    return {
      baseId: required(config, 'baseId', 'AIRTABLE_BASE_ID'),
      table: required(config, 'table', 'AIRTABLE_TABLE'),
      view: text(config.view),
      filter: text(config.filterByFormula)
    }
  }

  // The watermark, or the hour before now on the very first poll rather than the table's whole history.
  function watermarkOf(context: FetchContext): string {
    return context.since ?? new Date(Date.parse(context.now()) - FIRST_POLL_LOOKBACK_MS).toISOString()
  }

  // `sort` takes only field names and CREATED_TIME() is not one, so the order is settled here.
  async function fetchNewRecords(context: FetchContext): Promise<ConnectorItem[]> {
    const { baseId, table, view, filter } = scope(context.config)
    const records = await client(context).listRecords(baseId, table, {
      filterByFormula: andFormulas(sinceFormula('CREATED_TIME()', watermarkOf(context)), filter),
      ...(view && { view }),
      pageSize: MAX_PAGE_SIZE
    })
    return records
      .sort((left, right) => left.createdTime.localeCompare(right.createdTime))
      .map((record) => recordToItem(record, { baseId, table }))
  }

  // With a last-modified field the record carries its own time; without one only Airtable knows it, so the poll time stands in.
  async function fetchUpdatedRecords(context: FetchContext): Promise<ConnectorItem[]> {
    const { baseId, table, view, filter } = scope(context.config)
    const since = watermarkOf(context)
    const field = text(context.config.lastModifiedField)
    if (field !== undefined) {
      const reference = fieldReference(field)
      const records = await client(context).listRecords(baseId, table, {
        filterByFormula: andFormulas(reference, sinceFormula(reference, since), filter),
        sort: [{ field, direction: 'asc' }],
        ...(view && { view }),
        pageSize: MAX_PAGE_SIZE
      })
      return records.map((record) => recordToItem(record, { baseId, table, updatedAt: modifiedAt(record, field) }))
    }
    const polledAt = context.now()
    const records = await client(context).listRecords(baseId, table, {
      filterByFormula: andFormulas(sinceFormula('LAST_MODIFIED_TIME()', since), filter),
      ...(view && { view }),
      pageSize: MAX_PAGE_SIZE
    })
    return records.map((record) => recordToItem(record, { baseId, table, updatedAt: polledAt }))
  }

  // Live samples come from the environment; the placeholders stand in where a real id is not known.
  const sampleBase = text(env.AIRTABLE_BASE_ID)
  const sampleTable = text(env.AIRTABLE_TABLE)
  const sampleRecord = text(env.AIRTABLE_RECORD_ID)
  const baseId = sampleBase ?? PLACEHOLDER_BASE_ID
  const table = sampleTable ?? PLACEHOLDER_TABLE_ID

  return defineConnector({
    id: 'airtable',
    name: 'Airtable',
    version: options.version ?? pkg.version,
    description:
      'Trigger workflows from new or updated Airtable records, and create, update, upsert, delete or read records and base schemas from a step.',
    // Airtable's stacked plates: the top rhombus and the two lower faces.
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M12 1.5 23 6l-11 4.5L1 6z',
        'M1 8l10 4.5v11L1 19z',
        'M13 12.5l8.6-3.9L23 9.3v9.2L13 23z'
      ]
    },
    auth: { rung: 'key', keys: ['apiKey'] },
    config: [
      {
        key: 'apiKey',
        env: 'AIRTABLE_API_KEY',
        label: 'Personal access token',
        secret: true,
        required: true,
        description:
          'A personal access token from airtable.com/create/tokens with the scopes data.records:read, data.records:write and schema.bases:read, granted access to each base it should reach.',
        builderHint:
          'Sent as Authorization: Bearer on every call. Scopes are not enough: the token lists the bases it may touch, and one it was not granted answers 403 or 404. There is no Airtable CLI to borrow a login from.'
      },
      {
        key: 'baseId',
        env: 'AIRTABLE_BASE_ID',
        label: 'Base',
        required: true,
        description: 'The base the triggers watch, app… from the base URL or listBases.',
        builderHint: 'Only the triggers read it; every action takes its own baseId input.'
      },
      {
        key: 'table',
        env: 'AIRTABLE_TABLE',
        label: 'Table',
        required: true,
        description: 'The table the triggers watch, by id (tbl…) or by name.',
        builderHint: 'A name is URL-encoded into the path; an id also lets each item carry a record URL.'
      },
      {
        key: 'view',
        env: 'AIRTABLE_VIEW',
        label: 'View',
        description: 'A view name or id to watch. Records hidden by the view are skipped. Blank for the whole table.',
        builderHint: 'Sent as view on the listRecords body; records come back in the view’s order and its filters apply.'
      },
      {
        key: 'filterByFormula',
        env: 'AIRTABLE_FILTER_BY_FORMULA',
        label: 'Filter formula',
        description: 'An extra Airtable formula a record must satisfy, such as {Status} = "Open".',
        builderHint: 'ANDed with the time clause each poll sends: AND(NOT(IS_BEFORE(CREATED_TIME(), DATETIME_PARSE("…"))), <formula>).'
      },
      {
        key: 'lastModifiedField',
        env: 'AIRTABLE_LAST_MODIFIED_FIELD',
        label: 'Last modified field',
        description:
          'The name of a "Last modified time" field in the table, for the updated-record trigger. Blank falls back to LAST_MODIFIED_TIME() and the poll time.',
        builderHint:
          'The list response has no modification time, so without this field the trigger stamps each record with the poll time and fires once per poll a record was touched in; with it the cell value is the item’s updatedAt and the sort key.'
      }
    ],
    triggers: [
      {
        type: 'newRecord',
        label: 'A record is created',
        description: 'Fires once for each record created in the table since the last poll, oldest first.',
        dedupe: 'timestamp',
        fetch: fetchNewRecords,
        defaultWorkflow: { name: 'Airtable: new records', defaultCronFromMinutes: 5 },
        sample: [recordToItem(SAMPLE_RECORD, { baseId: SAMPLE_BASE_ID, table: SAMPLE_TABLE_ID })]
      },
      {
        type: 'updatedRecord',
        label: 'A record is updated',
        description:
          'Fires for each record modified since the last poll. Name a last-modified-time field to stamp items with the real time; without one the poll time stands in.',
        dedupe: 'timestamp',
        fetch: fetchUpdatedRecords,
        defaultWorkflow: { name: 'Airtable: updated records', defaultCronFromMinutes: 5 },
        sample: [
          recordToItem(SAMPLE_UPDATED_RECORD, {
            baseId: SAMPLE_BASE_ID,
            table: SAMPLE_TABLE_ID,
            updatedAt: modifiedAt(SAMPLE_UPDATED_RECORD, 'Last modified')
          })
        ]
      }
    ],
    actions: [
      {
        type: 'createRecord',
        label: 'Create a record',
        description: 'Add one record to a table.',
        // Two calls make two records; Airtable offers no idempotency key.
        idempotent: false,
        inputs: [BASE_ID_INPUT, TABLE_INPUT, FIELDS_INPUT('to set'), TYPECAST_INPUT, RETURN_BY_ID_INPUT],
        outputs: RECORD_OUTPUTS,
        async run(args, context) {
          const baseId = String(args.baseId)
          const table = String(args.table)
          const record = await client(context).createRecord(baseId, table, {
            fields: fieldsArg(args.fields),
            typecast: flag(args.typecast),
            returnFieldsByFieldId: flag(args.returnFieldsByFieldId)
          })
          return recordOutput(record, baseId, table)
        }
      },
      {
        type: 'updateRecord',
        label: 'Update a record',
        description: 'Change the given fields of a record and leave the rest as they were.',
        // PATCH with the same values lands the same record twice.
        idempotent: true,
        inputs: [BASE_ID_INPUT, TABLE_INPUT, RECORD_ID_INPUT, FIELDS_INPUT('to change'), TYPECAST_INPUT, RETURN_BY_ID_INPUT],
        outputs: RECORD_OUTPUTS,
        async run(args, context) {
          const baseId = String(args.baseId)
          const table = String(args.table)
          const record = await client(context).updateRecord(baseId, table, String(args.recordId), {
            fields: fieldsArg(args.fields),
            typecast: flag(args.typecast),
            returnFieldsByFieldId: flag(args.returnFieldsByFieldId)
          })
          return recordOutput(record, baseId, table)
        }
      },
      {
        type: 'upsertRecords',
        label: 'Upsert records',
        description:
          'Create or update up to 10 records at once, matching each on the merge fields: no match creates, one match updates, several fail the call.',
        // A merge value that changes between runs creates rather than updates.
        idempotent: false,
        inputs: [
          BASE_ID_INPUT,
          TABLE_INPUT,
          {
            key: 'records',
            label: 'Records',
            type: 'json',
            required: true,
            description: 'An array of up to 10 {"fields": {…}} objects; a single object is taken as one record.',
            builderHint: 'Sent as records on PATCH {baseId}/{table}; more than 10 is refused here rather than split, because a failure mid-batch is not reported per record.'
          },
          {
            key: 'fieldsToMergeOn',
            label: 'Fields to merge on',
            required: true,
            description: 'One to three field names or ids that identify a record, comma-separated or as a JSON array.',
            builderHint: 'Sent as performUpsert.fieldsToMergeOn; they act as external ids and cannot be computed fields.'
          },
          TYPECAST_INPUT
        ],
        outputs: [
          { key: 'records', description: 'Every record touched, as { id, createdTime, fields }' },
          { key: 'createdRecords', description: 'The ids of records that were created' },
          { key: 'updatedRecords', description: 'The ids of records that were updated' }
        ],
        async run(args, context) {
          const fieldsToMergeOn = namesArg(args.fieldsToMergeOn, 'fieldsToMergeOn')
          if (fieldsToMergeOn.length < 1 || fieldsToMergeOn.length > MAX_MERGE_FIELDS) {
            throw new Error(`fieldsToMergeOn must name 1 to ${MAX_MERGE_FIELDS} fields, got ${fieldsToMergeOn.length}`)
          }
          const result = await client(context).upsertRecords(String(args.baseId), String(args.table), {
            performUpsert: { fieldsToMergeOn },
            records: recordsArg(args.records),
            typecast: flag(args.typecast)
          })
          return {
            records: result.records ?? [],
            createdRecords: result.createdRecords ?? [],
            updatedRecords: result.updatedRecords ?? []
          }
        }
      },
      {
        type: 'deleteRecord',
        label: 'Delete a record',
        description: 'Delete one record. A second call for the same id answers 404.',
        idempotent: false,
        inputs: [BASE_ID_INPUT, TABLE_INPUT, RECORD_ID_INPUT],
        outputs: [
          { key: 'id', description: 'The id that was deleted' },
          { key: 'deleted', type: 'boolean', description: 'True when Airtable confirmed the deletion' }
        ],
        async run(args, context) {
          const result = await client(context).deleteRecord(
            String(args.baseId),
            String(args.table),
            String(args.recordId)
          )
          return { id: result.id ?? String(args.recordId), deleted: result.deleted === true }
        }
      },
      {
        type: 'getRecord',
        label: 'Get a record',
        description: 'Read one record by id. Empty cells are omitted from fields.',
        idempotent: true,
        inputs: [BASE_ID_INPUT, TABLE_INPUT, RECORD_ID_INPUT, RETURN_BY_ID_INPUT],
        outputs: RECORD_OUTPUTS,
        ...(sampleBase &&
          sampleTable &&
          sampleRecord && { sample: { baseId: sampleBase, table: sampleTable, recordId: sampleRecord } }),
        async run(args, context) {
          const baseId = String(args.baseId)
          const table = String(args.table)
          const record = await client(context).getRecord(baseId, table, String(args.recordId), {
            returnFieldsByFieldId: flag(args.returnFieldsByFieldId)
          })
          return recordOutput(record, baseId, table)
        }
      },
      {
        type: 'listRecords',
        label: 'List records',
        description: 'List the records of a table, optionally filtered by a formula or a view, up to maxRecords across pages.',
        idempotent: true,
        inputs: [
          BASE_ID_INPUT,
          TABLE_INPUT,
          {
            key: 'filterByFormula',
            label: 'Filter formula',
            description: 'An Airtable formula; only records where it is truthy are returned, e.g. {Status} = "Open".',
            builderHint: 'Sent in the JSON body of POST {baseId}/{table}/listRecords, so its length is not bound by the 16,000 character URL limit.'
          },
          {
            key: 'view',
            label: 'View',
            description: 'A view name or id; records come back in the view’s order and hidden ones are skipped.',
            builderHint: 'Sent as view; a name is matched exactly, spaces included.'
          },
          {
            key: 'maxRecords',
            label: 'Maximum records',
            type: 'number',
            description: 'Total records to return across pages. Defaults to 100.',
            builderHint: 'Sent as maxRecords and enforced here as well; at most ten pages of 100 are walked in one call.'
          },
          {
            key: 'pageSize',
            label: 'Page size',
            type: 'number',
            description: 'Records per request, 1 to 100. Defaults to 100.',
            builderHint: 'Sent as pageSize; a smaller page only costs more requests against the 5 per second limit.'
          },
          {
            key: 'fields',
            label: 'Fields',
            description: 'Field names or ids to include, comma-separated or as a JSON array. Blank returns every field.',
            builderHint: 'Sent as the fields array; the primary field is not added on its own.'
          },
          {
            key: 'sort',
            label: 'Sort',
            type: 'json',
            description: 'An array of {"field": "Name", "direction": "asc"} objects; direction is asc or desc.',
            builderHint: 'Sent as sort; it takes field names only, so CREATED_TIME() and other formulas cannot be sorted on.'
          },
          RETURN_BY_ID_INPUT
        ],
        outputs: [
          { key: 'records', description: 'One entry per record: id, createdTime, fields, url' },
          { key: 'count', type: 'number', description: 'How many records came back' }
        ],
        sample: { baseId, table, maxRecords: '5' },
        async run(args, context) {
          const base = String(args.baseId)
          const tableRef = String(args.table)
          const fields = namesArg(args.fields, 'fields')
          const records = await client(context).listRecords(base, tableRef, {
            filterByFormula: text(args.filterByFormula),
            view: text(args.view),
            maxRecords: count(args.maxRecords, 'maxRecords') ?? MAX_PAGE_SIZE,
            pageSize: count(args.pageSize, 'pageSize', MAX_PAGE_SIZE),
            ...(fields.length > 0 && { fields }),
            sort: sortArg(args.sort),
            returnFieldsByFieldId: flag(args.returnFieldsByFieldId)
          })
          const output = records.map((record) => recordOutput(record, base, tableRef))
          return { records: output, count: output.length }
        }
      },
      {
        type: 'listBases',
        label: 'List bases',
        description: 'The bases the token can reach, 1000 at a time, with the permission level it holds on each.',
        idempotent: true,
        inputs: [
          {
            key: 'offset',
            label: 'Offset',
            description: 'The offset from an earlier answer, to fetch the next thousand bases.',
            builderHint: 'Sent as the offset query parameter; present in the output only when another page exists.'
          }
        ],
        outputs: [
          { key: 'bases', description: 'One entry per base: id, name, permissionLevel (none, read, comment, edit or create)' },
          { key: 'offset', description: 'Pass back to fetch the next page, when present' }
        ],
        sample: {},
        request: {
          url: `${API_ROOT}/meta/bases`,
          headers: { Authorization: 'Bearer {{config.apiKey}}' },
          query: { offset: '{{args.offset}}' }
        },
        postReceive: [{ op: 'pick', keys: ['bases', 'offset'] }]
      },
      {
        type: 'getBaseSchema',
        label: 'Get a base schema',
        description: 'The tables of a base with their fields and views.',
        idempotent: true,
        inputs: [
          {
            ...BASE_ID_INPUT,
            builderHint: 'Sent as the path segment of GET meta/bases/{baseId}/tables; needs the schema.bases:read scope.'
          }
        ],
        outputs: [
          {
            key: 'tables',
            description: 'One entry per table: id, name, primaryFieldId, fields [{ id, name, type, options }], views [{ id, name, type }]'
          }
        ],
        sample: { baseId },
        request: {
          url: `${API_ROOT}/meta/bases/{{args.baseId}}/tables`,
          headers: { Authorization: 'Bearer {{config.apiKey}}' }
        },
        postReceive: [{ op: 'pick', keys: ['tables'] }]
      }
    ]
  })
}

export const connector = createAirtableConnector()
