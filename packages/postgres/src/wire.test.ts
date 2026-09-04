import { createHash, createHmac, pbkdf2Sync } from 'node:crypto'
import { Duplex } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionOptions } from './connection-string'
import { OID } from './sql'
import type { Transport } from './transport'
import {
  extendedQuery,
  frame,
  md5Password,
  openConnection,
  parseCommandTag,
  parseDataRow,
  parseErrorFields,
  parseRowDescription,
  PostgresError,
  randomNonce,
  ScramSession,
  simpleQuery,
  sslRequest,
  startupMessage,
  terminateMessage
} from './wire'

// --- Server-side message builders, written independently of the client's ---

function int32(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeInt32BE(value)
  return b
}

function int16(value: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeInt16BE(value)
  return b
}

const cstr = (text: string) => Buffer.from(`${text}\0`)

const auth = (code: number, ...rest: Buffer[]) => frame('R', int32(code), ...rest)
const ready = () => frame('Z', Buffer.from('I'))
const paramStatus = () => frame('S', cstr('server_version'), cstr('16.0'))
const backendKey = () => frame('K', int32(1), int32(2))
const notice = () => frame('N', Buffer.from('S'), cstr('NOTICE'), Buffer.from('M'), cstr('hello'), Buffer.from([0]))
const complete = (tag: string) => frame('C', cstr(tag))
const rowDescription = (fields: Array<[string, number]>) =>
  frame(
    'T',
    int16(fields.length),
    ...fields.flatMap(([name, oid]) => [cstr(name), int32(0), int16(0), int32(oid), int16(-1), int32(-1), int16(0)])
  )
const dataRow = (values: Array<string | null>) =>
  frame(
    'D',
    int16(values.length),
    ...values.map((v) => (v === null ? int32(-1) : Buffer.concat([int32(Buffer.byteLength(v)), Buffer.from(v)])))
  )
const errorResponse = (fields: Record<string, string>) =>
  frame('E', ...Object.entries(fields).map(([k, v]) => Buffer.concat([Buffer.from(k), cstr(v)])), Buffer.from([0]))

const happyStartup = () => [auth(0), paramStatus(), backendKey(), notice(), ready()]

// --- A scripted in-process stream standing in for the server ---

type Script = (incoming: Buffer, count: number) => Buffer[] | 'close' | 'end' | undefined

function scripted(script: Script, chunk?: number) {
  const written: Buffer[] = []
  const stream = new Duplex({
    read() {},
    write(incoming: Buffer, _encoding, callback) {
      written.push(incoming)
      const reply = script(incoming, written.length)
      if (reply === 'close') process.nextTick(() => stream.destroy())
      else if (reply === 'end') process.nextTick(() => stream.push(null))
      else if (reply) {
        const all = Buffer.concat(reply)
        if (chunk) for (let at = 0; at < all.length; at += chunk) stream.push(all.subarray(at, at + chunk))
        else stream.push(all)
      }
      callback()
    }
  })
  return { stream, written }
}

const options: ConnectionOptions = {
  user: 'alice',
  password: 'pencil',
  host: 'db',
  port: 5432,
  database: 'app',
  sslMode: 'disable',
  connectTimeoutMs: 0,
  applicationName: 'test'
}

function transportOf(stream: Duplex, secured?: Duplex): Transport & { secure: ReturnType<typeof vi.fn> } {
  return {
    connect: async () => stream,
    secure: vi.fn(async () => secured ?? stream)
  }
}

/** RFC 5802 done by hand, so the client is checked against something it did not write. */
function scramByHand(password: string, clientFirstBare: string, serverFirst: string, serverNonce: string) {
  const attrs = Object.fromEntries(serverFirst.split(',').map((p) => [p[0], p.slice(2)]))
  const salted = pbkdf2Sync(password, Buffer.from(attrs.s as string, 'base64'), Number(attrs.i), 32, 'sha256')
  const hmac = (key: Buffer, data: string) => createHmac('sha256', key).update(data).digest()
  const clientKey = hmac(salted, 'Client Key')
  const storedKey = createHash('sha256').update(clientKey).digest()
  const authMessage = `${clientFirstBare},${serverFirst},c=biws,r=${serverNonce}`
  const signature = hmac(storedKey, authMessage)
  const proof = Buffer.from(clientKey.map((b, i) => b ^ (signature[i] as number))).toString('base64')
  const serverSignature = hmac(hmac(salted, 'Server Key'), authMessage).toString('base64')
  return { clientFinal: `c=biws,r=${serverNonce},p=${proof}`, serverFinal: `v=${serverSignature}` }
}

