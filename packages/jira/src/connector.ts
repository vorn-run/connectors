import {
  defineConnector,
  type ConnectorConfig,
  type ConnectorItem,
  type FetchContext
} from '@vornrun/connector-sdk'
import { toAdf } from './adf'
import { TOKEN_HINT, browseUrl, createJiraClient, type FetchLike, type JiraClient, type Sleep } from './client'
import {
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
  userSummary,
  type JiraIssue,
  type JiraProject,
  type JiraTransition,
  type JiraUser,
  type SearchPage,
  type TriggerKind
} from './items'
import { andClauses, boundedJql, jqlDate, orderBy, projectClause, sinceClause, transitionedClause } from './jql'
// Bundled at build time: a pack is one file, so a version read from disk is not there to read.
import pkg from '../package.json'

/** Issues asked for per search page. */
export const PAGE_SIZE = 100

/** Pages one poll or one search walks before leaving the rest for the next. */
export const MAX_PAGES = 10

/** How far before the watermark a poll starts: JQL dates resolve to the minute, and the index lags. */
export const OVERLAP_MS = 2 * 60_000

// Where the very first poll starts, before any watermark exists.
export const FIRST_POLL_CREATED_MS = 24 * 3_600_000

export const FIRST_POLL_UPDATED_MS = 3_600_000

export const DEFAULT_SEARCH_RESULTS = 50

/** "It returns max 5000 issues" per search. */
export const MAX_SEARCH_RESULTS = 5_000

/** "Must be less than or equal to 100" on project search. */
export const PROJECT_PAGE_SIZE = 100

export interface JiraConnectorOptions {
  version?: string
  /** Injected in tests, so nothing reaches the network. */
  fetchImpl?: FetchLike
  /** Injected in tests, so no test spends real time asleep. */
  sleep?: Sleep
  now?: () => number
  /** Source of the retry jitter; fixed in tests. */
  random?: () => number
  /** Where preflight and the live samples read from; defaults to the process environment. */
  env?: NodeJS.ProcessEnv
}

/* --------------------------------------------------------------- config -- */

function text(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim()
  return trimmed === '' ? undefined : trimmed
}

export interface Settings {
  siteUrl: string
  email: string
  apiToken: string
  projectKey?: string
  jql?: string
  status?: string
}

export function readSettings(config: ConnectorConfig): Settings {
  const siteUrl = text(config.siteUrl)
  const email = text(config.email)
  const apiToken = text(config.apiToken)
  if (siteUrl === undefined) throw new Error('JIRA_SITE_URL is required, such as https://example.atlassian.net')
  if (email === undefined) throw new Error('JIRA_EMAIL is required: the email of the Atlassian account the token belongs to')
  if (apiToken === undefined) throw new Error(`JIRA_API_TOKEN is required. ${TOKEN_HINT}`)
  const projectKey = text(config.projectKey)
  const jql = text(config.jql)
  const status = text(config.status)
  return {
    siteUrl,
    email,
    apiToken,
    ...(projectKey && { projectKey }),
    ...(jql && { jql }),
    ...(status && { status })
  }
}

/* ---------------------------------------------------------------- input -- */

// A json input arrives parsed from the harness and as text from a direct call; both are read.
export function jsonObject(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === '') return undefined
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error(`${key} must be a JSON object`)
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${key} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

// Labels are comma-separated; Jira refuses a label with a space, so it is refused here with a clearer message.
export function labelList(value: unknown): string[] | undefined {
  const raw = text(value)
  if (raw === undefined) return undefined
  const labels = raw
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label !== '')
  const spaced = labels.find((label) => /\s/.test(label))
  if (spaced) throw new Error(`labels cannot contain spaces, got "${spaced}"`)
  return labels
}

// A whole number within bounds; unset stays unset so the caller applies its default.
export function count(value: unknown, key: string, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw new Error(`${key} must be a whole number from 1 to ${max}, got "${String(value)}"`)
  }
  return number
}

function isFalse(value: unknown): boolean {
  return value === false || /^(false|0|no)$/i.test(String(value ?? '').trim())
}

// `null`, `none` or nothing at all unassigns; "-1" is Jira's own word for the project default.
export function assigneeId(value: unknown): string | null {
  const raw = text(value)
  return raw === undefined || /^(null|none|unassigned)$/i.test(raw) ? null : raw
}

