import type { ConnectorItem } from '@vornrun/connector-sdk'
import type { AirtableRecord } from './client'

const TABLE_ID = /^tbl[A-Za-z0-9]+$/

// A record opens at base/table/record, but only a table id makes that path; a name needs a schema call the connector does not make.
export function recordUrl(baseId: string, table: string, recordId: string): string | undefined {
  if (!TABLE_ID.test(table) || !baseId || !recordId) return undefined
  return `https://airtable.com/${baseId}/${table}/${recordId}`
}

// The first string cell, which in practice is the primary field; the id when no cell is text.
export function recordTitle(record: AirtableRecord): string {
  for (const value of Object.values(record.fields ?? {})) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return record.id
}

export function recordOutput(record: AirtableRecord, baseId: string, table: string): Record<string, unknown> {
  const url = recordUrl(baseId, table, record.id ?? '')
  return {
    id: record.id ?? '',
    createdTime: record.createdTime ?? '',
    fields: record.fields ?? {},
    ...(url !== undefined && { url })
  }
}

export interface ItemScope {
  baseId: string
  table: string
  /** When the record changed for this trigger; the created time when absent. */
  updatedAt?: string
}

export function recordToItem(record: AirtableRecord, scope: ItemScope): ConnectorItem {
  const url = recordUrl(scope.baseId, scope.table, record.id)
  return {
    externalId: record.id,
    title: recordTitle(record),
    ...(url !== undefined && { url }),
    updatedAt: scope.updatedAt ?? record.createdTime,
    data: {
      id: record.id,
      createdTime: record.createdTime,
      fields: record.fields ?? {}
    }
  }
}

// Field names go in braces; a brace inside one cannot be escaped, so it is refused rather than mis-parsed.
export function fieldReference(name: string): string {
  if (/[{}]/.test(name)) throw new Error(`Field name "${name}" may not contain braces`)
  return `{${name}}`
}

// "At or after" the instant: NOT(IS_BEFORE(…)) keeps a record stamped exactly on the cursor, and dedupe absorbs the repeat.
export function sinceFormula(expression: string, since: string): string {
  return `NOT(IS_BEFORE(${expression}, DATETIME_PARSE("${since}")))`
}

export function andFormulas(...formulas: Array<string | undefined>): string {
  const present = formulas.filter((formula): formula is string => Boolean(formula && formula.trim()))
  return present.length > 1 ? `AND(${present.join(', ')})` : (present[0] ?? '')
}

// The reference's own example record, which `check --mock` replays through the dedupe pipeline.
export const SAMPLE_BASE_ID = 'appLkNDICXNqxSDhG'
export const SAMPLE_TABLE_ID = 'tbltp8DGLhqbUmjK1'

export const SAMPLE_RECORD: AirtableRecord = {
  id: 'rec560UJdUtocSouk',
  createdTime: '2022-09-12T21:03:48.000Z',
  fields: { Name: 'Union Square', Address: '333 Post St', Visited: true }
}

export const SAMPLE_UPDATED_RECORD: AirtableRecord = {
  ...SAMPLE_RECORD,
  fields: { ...SAMPLE_RECORD.fields, Visited: false, 'Last modified': '2022-09-13T08:15:02.000Z' }
}
