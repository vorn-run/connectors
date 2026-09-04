/**
 * The libpq connection URI, as the manual describes it:
 * `postgresql://[userspec@][hostspec][/dbname][?paramspec]`.
 *
 * Parsed by hand rather than with `URL`, because a URI with several hosts or
 * a password holding a reserved character must fail with a sentence naming
 * the problem, not with "Invalid URL".
 */

export const SSL_MODES = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'] as const
export type SslMode = (typeof SSL_MODES)[number]

export interface ConnectionOptions {
  user: string
  password?: string
  host: string
  port: number
  database: string
  sslMode: SslMode
  /** Path to a PEM CA bundle, or `system` for Node's built-in roots. */
  sslRootCert?: string
  connectTimeoutMs: number
  applicationName: string
}

const DEFAULT_PORT = 5432
const DEFAULT_CONNECT_TIMEOUT_S = 10
export const DEFAULT_APPLICATION_NAME = 'vorn-connector-postgres'

function decode(part: string, what: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    throw new Error(`connectionString: the ${what} has a malformed percent-encoding`)
  }
}

function splitHostSpec(hostSpec: string): { host: string; port: number } {
  if (hostSpec.includes(',')) {
    throw new Error('connectionString: several hosts are not supported; give one host')
  }
  let host: string
  let rest: string
  if (hostSpec.startsWith('[')) {
    const close = hostSpec.indexOf(']')
    if (close === -1) throw new Error('connectionString: IPv6 host is missing its closing bracket')
    host = hostSpec.slice(1, close)
    rest = hostSpec.slice(close + 1)
  } else {
    const colon = hostSpec.indexOf(':')
    host = colon === -1 ? hostSpec : hostSpec.slice(0, colon)
    rest = colon === -1 ? '' : hostSpec.slice(colon)
  }
  if (!host) throw new Error('connectionString: a host is required, e.g. postgres://user:pass@host:5432/db')

  let port = DEFAULT_PORT
  if (rest !== '') {
    if (!rest.startsWith(':')) throw new Error(`connectionString: unexpected "${rest}" after the host`)
    const text = rest.slice(1)
    if (text !== '') {
      if (!/^\d+$/.test(text)) throw new Error(`connectionString: port "${text}" is not a number`)
      port = Number(text)
    }
  }
  return { host, port }
}

function parseParams(query: string): Map<string, string> {
  const params = new Map<string, string>()
  if (query === '') return params
  for (const pair of query.split('&')) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    const key = decode(eq === -1 ? pair : pair.slice(0, eq), 'parameter list')
    const value = eq === -1 ? '' : decode(pair.slice(eq + 1), 'parameter list')
    params.set(key, value)
  }
  return params
}

export function parseConnectionString(raw: string): ConnectionOptions {
  const uri = raw.trim()
  const scheme = /^(postgres|postgresql):\/\//i.exec(uri)
  if (!scheme) {
    throw new Error(
      'connectionString must be a libpq URI starting with postgres:// or postgresql://, ' +
        'e.g. postgres://user:password@host:5432/database?sslmode=require'
    )
  }
  const afterScheme = uri.slice(scheme[0].length)
  const question = afterScheme.indexOf('?')
  const beforeQuery = question === -1 ? afterScheme : afterScheme.slice(0, question)
  const params = parseParams(question === -1 ? '' : afterScheme.slice(question + 1))

  const slash = beforeQuery.indexOf('/')
  const authority = slash === -1 ? beforeQuery : beforeQuery.slice(0, slash)
  const path = slash === -1 ? '' : beforeQuery.slice(slash + 1)

  const at = authority.lastIndexOf('@')
  const userInfo = at === -1 ? '' : authority.slice(0, at)
  const hostSpec = at === -1 ? authority : authority.slice(at + 1)

  const colon = userInfo.indexOf(':')
  const user = decode(colon === -1 ? userInfo : userInfo.slice(0, colon), 'user name')
  const password = colon === -1 ? undefined : decode(userInfo.slice(colon + 1), 'password')
  if (!user) {
    throw new Error('connectionString: a user name is required, e.g. postgres://user:pass@host:5432/db')
  }

  const { host, port } = splitHostSpec(hostSpec)
  const database = path === '' ? user : decode(path, 'database name')

  const sslMode = params.get('sslmode') ?? 'prefer'
  if (!(SSL_MODES as readonly string[]).includes(sslMode)) {
    throw new Error(`connectionString: sslmode "${sslMode}" is not one of ${SSL_MODES.join(', ')}`)
  }

  const timeoutText = params.get('connect_timeout')
  let connectTimeoutS = DEFAULT_CONNECT_TIMEOUT_S
  if (timeoutText !== undefined && timeoutText !== '') {
    if (!/^\d+$/.test(timeoutText)) {
      throw new Error(`connectionString: connect_timeout "${timeoutText}" is not a whole number of seconds`)
    }
    connectTimeoutS = Number(timeoutText)
  }

  const sslRootCert = params.get('sslrootcert')
  return {
    user,
    ...(password !== undefined && { password }),
    host,
    port,
    database,
    sslMode: sslMode as SslMode,
    ...(sslRootCert && { sslRootCert }),
    connectTimeoutMs: connectTimeoutS * 1000,
    applicationName: params.get('application_name') || DEFAULT_APPLICATION_NAME
  }
}
