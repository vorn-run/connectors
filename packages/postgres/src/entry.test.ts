import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { isEntryPoint, serveIfEntryPoint } from './entry'
import connector, { connector as named, postgresConnector } from './index'

const HERE = import.meta.url

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

describe('serveIfEntryPoint', () => {
  it('starts nothing when the module was merely imported', () => {
    const serve = vi.fn()
    expect(serveIfEntryPoint(connector, HERE, serve)).toBe(false)
    expect(serve).not.toHaveBeenCalled()
  })

  it('serves when the module is the entry point', () => {
    const serve = vi.fn()
    const argv = process.argv[1]
    process.argv[1] = fileURLToPath(HERE)
    try {
      expect(serveIfEntryPoint(connector, HERE, serve)).toBe(true)
    } finally {
      process.argv[1] = argv as string
    }
    expect(serve).toHaveBeenCalledWith(connector)
  })
})

describe('the packaged connector', () => {
  it('is the same connector under every export, versioned from package.json', () => {
    expect(connector).toBe(named)
    expect(connector).toBe(postgresConnector)
    expect(connector.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})
