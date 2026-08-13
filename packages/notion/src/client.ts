/**
 * Notion's REST API, reached through the vendor client.
 *
 * `@notionhq/client` is a hand-written thin wrapper rather than a generated
 * client over the whole schema, so the repo's "prefer the vendor client" rule
 * applies here without the `packages/linear` exception: it carries the
 * per-endpoint types for the data-source model and the partial-object type
 * guards, both of which we would otherwise re-derive on every API change.
 *
 * The API version is pinned in one constant and sent explicitly rather than
 * inherited from whatever the installed SDK happens to default to, so the
 * version we were tested against is the version we send and a bump is one line
 * with a test. Notion states no plans to retire old versions.
 *
 * Everything below takes the API surface as an argument, so tests inject a
 * stub and never touch the network.
 */

/** The API version every request pins. See the module comment. */
export const NOTION_VERSION = '2025-09-03'

/** Notion's documented maximum `page_size`, and our default. */
export const MAX_PAGE_SIZE = 100

/** Notion refuses payloads over 100 blocks in one create call. */
export const MAX_BLOCKS_PER_CREATE = 100

/**
 * The slice of `@notionhq/client`'s `Client` this connector uses.
 *
 * Declared structurally rather than importing the class type so a test can
 * pass three functions instead of constructing a real client, and so adding an
 * endpoint here is a deliberate act.
 */
export interface NotionApi {
  databases: {
    retrieve(args: { database_id: string }): Promise<unknown>
  }
  dataSources: {
    retrieve(args: { data_source_id: string }): Promise<unknown>
    query(args: Record<string, unknown>): Promise<unknown>
  }
  pages: {
    create(args: Record<string, unknown>): Promise<unknown>
    update(args: Record<string, unknown>): Promise<unknown>
  }
}

export interface NotionPage {
  id: string
  url?: string
  created_time?: string
  last_edited_time?: string
  properties?: Record<string, unknown>
}

export interface DataSourceRef {
  id: string
  /** The property schema, empty when Notion answered with a partial object. */
  properties: Record<string, unknown>
}

/**
 * A page of query results, plus whether Notion truncated them.
 *
 * `query_result_limit_reached` is a hard server-side ceiling at 10,000 rows.
 * Swallowing it turns a truncated trigger into what looks like data loss
 * months later, so it travels with the results and is surfaced on the poll.
 */
export interface QueryResult {
  pages: NotionPage[]
  truncated: boolean
}

/* ------------------------------------------------------------------ ids -- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Accept whatever is actually in someone's clipboard.
 *
 * The id a person can get from a browser is the 32-character unhyphenated one
 * at the end of a Notion URL, optionally with a `?v=` view id after it. Notion
 * wants canonical UUID form, so normalise here — once, with a test — rather
 * than in each caller.
 */
export function normalizeId(value: string, label = 'id'): string {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) throw new Error(`${label} is required`)

  // A URL: the id is the last 32 hex characters of the path, and any query
  // string (`?v=<view id>`) must not be mistaken for it.
  const withoutQuery = trimmed.split('?')[0]
  const candidate = withoutQuery.split('/').pop() ?? ''
  const hex = (candidate.match(/[0-9a-f]{32}/i) ?? [])[0]
  if (hex) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase()
  }
  if (UUID_RE.test(candidate)) return candidate.toLowerCase()

  throw new Error(
    `${label} does not look like a Notion id: ${trimmed}. ` +
      'Paste the page or database URL, or the 32-character id from it.'
  )
}

/* --------------------------------------------------------------- errors -- */

interface Httpish {
  status?: number
  message?: string
}

/**
 * Say what actually went wrong, in Notion's terms.
 *
 * A valid token returning 404 on everything is the *expected* first-run state:
 * Notion connections see nothing until a human shares each page with them. The
 * raw error sends people to check their id, which is the wrong thing to look
 * at, so the translation happens here in the spirit of `packages/ado`'s
 * `explain()`.
 */
