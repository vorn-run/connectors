import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { serveConnector } from '@vornrun/connector-sdk'
import { connector } from './connector'

/** True when this file was run directly rather than imported. */
export function isEntryPoint(moduleUrl: string, argv = process.argv): boolean {
  const invoked = argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(invoked)
  } catch {
    return false
  }
}

/** Serve on stdio when run directly, which is what Vorn spawns; says whether it did. */
export async function serveIfEntryPoint(
  moduleUrl: string,
  serve: (c: typeof connector) => Promise<void> = serveConnector
): Promise<boolean> {
  if (!isEntryPoint(moduleUrl)) return false
  await serve(connector)
  return true
}
