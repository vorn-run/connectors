import { createRequire } from 'node:module'
import { createLinearConnector } from './connector'
import { serveIfEntryPoint } from './entry'

export { createLinearConnector } from './connector'
export type { LinearConnectorOptions } from './connector'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export const adoConnector = createLinearConnector({ version })

serveIfEntryPoint(adoConnector, import.meta.url)
