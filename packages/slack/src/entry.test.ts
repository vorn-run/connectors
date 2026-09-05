import { describe, expect, it, vi } from 'vitest'
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isEntryPoint, serveIfEntryPoint } from './entry'
import connector, { connector as named } from './index'

const HERE = import.meta.url

describe('isEntryPoint', () => {
  it('is false when the process was started without a script', () => {
    expect(isEntryPoint(HERE, ['node'])).toBe(false)
  })

  it('is true when argv points at this module, through a symlink or not', () => {
    expect(isEntryPoint(HERE, ['node', fileURLToPath(HERE)])).toBe(true)
    expect(isEntryPoint(HERE, ['node', realpathSync(fileURLToPath(HERE))])).toBe(true)
  })

  it('is false when the module is running under the test runner', () => {
    expect(isEntryPoint(HERE)).toBe(false)
  })

  it('is false rather than throwing when a path cannot be resolved', () => {
    expect(isEntryPoint(HERE, ['node', '/nowhere/that/exists'])).toBe(false)
  })
})

describe('serveIfEntryPoint', () => {
  it('starts nothing when the module was merely imported', async () => {
    const serve = vi.fn(async () => {})
    expect(await serveIfEntryPoint(HERE, serve)).toBe(false)
    expect(serve).not.toHaveBeenCalled()
  })

  it('serves the connector when the module is the entry point', async () => {
    const serve = vi.fn(async () => {})
    const self = pathToFileURL(process.argv[1]!).href
    expect(await serveIfEntryPoint(self, serve)).toBe(true)
    expect(serve).toHaveBeenCalledWith(connector)
  })
})

describe('the packaged connector', () => {
  it('is the same connector under both exports', () => {
    expect(connector).toBe(named)
    expect(connector.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})
