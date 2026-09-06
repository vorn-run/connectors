import { describe, expect, it } from 'vitest'
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
  LimitParam,
  LIST_TABLES_SQL,
  quoteIdent,
  quoteTable,
  splitTable
} from './sql'

const limit = (n: number) => new LimitParam(n)

describe('identifiers', () => {
  it('backticks a name from the unquoted alphabet, including $ and non-ASCII letters', () => {
    expect(quoteIdent('orders')).toBe('`orders`')
    expect(quoteIdent(' order_2$ ')).toBe('`order_2$`')
    expect(quoteIdent('café')).toBe('`café`')
    expect(quoteIdent('a'.repeat(64))).toBe(`\`${'a'.repeat(64)}\``)
  })

  it('refuses an empty name, a long one, and anything outside the alphabet', () => {
    expect(() => quoteIdent('  ')).toThrow(/empty/)
    expect(() => quoteIdent('a'.repeat(65))).toThrow(/longer than 64 characters/)
    expect(() => quoteIdent('drop table; --')).toThrow(/may only hold letters, digits, _ and \$/)
    expect(() => quoteIdent('a`b')).toThrow(/may only hold/)
    expect(() => quoteIdent('a\0b')).toThrow(/may only hold/)
    expect(() => quoteIdent('a b')).toThrow(/may only hold/)
  })

  it('quotes db.table at the first dot and validates each part', () => {
    expect(quoteTable('orders')).toBe('`orders`')
    expect(quoteTable('shop.orders')).toBe('`shop`.`orders`')
    expect(() => quoteTable('a.b.c')).toThrow(/may only hold/)
  })

  it('splits a reference into database and table', () => {
    expect(splitTable('orders')).toEqual({ table: 'orders' })
    expect(splitTable(' shop . orders ')).toEqual({ database: 'shop', table: 'orders' })
    expect(() => splitTable('')).toThrow(/required/)
    expect(() => splitTable('.orders')).toThrow(/not table or db.table/)
  })
})

describe('JSON arguments and the limit', () => {
  it('checks the shape the SDK has already parsed', () => {
    expect(jsonArray(undefined, 'params')).toEqual([])
    expect(jsonArray([1, 'two'], 'params')).toEqual([1, 'two'])
    expect(() => jsonArray({ a: 1 }, 'params')).toThrow(/JSON array/)
    expect(jsonObject({ a: 1 }, 'values')).toEqual({ a: 1 })
    expect(() => jsonObject(undefined, 'values')).toThrow(/values is required/)
    expect(() => jsonObject([1], 'values')).toThrow(/JSON object/)
    expect(() => jsonObject(null, 'values')).toThrow(/JSON object/)
  })

  it('refuses a limit that is not a whole number', () => {
    expect(() => new LimitParam(1.5)).toThrow(/not a whole number/)
    expect(() => new LimitParam(-1)).toThrow(/not a whole number/)
    expect(new LimitParam(3).value).toBe(3)
  })
})

