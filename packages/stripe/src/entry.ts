import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { serveConnector, type Connector } from '@vornrun/connector-sdk'

// Compared through realpath: Vorn launches the connector via a node_modules/.bin symlink, where argv[1] is the link and the module URL its target.
export function isEntryPoint(moduleUrl: string, entry = process.argv[1]): boolean {
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    // Either path can be gone; not being the entry point is the safe answer, since importing must start nothing.
    return false
  }
}

// Serve on stdio only when run directly: tests and `vorn-connector check` import the module and must start no server.
export function serveIfEntryPoint(
  connector: Connector,
  moduleUrl: string,
  serve: (connector: Connector) => unknown = serveConnector
): boolean {
  if (!isEntryPoint(moduleUrl)) return false
  void serve(connector)
  return true
}
