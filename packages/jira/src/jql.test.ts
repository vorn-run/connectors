import { describe, expect, it } from 'vitest'
import {
  andClauses,
  boundedJql,
  jqlDate,
  orderBy,
  projectClause,
  quote,
  sinceClause,
  transitionedClause
} from './jql'

describe('quote', () => {
  it('double-quotes and escapes quotes and backslashes', () => {
    expect(quote('Done')).toBe('"Done"')
    expect(quote('In "Review"')).toBe('"In \\"Review\\""')
    expect(quote('a\\b')).toBe('"a\\\\b"')
  })
})

describe('projectClause', () => {
  it('uppercases a key and refuses anything that is not one', () => {
    expect(projectClause(undefined)).toBeUndefined()
    expect(projectClause('ex')).toBe('project = EX')
    expect(projectClause('EX_2')).toBe('project = EX_2')
    expect(() => projectClause('EX OR 1=1')).toThrow(/JIRA_PROJECT_KEY must be a project key/)
    expect(() => projectClause('1EX')).toThrow(/JIRA_PROJECT_KEY/)
  })
})

describe('andClauses', () => {
  it('ANDs the present clauses, parenthesising every one after the first', () => {
    expect(andClauses(undefined, 'created >= "x"', '  ', 'a OR b')).toBe('created >= "x" AND (a OR b)')
    expect(andClauses('project = EX', 'updated >= "y"')).toBe('project = EX AND (updated >= "y")')
    expect(andClauses()).toBe('')
  })
})

describe('jqlDate', () => {
  it('formats to the minute in the given zone', () => {
    expect(jqlDate('2026-09-06T10:30:45.000Z', 'UTC')).toBe('2026-09-06 10:30')
    expect(jqlDate('2026-09-06T10:30:45.000Z', 'America/Los_Angeles')).toBe('2026-09-06 03:30')
    expect(jqlDate('2026-09-06T23:30:00.000Z', 'Asia/Tokyo')).toBe('2026-09-07 08:30')
    expect(jqlDate('2026-01-01T00:05:00.000Z', 'UTC')).toBe('2026-01-01 00:05')
  })

  it('falls back to UTC for a zone Intl does not know, and refuses a non-date', () => {
    expect(jqlDate('2026-09-06T10:30:00.000Z', 'Mars/Olympus')).toBe('2026-09-06 10:30')
    expect(() => jqlDate('yesterday', 'UTC')).toThrow(/Not a timestamp/)
  })
})

describe('clauses', () => {
  it('builds the time and status clauses and the order', () => {
    expect(sinceClause('created', '2026-09-06 10:30')).toBe('created >= "2026-09-06 10:30"')
    expect(transitionedClause('Done', '2026-09-06 10:30')).toBe('status CHANGED TO "Done" AFTER "2026-09-06 10:30"')
    expect(orderBy('project = EX', 'updated')).toBe('project = EX ORDER BY updated ASC')
  })
})

describe('boundedJql', () => {
  it('bounds a bare ORDER BY and leaves a bounded query alone', () => {
    expect(boundedJql(' order by created DESC ')).toBe('created >= "1970-01-01" order by created DESC')
    expect(boundedJql('ORDER BY key')).toBe('created >= "1970-01-01" ORDER BY key')
    expect(boundedJql('project = EX order by created')).toBe('project = EX order by created')
    expect(boundedJql('orderby = 1')).toBe('orderby = 1')
    expect(() => boundedJql('  ')).toThrow(/jql is required/)
  })
})
