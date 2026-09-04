import { createRequire } from 'node:module'
import { createKustoConnector } from './connector'
import { serveIfEntryPoint } from './entry'

export { createKustoConnector } from './connector'
export type { KustoConnectorOptions } from './connector'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export const kustoConnector = createKustoConnector({ version })

// The names the SDK's own tooling loads a connector by.
export { kustoConnector as connector }
export default kustoConnector

serveIfEntryPoint(kustoConnector, import.meta.url)