export function explainNotionError(error: unknown, target: string): Error {
  const err = (error ?? {}) as Httpish
  const status = typeof err.status === 'number' ? err.status : undefined
  const detail = err.message ?? String(error)

  if (status === 404) {
    return new Error(
      `Notion returned 404 for ${target}. The token is valid but this has not been ` +
        'shared with the connection — open it in Notion, ••• → Add connections, and ' +
        `pick this integration. (${detail})`
    )
  }
  if (status === 401) {
    return new Error(
      `Notion rejected the token (401) for ${target}. Create a new integration token ` +
        `and paste it into NOTION_TOKEN. (${detail})`
    )
  }
  if (status === 403) {
    return new Error(
      `Notion refused ${target} (403). This is a capabilities problem, not a sharing ` +
        'one: the integration needs read, update and insert content capabilities, and ' +
        `"update content" alone cannot create pages. (${detail})`
    )
  }
  if (status === 429) {
    return new Error(
      `Notion rate-limited ${target} (429). The limit is shared across every ` +
        `integration in the workspace, so this can be someone else's traffic. (${detail})`
    )
  }
  return error instanceof Error ? error : new Error(`Notion request for ${target} failed: ${detail}`)
}

/* ---------------------------------------------------------------- retry -- */

/**
 * The statuses worth trying again, and nothing else.
 *
 * 429 is the shared per-workspace limit, 503/529 are Notion's own transient
 * failures. 400/401/403/404 are *never* retried: a misspelled property, a bad
 * token or an unshared database returns exactly the same answer three times,
 * and retrying only delays the error message that would have fixed it.
 */
const RETRYABLE = new Set([429, 503, 529])

/** Attempts after the first. Small, because the poll interval is the real backstop. */
const MAX_RETRIES = 3

/** Base for the exponential backoff, in milliseconds. */
const RETRY_BASE_MS = 500

/**
 * How long to wait before trying again.
 *
 * `Retry-After` wins when Notion sent one — it is documented as integer
 * seconds and it is the only number that reflects the *shared* workspace
 * budget. Otherwise exponential, with jitter: the limit is shared across every
 * integration in the workspace, so a fleet of unjittered clients backing off
 * on the same curve re-collides on every attempt.
 */
/**
 * Read one header out of either shape an error carries them in.
 *
 * `APIResponseError.headers` is a `Headers`, and indexed access on one returns
 * `undefined` — `Object.entries()` on it is `[]` as well, so nothing about the
 * failure is visible from the outside. Only `.get()` reads it, and that already
 * matches case-insensitively. A plain object still reaches here from errors
 * built by hand, so both are handled rather than betting on either.
 */
function headerValue(headers: unknown, lowercaseName: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  const get = (headers as Headers).get
  if (typeof get === 'function') return (headers as Headers).get(lowercaseName) ?? undefined
  const record = headers as Record<string, string>
  const key = Object.keys(record).find((k) => k.toLowerCase() === lowercaseName)
  return key === undefined ? undefined : record[key]
}

export function retryDelayMs(error: unknown, attempt: number, random = Math.random): number {
  // An HTTP-date `Retry-After` parses to NaN here and falls through to the
  // backoff below. That is the safe direction, and Notion documents seconds.
  const header = headerValue((error as { headers?: unknown })?.headers, 'retry-after')
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  const backoff = RETRY_BASE_MS * 2 ** attempt
  // Full jitter: anywhere in [0, backoff), not backoff ± a nudge.
  return Math.floor(backoff * random())
}

function isRetryable(error: unknown): boolean {
  const status = (error as Httpish)?.status
  return typeof status === 'number' && RETRYABLE.has(status)
}

