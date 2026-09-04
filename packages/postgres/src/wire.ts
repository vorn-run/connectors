/**
 * The frontend/backend protocol, version 3.0, as far as this connector needs:
 * start-up with SSL negotiation, cleartext, MD5 and SCRAM-SHA-256 password
 * authentication, the simple and extended query flows, and termination.
 *
 * Nothing here touches a socket directly. A `Transport` opens the TCP stream
 * and upgrades it to TLS, so tests hand in scripted in-process streams and the
 * protocol is exercised byte for byte with no network.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { ConnectionOptions } from './connection-string'
import { encodeParam, type Field, type RawRow } from './sql'
import { nodeTransport, type Transport } from './transport'

const PROTOCOL_VERSION = 196608
const SSL_REQUEST_CODE = 80877103
const SCRAM_MECHANISM = 'SCRAM-SHA-256'
/** Channel binding is not offered, so the GS2 header is always `n,,`, which is `biws` in base64. */
const GS2_HEADER_BASE64 = 'biws'

export interface QueryResult {
  fields: Field[]
  /** The last result set's rows, as text. */
  rows: RawRow[]
  /** The last CommandComplete tag's first word, e.g. `SELECT`, `INSERT`. */
  command: string
  /** The row count the tag carried, or 0 when it carried none. */
  rowCount: number
}

export interface PgClient {
  query(sql: string, params?: unknown[]): Promise<QueryResult>
  close(): Promise<void>
}

export class PostgresError extends Error {
  readonly code: string
  readonly severity: string
  readonly detail?: string
  readonly hint?: string
  readonly position?: number

  constructor(fields: Map<string, string>) {
    const code = fields.get('C') ?? 'XX000'
    const text = fields.get('M') ?? 'unknown error'
    // Class 28 is "invalid authorization", which the SDK grades as a failed login only when it says so.
    const prefix = code.startsWith('28') ? 'unauthorized: ' : ''
    super(`${prefix}${text} (SQLSTATE ${code})`)
    this.name = 'PostgresError'
    this.code = code
    this.severity = fields.get('V') ?? fields.get('S') ?? 'ERROR'
    const detail = fields.get('D')
    if (detail !== undefined) this.detail = detail
    const hint = fields.get('H')
    if (hint !== undefined) this.hint = hint
    const position = fields.get('P')
    if (position !== undefined) this.position = Number(position)
  }
}

// --- Frames ---------------------------------------------------------------

function cstring(text: string): Buffer {
  if (text.includes('\0')) throw new Error('a protocol string cannot contain a NUL character')
  return Buffer.from(`${text}\0`, 'utf8')
}

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeInt32BE(value)
  return buffer
}

function int16(value: number): Buffer {
  const buffer = Buffer.alloc(2)
  buffer.writeInt16BE(value)
  return buffer
}

/** One message: the type byte (none for start-up frames), then a length that counts itself. */
export function frame(type: string | null, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  const header = type === null ? int32(body.length + 4) : Buffer.concat([Buffer.from(type), int32(body.length + 4)])
  return Buffer.concat([header, body])
}

export function sslRequest(): Buffer {
  return frame(null, int32(SSL_REQUEST_CODE))
}

export function startupMessage(options: ConnectionOptions): Buffer {
  const parameters: Array<[string, string]> = [
    ['user', options.user],
    ['database', options.database],
    ['application_name', options.applicationName],
    ['client_encoding', 'UTF8'],
    ['DateStyle', 'ISO'],
    ['TimeZone', 'UTC']
  ]
  const pairs = parameters.flatMap(([key, value]) => [cstring(key), cstring(value)])
  return frame(null, int32(PROTOCOL_VERSION), ...pairs, Buffer.from([0]))
}

export function simpleQuery(sql: string): Buffer {
  return frame('Q', cstring(sql))
}

/** Parse, Bind, Describe, Execute and Sync in one write, all against the unnamed statement and portal. */
export function extendedQuery(sql: string, params: unknown[]): Buffer {
  const values = params.map((value) => {
    const text = encodeParam(value)
    if (text === null) return int32(-1)
    const bytes = Buffer.from(text, 'utf8')
    return Buffer.concat([int32(bytes.length), bytes])
  })
  return Buffer.concat([
    frame('P', cstring(''), cstring(sql), int16(0)),
    frame('B', cstring(''), cstring(''), int16(0), int16(values.length), ...values, int16(1), int16(0)),
    frame('D', Buffer.from('P'), cstring('')),
    frame('E', cstring(''), int32(0)),
    frame('S')
  ])
}

