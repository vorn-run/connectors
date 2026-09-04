import { createRequire } from 'node:module'
import { createPostgresConnector } from './connector'
import { serveIfEntryPoint } from './entry'

export { createPostgresConnector } from './connector'
export type { PostgresConnectorOptions } from './connector'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export const postgresConnector = createPostgresConnector({ version })

// The names the SDK's own tooling loads a connector by.
export { postgresConnector as connector }
export default postgresConnector

serveIfEntryPoint(postgresConnector, import.meta.url)
