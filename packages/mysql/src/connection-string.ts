// The MySQL connection URL, parsed here so the driver gets its parts and a bad one fails with a sentence.

export const SSL_MODES = ['disabled', 'required', 'verify-full'] as const
export type SslMode = (typeof SSL_MODES)[number]

export interface ConnectionOptions {
  user: string
  password?: string
  host: string
  port: number
  database?: string
  sslMode: SslMode
  /** Path to a PEM CA bundle for verify-full; Node's roots when absent. */
  sslCa?: string
}

const DEFAULT_PORT = 3306
const EXAMPLE = 'mysql://user:password@host:3306/database'

// The manual's ssl-mode values, mapped onto the three settings the connector offers.
const URL_SSL_MODES: Record<string, SslMode> = {
  DISABLED: 'disabled',
  PREFERRED: 'required',
  REQUIRED: 'required',
  VERIFY_CA: 'verify-full',
  VERIFY_IDENTITY: 'verify-full'
}

function decode(part: string, what: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    throw new Error(`connectionString: the ${what} has a malformed percent-encoding`)
  }
}

/** The `ssl` setting, refusing anything but the three documented values. */
export function parseSslMode(value: unknown): SslMode | undefined {
  const text = String(value ?? '').trim()
  if (text === '') return undefined
  if (!(SSL_MODES as readonly string[]).includes(text)) {
    throw new Error(`ssl must be one of ${SSL_MODES.join(', ')}, not "${text}"`)
  }
  return text as SslMode
}

export function parseConnectionString(raw: string, settings: { ssl?: unknown; sslCa?: unknown } = {}): ConnectionOptions {
  const text = raw.trim()
  if (/^mysqlx:\/\//i.test(text)) {
    throw new Error('connectionString: mysqlx:// is the X Protocol, which this connector does not speak; use mysql://')
  }
  if (!/^mysql:\/\//i.test(text)) {
    throw new Error(`connectionString must be a MySQL URL starting with mysql://, e.g. ${EXAMPLE}`)
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error(`connectionString is not a valid URL; the form is ${EXAMPLE}`)
  }
  const user = decode(url.username, 'user name')
  if (!user) throw new Error(`connectionString: a user name is required, e.g. ${EXAMPLE}`)
  if (/[()]/.test(url.host)) throw new Error('connectionString: a socket path in parentheses is not supported; give a host name or IP')
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  if (!host) throw new Error(`connectionString: a host is required, e.g. ${EXAMPLE}`)
  const port = url.port === '' ? DEFAULT_PORT : Number(url.port)
  const database = decode(url.pathname.replace(/^\//, ''), 'database name')

  const urlMode = url.searchParams.get('ssl-mode')
  const fromUrl = urlMode === null ? undefined : URL_SSL_MODES[urlMode.toUpperCase()]
  if (urlMode !== null && fromUrl === undefined) {
    throw new Error(`connectionString: ssl-mode "${urlMode}" is not one of ${Object.keys(URL_SSL_MODES).join(', ')}`)
  }
  const sslMode = parseSslMode(settings.ssl) ?? fromUrl ?? 'disabled'
  const sslCa = String(settings.sslCa ?? '').trim() || url.searchParams.get('ssl-ca')?.replace(/^\((.*)\)$/, '$1') || undefined

  return {
    user,
    ...(url.password !== '' && { password: decode(url.password, 'password') }),
    host,
    port,
    ...(database !== '' && { database }),
    sslMode,
    ...(sslCa && { sslCa })
  }
}
