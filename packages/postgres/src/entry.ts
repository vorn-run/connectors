import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { serveConnector, type Connector } from '@vornrun/connector-sdk'

// True when this module is the entry point, compared through realpathSync because argv[1] may be the .bin symlink.
export function isEntryPoint(moduleUrl: string, entry = process.argv[1]): boolean {
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    // Either path can be gone; not being the entry point is the safe answer.
    return false
  }
}

/** Start the MCP server, but only when run directly; importing must start nothing. */
export function serveIfEntryPoint(
  connector: Connector,
  moduleUrl: string,
  serve: (connector: Connector) => unknown = serveConnector
): boolean {
  if (!isEntryPoint(moduleUrl)) return false
  void serve(connector)
  return true
}