const NONCE = 'rOprNGfwEbeRWgbNEkqO'
const SERVER_NONCE = `${NONCE}%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0`
const SERVER_FIRST = `r=${SERVER_NONCE},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096`

describe('frames', () => {
  it('lays out the start-up packet without a type byte', () => {
    const packet = startupMessage(options)
    expect(packet.readInt32BE(0)).toBe(packet.length)
    expect(packet.readInt32BE(4)).toBe(196608)
    const body = packet.subarray(8).toString()
    expect(body).toBe('user\0alice\0database\0app\0application_name\0test\0client_encoding\0UTF8\0DateStyle\0ISO\0TimeZone\0UTC\0\0')
  })

  it('lays out SSLRequest, Query and Terminate', () => {
    expect(sslRequest()).toEqual(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]))
    expect(simpleQuery('SELECT 1')).toEqual(Buffer.concat([Buffer.from('Q'), int32(13), cstr('SELECT 1')]))
    expect(terminateMessage()).toEqual(Buffer.from([88, 0, 0, 0, 4]))
    expect(frame('S')).toEqual(Buffer.from([83, 0, 0, 0, 4]))
  })

  it('binds parameters as text, with -1 for NULL, all in one write', () => {
    const bytes = extendedQuery('SELECT $1, $2', ['a', null])
    const bind = bytes.indexOf(Buffer.from('B'))
    expect(bytes[0]).toBe('P'.charCodeAt(0))
    expect(bytes.subarray(bind + 5).toString('latin1')).toContain('\0\0\0\0\0\0\0\0a\xff\xff\xff\xff\0\0\0')
    expect(bytes.subarray(-22)).toEqual(
      Buffer.concat([Buffer.from('D'), int32(6), Buffer.from('P'), cstr(''), Buffer.from('E'), int32(9), cstr(''), int32(0), frame('S')])
    )
  })

  it('refuses a NUL inside protocol text', () => {
    expect(() => simpleQuery('SELECT \0')).toThrow(/NUL/)
  })
})

describe('parsers', () => {
  it('reads error fields until the terminator', () => {
    const fields = parseErrorFields(errorResponse({ S: 'ERROR', C: '42P01', M: 'relation "x" does not exist' }).subarray(5))
    expect(Object.fromEntries(fields)).toEqual({ S: 'ERROR', C: '42P01', M: 'relation "x" does not exist' })
    expect(() => parseErrorFields(Buffer.from('Mno terminator'))).toThrow(/unterminated/)
  })

  it('reads a row description and a data row', () => {
    const fields = parseRowDescription(rowDescription([['id', OID.int4], ['name', 25]]).subarray(5))
    expect(fields).toEqual([{ name: 'id', typeOid: OID.int4 }, { name: 'name', typeOid: 25 }])
    expect(parseDataRow(dataRow(['1', null, 'héllo']).subarray(5))).toEqual(['1', null, 'héllo'])
  })

  it('reads a command tag', () => {
    expect(parseCommandTag('INSERT 0 5')).toEqual({ command: 'INSERT', rowCount: 5 })
    expect(parseCommandTag('SELECT 3')).toEqual({ command: 'SELECT', rowCount: 3 })
    expect(parseCommandTag('CREATE TABLE')).toEqual({ command: 'CREATE', rowCount: 0 })
    expect(parseCommandTag('')).toEqual({ command: '', rowCount: 0 })
  })

  it('builds an error with the manual\'s fields, flagging class 28 as unauthorized', () => {
    const error = new PostgresError(
      new Map([['S', 'FATAL'], ['V', 'FATAL'], ['C', '28P01'], ['M', 'password authentication failed'], ['D', 'd'], ['H', 'h'], ['P', '7']])
    )
    expect(error.message).toBe('unauthorized: password authentication failed (SQLSTATE 28P01)')
    expect(error).toMatchObject({ code: '28P01', severity: 'FATAL', detail: 'd', hint: 'h', position: 7 })
    const bare = new PostgresError(new Map())
    expect(bare.message).toBe('unknown error (SQLSTATE XX000)')
    expect(bare.severity).toBe('ERROR')
  })
})

