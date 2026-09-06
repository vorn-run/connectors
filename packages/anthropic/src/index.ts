import { connector } from './connector'
import { serveIfEntryPoint } from './entry'

export { BATCH_LOOKBACK_MS, MODEL_LOOKBACK_MS, connector, createAnthropicConnector } from './connector'
export type { AnthropicConnectorOptions } from './connector'
export {
  ANTHROPIC_VERSION,
  API_ROOT,
  AnthropicApiError,
  MAX_LIST_PAGES,
  MAX_WAIT_MS,
  PAGE_LIMIT,
  createAnthropicClient,
  createRateGate,
  parseJsonl,
  retryAfterMs
} from './client'
export type { AnthropicClient, AnthropicModel, BatchResult, MessageBatch, Page, RateGate } from './client'
export {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  MODEL_IDS,
  SAMPLE_BATCH,
  SAMPLE_MODEL,
  batchOutput,
  batchToItem,
  firstText,
  listArg,
  messageOutput,
  messagesArg,
  modelOutput,
  modelToItem,
  numberArg,
  stopSequencesArg
} from './items'

// The names the SDK's own tooling loads a connector by.
export default connector

await serveIfEntryPoint(import.meta.url)