export function terminateMessage(): Buffer {
  return frame('X')
}

function readCString(body: Buffer, offset: number): { text: string; next: number } {
  const end = body.indexOf(0, offset)
  if (end === -1) throw new Error('malformed message from the server: unterminated string')
  return { text: body.toString('utf8', offset, end), next: end + 1 }
}

export function parseErrorFields(body: Buffer): Map<string, string> {
  const fields = new Map<string, string>()
  let offset = 0
  while (offset < body.length) {
    const type = body[offset] as number
    if (type === 0) break
    const { text, next } = readCString(body, offset + 1)
    fields.set(String.fromCharCode(type), text)
    offset = next
  }
  return fields
}

export function parseRowDescription(body: Buffer): Field[] {
  const count = body.readInt16BE(0)
  const fields: Field[] = []
  let offset = 2
  for (let index = 0; index < count; index++) {
    const { text, next } = readCString(body, offset)
    // After the name: table OID (4), column number (2), type OID (4), type size (2), modifier (4), format (2).
    fields.push({ name: text, typeOid: body.readInt32BE(next + 6) })
    offset = next + 18
  }
  return fields
}

export function parseDataRow(body: Buffer): RawRow {
  const count = body.readInt16BE(0)
  const row: RawRow = []
  let offset = 2
  for (let index = 0; index < count; index++) {
    const length = body.readInt32BE(offset)
    offset += 4
    if (length === -1) {
      row.push(null)
    } else {
      row.push(body.toString('utf8', offset, offset + length))
      offset += length
    }
  }
  return row
}

/** `INSERT 0 5` → INSERT and 5; `CREATE TABLE` → CREATE and 0. */
export function parseCommandTag(tag: string): { command: string; rowCount: number } {
  const words = tag.trim().split(' ')
  const last = words[words.length - 1] ?? ''
  const rowCount = words.length > 1 && /^\d+$/.test(last) ? Number(last) : 0
  return { command: words[0] ?? '', rowCount }
}

// --- Passwords ------------------------------------------------------------

/** The manual's formula: `'md5' + md5(md5(password + user) + salt)`. */
export function md5Password(user: string, password: string, salt: Buffer): string {
  const inner = createHash('md5').update(`${password}${user}`, 'utf8').digest('hex')
  const outer = createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex')
  return `md5${outer}`
}

function parseScramAttributes(message: string): Map<string, string> {
  const attributes = new Map<string, string>()
  for (const part of message.split(',')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    attributes.set(part.slice(0, eq), part.slice(eq + 1))
  }
  return attributes
}

/** One SCRAM-SHA-256 exchange, per RFC 5802 with the RFC 7677 hash; no channel binding. */
export class ScramSession {
  readonly clientFirstBare: string
  private serverSignature?: string

  constructor(
    private readonly password: string,
    private readonly clientNonce: string,
    user = ''
  ) {
    this.clientFirstBare = `n=${user},r=${clientNonce}`
  }

  clientFirst(): string {
    return `n,,${this.clientFirstBare}`
  }

  clientFinal(serverFirst: string): string {
    const attributes = parseScramAttributes(serverFirst)
    const nonce = attributes.get('r')
    const salt = attributes.get('s')
    const iterations = Number(attributes.get('i'))
    if (!nonce || !salt || !Number.isInteger(iterations) || iterations < 1) {
      throw new Error('malformed SCRAM server-first message')
    }
    if (!nonce.startsWith(this.clientNonce)) throw new Error('SCRAM server nonce does not start with ours')

    const salted = pbkdf2Sync(this.password, Buffer.from(salt, 'base64'), iterations, 32, 'sha256')
    const clientKey = createHmac('sha256', salted).update('Client Key').digest()
    const storedKey = createHash('sha256').update(clientKey).digest()
    const withoutProof = `c=${GS2_HEADER_BASE64},r=${nonce}`
    const authMessage = `${this.clientFirstBare},${serverFirst},${withoutProof}`
    const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest()
    const proof = Buffer.from(clientKey.map((byte, index) => byte ^ (clientSignature[index] as number)))
    const serverKey = createHmac('sha256', salted).update('Server Key').digest()
    this.serverSignature = createHmac('sha256', serverKey).update(authMessage).digest('base64')
    return `${withoutProof},p=${proof.toString('base64')}`
  }