describe('passwords', () => {
  it('computes the MD5 form the manual gives', () => {
    expect(md5Password('user', 'pencil', Buffer.from([1, 2, 3, 4]))).toBe('md54376eb6913b38f9aaff38dc7cf19ca76')
  })

  it('reproduces the RFC 7677 SCRAM-SHA-256 exchange', () => {
    const session = new ScramSession('pencil', NONCE, 'user')
    expect(session.clientFirst()).toBe(`n,,n=user,r=${NONCE}`)
    expect(session.clientFinal(SERVER_FIRST)).toBe(`c=biws,r=${SERVER_NONCE},p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=`)
    expect(() => session.verifyServerFinal('v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=')).not.toThrow()
  })

  it('refuses a malformed server-first, a foreign nonce, a server error and a bad signature', () => {
    expect(() => new ScramSession('p', NONCE).clientFinal('r=x,s=abc')).toThrow(/malformed/)
    expect(() => new ScramSession('p', NONCE).clientFinal('r=other,s=abc,i=1')).toThrow(/nonce/)
    const session = new ScramSession('pencil', NONCE)
    expect(() => session.verifyServerFinal('v=anything')).toThrow(/does not verify/)
    session.clientFinal(SERVER_FIRST)
    expect(() => session.verifyServerFinal('e=unknown-user')).toThrow(/unknown-user/)
    expect(() => session.verifyServerFinal('v=wrong')).toThrow(/does not verify/)
  })

  it('draws a fresh base64 nonce', () => {
    expect(randomNonce()).not.toBe(randomNonce())
    expect(randomNonce()).toMatch(/^[A-Za-z0-9+/]{24}$/)
  })
})

