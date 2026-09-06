import { EventEmitter } from 'node:events'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { closeOnExit, isEntryPoint, serveIfEntryPoint } from './entry'
import connector, { connector as named, mysqlConnector } from './index'

const HERE = import.meta.url

/** A process with a stdin, both plain emitters, whose exit only records the code. */
function fakeProcess() {
  return Object.assign(new EventEmitter(), { stdin: new EventEmitter(), exit: vi.fn() })
}

const settled = () => new Promise((resolve) => setImmediate(resolve))

describe('isEntryPoint', () => {
  it('is false when the process was started without a script', () => {
    expect(isEntryPoint(HERE, '')).toBe(false)
  })

  it('is true when argv points at this module, through a symlink or not', () => {
    expect(isEntryPoint(HERE, fileURLToPath(HERE))).toBe(true)
    expect(isEntryPoint(HERE, realpathSync(fileURLToPath(HERE)))).toBe(true)
  })

  it('is false when the module is running under the test runner', () => {
    expect(isEntryPoint(HERE)).toBe(false)
  })

  it('is false rather than throwing when a path cannot be resolved', () => {
    expect(isEntryPoint(HERE, '/nowhere/that/exists')).toBe(false)
  })
})

describe('closeOnExit', () => {
  it('closes the pools when stdin ends or closes, without exiting', async () => {
    const close = vi.fn(async () => {})
    const proc = fakeProcess()
    closeOnExit(close, proc)
    proc.stdin.emit('end')
    proc.stdin.emit('close')
    expect(close).toHaveBeenCalledTimes(2)
    await settled()
    expect(proc.exit).not.toHaveBeenCalled()
  })

  it('closes the pools on a stop signal and then exits with the conventional code, even when a close fails', async () => {
    const proc = fakeProcess()
    const close = vi.fn(async () => {})
    closeOnExit(close, proc)
    proc.emit('SIGTERM')
    await settled()
    expect(close).toHaveBeenCalledTimes(1)
    expect(proc.exit).toHaveBeenCalledWith(143)
    const failing = fakeProcess()
    closeOnExit(vi.fn(async () => { throw new Error('gone') }), failing)
    failing.emit('SIGINT')
    await settled()
    expect(failing.exit).toHaveBeenCalledWith(130)
  })
})

describe('serveIfEntryPoint', () => {
  it('starts nothing when the module was merely imported', () => {
    const serve = vi.fn()
    expect(serveIfEntryPoint(connector, HERE, serve)).toBe(false)
    expect(serve).not.toHaveBeenCalled()
  })

  it('serves when the module is the entry point, and closes the pools when stdin ends', async () => {
    const serve = vi.fn()
    const proc = fakeProcess()
    const argv = process.argv[1]
    process.argv[1] = fileURLToPath(HERE)
    try {
      expect(serveIfEntryPoint(connector, HERE, serve, proc)).toBe(true)
    } finally {
      process.argv[1] = argv as string
    }
    expect(serve).toHaveBeenCalledWith(connector)
    proc.stdin.emit('end')
    await expect(connector.closePools()).resolves.toBeUndefined()
  })
})

describe('the packaged connector', () => {
  it('is the same connector under every export, versioned from package.json', () => {
    expect(connector).toBe(named)
    expect(connector).toBe(mysqlConnector)
    expect(connector.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})
