import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { serveConnector, type Connector } from '@vornrun/connector-sdk'

/**
 * True when this module is the process entry point.
 *
 * Compared through `realpathSync` because Vorn launches the connector via the
 * `node_modules/.bin` symlink, where `argv[1]` is the link and
 * `import.meta.url` is its target.
 */
export function isEntryPoint(moduleUrl: string, entry = process.argv[1]): boolean {
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    // Either path can be gone — a deleted symlink, a bundle run from memory.
    // Not being the entry point is the safe answer: importing must start
    // nothing.
    return false
  }
}

/**
 * Start the MCP server, but only when run directly.
 *
 * Importing the module — tests, `vorn-connector check` — must start nothing.
 * Lives here rather than in index.ts so both halves are reachable from a test
 * without spawning a server.
 */
export function serveIfEntryPoint(
  connector: Connector,
  moduleUrl: string,
  serve: (connector: Connector) => unknown = serveConnector
): boolean {
  if (!isEntryPoint(moduleUrl)) return false
  void serve(connector)
  return true
}