describe('openConnection', () => {
  it('authenticates with SCRAM-SHA-256, runs a simple query and terminates', async () => {
    const expected = scramByHand('pencil', `n=,r=${NONCE}`, SERVER_FIRST, SERVER_NONCE)
    const { stream, written } = scripted((incoming, count) => {
      if (count === 1) return [auth(10, cstr('SCRAM-SHA-256-PLUS'), cstr('SCRAM-SHA-256'), Buffer.from([0]))]
      if (count === 2) return [auth(11, Buffer.from(SERVER_FIRST))]
      if (count === 3) {
        expect(incoming.subarray(5).toString()).toBe(expected.clientFinal)
        return [auth(12, Buffer.from(expected.serverFinal)), ...happyStartup()]
      }
      if (count === 4) {
        return [
          rowDescription([['one', OID.int4], ['when', OID.timestamptz]]),
          dataRow(['1', '2026-09-04 12:00:00+00']),
          complete('SELECT 1'),
          ready()
        ]
      }
      return undefined
    }, 3)
    const client = await openConnection(options, transportOf(stream), () => NONCE)
    expect(written[1]).toEqual(
      frame('p', cstr('SCRAM-SHA-256'), int32(8 + NONCE.length), Buffer.from(`n,,n=,r=${NONCE}`))
    )

    const result = await client.query('SELECT 1 AS one')
    expect(result).toEqual({
      fields: [{ name: 'one', typeOid: OID.int4 }, { name: 'when', typeOid: OID.timestamptz }],
      rows: [['1', '2026-09-04 12:00:00+00']],
      command: 'SELECT',
      rowCount: 1
    })
    expect(written[3]).toEqual(simpleQuery('SELECT 1 AS one'))

    await client.close()
    expect(written[4]).toEqual(terminateMessage())
    expect(stream.destroyed).toBe(true)
    await expect(client.close()).resolves.toBeUndefined()
  })

  it('answers an MD5 challenge with the manual\'s formula', async () => {
    const { stream, written } = scripted((_, count) => {
      if (count === 1) return [auth(5, Buffer.from([1, 2, 3, 4]))]
      if (count === 2) return happyStartup()
      return undefined
    })
    await openConnection({ ...options, user: 'user' }, transportOf(stream))
    expect(written[1]).toEqual(frame('p', cstr('md54376eb6913b38f9aaff38dc7cf19ca76')))
  })

  it('answers a cleartext request with the password', async () => {
    const { stream, written } = scripted((_, count) => (count === 1 ? [auth(3)] : count === 2 ? happyStartup() : undefined))
    await openConnection(options, transportOf(stream))
    expect(written[1]).toEqual(frame('p', cstr('pencil')))
  })

  it('accepts a trust login, ignoring NegotiateProtocolVersion', async () => {
    const { stream } = scripted((_, count) => (count === 1 ? [frame('v', int32(196608), int32(0)), ...happyStartup()] : undefined))
    await expect(openConnection(options, transportOf(stream))).resolves.toBeDefined()
  })

  it('says when a password is needed and none was given', async () => {
    const { stream } = scripted((_, count) => (count === 1 ? [auth(3)] : undefined))
    const { password: _omitted, ...withoutPassword } = options
    await expect(openConnection(withoutPassword, transportOf(stream))).rejects.toThrow(/carries none/)
  })

  it('names an authentication method it cannot do', async () => {
    const kerberos = scripted((_, count) => (count === 1 ? [auth(7)] : undefined))
    await expect(openConnection(options, transportOf(kerberos.stream))).rejects.toThrow(/method 7 is not supported/)

    const plusOnly = scripted((_, count) => (count === 1 ? [auth(10, cstr('SCRAM-SHA-256-PLUS'), Buffer.from([0]))] : undefined))
    await expect(openConnection(options, transportOf(plusOnly.stream))).rejects.toThrow(/offers SCRAM-SHA-256-PLUS/)

    const none = scripted((_, count) => (count === 1 ? [auth(10, Buffer.from([0]))] : undefined))
    await expect(openConnection(options, transportOf(none.stream))).rejects.toThrow(/offers no SASL/)
  })

  it('refuses SCRAM continue or final messages before the exchange started', async () => {
    const early = scripted((_, count) => (count === 1 ? [auth(11, Buffer.from('r=x'))] : undefined))
    await expect(openConnection(options, transportOf(early.stream))).rejects.toThrow(/before the exchange/)
    const final = scripted((_, count) => (count === 1 ? [auth(12, Buffer.from('v=x'))] : undefined))
    await expect(openConnection(options, transportOf(final.stream))).rejects.toThrow(/before the exchange/)
  })

  it('surfaces a refused login as unauthorized', async () => {
    const { stream } = scripted((_, count) =>
      count === 1 ? [errorResponse({ S: 'FATAL', C: '28P01', M: 'password authentication failed for user "alice"' })] : undefined
    )
    await expect(openConnection(options, transportOf(stream))).rejects.toThrow(
      'unauthorized: password authentication failed for user "alice" (SQLSTATE 28P01)'
    )
  })

  it('refuses a message that has no place in start-up', async () => {
    const { stream } = scripted((_, count) => (count === 1 ? [frame('Q', cstr('x'))] : undefined))
    await expect(openConnection(options, transportOf(stream))).rejects.toThrow(/unexpected message "Q"/)
  })

  it('upgrades to TLS when the server says S', async () => {
    const raw = scripted((_, count) => (count === 1 ? [Buffer.from('S')] : undefined))
    const secured = scripted((_, count) => (count === 1 ? happyStartup() : undefined))
    const transport = transportOf(raw.stream, secured.stream)
    await openConnection({ ...options, sslMode: 'require' }, transport)
    expect(raw.written).toEqual([sslRequest()])
    expect(transport.secure).toHaveBeenCalledWith(raw.stream, expect.objectContaining({ sslMode: 'require' }))
    expect(secured.written[0]).toEqual(startupMessage(options))
  })

  it('continues in clear on N under prefer, and refuses under require', async () => {
    const clear = scripted((_, count) => (count === 1 ? [Buffer.from('N')] : count === 2 ? happyStartup() : undefined))
    const transport = transportOf(clear.stream)
    await openConnection({ ...options, sslMode: 'prefer' }, transport)
    expect(transport.secure).not.toHaveBeenCalled()
    expect(clear.written[1]).toEqual(startupMessage(options))

    const strict = scripted((_, count) => (count === 1 ? [Buffer.from('N')] : undefined))
    await expect(openConnection({ ...options, sslMode: 'verify-full' }, transportOf(strict.stream))).rejects.toThrow(
      /does not support SSL and sslmode is verify-full/
    )
  })

  it('refuses an error or extra bytes in the SSL answer', async () => {
    const refused = scripted((_, count) => (count === 1 ? [errorResponse({ M: 'no' })] : undefined))
    await expect(openConnection({ ...options, sslMode: 'prefer' }, transportOf(refused.stream))).rejects.toThrow(
      /refused the SSL request/
    )
    const injected = scripted((_, count) => (count === 1 ? [Buffer.from('S'), Buffer.from('X')] : undefined))
    await expect(openConnection({ ...options, sslMode: 'prefer' }, transportOf(injected.stream))).rejects.toThrow(
      /ahead of the TLS handshake/
    )
    const odd = scripted((_, count) => (count === 1 ? [Buffer.from('?')] : undefined))
    await expect(openConnection({ ...options, sslMode: 'prefer' }, transportOf(odd.stream))).rejects.toThrow(
      /answered the SSL request with "\?"/
    )
  })

  it('fails when the socket errors while waiting for the SSL answer', async () => {
    const { stream } = scripted(() => {
      process.nextTick(() => stream.destroy(new Error('reset')))
      return undefined
    })
    await expect(openConnection({ ...options, sslMode: 'prefer' }, transportOf(stream))).rejects.toThrow('reset')
  })

  it('gives up after connect_timeout and passes a connect failure through', async () => {
    const stuck = scripted(() => undefined)
    const timing: Transport = { connect: async () => stuck.stream, secure: async (s) => s }
    await expect(openConnection({ ...options, connectTimeoutMs: 20 }, timing)).rejects.toThrow(/timed out after 20 ms/)
    expect(stuck.stream.destroyed).toBe(true)

    const never: Transport = { connect: () => new Promise(() => {}), secure: async (s) => s }
    await expect(openConnection({ ...options, connectTimeoutMs: 20 }, never)).rejects.toThrow(/timed out/)

    const refusing: Transport = { connect: async () => Promise.reject(new Error('ECONNREFUSED')), secure: async (s) => s }
    await expect(openConnection(options, refusing)).rejects.toThrow('ECONNREFUSED')
  })
})

