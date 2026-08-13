import { describe, it, expect, vi } from 'vitest'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isEntryPoint, serveIfEntryPoint } from './entry'
import { notionConnector } from './index'

const HERE = import.meta.url

describe('isEntryPoint', () => {
  it('is false when the process was started without a script', () => {
    // `node -e` leaves argv[1] empty, and realpath('') would throw.
    expect(isEntryPoint(HERE, '')).toBe(false)
  })

  it('is true when argv points at this module, symlink or not', () => {
    // Vorn launches through node_modules/.bin, so the comparison has to go
    // through realpath rather than compare the two strings.
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
    // Importing must start no server: `vorn-connector check` and these tests
    // both import the connector and would otherwise hang on a live stdio loop.
    const serve = vi.fn()
    expect(serveIfEntryPoint(notionConnector, HERE, serve)).toBe(false)
    expect(serve).not.toHaveBeenCalled()
  })

  it('serves the connector when the module is the entry point', () => {
    const serve = vi.fn()
    const self = `file://${process.argv[1]}`
    expect(serveIfEntryPoint(notionConnector, self, serve)).toBe(true)
    expect(serve).toHaveBeenCalledWith(notionConnector)
  })
})

describe('the packaged connector', () => {
  it('reports the package version, so a stale install is visible in the handshake', () => {
    expect(notionConnector.id).toBe('notion')
    expect(notionConnector.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('is exported under a name that says which connector it is', () => {
    // Guards a copy-paste from the connector this package was scaffolded from:
    // a `linearConnector` export here would be wired into Vorn under the wrong
    // name and only noticed by whoever read the import.
    expect(notionConnector.name).toBe('Notion')
  })
})