  verifyServerFinal(serverFinal: string): void {
    const attributes = parseScramAttributes(serverFinal)
    const error = attributes.get('e')
    if (error !== undefined) throw new Error(`SCRAM authentication failed: ${error}`)
    if (this.serverSignature === undefined || attributes.get('v') !== this.serverSignature) {
      throw new Error('SCRAM server signature does not verify; the server may not be who it says')
    }
  }
}

// --- Stream reading -------------------------------------------------------

/** Byte-exact reads over a Duplex, one outstanding read at a time. */
class Reader {
  private chunks: Buffer[] = []
  private available = 0
  private waiting?: { need: number; resolve: (bytes: Buffer) => void; reject: (error: Error) => void }
  private failure?: Error

  constructor(private readonly stream: Duplex) {
    stream.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk)
      this.available += chunk.length
      this.settle()
    })
    stream.on('error', (error: Error) => this.fail(error))
    stream.on('end', () => this.fail(new Error('the server closed the connection')))
    stream.on('close', () => this.fail(new Error('the server closed the connection')))
    stream.resume()
  }

  read(need: number): Promise<Buffer> {
    if (this.available >= need) return Promise.resolve(this.take(need))
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.waiting = { need, resolve, reject }
    })
  }

  private take(need: number): Buffer {
    const joined = this.chunks.length === 1 ? (this.chunks[0] as Buffer) : Buffer.concat(this.chunks)
    const bytes = joined.subarray(0, need)
    const rest = joined.subarray(need)
    this.chunks = rest.length > 0 ? [rest] : []
    this.available = rest.length
    return bytes
  }

  private settle(): void {
    if (this.waiting && this.available >= this.waiting.need) {
      const { need, resolve } = this.waiting
      this.waiting = undefined
      resolve(this.take(need))
    }
  }

  private fail(error: Error): void {
    this.failure ??= error
    if (this.waiting) {
      const { reject } = this.waiting
      this.waiting = undefined
      reject(error)
    }
  }
}

// --- The connection -------------------------------------------------------

class Connection implements PgClient {
  private readonly reader: Reader

  constructor(private readonly stream: Duplex) {
    this.reader = new Reader(stream)
  }

  private async readMessage(): Promise<{ type: string; body: Buffer }> {
    const header = await this.reader.read(5)
    const type = String.fromCharCode(header[0] as number)
    const length = header.readInt32BE(1)
    if (length < 4) throw new Error(`malformed message "${type}" from the server`)
    return { type, body: await this.reader.read(length - 4) }
  }

