import { describe, it, expect, vi } from 'vitest'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isEntryPoint, serveIfEntryPoint } from './entry'
import { discordConnector } from './index'

const HERE = import.meta.url

describe('isEntryPoint', () => {
  it('is false when the process was started without a script', () => {
    expect(isEntryPoint(HERE, '')).toBe(false)
  })

  it('is true when argv points at this module, symlink or not', () => {
    expect(isEntryPoint(HERE, fileURLToPath(HERE))).toBe(true)
    expect(isEntryPoint(HERE, realpathSync(fileURLToPath(HERE)))).toBe(true)
  })

  it('is false when the module is running the test runner, not itself', () => {
    expect(isEntryPoint(HERE, process.argv[1])).toBe(false)
  })

  it('is false rather than throwing when a path cannot be resolved', () => {
    expect(isEntryPoint(HERE, '/nowhere/that/exists/at/all')).toBe(false)
  })
})

describe('serveIfEntryPoint', () => {
  it('starts nothing when the module was merely imported', () => {
    const serve = vi.fn()
    expect(serveIfEntryPoint(discordConnector, HERE, serve)).toBe(false)
    expect(serve).not.toHaveBeenCalled()
  })

  it('serves the connector when the module is the entry point', () => {
    const serve = vi.fn()
    const self = `file://${process.argv[1]}`
    expect(serveIfEntryPoint(discordConnector, self, serve)).toBe(true)
    expect(serve).toHaveBeenCalledWith(discordConnector)
  })
})

describe('the packaged connector', () => {
  it('reports the package version, so a stale install is visible in the handshake', () => {
    expect(discordConnector.id).toBe('discord')
    expect(discordConnector.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('is exported under a name that says which connector it is', () => {
    expect(discordConnector.name).toBe('Discord')
  })
})
