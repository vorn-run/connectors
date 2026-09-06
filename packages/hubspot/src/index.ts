import { connector } from './connector'
import { serveIfEntryPoint } from './entry'

export { connector, createHubSpotConnector, INDEXING_MARGIN_MS } from './connector'
export type { HubSpotConnectorOptions } from './connector'
export { count, filterGroupsArg, isEmail, namesArg, propertiesArg } from './connector'
export {
  API_ROOT,
  ASSOCIATIONS_PATH,
  CRM_PATH,
  DEFAULT_RATE_LIMIT_INTERVAL_MS,
  HubSpotApiError,
  MAX_RETRY_AFTER_MS,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_PAGES,
  OBJECTS_PATH,
  RATE_LIMIT_RETRY_MS,
  createHubSpotClient,
  retryAfterMs
} from './client'
export type { CrmRecord, HubSpotClient, SearchBody, SearchPage } from './client'
export {
  DEFAULT_PROPERTIES,
  NOTE_ASSOCIATION_TYPE_IDS,
  OBJECT_TYPE_IDS,
  SAMPLE_COMPANY,
  SAMPLE_CONTACT,
  SAMPLE_DEAL,
  companyTitle,
  contactTitle,
  createdToItem,
  dealTitle,
  epochMillis,
  filter,
  property,
  recordOutput,
  recordUrl,
  stageToItem
} from './items'
export type { ObjectType, SearchFilter } from './items'

// The names the SDK's own tooling loads a connector by.
export default connector

await serveIfEntryPoint(import.meta.url)
