// A project key is letters, digits and underscores; anything else would be JQL, not a key.
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*$/

// A quoted JQL string; a double quote inside a value is escaped as \".
export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function projectClause(key: string | undefined): string | undefined {
  if (key === undefined) return undefined
  if (!PROJECT_KEY.test(key)) throw new Error(`JIRA_PROJECT_KEY must be a project key such as "EX", got "${key}"`)
  return `project = ${key.toUpperCase()}`
}

// Every clause ANDed, each extra clause in parentheses so its own ORs stay together.
export function andClauses(...clauses: Array<string | undefined>): string {
  const present = clauses.map((clause) => clause?.trim()).filter((clause): clause is string => Boolean(clause))
  return present.map((clause, index) => (index === 0 ? clause : `(${clause})`)).join(' AND ')
}

const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
}

// The user's zone from GET /myself; UTC when Intl does not know the name.
function partsIn(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US', { ...DATE_OPTIONS, timeZone })
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...DATE_OPTIONS, timeZone: 'UTC' })
  }
}

// `yyyy-MM-dd HH:mm` in the searching user's zone, floored to the minute JQL resolves to.
export function jqlDate(iso: string, timeZone: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) throw new Error(`Not a timestamp: "${iso}"`)
  const read: Record<string, string> = {}
  for (const part of partsIn(timeZone).formatToParts(new Date(at))) read[part.type] = part.value
  return `${read.year}-${read.month}-${read.day} ${read.hour}:${read.minute}`
}

export type TimeField = 'created' | 'updated'

export function sinceClause(field: TimeField, date: string): string {
  return `${field} >= ${quote(date)}`
}

// "This operator can be used with the … Status fields only": CHANGED TO a value AFTER a date.
export function transitionedClause(status: string, date: string): string {
  return `status CHANGED TO ${quote(status)} AFTER ${quote(date)}`
}

export function orderBy(jql: string, field: TimeField): string {
  return `${jql} ORDER BY ${field} ASC`
}

const BARE_ORDER_BY = /^\s*order\s+by\b/i

// "This parameter requires a bounded query": a bare ORDER BY gets a restriction every issue satisfies.
export function boundedJql(jql: string): string {
  const trimmed = jql.trim()
  if (trimmed === '') throw new Error('jql is required')
  return BARE_ORDER_BY.test(trimmed) ? `created >= "1970-01-01" ${trimmed}` : trimmed
}
