import { createRequire } from 'node:module'
import { createNotionConnector } from './connector'
import { serveIfEntryPoint } from './entry'

export { createNotionConnector } from './connector'
export type { NotionConnectorOptions, CreateApi } from './connector'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export const notionConnector = createNotionConnector({ version })

serveIfEntryPoint(notionConnector, import.meta.url)