/* --------------------------------------------------------------- inputs -- */

const ISSUE_KEY_INPUT = {
  key: 'issueKey',
  label: 'Issue',
  required: true,
  description: 'The issue key (EX-12) or id.',
  builderHint:
    'Sent URL-encoded as the {issueIdOrKey} path segment; a key that no longer matches is looked up case-insensitively and across moves by Jira itself, and an unknown one answers 404.'
}

const DESCRIPTION_INPUT = {
  key: 'description',
  label: 'Description',
  description: 'The description as plain text; blank lines start new paragraphs. An ADF document as JSON is sent as it is.',
  builderHint:
    'Converted to Atlassian Document Format ({ version: 1, type: "doc", content: [paragraph…] }) because v3 refuses plain text; a value that parses as JSON with type "doc" is passed through.'
}

const FIELDS_INPUT = (verb: string) => ({
  key: 'fields',
  label: 'Fields',
  type: 'json' as const,
  description: `A JSON object of issue fields ${verb}, keyed by field id, such as {"customfield_10000":"value","duedate":"2026-09-30"}.`,
  builderHint:
    'Merged over the named inputs into the request body\'s `fields`; a field the screen does not carry answers 400 with the field named in `errors`.'
})

const ISSUE_OUTPUTS = [
  { key: 'id', description: 'The issue id' },
  { key: 'key', description: 'The issue key, such as EX-12' },
  { key: 'url', description: 'Where to open it: <site>/browse/<key>' }
]

const ISSUE_SUMMARY_OUTPUTS = [
  ...ISSUE_OUTPUTS,
  { key: 'summary', description: 'The summary line' },
  { key: 'status', description: 'Status name, such as In Progress' },
  { key: 'statusCategory', description: 'The status category: To Do, In Progress or Done' },
  { key: 'issueType', description: 'Issue type name' },
  { key: 'priority', description: 'Priority name' },
  { key: 'assignee', description: '{ accountId, displayName } or null' },
  { key: 'reporter', description: '{ accountId, displayName } or null' },
  { key: 'project', description: '{ id, key, name }' },
  { key: 'labels', description: 'The labels' },
  { key: 'created', description: 'When it was created, ISO 8601' },
  { key: 'updated', description: 'When it last changed, ISO 8601' },
  { key: 'resolution', description: 'Resolution name, or null while open' },
  { key: 'descriptionText', description: 'The description flattened to plain text' }
]

/* ------------------------------------------------------------ connector -- */

