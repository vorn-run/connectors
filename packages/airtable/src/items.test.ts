import { describe, expect, it } from 'vitest'
import {
  SAMPLE_BASE_ID,
  SAMPLE_RECORD,
  SAMPLE_TABLE_ID,
  SAMPLE_UPDATED_RECORD,
  andFormulas,
  fieldReference,
  recordOutput,
  recordTitle,
  recordToItem,
  recordUrl,
  sinceFormula
} from './items'

describe('recordUrl', () => {
  it('builds a URL only when the table is an id', () => {
    expect(recordUrl('appA', 'tblB', 'recC')).toBe('https://airtable.com/appA/tblB/recC')
    expect(recordUrl('appA', 'My Table', 'recC')).toBeUndefined()
    expect(recordUrl('', 'tblB', 'recC')).toBeUndefined()
    expect(recordUrl('appA', 'tblB', '')).toBeUndefined()
  })
})

describe('recordTitle', () => {
  it('takes the first text cell and falls back to the id', () => {
    expect(recordTitle(SAMPLE_RECORD)).toBe('Union Square')
    expect(recordTitle({ id: 'rec1', createdTime: 't', fields: { Count: 3, Name: '  ', Label: 'x' } })).toBe('x')
    expect(recordTitle({ id: 'rec1', createdTime: 't', fields: { Count: 3 } })).toBe('rec1')
    expect(recordTitle({ id: 'rec1', createdTime: 't', fields: undefined as never })).toBe('rec1')
  })
})

describe('recordOutput', () => {
  it('names the record and where to open it', () => {
    expect(recordOutput(SAMPLE_RECORD, SAMPLE_BASE_ID, SAMPLE_TABLE_ID)).toEqual({
      id: 'rec560UJdUtocSouk',
      createdTime: '2022-09-12T21:03:48.000Z',
      fields: SAMPLE_RECORD.fields,
      url: `https://airtable.com/${SAMPLE_BASE_ID}/${SAMPLE_TABLE_ID}/rec560UJdUtocSouk`
    })
  })

  it('survives an empty answer and a table given by name', () => {
    expect(recordOutput({} as never, 'appA', 'Places')).toEqual({ id: '', createdTime: '', fields: {} })
  })
})

describe('recordToItem', () => {
  it('matches the sample item in the spec', () => {
    expect(recordToItem(SAMPLE_RECORD, { baseId: SAMPLE_BASE_ID, table: SAMPLE_TABLE_ID })).toEqual({
      externalId: 'rec560UJdUtocSouk',
      title: 'Union Square',
      url: 'https://airtable.com/appLkNDICXNqxSDhG/tbltp8DGLhqbUmjK1/rec560UJdUtocSouk',
      updatedAt: '2022-09-12T21:03:48.000Z',
      data: {
        id: 'rec560UJdUtocSouk',
        createdTime: '2022-09-12T21:03:48.000Z',
        fields: { Name: 'Union Square', Address: '333 Post St', Visited: true }
      }
    })
  })

  it('takes the time it is given and omits the URL for a named table', () => {
    const item = recordToItem(SAMPLE_UPDATED_RECORD, { baseId: 'appA', table: 'Places', updatedAt: '2022-09-13T08:15:02.000Z' })
    expect(item.updatedAt).toBe('2022-09-13T08:15:02.000Z')
    expect(item).not.toHaveProperty('url')
    expect(item.data?.fields).toEqual(SAMPLE_UPDATED_RECORD.fields)
  })

  it('reads a record without fields as having none', () => {
    const item = recordToItem({ id: 'rec1', createdTime: 't' } as never, { baseId: 'appA', table: 'tblB' })
    expect(item.data?.fields).toEqual({})
  })
})

describe('formulas', () => {
  it('writes the at-or-after clause the spec shows', () => {
    expect(sinceFormula('CREATED_TIME()', '2024-05-01T12:00:00.000Z')).toBe(
      'NOT(IS_BEFORE(CREATED_TIME(), DATETIME_PARSE("2024-05-01T12:00:00.000Z")))'
    )
  })

  it('braces a field name and refuses one that cannot be braced', () => {
    expect(fieldReference('Last modified')).toBe('{Last modified}')
    expect(() => fieldReference('a}b')).toThrow('may not contain braces')
  })

  it('ANDs only the clauses that are present', () => {
    expect(andFormulas('A', undefined, ' ', 'B')).toBe('AND(A, B)')
    expect(andFormulas('A', undefined)).toBe('A')
    expect(andFormulas(undefined)).toBe('')
  })
})
