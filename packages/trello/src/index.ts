import { connector } from './connector'
import { serveIfEntryPoint } from './entry'

export { connector, createTrelloConnector, trelloPreflight } from './connector'
export type { TrelloConnectorOptions, PreflightOptions } from './connector'
export {
  CARD_FIELDS,
  DEFAULT_WITHIN_HOURS,
  FIRST_POLL_LOOKBACK_MS,
  alreadyLabelled,
  cardOutput,
  count,
  listArg,
  searchCards,
  text
} from './connector'
export {
  API_ROOT,
  MAX_ACTION_LIMIT,
  MAX_ACTION_PAGES,
  RATE_LIMIT_WINDOW_MS,
  TrelloApiError,
  createTrelloClient,
  rateLimitWaitMs,
  retryAfterMs
} from './client'
export type { TrelloAction, TrelloCard, TrelloClient } from './client'
export {
  SAMPLE_COMMENT_ACTION,
  SAMPLE_CREATE_ACTION,
  SAMPLE_DUE_CARD,
  SAMPLE_ID,
  SAMPLE_MOVE_ACTION,
  actionParts,
  cardUrl,
  commentItem,
  createdItem,
  dueSoonItem,
  dueWithin,
  movedItem,
  movedLists
} from './items'

// The names the SDK's own tooling loads a connector by.
export default connector

await serveIfEntryPoint(import.meta.url)
