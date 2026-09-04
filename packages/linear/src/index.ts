import { createRequire } from 'node:module'
import { createLinearConnector } from './connector'
import { serveIfEntryPoint } from './entry'

export { createLinearConnector } from './connector'
export type { LinearConnectorOptions } from './connector'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export const linearConnector = createLinearConnector({ version })

// The names the SDK's own tooling loads a connector by.
export { linearConnector as connector }
export default linearConnector

serveIfEntryPoint(linearConnector, import.meta.url)