export interface RetryOptions {
  /** Injected in tests so no test spends real time asleep. */
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  retries?: number
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Run a call, retrying only what is worth retrying, and translate what is left.
 *
 * Retry lives here rather than in `@notionhq/client`, which has no policy of
 * its own — the same place `packages/ado` keeps the behaviour its vendor client
 * does not provide. A client-side rate limiter would not be enough on its own:
 * the budget is shared with every other integration in the workspace, so
 * reacting to `Retry-After` is the mechanism and a limiter is at best a
 * courtesy.
 */
export async function withExplanation<T>(
  target: string,
  run: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { sleep = realSleep, random = Math.random, retries = MAX_RETRIES } = options

  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) throw explainNotionError(error, target)
      await sleep(retryDelayMs(error, attempt, random))
    }
  }
}

/* --------------------------------------------------------- data sources -- */

interface DatabaseShape {
  data_sources?: Array<{ id: string; name?: string }>
}

/**
 * Turn what the user pasted into the data source the query API needs.
 *
 * Since `2025-09-03` a database is a container and the queryable schema lives
 * on its data sources; a database id is rejected by the data-source endpoints
 * and vice-versa. The id a person can copy from a browser is the database's,
 * so we take that and resolve it. One data source is used silently; several is
 * ambiguous and fails with the ids listed, because guessing picks the wrong
 * table on somebody's real database.
 */
export async function resolveDataSource(
  api: NotionApi,
  options: { databaseId: string; dataSourceId?: string }
): Promise<DataSourceRef> {
  let id: string
  if (options.dataSourceId) {
    id = normalizeId(options.dataSourceId, 'dataSourceId')
  } else {
    const databaseId = normalizeId(options.databaseId, 'databaseId')
    const database = (await withExplanation(`database ${databaseId}`, () =>
      api.databases.retrieve({ database_id: databaseId })
    )) as DatabaseShape
    const sources = database.data_sources ?? []
    if (sources.length === 0) {
      throw new Error(
        `Database ${databaseId} reports no data sources. Check that the id is a ` +
          'database rather than a page.'
      )
    }
    if (sources.length > 1) {
      const listed = sources.map((s) => `${s.id} (${s.name ?? 'unnamed'})`).join(', ')
      throw new Error(
        `Database ${databaseId} has ${sources.length} data sources, so one has to be ` +
          `chosen: set NOTION_DATA_SOURCE_ID to one of ${listed}.`
      )
    }
    id = sources[0].id
  }

  const source = (await withExplanation(`data source ${id}`, () =>
    api.dataSources.retrieve({ data_source_id: id })
  )) as { properties?: Record<string, unknown> }
  // A partial object carries no schema. Everything downstream treats an empty
  // schema as "cannot validate", never as "no properties exist".
  return { id, properties: source.properties ?? {} }
}

/* ---------------------------------------------------------------- query -- */

export interface QueryOptions {
  dataSourceId: string
  /** Inclusive watermark. The SDK's `since` is a hint, so inclusive is correct. */
  since?: string
  /** The user's own Notion filter, ANDed with the watermark. */
  filter?: Record<string, unknown>
  limit: number
}

/** Build the request body, kept separate so the filter algebra is testable. */
export function buildQueryBody(options: QueryOptions): Record<string, unknown> {
  const clauses: Array<Record<string, unknown>> = []
  if (options.since) {
    clauses.push({
      timestamp: 'last_edited_time',
      last_edited_time: { on_or_after: options.since }
    })
  }
  if (options.filter) clauses.push(options.filter)

  const body: Record<string, unknown> = {
    data_source_id: options.dataSourceId,
    sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
    // Always explicit: Notion's own docs disagree with themselves about the
    // default, so we never inherit it.
    page_size: Math.min(Math.max(options.limit, 1), MAX_PAGE_SIZE)
  }
  if (clauses.length === 1) body.filter = clauses[0]
  if (clauses.length > 1) body.filter = { and: clauses }
  return body
}

interface QueryResponseShape {
  results?: unknown[]
  has_more?: boolean
  next_cursor?: string | null
  request_status?: { incomplete_reason?: string }
}

