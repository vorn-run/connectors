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

interface ProcessLike {
  stdin: { on(event: string, listener: () => void): unknown }
  on(event: string, listener: () => void): unknown
  exit(code?: number): void
}

/** The SDK has no stop hook, so the pools close when Vorn hangs up stdin or the process is told to stop. */
export function closeOnExit(close: () => Promise<void>, proc: ProcessLike = process): void {
  const closeAll = () => close().catch(() => undefined)
  proc.stdin.on('end', () => void closeAll())
  proc.stdin.on('close', () => void closeAll())
  // A signal listener replaces Node's default of exiting, so the exit happens here once the pools are closed.
  const stop = (code: number) => () => void closeAll().then(() => proc.exit(code))
  proc.on('SIGTERM', stop(143))
  proc.on('SIGINT', stop(130))
}

/** Start the MCP server, but only when run directly; importing must start nothing. */
export function serveIfEntryPoint(
  connector: Connector & { closePools(): Promise<void> },
  moduleUrl: string,
  serve: (connector: Connector) => unknown = serveConnector,
  proc?: ProcessLike
): boolean {
  if (!isEntryPoint(moduleUrl)) return false
  closeOnExit(() => connector.closePools(), proc)
  void serve(connector)
  return true
}