describe('builders', () => {
  it('selects with optional columns, where, order and a bound limit', () => {
    expect(buildSelect({ table: 'orders', limit: 10 })).toEqual({ text: 'SELECT * FROM `orders` LIMIT ?', params: [limit(10)] })
    expect(
      buildSelect({ table: 'shop.orders', columns: ['id', 'ref'], where: 'status = ?', params: ['new'], orderBy: 'id', descending: true, limit: 5 })
    ).toEqual({
      text: 'SELECT `id`, `ref` FROM `shop`.`orders` WHERE status = ? ORDER BY `id` DESC LIMIT ?',
      params: ['new', limit(5)]
    })
    expect(buildSelect({ table: 'orders', columns: [], where: ' ', orderBy: 'id', limit: 1 }).text).toBe(
      'SELECT * FROM `orders` ORDER BY `id` LIMIT ?'
    )
  })

  it('inserts with placeholders and insists on a column', () => {
    expect(buildInsert('orders', { ref: 'A-1', qty: 2 })).toEqual({
      text: 'INSERT INTO `orders` (`ref`, `qty`) VALUES (?, ?)',
      params: ['A-1', 2]
    })
    expect(() => buildInsert('orders', {})).toThrow(/at least one column/)
  })

  it('updates with the SET values bound before the where params', () => {
    expect(buildUpdate({ table: 'orders', values: { status: 'done', n: 1 }, where: 'id = ?', params: [7] })).toEqual({
      text: 'UPDATE `orders` SET `status` = ?, `n` = ? WHERE id = ?',
      params: ['done', 1, 7]
    })
    expect(buildUpdate({ table: 'orders', values: { a: 1 }, where: 'id = 1' }).params).toEqual([1])
    expect(() => buildUpdate({ table: 'orders', values: {}, where: 'id = ?' })).toThrow(/at least one column/)
    expect(() => buildUpdate({ table: 'orders', values: { a: 1 }, where: ' ' })).toThrow(/where is required/)
  })

  it('deletes and counts', () => {
    expect(buildDelete({ table: 'orders', where: 'id = ?', params: [7] })).toEqual({ text: 'DELETE FROM `orders` WHERE id = ?', params: [7] })
    expect(buildDelete({ table: 'orders', where: 'id = 1' }).params).toEqual([])
    expect(() => buildDelete({ table: 'orders', where: '' })).toThrow(/where is required/)
    expect(buildCount({ table: 'orders' })).toEqual({ text: 'SELECT COUNT(*) AS count FROM `orders`', params: [] })
    expect(buildCount({ table: 'orders', where: 'status = ?', params: ['new'] })).toEqual({
      text: 'SELECT COUNT(*) AS count FROM `orders` WHERE status = ?',
      params: ['new']
    })
  })

  it('names the information_schema views', () => {
    expect(LIST_TABLES_SQL).toContain('information_schema.TABLES')
    expect(DESCRIBE_TABLE_SQL).toContain('information_schema.COLUMNS')
  })

  describe('buildNewRows', () => {
    const base = { table: 'orders', orderingColumn: 'created_at', keyColumn: 'id', limit: 50 }

    it('reads the newest page first, newest first, with the where in parentheses', () => {
      expect(buildNewRows(base)).toEqual({
        text: 'SELECT * FROM `orders` ORDER BY `created_at` DESC, `id` DESC LIMIT ?',
        params: [limit(50)]
      })
      expect(buildNewRows({ ...base, keyColumn: 'created_at', where: "status = 'new'" })).toEqual({
        text: "SELECT * FROM `orders` WHERE (status = 'new') ORDER BY `created_at` DESC LIMIT ?",
        params: [limit(50)]
      })
    })

    it('starts after a given value on the first poll', () => {
      expect(buildNewRows({ ...base, startFrom: '2026-01-01', where: 'x = 1' })).toEqual({
        text: 'SELECT * FROM `orders` WHERE `created_at` > ? AND (x = 1) ORDER BY `created_at`, `id` LIMIT ?',
        params: ['2026-01-01', limit(50)]
      })
    })

    it('continues from a cursor with the row-wise comparison spelled out, or a plain one for a single column', () => {
      expect(buildNewRows({ ...base, cursor: { ordering: '2026-01-01 00:00:00', key: 9 } })).toEqual({
        text: 'SELECT * FROM `orders` WHERE (`created_at` > ? OR (`created_at` = ? AND `id` > ?)) ORDER BY `created_at`, `id` LIMIT ?',
        params: ['2026-01-01 00:00:00', '2026-01-01 00:00:00', 9, limit(50)]
      })
      expect(buildNewRows({ ...base, keyColumn: 'created_at', cursor: { ordering: 5, key: 5 } })).toEqual({
        text: 'SELECT * FROM `orders` WHERE `created_at` > ? ORDER BY `created_at` LIMIT ?',
        params: [5, limit(50)]
      })
    })
  })

  describe('buildUpdatedRows', () => {
    const base = { table: 'tickets', updatedAtColumn: 'updated_at', keyColumn: 'id', limit: 20 }

    it('reads the newest page first without a start, and at or past the start otherwise', () => {
      expect(buildUpdatedRows(base)).toEqual({
        text: 'SELECT * FROM `tickets` ORDER BY `updated_at` DESC, `id` DESC LIMIT ?',
        params: [limit(20)]
      })
      expect(buildUpdatedRows({ ...base, where: 'open = 1' }).text).toBe(
        'SELECT * FROM `tickets` WHERE (open = 1) ORDER BY `updated_at` DESC, `id` DESC LIMIT ?'
      )
      expect(buildUpdatedRows({ ...base, since: '2026-09-04 09:30:00', where: 'open = 1' })).toEqual({
        text: 'SELECT * FROM `tickets` WHERE `updated_at` >= ? AND (open = 1) ORDER BY `updated_at`, `id` LIMIT ?',
        params: ['2026-09-04 09:30:00', limit(20)]
      })
    })
  })
})