export function createJiraConnector(options: JiraConnectorOptions = {}) {
  const env = options.env ?? process.env
  // The searching user's zone decides what a JQL date means; read once per site and account.
  const zones = new Map<string, string>()

  function clientFor(config: ConnectorConfig, fetchImpl?: typeof fetch): JiraClient {
    const settings = readSettings(config)
    return createJiraClient({
      siteUrl: settings.siteUrl,
      email: settings.email,
      apiToken: settings.apiToken,
      fetchImpl: options.fetchImpl ?? (fetchImpl as FetchLike | undefined),
      ...(options.sleep && { sleep: options.sleep }),
      ...(options.now && { now: options.now }),
      ...(options.random && { random: options.random })
    })
  }

  async function timeZoneOf(client: JiraClient, email: string): Promise<string> {
    const cacheKey = `${client.site}|${email}`
    const cached = zones.get(cacheKey)
    if (cached !== undefined) return cached
    const me = await client.get<JiraUser>('myself')
    const zone = text(me?.timeZone) ?? 'UTC'
    zones.set(cacheKey, zone)
    return zone
  }

  // Walks nextPageToken until the last page, `wanted` issues or the page cap.
  async function searchAll(client: JiraClient, jql: string, fields: string, wanted: number): Promise<SearchPage> {
    const issues: JiraIssue[] = []
    let nextPageToken: string | undefined
    let isLast = true
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await client.get<SearchPage>('search/jql', {
        jql,
        fields,
        maxResults: Math.min(PAGE_SIZE, wanted - issues.length),
        nextPageToken
      })
      const found = Array.isArray(body?.issues) ? body.issues : []
      issues.push(...found)
      nextPageToken = text(body?.nextPageToken)
      isLast = body?.isLast === true || nextPageToken === undefined
      if (isLast || found.length === 0 || issues.length >= wanted) break
    }
    return { issues: issues.slice(0, wanted), isLast, ...(nextPageToken && !isLast && { nextPageToken }) }
  }

  /* ---------------------------------------------------------- triggers -- */

  async function fetchIssues(context: FetchContext, kind: TriggerKind): Promise<ConnectorItem[]> {
    const settings = readSettings(context.config)
    if (kind === 'transitioned' && settings.status === undefined) {
      throw new Error('JIRA_STATUS is required for the issueTransitioned trigger: the status name, such as Done')
    }
    const client = clientFor(context.config, context.fetch)
    const zone = await timeZoneOf(client, settings.email)
    const firstLookback = kind === 'created' ? FIRST_POLL_CREATED_MS : FIRST_POLL_UPDATED_MS
    const floor = context.since ? Date.parse(context.since) - OVERLAP_MS : Date.parse(context.now()) - firstLookback
    const date = jqlDate(new Date(floor).toISOString(), zone)
    const field = kind === 'created' ? 'created' : 'updated'
    const timeClause =
      kind === 'transitioned' ? transitionedClause(settings.status as string, date) : sinceClause(field, date)
    const jql = orderBy(andClauses(projectClause(settings.projectKey), timeClause, settings.jql), field)
    const page = await searchAll(client, jql, TRIGGER_FIELDS, PAGE_SIZE * MAX_PAGES)
    return (page.issues ?? []).map((issue) => issueToItem(issue, client.site, kind))
  }

  /* ----------------------------------------------------------- samples -- */

  // Live samples name a real issue only when the machine running them says which.
  const sampleIssueKey = text(env.JIRA_ISSUE_KEY)

  return defineConnector({
    id: 'jira',
    name: 'Jira',
    version: options.version ?? pkg.version,
    description:
      'Trigger workflows when a Jira Cloud issue is created, updated or moved to a status, and create, edit, transition, comment on, assign, read or search issues from a step.',
    // Jira's mark: three rotated tiles stacked up-left, the bottom one notched at its centre.
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M16 9 23 16 16 23 9 16 10.75 14.25 12.5 16 16 12.5 14.25 10.75z',
        'M12 5 15.5 8.5 13.25 10.75 15 12.5 12.5 15 10.75 13.25 8.5 15.5 5 12 6.75 10.25 8.5 12 12 8.5 10.25 6.75z',
        'M8 1 11.5 4.5 9.25 6.75 11 8.5 8.5 11 6.75 9.25 4.5 11.5 1 8z'
      ]
    },
    auth: { rung: 'key', keys: ['apiToken'] },
    config: [
      {
        key: 'siteUrl',
        env: 'JIRA_SITE_URL',
        label: 'Site URL',
        required: true,
        description: 'Your Jira Cloud site, such as https://example.atlassian.net.',
        builderHint:
          'Only the origin is kept: a trailing slash or a path is dropped and /rest/api/3 appended. A mistyped site answers 200 with an HTML login page, which the connector reports as a non-JSON answer.'
      },
      {
        key: 'email',
        env: 'JIRA_EMAIL',
        label: 'Account email',
        required: true,
        description: 'The email address of the Atlassian account the API token belongs to.',
        builderHint: 'The user half of HTTP Basic auth: Authorization: Basic base64(email + ":" + apiToken) on every call.'
      },
      {
        key: 'apiToken',
        env: 'JIRA_API_TOKEN',
        label: 'API token',
        secret: true,
        required: true,
        description:
          'An API token from https://id.atlassian.com/manage-profile/security/api-tokens, created without scopes. Every issue created or comment posted is attributed to this account.',
        builderHint:
          'The password half of Basic auth. A token created "with scopes" only works against api.atlassian.com/ex/jira/{cloudId} and answers 401 on the site URL. A 401 is never retried: repeated failures trip a CAPTCHA that blocks the API until the person logs in through the browser.'
      },
      {
        key: 'projectKey',
        env: 'JIRA_PROJECT_KEY',
        label: 'Project key',
        description: 'Limit the triggers to one project, by key (EX). Blank watches every project the account can browse.',
        builderHint: 'Adds `project = <KEY>` in front of every trigger\'s JQL; letters, digits and underscores only, so it cannot carry JQL of its own.'
      },
      {
        key: 'jql',
        env: 'JIRA_JQL',
        label: 'Extra JQL',
        description: 'An extra JQL filter every trigger applies, such as issuetype = Bug AND priority in (High, Highest).',
        builderHint: 'ANDed in parentheses after the time clause, so ORs inside it stay together; leave out ORDER BY, the trigger adds its own.'
      },
      {
        key: 'status',
        env: 'JIRA_STATUS',
        label: 'Status',
        description: 'The status name the issueTransitioned trigger watches for, such as Done. Only that trigger reads it.',
        builderHint: 'Quoted into `status CHANGED TO "<status>" AFTER "<cursor>"`; the name is matched by Jira, not here.'
      }
    ],
    triggers: [
      {
        type: 'newIssue',
        label: 'An issue is created',
        description: 'Fires once for each issue created since the last poll, oldest first, within the project and JQL filter from the settings.',
        dedupe: 'timestamp',
        fetch: (context) => fetchIssues(context, 'created'),
        defaultWorkflow: { name: 'Jira: new issues', defaultCronFromMinutes: 5 },
        sample: [issueToItem(SAMPLE_ISSUE, SAMPLE_SITE, 'created')]
      },
      {
        type: 'issueUpdated',
        label: 'An issue is updated',
        description: 'Fires for each change to an issue since the last poll, keyed by issue and update time, so an issue edited twice fires twice.',
        dedupe: 'timestamp',
        fetch: (context) => fetchIssues(context, 'updated'),
        defaultWorkflow: { name: 'Jira: updated issues', defaultCronFromMinutes: 5 },
        sample: [issueToItem(SAMPLE_UPDATED_ISSUE, SAMPLE_SITE, 'updated')]
      },
      {
        type: 'issueTransitioned',
        label: 'An issue moves to a status',
        description:
          'Fires when an issue is transitioned into the status named in the settings. JQL records that the change happened, not when, so the issue\'s last update stands in as the time.',
        dedupe: 'timestamp',
        fetch: (context) => fetchIssues(context, 'transitioned'),
        defaultWorkflow: { name: 'Jira: issues moved to a status', defaultCronFromMinutes: 5 },
        sample: [issueToItem(SAMPLE_TRANSITIONED_ISSUE, SAMPLE_SITE, 'transitioned')]
      }
    ],
    actions: [
      {
        type: 'createIssue',
        label: 'Create an issue',
        description: 'Create one issue in a project. The description is written as plain text and converted to Atlassian Document Format.',
        // Two calls make two issues; Jira offers no idempotency key.
        idempotent: false,
        inputs: [
          {
            key: 'projectKey',
            label: 'Project',
            required: true,
            description: 'The project key, such as EX.',
            builderHint: 'Sent as fields.project.key; the account needs Create issues in that project or the call answers 403.'
          },
          {
            key: 'issueType',
            label: 'Issue type',
            required: true,
            description: 'The issue type name: Bug, Task, Story, Epic or Subtask.',
            builderHint: 'Sent as fields.issuetype.name and matched by Jira against the project\'s issue type scheme; an unknown name answers 400 naming issuetype in errors.'
          },
          {
            key: 'summary',
            label: 'Summary',
            required: true,
            description: 'The one-line summary.',
            builderHint: 'Sent as fields.summary; required by every default screen.'
          },
          DESCRIPTION_INPUT,
          {
            key: 'assigneeAccountId',
            label: 'Assignee account id',
            description: 'The account id of the assignee, from getCurrentUser or the issue\'s assignee output.',
            builderHint: 'Sent as fields.assignee.id; names and emails are not accepted here, only account ids.'
          },
          {
            key: 'labels',
            label: 'Labels',
            description: 'Comma-separated labels, such as bugfix,triaged. Labels cannot contain spaces.',
            builderHint: 'Sent as the fields.labels array; a label with a space is refused before the call.'
          },
          {
            key: 'priority',
            label: 'Priority',
            description: 'The priority name: Highest, High, Medium, Low or Lowest.',
            builderHint: 'Sent as fields.priority.name; the reference\'s own 400 example is "Field \'priority\' is required" on a project whose screen demands it.'
          },
          {
            key: 'parentKey',
            label: 'Parent issue',
            description: 'The parent issue key, for a subtask or a child of an epic.',
            builderHint: 'Sent as fields.parent.key; a Subtask issue type needs one.'
          },
          FIELDS_INPUT('to set as well')
        ],
        outputs: [...ISSUE_OUTPUTS, { key: 'self', description: 'The REST URL of the issue' }],
        async run(args, context) {
          const client = clientFor(context.config, context.fetch)
          const description = text(args.description)
          const assignee = text(args.assigneeAccountId)
          const labels = labelList(args.labels)
          const priority = text(args.priority)
          const parent = text(args.parentKey)
          const fields = {
            project: { key: String(args.projectKey).trim() },
            issuetype: { name: String(args.issueType).trim() },
            summary: String(args.summary),
            ...(description && { description: toAdf(description) }),
            ...(assignee && { assignee: { id: assignee } }),
            ...(labels && labels.length > 0 && { labels }),
            ...(priority && { priority: { name: priority } }),
            ...(parent && { parent: { key: parent } }),
            ...jsonObject(args.fields, 'fields')
          }
          const issue = await client.request<JiraIssue>('POST', 'issue', { body: { fields }, idempotent: false })
          const key = issue?.key ?? ''
          return { id: issue?.id ?? '', key, url: key ? browseUrl(client.site, key) : '', self: issue?.self ?? '' }
        }
      },
      {
        type: 'updateIssue',
        label: 'Update an issue',
        description: 'Edit the summary, description or any fields of an issue; the rest stays as it was. Transitions are ignored here, use transitionIssue.',
        // Setting the same fields twice leaves the same issue.
        idempotent: true,
        inputs: [
          ISSUE_KEY_INPUT,
          {
            key: 'summary',
            label: 'Summary',
            description: 'A new summary line.',
            builderHint: 'Sent as fields.summary when set.'
          },
          DESCRIPTION_INPUT,
          FIELDS_INPUT('to set'),
          {
            key: 'update',
            label: 'Update operations',
            type: 'json',
            description: 'A JSON object of update operations, such as {"labels":[{"add":"triaged"}]} or {"components":[{"remove":{"name":"UI"}}]}.',
            builderHint: 'Sent as the body\'s `update`; a field may appear in `fields` or `update`, not both, or Jira answers 400.'
          },
          {
            key: 'notifyUsers',
            label: 'Notify users',
            type: 'boolean',
            description: 'Send the usual edit notifications. Defaults to true; false needs project administer permission or is ignored.',
            builderHint: 'Sent as notifyUsers=false on the query only when set to false.'
          }
        ],
        outputs: [...ISSUE_OUTPUTS, { key: 'issue', description: 'The issue after the edit, as Jira returns it' }],
        async run(args, context) {
          const client = clientFor(context.config, context.fetch)
          const issueKey = String(args.issueKey).trim()
          const summary = text(args.summary)
          const description = text(args.description)
          const extra = jsonObject(args.fields, 'fields')
          const update = jsonObject(args.update, 'update')
          if (summary === undefined && description === undefined && extra === undefined && update === undefined) {
            throw new Error('updateIssue needs at least one of summary, description, fields or update')
          }
          const fields = {
            ...(summary && { summary }),
            ...(description && { description: toAdf(description) }),
            ...extra
          }
          const issue = await client.request<JiraIssue>('PUT', `issue/${encodeURIComponent(issueKey)}`, {
            query: { returnIssue: true, ...(isFalse(args.notifyUsers) && { notifyUsers: false }) },
            body: { ...(Object.keys(fields).length > 0 && { fields }), ...(update && { update }) },
            idempotent: true
          })
          const key = issue?.key ?? issueKey
          return { id: issue?.id ?? '', key, url: browseUrl(client.site, key), issue: issue ?? {} }
        }
      },
      {
        type: 'transitionIssue',
        label: 'Transition an issue',
        description: 'Move an issue through a workflow transition, by transition id or name, optionally with a comment and screen fields.',
        // Once taken the transition is gone, so a second call answers 400.
        idempotent: false,
        inputs: [
          ISSUE_KEY_INPUT,
          {
            key: 'transition',
            label: 'Transition',
            required: true,
            description: 'A transition id (31) or name (Done). A name is matched against the transitions the issue offers, then against their target statuses.',
            builderHint:
              'Digits are sent as transition.id as they are; anything else is resolved case-insensitively against GET issue/{key}/transitions by name, then by to.name. When that list names nothing the value is sent as the id and Jira\'s own answer stands; when it names transitions and none match, the error lists them.'
          },
          {
            key: 'comment',
            label: 'Comment',
            description: 'A plain-text comment to add with the transition.',
            builderHint: 'Sent as update.comment[0].add.body in ADF, the documented way to comment on a transition.'
          },
          {
            key: 'fields',
            label: 'Fields',
            type: 'json',
            description: 'A JSON object of fields the transition screen asks for, such as {"resolution":{"name":"Done"}}.',
            builderHint: 'Sent as the body\'s `fields`; only fields on the transition screen are accepted.'
          }
        ],
        outputs: [
          { key: 'key', description: 'The issue key or id that was transitioned' },
          { key: 'id', description: 'The transition id taken' },
          { key: 'name', description: 'The transition name, when it was resolved' },
          { key: 'to', description: 'The status the issue moved to, when known' }
        ],
        async run(args, context) {
          const client = clientFor(context.config, context.fetch)
          const issueKey = String(args.issueKey).trim()
          const wanted = String(args.transition).trim()
          const path = `issue/${encodeURIComponent(issueKey)}/transitions`
          const listed = await client.get<{ transitions?: JiraTransition[] }>(path)
          const transitions = Array.isArray(listed?.transitions) ? listed.transitions : []
          const lower = wanted.toLowerCase()
          const chosen = /^\d+$/.test(wanted)
            ? transitions.find((transition) => transition.id === wanted)
            : (transitions.find((transition) => transition.name?.toLowerCase() === lower) ??
              transitions.find((transition) => transition.to?.name?.toLowerCase() === lower))
          if (!chosen && !/^\d+$/.test(wanted) && transitions.length > 0) {
            const names = transitions.map((transition) => `${transition.name ?? '?'} (${transition.id ?? '?'})`).join(', ')
            throw new Error(`${issueKey} offers no transition named "${wanted}"; it offers: ${names}`)
          }
          const id = chosen?.id ?? wanted
          const comment = text(args.comment)
          const fields = jsonObject(args.fields, 'fields')
          await client.request('POST', path, {
            body: {
              transition: { id },
              ...(comment && { update: { comment: [{ add: { body: toAdf(comment) } }] } }),
              ...(fields && { fields })
            },
            idempotent: false
          })
          return { key: issueKey, id, name: chosen?.name ?? '', to: chosen?.to?.name ?? '' }
        }
      },
      {
        type: 'addComment',
        label: 'Add a comment',
        description: 'Post a comment on an issue. Plain text is converted to Atlassian Document Format.',
        // Two calls post two comments.
        idempotent: false,
        inputs: [
          ISSUE_KEY_INPUT,
          {
            key: 'body',
            label: 'Comment',
            required: true,
            description: 'The comment as plain text; blank lines start new paragraphs. An ADF document as JSON is sent as it is.',
            builderHint: 'Sent as `body` in ADF on POST issue/{key}/comment; the account needs Add comments on the project.'
          }
        ],
        outputs: [
          { key: 'id', description: 'The comment id' },
          { key: 'created', description: 'When it was posted, ISO 8601' },
          { key: 'updated', description: 'When it last changed, ISO 8601' },
          { key: 'author', description: '{ accountId, displayName } of the account that posted it' },
          { key: 'self', description: 'The REST URL of the comment' },
          { key: 'url', description: 'Where to open it: <site>/browse/<key>?focusedCommentId=<id>' }
        ],
        async run(args, context) {
          const client = clientFor(context.config, context.fetch)
          const issueKey = String(args.issueKey).trim()
          const comment = await client.request<{
            id?: string
            created?: string
            updated?: string
            author?: JiraUser
            self?: string
          }>('POST', `issue/${encodeURIComponent(issueKey)}/comment`, {
            body: { body: toAdf(String(args.body)) },
            idempotent: false
          })
          const id = comment?.id ?? ''
          return {
            id,
            created: isoOf(comment?.created) ?? '',
            updated: isoOf(comment?.updated) ?? '',
            author: { accountId: comment?.author?.accountId ?? '', displayName: comment?.author?.displayName ?? '' },
            self: comment?.self ?? '',
            url: `${browseUrl(client.site, issueKey)}${id ? `?focusedCommentId=${encodeURIComponent(id)}` : ''}`
          }
        }
      },
      {
        type: 'assignIssue',
        label: 'Assign an issue',
        description: 'Assign an issue to an account, or unassign it.',
        // The same assignee set twice is the same issue.
        idempotent: true,
        inputs: [
          ISSUE_KEY_INPUT,
          {
            key: 'accountId',
            label: 'Account id',
            description: 'The assignee\'s account id. Blank or null unassigns; -1 assigns the project\'s default assignee.',
            builderHint: 'Sent as { accountId } on PUT issue/{key}/assignee, with null for unassigned as the reference documents.'
          }
        ],
        outputs: [
          { key: 'key', description: 'The issue key or id' },
          { key: 'accountId', description: 'The account id now assigned, or null' }
        ],
        async run(args, context) {
          const client = clientFor(context.config, context.fetch)
          const issueKey = String(args.issueKey).trim()
          const accountId = assigneeId(args.accountId)
          await client.request('PUT', `issue/${encodeURIComponent(issueKey)}/assignee`, {
            body: { accountId },
            idempotent: true
          })
          return { key: issueKey, accountId }
        }
      },
      {
        type: 'getIssue',
        label: 'Get an issue',
        description: 'Read one issue by key or id, with its main fields flattened and the description as plain text.',
        idempotent: true,
        inputs: [
          ISSUE_KEY_INPUT,
          {
            key: 'fields',
            label: 'Fields',
            description: 'Comma-separated field ids to return, such as summary,status,customfield_10000. Defaults to every navigable field.',
            builderHint: 'Sent as the `fields` query parameter; *navigable is the default here because the API\'s own default is only `id`.'
          }
        ],
        outputs: [...ISSUE_SUMMARY_OUTPUTS, { key: 'issue', description: 'The issue as Jira returns it, fields included' }],
        ...(sampleIssueKey && { sample: { issueKey: sampleIssueKey } }),
        async run(args, context) {
          const client = clientFor(context.config, context.fetch)
          const issueKey = String(args.issueKey).trim()
          const issue = await client.get<JiraIssue>(`issue/${encodeURIComponent(issueKey)}`, {
            fields: text(args.fields) ?? '*navigable'
          })
          return { ...issueSummary(issue ?? {}, client.site), issue: issue ?? {} }
        }
      },
      {
        type: 'searchIssues',
        label: 'Search issues',
        description: 'Run a JQL query and return the matching issues, paging until maxResults are collected.',
        idempotent: true,
        inputs: [
          {
            key: 'jql',
            label: 'JQL',
            required: true,
            description: 'A JQL expression, such as project = EX AND status = "In Progress" ORDER BY updated DESC.',
            builderHint: 'Sent as `jql` on GET search/jql, which needs a bounded query; a bare ORDER BY is prefixed with created >= "1970-01-01" so it is accepted.'
          },
          {
            key: 'fields',
            label: 'Fields',
            description: 'Comma-separated field ids to return. Defaults to summary, status, issue type, priority, assignee, reporter, project, labels, created, updated and resolution.',
            builderHint: 'Sent as `fields`; the API returns only `id` when it is left out, so the default list is always sent.'
          },
          {
            key: 'maxResults',
            label: 'Maximum results',
            type: 'number',
            description: 'How many issues to return in total, 1 to 5000. Defaults to 50.',
            builderHint: 'Pages of up to 100 are walked with nextPageToken until this many are collected or the last page arrives, at most ten pages per call.'
          }
        ],
        outputs: [
          { key: 'issues', description: 'One entry per issue in the getIssue shape: id, key, url, summary, status, …' },
          { key: 'count', type: 'number', description: 'How many issues came back' },
          { key: 'isLast', type: 'boolean', description: 'True when no further page exists' },
          { key: 'nextPageToken', description: 'The token for the next page, when the walk stopped before the end' }
        ],
        sample: { jql: 'order by created DESC', maxResults: '5' },
        async run(args, context) {
          const client = clientFor(context.config, context.fetch)
          const jql = boundedJql(String(args.jql ?? ''))
          const fields = text(args.fields) ?? TRIGGER_FIELDS
          const wanted = count(args.maxResults, 'maxResults', MAX_SEARCH_RESULTS) ?? DEFAULT_SEARCH_RESULTS
          const page = await searchAll(client, jql, fields, wanted)
          const issues = (page.issues ?? []).map((issue) => issueSummary(issue, client.site))
          return {
            issues,
            count: issues.length,
            isLast: page.isLast === true,
            ...(page.nextPageToken && { nextPageToken: page.nextPageToken })
          }
        }
      },
      {
        type: 'listTransitions',
        label: 'List transitions',
        description: 'The workflow transitions an issue can take from its current status.',
        idempotent: true,
        inputs: [ISSUE_KEY_INPUT],
        outputs: [
          { key: 'transitions', description: 'One entry per transition: id, name, to { id, name, statusCategory }, hasScreen, isAvailable' },
          { key: 'count', type: 'number', description: 'How many transitions the issue offers' }
        ],
        ...(sampleIssueKey && { sample: { issueKey: sampleIssueKey } }),
        async run(args, context) {
          const client = clientFor(context.config, context.fetch)
          const issueKey = String(args.issueKey).trim()
          const body = await client.get<{ transitions?: JiraTransition[] }>(`issue/${encodeURIComponent(issueKey)}/transitions`)
          const transitions = (Array.isArray(body?.transitions) ? body.transitions : []).map(transitionSummary)
          return { transitions, count: transitions.length }
        }
      },
      {
        type: 'listProjects',
        label: 'List projects',
        description: 'The projects the account can browse, ordered by key, optionally filtered by a name or key fragment and by type.',
        idempotent: true,
        inputs: [
          {
            key: 'query',
            label: 'Query',
            description: 'Return only projects whose key or name contains this text, case-insensitively.',
            builderHint: 'Sent as `query` on GET project/search.'
          },
          {
            key: 'typeKey',
            label: 'Project type',
            type: 'select',
            options: [
              { value: 'software', label: 'Software' },
              { value: 'business', label: 'Business' },
              { value: 'service_desk', label: 'Service management' }
            ],
            description: 'Limit to one project type. Blank returns every type.',
            builderHint: 'Sent as `typeKey` when set; the API also accepts a comma-separated list.'
          }
        ],
        outputs: [
          { key: 'projects', description: 'One entry per project: id, key, name, projectTypeKey, simplified, style, url' },
          { key: 'count', type: 'number', description: 'How many projects came back' }
        ],
        sample: {},
        async run(args, context) {
          const client = clientFor(context.config, context.fetch)
          const projects: JiraProject[] = []
          for (let page = 0; page < MAX_PAGES; page += 1) {
            const body = await client.get<{ values?: JiraProject[]; isLast?: boolean }>('project/search', {
              maxResults: PROJECT_PAGE_SIZE,
              orderBy: 'key',
              startAt: projects.length,
              query: text(args.query),
              typeKey: text(args.typeKey)
            })
            const values = Array.isArray(body?.values) ? body.values : []
            projects.push(...values)
            if (values.length === 0 || body?.isLast !== false) break
          }
          return { projects: projects.map((project) => projectSummary(project, client.site)), count: projects.length }
        }
      },
      {
        type: 'getCurrentUser',
        label: 'Get the current user',
        description: 'The account the API token belongs to, with its account id and time zone.',
        idempotent: true,
        inputs: [],
        outputs: [
          { key: 'accountId', description: 'The account id, as assignee fields take it' },
          { key: 'accountType', description: 'atlassian, app or customer' },
          { key: 'displayName', description: 'The display name' },
          { key: 'emailAddress', description: 'The email address, when the account does not hide it' },
          { key: 'active', type: 'boolean', description: 'Whether the account is active' },
          { key: 'timeZone', description: 'The account\'s time zone, which JQL dates are read in' },
          { key: 'locale', description: 'The account\'s locale' },
          { key: 'self', description: 'The REST URL of the user' }
        ],
        sample: {},
        async run(_args, context) {
          const client = clientFor(context.config, context.fetch)
          return userSummary((await client.get<JiraUser>('myself')) ?? {})
        }
      }
    ],
    async preflight() {
      const missing = ['JIRA_SITE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'].filter((name) => text(env[name]) === undefined)
      if (missing.length > 0) return { ok: false, message: `Set ${missing.join(', ')}. ${TOKEN_HINT}` }
      const client = clientFor({ siteUrl: env.JIRA_SITE_URL, email: env.JIRA_EMAIL, apiToken: env.JIRA_API_TOKEN })
      const me = await client.get<JiraUser>('myself')
      return { ok: true, message: `Signed in to ${client.site} as ${me?.displayName ?? me?.accountId ?? 'the token\'s account'}` }
    }
  })
}

export const connector = createJiraConnector()