/** A result row Notion returned in full, rather than as `{object, id}`. */
export function isFullPage(value: unknown): value is NotionPage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as NotionPage).id === 'string' &&
    typeof (value as { properties?: unknown }).properties === 'object' &&
    (value as { properties?: unknown }).properties !== null
  )
}

/**
 * Page through a data source query up to `limit` rows.
 *
 * Paging loops on `has_more`, never on `results.length`: Notion can answer with
 * a short page and a cursor, and stopping on a short page silently drops the
 * rest of the backlog.
 */
export async function queryDataSource(
  api: NotionApi,
  options: QueryOptions
): Promise<QueryResult> {
  const pages: NotionPage[] = []
  let cursor: string | undefined
  let truncated = false

  while (pages.length < options.limit) {
    const body = buildQueryBody({ ...options, limit: options.limit - pages.length })
    if (cursor) body.start_cursor = cursor

    const response = (await withExplanation(`data source ${options.dataSourceId}`, () =>
      api.dataSources.query(body)
    )) as QueryResponseShape

    for (const row of response.results ?? []) {
      // Partial rows carry no properties, so there is nothing to map; skipping
      // beats emitting an item with an empty title.
      if (isFullPage(row)) pages.push(row)
    }
    if (response.request_status?.incomplete_reason === 'query_result_limit_reached') {
      truncated = true
    }
    if (!response.has_more || !response.next_cursor) break
    cursor = response.next_cursor
  }

  return { pages: pages.slice(0, options.limit), truncated }
}

/* ----------------------------------------------------------- properties -- */

interface RichTextish {
  plain_text?: string
}

/** Flatten Notion's rich text array to the text a human would read. */
export function plainText(rich: unknown): string {
  if (!Array.isArray(rich)) return ''
  return rich
    .map((part) => (part as RichTextish)?.plain_text ?? '')
    .join('')
    .trim()
}

/**
 * One Notion property as a plain JSON value.
 *
 * Notion wraps every value in its type, and workflow templates want the value.
 * Unknown types fall through to `null` rather than leaking the wrapper: a
 * template rendering `[object Object]` is worse than one rendering nothing.
 */
export function propertyValue(property: unknown): unknown {
  const prop = property as { type?: string; [key: string]: unknown }
  if (!prop || typeof prop.type !== 'string') return null
  switch (prop.type) {
    case 'title':
    case 'rich_text':
      return plainText(prop[prop.type])
    case 'select':
    case 'status':
      return (prop[prop.type] as { name?: string } | null)?.name ?? null
    case 'multi_select':
      return ((prop.multi_select as Array<{ name?: string }>) ?? []).map((o) => o.name ?? '')
    case 'people':
      return ((prop.people as Array<{ name?: string }>) ?? []).map((p) => p.name ?? '')
    case 'date':
      return (prop.date as { start?: string } | null)?.start ?? null
    case 'checkbox':
    case 'number':
    case 'url':
    case 'email':
    case 'phone_number':
      return prop[prop.type] ?? null
    case 'unique_id': {
      const uid = prop.unique_id as { prefix?: string | null; number?: number } | null
      if (!uid) return null
      return uid.prefix ? `${uid.prefix}-${uid.number}` : (uid.number ?? null)
    }
    default:
      return null
  }
}

/** Every property of a page, flattened. */
export function pageProperties(page: NotionPage): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, property] of Object.entries(page.properties ?? {})) {
    out[name] = propertyValue(property)
  }
  return out
}

/** The page's title, which is whichever property has type `title`. */
export function pageTitle(page: NotionPage): string {
  for (const property of Object.values(page.properties ?? {})) {
    const prop = property as { type?: string; title?: unknown }
    if (prop?.type === 'title') return plainText(prop.title)
  }
  return ''
}

/**
 * Name of the property carrying status.
 *
 * Notion has no fixed status field. A real `status` property is the strongest
 * signal, then a `select`; an explicit configured name always wins so a
 * database with two candidates is not decided by property order.
 */
