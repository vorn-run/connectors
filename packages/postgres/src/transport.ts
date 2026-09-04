/**
 * The one place a real socket is opened.
 *
 * Built from injected `net` and `tls` functions so a test can hand in fakes
 * that emit the events a socket would, and every branch here runs without a
 * socket ever existing.
 */
import { readFileSync } from 'node:fs'
import { connect as netConnect, isIP, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect, type ConnectionOptions as TlsOptions } from 'node:tls'
import type { ConnectionOptions } from './connection-string'

export interface Transport {
  connect(options: ConnectionOptions): Promise<Duplex>
  secure(socket: Duplex, options: ConnectionOptions): Promise<Duplex>
}

export interface TransportDeps {
  netConnect: typeof netConnect
  tlsConnect: typeof tlsConnect
  readFile: (path: string) => Buffer
}

/** What `tls.connect` is told for each sslmode, following the manual's table. */
export function tlsOptions(options: ConnectionOptions, readFile: (path: string) => Buffer): TlsOptions {
  const verify = options.sslMode === 'verify-ca' || options.sslMode === 'verify-full'
  const ca = verify && options.sslRootCert && options.sslRootCert !== 'system' ? readFile(options.sslRootCert) : undefined
  return {
    rejectUnauthorized: verify,
    ...(ca && { ca }),
    // SNI takes a name, not an address.
    ...(isIP(options.host) === 0 && { servername: options.host }),
    // verify-ca checks the chain but not the name, which is the manual's definition of it.
    ...(options.sslMode === 'verify-ca' && { checkServerIdentity: () => undefined })
  }
}

export function createNodeTransport(deps: Partial<TransportDeps> = {}): Transport {
  const { netConnect: openTcp = netConnect, tlsConnect: openTls = tlsConnect, readFile = readFileSync } = deps
  return {
    connect(options) {
      return new Promise((resolve, reject) => {
        const socket = openTcp({ host: options.host, port: options.port })
        if (options.connectTimeoutMs > 0) {
          socket.setTimeout(options.connectTimeoutMs, () => {
            socket.destroy(new Error(`connecting to ${options.host}:${options.port} timed out`))
          })
        }
        socket.once('error', reject)
        socket.once('connect', () => {
          socket.off('error', reject)
          socket.setTimeout(0)
          socket.setNoDelay(true)
          resolve(socket)
        })
      })
    },
    secure(socket, options) {
      return new Promise((resolve, reject) => {
        const secured = openTls({ socket: socket as Socket, ...tlsOptions(options, readFile) })
        secured.once('error', reject)
        secured.once('secureConnect', () => {
          secured.off('error', reject)
          resolve(secured)
        })
      })
    }
  }
}

export const nodeTransport: Transport = createNodeTransport()
