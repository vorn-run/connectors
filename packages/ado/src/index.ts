import { createRequire } from 'node:module'
import { createAdoConnector } from './connector'
import { serveIfEntryPoint } from './entry'

export { createAdoConnector } from './connector'
export type { AdoConnectorOptions } from './connector'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export const adoConnector = createAdoConnector({ version })

serveIfEntryPoint(adoConnector, import.meta.url)