export function findStatusProperty(
  properties: Record<string, unknown>,
  configured?: string
): string | undefined {
  if (configured) return configured
  const entries = Object.entries(properties)
  const status = entries.find(([, p]) => (p as { type?: string })?.type === 'status')
  if (status) return status[0]
  const select = entries.find(([, p]) => (p as { type?: string })?.type === 'select')
  return select?.[0]
}

/**
 * Map every status option name to the group it belongs to.
 *
 * The three groups — To-do, In progress, Complete — are the stable part of a
 * status property; the option names are whatever a team invented. The query
 * response gives only the option name, so the group has to come from the
 * schema, and it travels on the item so a workflow can branch on it when the
 * team's vocabulary is not in `statusMapping`.
 */
export function statusGroups(
  properties: Record<string, unknown>,
  statusProperty?: string
): Record<string, string> {
  const config = statusProperty ? properties[statusProperty] : undefined
  const status = (config as { status?: { options?: unknown; groups?: unknown } })?.status
  if (!status) return {}
  const options = (status.options as Array<{ id?: string; name?: string }>) ?? []
  const groups = (status.groups as Array<{ name?: string; option_ids?: string[] }>) ?? []
  const byId = new Map(options.map((o) => [o.id ?? '', o.name ?? '']))
  const out: Record<string, string> = {}
  for (const group of groups) {
    for (const optionId of group.option_ids ?? []) {
      const name = byId.get(optionId)
      if (name) out[name] = group.name ?? ''
    }
  }
  return out
}

/* ------------------------------------------------------------- mutation -- */

/**
 * Turn a markdown-ish string into Notion blocks.
 *
 * Deliberately shallow — paragraphs and `#` headings — because the alternative
 * is a markdown parser inside a connector. Anything richer belongs in the block
 * work described in the design's §4, not smuggled in here.
 */
export function markdownToBlocks(markdown: string): Array<Record<string, unknown>> {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

  return lines.map((line) => {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      const type = `heading_${heading[1].length}`
      return { object: 'block', type, [type]: { rich_text: richText(heading[2]) } }
    }
    return { object: 'block', type: 'paragraph', paragraph: { rich_text: richText(line) } }
  })
}

/** Notion's rich text request shape for a plain string. */
export function richText(content: string): Array<Record<string, unknown>> {
  return [{ type: 'text', text: { content } }]
}

/**
 * Check submitted property names against the data source schema.
 *
 * Notion answers a misspelled property with a generic 400 that names nothing,
 * so the offending name is found here instead. An empty schema means Notion
 * gave us a partial object and we cannot validate — passing through beats
 * refusing a legitimate edit.
 */
export function assertKnownProperties(
  schema: Record<string, unknown>,
  properties: Record<string, unknown>
): void {
  if (Object.keys(schema).length === 0) return
  const unknown = Object.keys(properties).filter((name) => !(name in schema))
  if (unknown.length > 0) {
    throw new Error(
      `No property named ${unknown.join(', ')} in this data source. It has: ` +
        `${Object.keys(schema).join(', ')}.`
    )
  }
  const rollups = Object.keys(properties).filter(
    (name) => (schema[name] as { type?: string })?.type === 'rollup'
  )
  if (rollups.length > 0) {
    throw new Error(`Rollup properties cannot be written through the API: ${rollups.join(', ')}.`)
  }
}

/** Parse a JSON argument, naming the field when it is not JSON. */
export function parseJsonArg(value: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(`${label} must be JSON: ${(error as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/**
 * The browser URL of a page Notion may have answered with only partially.
 *
 * `POST /v1/pages` can legitimately return `{object, id}` alone, so a caller
 * that read `.url` off it would crash. Notion's own URL form is derivable from
 * the id, which is better than returning nothing to `{{steps.createPage.url}}`.
 */
export function pageUrl(page: { id: string; url?: string }): string {
  if (page.url) return page.url
  return `https://www.notion.so/${page.id.replace(/-/g, '')}`
}