describe('query', () => {
  async function connected(script: Script) {
    const { stream, written } = scripted((incoming, count) => (count === 1 ? happyStartup() : script(incoming, count - 1)))
    const client = await openConnection(options, transportOf(stream))
    return { client, stream, written }
  }

  it('uses the extended protocol when there are parameters', async () => {
    const { client, written } = await connected(() => [
      frame('1'),
      frame('2'),
      rowDescription([['id', OID.int4]]),
      dataRow(['7']),
      complete('SELECT 1'),
      ready()
    ])
    const result = await client.query('SELECT id FROM t WHERE id = $1', [7])
    expect(result.rows).toEqual([['7']])
    expect(written[1]).toEqual(extendedQuery('SELECT id FROM t WHERE id = $1', [7]))
  })

  it('reports a statement with no result set, and an empty query', async () => {
    const { client } = await connected((_, count) =>
      count === 1 ? [frame('1'), frame('2'), frame('n'), complete('UPDATE 3'), ready()] : [frame('I'), ready()]
    )
    expect(await client.query('UPDATE t SET a = $1', [1])).toEqual({ fields: [], rows: [], command: 'UPDATE', rowCount: 3 })
    expect(await client.query('')).toEqual({ fields: [], rows: [], command: '', rowCount: 0 })
  })

  it('returns the last result set of several statements', async () => {
    const { client } = await connected(() => [
      rowDescription([['a', 25]]),
      dataRow(['1']),
      complete('SELECT 1'),
      paramStatus(),
      rowDescription([['b', 25]]),
      dataRow(['2']),
      dataRow(['3']),
      complete('SELECT 2'),
      ready()
    ])
    const result = await client.query('SELECT 1 AS a; SELECT 2 AS b UNION ALL SELECT 3')
    expect(result.fields).toEqual([{ name: 'b', typeOid: 25 }])
    expect(result.rows).toEqual([['2'], ['3']])
    expect(result.rowCount).toBe(2)
  })

  it('throws the server\'s error once ReadyForQuery arrives', async () => {
    const { client } = await connected(() => [
      errorResponse({ S: 'ERROR', C: '42601', M: 'syntax error at or near "SELEC"', P: '1', H: 'check the spelling' }),
      ready()
    ])
    const failure = await client.query('SELEC 1').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PostgresError)
    expect(failure).toMatchObject({ code: '42601', position: 1, hint: 'check the spelling' })
    expect((failure as Error).message).toBe('syntax error at or near "SELEC" (SQLSTATE 42601)')
  })

  it('refuses a message that has no place in a query', async () => {
    const { client } = await connected(() => [frame('R', int32(0))])
    await expect(client.query('SELECT 1')).rejects.toThrow(/unexpected message "R"/)
  })

  it('refuses a malformed length', async () => {
    const { client } = await connected(() => [Buffer.from([84, 0, 0, 0, 2])])
    await expect(client.query('SELECT 1')).rejects.toThrow(/malformed message "T"/)
  })

  it('fails when the server closes, half-closes, or errors mid-query', async () => {
    const closed = await connected(() => 'close')
    await expect(closed.client.query('SELECT 1')).rejects.toThrow(/closed the connection/)
    await expect(closed.client.query('SELECT 1')).rejects.toThrow(/closed the connection/)

    const ended = await connected(() => 'end')
    await expect(ended.client.query('SELECT 1')).rejects.toThrow(/closed the connection/)

    const broken = await connected(() => {
      process.nextTick(() => broken.stream.destroy(new Error('EPIPE')))
      return undefined
    })
    await expect(broken.client.query('SELECT 1')).rejects.toThrow('EPIPE')
  })
})
