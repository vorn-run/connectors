import { createRequire } from 'node:module'
import { createKustoConnector } from './connector'
import { serveIfEntryPoint } from './entry'

export { createKustoConnector } from './connector'
export type { KustoConnectorOptions } from './connector'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export const kustoConnector = createKustoConnector({ version })

serveIfEntryPoint(kustoConnector, import.meta.url)
