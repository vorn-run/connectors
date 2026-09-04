import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionOptions } from './connection-string'
import { createNodeTransport, nodeTransport, tlsOptions, type TransportDeps } from './transport'

const base: ConnectionOptions = {
  user: 'u',
  host: 'db.example.com',
  port: 5432,
  database: 'd',
  sslMode: 'prefer',
  connectTimeoutMs: 1000,
  applicationName: 'test'
}

/** Enough of a net.Socket for the transport: events, timeouts, and the two setters it calls. */
class FakeSocket extends EventEmitter {
  timeoutMs?: number
  onTimeout?: () => void
  noDelay?: boolean
  destroyedWith?: Error
  setTimeout(ms: number, handler?: () => void) {
    this.timeoutMs = ms
    this.onTimeout = handler
  }
  setNoDelay(value: boolean) {
    this.noDelay = value
  }
  destroy(error?: Error) {
    this.destroyedWith = error
    if (error) this.emit('error', error)
  }
}

function deps(socket: FakeSocket, secured = new FakeSocket()): TransportDeps & { tlsArgs: unknown[] } {
  const holder = { tlsArgs: [] as unknown[] }
  return {
    ...holder,
    netConnect: vi.fn(() => socket) as unknown as TransportDeps['netConnect'],
    tlsConnect: vi.fn((options: unknown) => {
      holder.tlsArgs.push(options)
      return secured
    }) as unknown as TransportDeps['tlsConnect'],
    readFile: vi.fn(() => Buffer.from('PEM')),
    get tlsArgs() {
      return holder.tlsArgs
    }
  }
}

describe('tlsOptions', () => {
  const read = () => Buffer.from('CA')

  it('encrypts without verifying for require', () => {
    expect(tlsOptions({ ...base, sslMode: 'require' }, read)).toEqual({
      rejectUnauthorized: false,
      servername: 'db.example.com'
    })
  })

  it('verifies the chain but not the name for verify-ca, from the given bundle', () => {
    const options = tlsOptions({ ...base, sslMode: 'verify-ca', sslRootCert: '/ca.pem' }, read)
    expect(options.rejectUnauthorized).toBe(true)
    expect(options.ca).toEqual(Buffer.from('CA'))
    expect(typeof options.checkServerIdentity).toBe('function')
    expect(options.checkServerIdentity?.('x', {} as never)).toBeUndefined()
  })

  it('verifies name and chain for verify-full, using the system roots when asked', () => {
    const options = tlsOptions({ ...base, sslMode: 'verify-full', sslRootCert: 'system' }, read)
    expect(options).toEqual({ rejectUnauthorized: true, servername: 'db.example.com' })
  })

  it('sends no SNI for an IP address host', () => {
    expect(tlsOptions({ ...base, host: '10.0.0.1', sslMode: 'require' }, read)).toEqual({
      rejectUnauthorized: false
    })
  })
})

describe('createNodeTransport', () => {
  it('resolves with the socket once it connects, clearing the connect timeout', async () => {
    const socket = new FakeSocket()
    const transport = createNodeTransport(deps(socket))
    const pending = transport.connect(base)
    expect(socket.timeoutMs).toBe(1000)
    socket.emit('connect')
    expect(await pending).toBe(socket)
    expect(socket.timeoutMs).toBe(0)
    expect(socket.noDelay).toBe(true)
  })

  it('sets no timeout when connect_timeout is 0', async () => {
    const socket = new FakeSocket()
    const pending = createNodeTransport(deps(socket)).connect({ ...base, connectTimeoutMs: 0 })
    expect(socket.timeoutMs).toBeUndefined()
    socket.emit('connect')
    await pending
  })

  it('rejects when the socket errors or times out before connecting', async () => {
    const failing = new FakeSocket()
    const failed = createNodeTransport(deps(failing)).connect(base)
    failing.emit('error', new Error('ECONNREFUSED'))
    await expect(failed).rejects.toThrow('ECONNREFUSED')

    const slow = new FakeSocket()
    const late = createNodeTransport(deps(slow)).connect(base)
    slow.onTimeout?.()
    await expect(late).rejects.toThrow(/timed out/)
    expect(slow.destroyedWith?.message).toMatch(/db.example.com:5432/)
  })

  it('upgrades the socket with the options for its sslmode', async () => {
    const socket = new FakeSocket()
    const secured = new FakeSocket()
    const d = deps(socket, secured)
    const pending = createNodeTransport(d).secure(socket as never, { ...base, sslMode: 'verify-ca', sslRootCert: '/ca' })
    secured.emit('secureConnect')
    expect(await pending).toBe(secured)
    expect(d.tlsArgs[0]).toMatchObject({ socket, rejectUnauthorized: true, ca: Buffer.from('PEM') })
  })

  it('rejects when the handshake fails', async () => {
    const secured = new FakeSocket()
    const pending = createNodeTransport(deps(new FakeSocket(), secured)).secure(new FakeSocket() as never, base)
    secured.emit('error', new Error('self signed certificate'))
    await expect(pending).rejects.toThrow('self signed certificate')
  })

  it('has a default built on node:net and node:tls', () => {
    expect(typeof nodeTransport.connect).toBe('function')
    expect(typeof nodeTransport.secure).toBe('function')
  })
})
