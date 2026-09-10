import { connector } from './connector'
import { serveIfEntryPoint } from './entry'

export { SAMPLE_MODEL_NAME, connector, createOllamaConnector } from './connector'
export type { OllamaConnectorOptions } from './connector'
export {
  CONNECTION_RETRY_WAIT_MS,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  LONG_TIMEOUT_MS,
  OllamaApiError,
  createOllamaClient,
  describeFailure,
  normalizeBaseUrl
} from './client'
export type { OllamaClient, OllamaClientOptions } from './client'
export default connector

await serveIfEntryPoint(import.meta.url)
