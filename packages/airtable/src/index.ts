import { connector } from './connector'
import { serveIfEntryPoint } from './entry'

export { connector, createAirtableConnector } from './connector'
export type { AirtableConnectorOptions } from './connector'
export { count, fieldsArg, modifiedAt, namesArg, recordsArg, sortArg } from './connector'
export {
  API_ROOT,
  AirtableApiError,
  LOCKOUT_MS,
  MAX_BATCH_RECORDS,
  MAX_LIST_PAGES,
  MAX_PAGE_SIZE,
  RATE_LIMIT_PER_SECOND,
  createAirtableClient,
  createRateLimiter,
  retryAfterMs
} from './client'
export type { AirtableClient, AirtableRecord, ListRecordsParams, RateLimiter } from './client'
export {
  SAMPLE_BASE_ID,
  SAMPLE_RECORD,
  SAMPLE_TABLE_ID,
  SAMPLE_UPDATED_RECORD,
  andFormulas,
  fieldReference,
  recordOutput,
  recordTitle,
  recordToItem,
  recordUrl,
  sinceFormula
} from './items'

// The names the SDK's own tooling loads a connector by.
export default connector

await serveIfEntryPoint(import.meta.url)
