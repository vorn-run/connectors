import { describe, expect, it } from 'vitest'
import {
  buildInsert,
  buildNewRows,
  buildSelect,
  buildUpdate,
  decodeValue,
  DESCRIBE_TABLE_SQL,
  encodeParam,
  isDateTime,
  jsonArg,
  jsonArray,
  jsonObject,
  LIST_TABLES_SQL,
  OID,
  quoteIdent,
  quoteTable,
  rowToObject,
  splitTable,
  timestampToIso
} from './sql'

describe('identifiers', () => {
  it('double-quotes and doubles embedded quotes', () => {
    expect(quoteIdent('orders')).toBe('"orders"')
    expect(quoteIdent(' say "hi" ')).toBe('"say ""hi"""')
    expect(quoteIdent('drop table; --')).toBe('"drop table; --"')
  })

  it('refuses an empty name or one holding NUL', () => {
    expect(() => quoteIdent('  ')).toThrow(/empty/)
    expect(() => quoteIdent('a\0b')).toThrow(/NUL/)
  })

  it('quotes schema.table at the first dot', () => {
    expect(quoteTable('orders')).toBe('"orders"')
    expect(quoteTable('sales.orders')).toBe('"sales"."orders"')
    expect(quoteTable('a.b.c')).toBe('"a"."b.c"')
  })

  it('splits a reference into schema and table, defaulting to public', () => {
    expect(splitTable('orders')).toEqual({ schema: 'public', table: 'orders' })
    expect(splitTable(' sales . orders ')).toEqual({ schema: 'sales', table: 'orders' })
    expect(() => splitTable('')).toThrow(/required/)
    expect(() => splitTable('.orders')).toThrow(/not table or schema.table/)
  })
})

describe('encodeParam', () => {
  it('turns each JavaScript shape into the text the server casts', () => {
    expect(encodeParam(null)).toBeNull()
    expect(encodeParam(undefined)).toBeNull()
    expect(encodeParam('x')).toBe('x')
    expect(encodeParam(12.5)).toBe('12.5')
    expect(encodeParam(10n)).toBe('10')
    expect(encodeParam(true)).toBe('true')
    expect(encodeParam(false)).toBe('false')
    expect(encodeParam(new Date('2026-09-04T12:00:00Z'))).toBe('2026-09-04T12:00:00.000Z')
    expect(encodeParam(Buffer.from([0xde, 0xad]))).toBe('\\xdead')
    expect(encodeParam({ a: [1] })).toBe('{"a":[1]}')
    expect(encodeParam([1, 2])).toBe('[1,2]')
  })

  it('refuses values that have no text', () => {
    expect(() => encodeParam(Number.NaN)).toThrow(/cannot bind NaN/)
    expect(() => encodeParam(new Date('nope'))).toThrow(/invalid Date/)
  })
})

describe('timestampToIso', () => {
  it('rewrites the ISO DateStyle output under TimeZone=UTC', () => {
    expect(timestampToIso('2026-09-04 12:00:00.5+00')).toBe('2026-09-04T12:00:00.5Z')
    expect(timestampToIso('2026-09-04 12:00:00+00:00')).toBe('2026-09-04T12:00:00Z')
    expect(timestampToIso('2026-09-04 12:00:00')).toBe('2026-09-04T12:00:00Z')
    expect(timestampToIso('2026-09-04 12:00:00+05:30')).toBe('2026-09-04T12:00:00+05:30')
    expect(timestampToIso('2026-09-04 12:00:00-03')).toBe('2026-09-04T12:00:00-03:00')
    expect(timestampToIso('2026-09-04')).toBe('2026-09-04')
  })

  it('leaves what it does not recognise alone', () => {
    expect(timestampToIso('infinity')).toBe('infinity')
    expect(timestampToIso('0001-01-01 00:00:00 BC')).toBe('0001-01-01 00:00:00 BC')
  })
})

describe('decodeValue', () => {
  it('decodes by type OID', () => {
    expect(decodeValue(OID.bool, 't')).toBe(true)
    expect(decodeValue(OID.bool, 'f')).toBe(false)
    expect(decodeValue(OID.int2, '7')).toBe(7)
    expect(decodeValue(OID.int4, '-7')).toBe(-7)
    expect(decodeValue(OID.oid, '16384')).toBe(16384)
    expect(decodeValue(OID.float4, '1.5')).toBe(1.5)
    expect(decodeValue(OID.float8, '2.5')).toBe(2.5)
    expect(decodeValue(OID.int8, '42')).toBe(42)
    expect(decodeValue(OID.int8, '9007199254740993')).toBe('9007199254740993')
    expect(decodeValue(OID.numeric, '1.10')).toBe('1.10')
    expect(decodeValue(OID.json, '{"a":1}')).toEqual({ a: 1 })
    expect(decodeValue(OID.jsonb, '[1]')).toEqual([1])
    expect(decodeValue(OID.timestamp, '2026-09-04 12:00:00')).toBe('2026-09-04T12:00:00Z')
    expect(decodeValue(OID.timestamptz, '2026-09-04 12:00:00+00')).toBe('2026-09-04T12:00:00Z')
    expect(decodeValue(25, 'text')).toBe('text')
    expect(decodeValue(OID.int4, null)).toBeNull()
  })

  it('knows which OIDs are dates and times', () => {
    expect(isDateTime(OID.date)).toBe(true)
    expect(isDateTime(OID.timestamptz)).toBe(true)
    expect(isDateTime(OID.int4)).toBe(false)
  })

  it('builds an object from a row, with null for a short row', () => {
    const fields = [
      { name: 'id', typeOid: OID.int4 },
      { name: 'ok', typeOid: OID.bool },
      { name: 'missing', typeOid: 25 }
    ]
    expect(rowToObject(fields, ['1', 't'])).toEqual({ id: 1, ok: true, missing: null })
  })
})

