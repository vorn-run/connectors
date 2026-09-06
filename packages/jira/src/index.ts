import { connector } from './connector'
import { serveIfEntryPoint } from './entry'

export { connector, createJiraConnector } from './connector'
export type { JiraConnectorOptions, Settings } from './connector'
export {
  DEFAULT_SEARCH_RESULTS,
  FIRST_POLL_CREATED_MS,
  FIRST_POLL_UPDATED_MS,
  MAX_PAGES,
  MAX_SEARCH_RESULTS,
  OVERLAP_MS,
  PAGE_SIZE,
  PROJECT_PAGE_SIZE,
  assigneeId,
  count,
  jsonObject,
  labelList,
  readSettings
} from './connector'
export {
  API_PATH,
  DEFAULT_RATE_LIMIT_WAIT_MS,
  DEFAULT_SERVER_ERROR_WAIT_MS,
  JiraApiError,
  TOKEN_HINT,
  basicAuth,
  browseUrl,
  createJiraClient,
  describeFailure,
  retryAfterMs,
  retryDelayMs,
  siteOrigin
} from './client'
export type { FetchLike, JiraClient, JiraClientOptions, RequestOptions, Sleep } from './client'
export { adfText, toAdf } from './adf'
export type { AdfDocument, AdfNode } from './adf'
export {
  andClauses,
  boundedJql,
  jqlDate,
  orderBy,
  projectClause,
  quote,
  sinceClause,
  transitionedClause
} from './jql'
export {
  SAMPLE_ISSUE,
  SAMPLE_SITE,
  SAMPLE_TRANSITIONED_ISSUE,
  SAMPLE_UPDATED_ISSUE,
  TRIGGER_FIELDS,
  isoOf,
  issueSummary,
  issueToItem,
  projectSummary,
  transitionSummary,
  userSummary
} from './items'
export type { JiraIssue, JiraProject, JiraTransition, JiraUser, SearchPage, TriggerKind } from './items'

// The names the SDK's own tooling loads a connector by.
export default connector

await serveIfEntryPoint(import.meta.url)
