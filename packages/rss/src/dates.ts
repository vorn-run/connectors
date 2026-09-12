const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** RFC 822 §5.1 zone names, in hours from UT. */
const ZONES: Record<string, number> = {
  UT: 0,
  GMT: 0,
  Z: 0,
  EST: -5,
  EDT: -4,
  CST: -6,
  CDT: -5,
  MST: -7,
  MDT: -6,
  PST: -8,
  PDT: -7
}

const RFC822 =
  /^(?:[A-Za-z]{2,},?\s*)?(\d{1,2})[\s-]+([A-Za-z]{3,})\.?[\s-]+(\d{4}|\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([A-Za-z]+|[+-]\d{4}|[+-]\d{2}:\d{2}))?/

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt\s](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*([Zz]|[+-]\d{2}:?\d{2})?)?$/

/** Minutes east of UT; an unknown or missing zone reads as UT. */
function offsetMinutes(zone: string | undefined): number {
  if (zone === undefined) return 0
  const numeric = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)
  if (numeric) return (numeric[1] === '-' ? -1 : 1) * (Number(numeric[2]) * 60 + Number(numeric[3]))
  const upper = zone.toUpperCase()
  if (upper in ZONES) return ZONES[upper]! * 60
  // RFC 822 §5.2 military zones: A to M (no J) are -1 to -12, N to Y are +1 to +12.
  if (/^[A-IK-M]$/.test(upper)) return -(upper.charCodeAt(0) - 64 - (upper > 'J' ? 1 : 0)) * 60
  if (/^[N-Y]$/.test(upper)) return (upper.charCodeAt(0) - 77) * 60
  return 0
}

function utc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  offset: number
): string {
  if (month < 0 || month > 11 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return ''
  if (new Date(Date.UTC(year, month, day)).getUTCMonth() !== month) return ''
  return new Date(Date.UTC(year, month, day, hour, minute, second, ms) - offset * 60_000).toISOString()
}

function fromRfc3339(value: string): string | undefined {
  const m = RFC3339.exec(value)
  if (!m) return undefined
  const ms = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, '0'))
  const zone = m[8] === undefined || /^z$/i.test(m[8]) ? undefined : m[8]
  return utc(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
    ms,
    offsetMinutes(zone)
  )
}

function fromRfc822(value: string): string | undefined {
  const m = RFC822.exec(value)
  if (!m) return undefined
  const month = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase())
  if (month === -1) return ''
  const short = m[3]!.length === 2 ? Number(m[3]) : undefined
  const year = short === undefined ? Number(m[3]) : short < 50 ? 2000 + short : 1900 + short
  return utc(year, month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), 0, offsetMinutes(m[7]))
}

/** A feed date in RFC 3339 or RFC 822 form as ISO 8601 in UTC, or "" when it is neither. */
export function parseDate(value: string | undefined): string {
  const trimmed = (value ?? '').trim()
  if (trimmed === '') return ''
  return fromRfc3339(trimmed) ?? fromRfc822(trimmed) ?? ''
}