describe('JSON arguments', () => {
  it('parses text, passes objects through and treats blank as absent', () => {
    expect(jsonArg(undefined, 'x')).toBeUndefined()
    expect(jsonArg(null, 'x')).toBeUndefined()
    expect(jsonArg('  ', 'x')).toBeUndefined()
    expect(jsonArg('[1]', 'x')).toEqual([1])
    expect(jsonArg({ a: 1 }, 'x')).toEqual({ a: 1 })
    expect(() => jsonArg('{nope', 'params')).toThrow(/params must be JSON/)
  })

  it('checks the shape it is asked for', () => {
    expect(jsonArray(undefined, 'params')).toEqual([])
    expect(jsonArray('[1,"two"]', 'params')).toEqual([1, 'two'])
    expect(() => jsonArray('{"a":1}', 'params')).toThrow(/JSON array/)
    expect(jsonObject('{"a":1}', 'values')).toEqual({ a: 1 })
    expect(() => jsonObject(undefined, 'values')).toThrow(/values is required/)
    expect(() => jsonObject('[1]', 'values')).toThrow(/JSON object/)
    expect(() => jsonObject('null', 'values')).toThrow(/JSON object/)
  })
})

describe('builders', () => {
  it('selects with an optional where, order and a bound limit', () => {
    expect(buildSelect({ table: 'orders', limit: 10 })).toEqual({
      text: 'SELECT * FROM "orders" LIMIT $1',
      params: [10]
    })
    expect(
      buildSelect({ table: 'sales.orders', where: 'status = $1', params: ['new'], orderBy: 'id', limit: 5 })
    ).toEqual({
      text: 'SELECT * FROM "sales"."orders" WHERE status = $1 ORDER BY "id" LIMIT $2',
      params: ['new', 5]
    })
  })

  it('inserts with placeholders, or DEFAULT VALUES for an empty object', () => {
    expect(buildInsert('orders', { ref: 'A-1', qty: 2 })).toEqual({
      text: 'INSERT INTO "orders" ("ref", "qty") VALUES ($1, $2) RETURNING *',
      params: ['A-1', 2]
    })
    expect(buildInsert('orders', {})).toEqual({
      text: 'INSERT INTO "orders" DEFAULT VALUES RETURNING *',
      params: []
    })
  })

  it('updates with the where params bound first', () => {
    expect(buildUpdate({ table: 'orders', set: { status: 'done', n: 1 }, where: 'id = $1', params: [7] })).toEqual({
      text: 'UPDATE "orders" SET "status" = $2, "n" = $3 WHERE id = $1',
      params: [7, 'done', 1]
    })
    expect(() => buildUpdate({ table: 'orders', set: {}, where: 'id = $1' })).toThrow(/at least one column/)
    expect(() => buildUpdate({ table: 'orders', set: { a: 1 }, where: ' ' })).toThrow(/where is required/)
  })

  it('names the information_schema views', () => {
    expect(LIST_TABLES_SQL).toContain('information_schema.tables')
    expect(DESCRIBE_TABLE_SQL).toContain('information_schema.columns')
  })

  describe('buildNewRows', () => {
    const base = { table: 'orders', orderingColumn: 'created_at', keyColumn: 'id', limit: 50 }

    it('reads the newest page first, newest first', () => {
      expect(buildNewRows(base)).toEqual({
        text: 'SELECT * FROM "orders" ORDER BY "created_at" DESC, "id" DESC LIMIT $1',
        params: [50]
      })
      expect(buildNewRows({ ...base, keyColumn: 'created_at' })).toEqual({
        text: 'SELECT * FROM "orders" ORDER BY "created_at" DESC LIMIT $1',
        params: [50]
      })
    })

    it('starts after a given value on the first poll', () => {
      expect(buildNewRows({ ...base, startFrom: '2026-01-01' })).toEqual({
        text: 'SELECT * FROM "orders" WHERE "created_at" > $1 ORDER BY "created_at", "id" LIMIT $2',
        params: ['2026-01-01', 50]
      })
    })

    it('continues from a cursor with a row-wise comparison, or a plain one for a single column', () => {
      expect(buildNewRows({ ...base, cursor: { ordering: '2026-01-01 00:00:00', key: '9' } })).toEqual({
        text: 'SELECT * FROM "orders" WHERE ("created_at", "id") > ($1, $2) ORDER BY "created_at", "id" LIMIT $3',
        params: ['2026-01-01 00:00:00', '9', 50]
      })
      expect(buildNewRows({ ...base, keyColumn: 'created_at', cursor: { ordering: '5', key: '5' } })).toEqual({
        text: 'SELECT * FROM "orders" WHERE "created_at" > $1 ORDER BY "created_at" LIMIT $2',
        params: ['5', 50]
      })
    })
  })
})
