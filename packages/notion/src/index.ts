import { createRequire } from 'node:module'
import { createNotionConnector } from './connector'
import { serveIfEntryPoint } from './entry'

export { createNotionConnector } from './connector'
export type { NotionConnectorOptions, CreateApi } from './connector'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export const notionConnector = createNotionConnector({ version })

// The names the SDK's own tooling loads a connector by.
export { notionConnector as connector }
export default notionConnector

serveIfEntryPoint(notionConnector, import.meta.url)
