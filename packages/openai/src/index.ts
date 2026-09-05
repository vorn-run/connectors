import { connector } from './connector'
import { serveIfEntryPoint } from './entry'

export { connector, createOpenAIConnector, readSettings } from './connector'
export type { OpenAIConnectorOptions, Settings } from './connector'
export { API_ROOT, OpenAIApiError, createOpenAIClient, durationMs, normalizeKey } from './client'
export type { OpenAIClient, OpenAIClientOptions } from './client'
export default connector

await serveIfEntryPoint(import.meta.url)
