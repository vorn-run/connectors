import { describe, expect, it } from 'vitest'
import {
  buildInsert,
  buildNewRows,
  buildSelect,
  buildUpdate,
  DESCRIBE_TABLE_SQL,
  jsonArray,
  jsonObject,
  LIST_TABLES_SQL,
  quoteIdent,
  quoteTable,
  splitTable
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

describe('JSON arguments', () => {
  it('checks the shape the SDK has already parsed', () => {
    expect(jsonArray(undefined, 'params')).toEqual([])
    expect(jsonArray([1, 'two'], 'params')).toEqual([1, 'two'])
    expect(() => jsonArray({ a: 1 }, 'params')).toThrow(/JSON array/)
    expect(jsonObject({ a: 1 }, 'values')).toEqual({ a: 1 })
    expect(() => jsonObject(undefined, 'values')).toThrow(/values is required/)
    expect(() => jsonObject([1], 'values')).toThrow(/JSON object/)
    expect(() => jsonObject(null, 'values')).toThrow(/JSON object/)
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