  async startup(options: ConnectionOptions, nonce: () => string): Promise<void> {
    this.stream.write(startupMessage(options))
    let scram: ScramSession | undefined
    const password = (): string => {
      if (options.password === undefined) {
        throw new Error('the server asks for a password and the connection string carries none')
      }
      return options.password
    }

    for (;;) {
      const { type, body } = await this.readMessage()
      switch (type) {
        case 'R': {
          const code = body.readInt32BE(0)
          if (code === 0) break
          if (code === 3) {
            this.stream.write(frame('p', cstring(password())))
          } else if (code === 5) {
            this.stream.write(frame('p', cstring(md5Password(options.user, password(), body.subarray(4, 8)))))
          } else if (code === 10) {
            const mechanisms: string[] = []
            let offset = 4
            while (offset < body.length && body[offset] !== 0) {
              const { text, next } = readCString(body, offset)
              mechanisms.push(text)
              offset = next
            }
            if (!mechanisms.includes(SCRAM_MECHANISM)) {
              throw new Error(`the server offers ${mechanisms.join(', ') || 'no'} SASL mechanisms; only ${SCRAM_MECHANISM} is supported`)
            }
            scram = new ScramSession(password(), nonce())
            const first = Buffer.from(scram.clientFirst(), 'utf8')
            this.stream.write(frame('p', cstring(SCRAM_MECHANISM), int32(first.length), first))
          } else if (code === 11) {
            if (!scram) throw new Error('SCRAM continue message arrived before the exchange started')
            this.stream.write(frame('p', Buffer.from(scram.clientFinal(body.toString('utf8', 4)), 'utf8')))
          } else if (code === 12) {
            if (!scram) throw new Error('SCRAM final message arrived before the exchange started')
            scram.verifyServerFinal(body.toString('utf8', 4))
          } else {
            throw new Error(`authentication method ${code} is not supported`)
          }
          break
        }
        case 'E':
          throw new PostgresError(parseErrorFields(body))
        case 'S':
        case 'K':
        case 'N':
        case 'v':
          break
        case 'Z':
          return
        default:
          throw new Error(`unexpected message "${type}" from the server during start-up`)
      }
    }
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    this.stream.write(params.length === 0 ? simpleQuery(sql) : extendedQuery(sql, params))
    let fields: Field[] = []
    let rows: RawRow[] = []
    let command = ''
    let rowCount = 0
    let failure: PostgresError | undefined
    for (;;) {
      const { type, body } = await this.readMessage()
      switch (type) {
        case 'T':
          fields = parseRowDescription(body)
          rows = []
          break
        case 'D':
          rows.push(parseDataRow(body))
          break
        case 'C':
          ({ command, rowCount } = parseCommandTag(readCString(body, 0).text))
          break
        case 'I':
          command = ''
          rowCount = 0
          break
        case 'E':
          failure ??= new PostgresError(parseErrorFields(body))
          break
        case '1':
        case '2':
        case 'n':
        case 'N':
        case 'S':
          break
        case 'Z':
          if (failure) throw failure
          return { fields, rows, command, rowCount }
        default:
          throw new Error(`unexpected message "${type}" from the server during a query`)
      }
    }
  }

  async close(): Promise<void> {
    if (this.stream.destroyed) return
    await new Promise<void>((resolve) => this.stream.end(terminateMessage(), () => resolve()))
    this.stream.destroy()
  }
}

// --- Opening --------------------------------------------------------------

async function negotiateSsl(socket: Duplex, options: ConnectionOptions, transport: Transport): Promise<Duplex> {
  const answer = await new Promise<Buffer>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    socket.once('error', onError)
    socket.once('data', (chunk: Buffer) => {
      socket.off('error', onError)
      resolve(chunk)
    })
    socket.write(sslRequest())
  })
  const reply = String.fromCharCode(answer[0] as number)
  // An ErrorResponse here is never shown: it arrived unencrypted from whoever answered (CVE-2024-10977).
  if (reply === 'E') throw new Error('the server refused the SSL request')
  // Exactly one byte comes back; anything more is data injected ahead of the handshake (CVE-2021-23222).
  if (answer.length !== 1) throw new Error('the server sent data ahead of the TLS handshake; refusing to continue')
  if (reply === 'S') return transport.secure(socket, options)
  if (reply === 'N') {
    if (options.sslMode !== 'allow' && options.sslMode !== 'prefer') {
      throw new Error(`the server does not support SSL and sslmode is ${options.sslMode}`)
    }
    socket.pause()
    return socket
  }
  throw new Error(`the server answered the SSL request with "${reply}"`)
}

export function randomNonce(): string {
  return randomBytes(18).toString('base64')
}

/** Open, negotiate SSL, authenticate and wait for ReadyForQuery, within `connect_timeout`. */
export async function openConnection(
  options: ConnectionOptions,
  transport: Transport = nodeTransport,
  nonce: () => string = randomNonce
): Promise<PgClient> {
  let socket: Duplex | undefined
  let stream: Duplex | undefined
  const work = (async () => {
    socket = await transport.connect(options)
    stream = options.sslMode === 'disable' ? socket : await negotiateSsl(socket, options, transport)
    const connection = new Connection(stream)
    await connection.startup(options, nonce)
    return connection
  })()

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    if (options.connectTimeoutMs <= 0) return
    timer = setTimeout(() => {
      reject(new Error(`connecting to ${options.host}:${options.port} timed out after ${options.connectTimeoutMs} ms`))
    }, options.connectTimeoutMs)
  })

  try {
    return await Promise.race([work, timeout])
  } catch (error) {
    stream?.destroy()
    socket?.destroy()
    throw error
  } finally {
    clearTimeout(timer)
  }
}
