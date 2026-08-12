import { defineConnector, type ConnectorItem, type FetchContext } from '@vornrun/connector-sdk'
import {
  ISSUE_FIELDS,
  linearGraphQL,
  resolveCompletedStateId,
  resolveIssueId,
  resolveIssueWithTeam,
  resolveTeamId,
  type FetchLike,
  type LinearIssue
} from './client'

const DEFAULT_LIMIT = 50

export interface LinearConnectorOptions {
  version?: string
  /** Injected in tests, so nothing reaches the network. */
  fetchImpl?: FetchLike
}

function required(config: Record<string, unknown>, key: string, env: string): string {
  const value = String(config[key] ?? '').trim()
  if (!value) throw new Error(`${env} is required`)
  return value
}

/** Trim an argument, treating blank as absent. */
function text(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * One issue as Vorn holds it.
 *
 * `status` is the state *type* rather than its name, because a team can rename
 * "In Progress" to anything it likes while the type stays `started` — and the
 * status mapping below is written against types.
 */
function issueToItem(issue: LinearIssue): ConnectorItem {
  return {
    externalId: issue.identifier,
    url: issue.url,
    title: issue.title,
    description: issue.description ?? '',
    status: issue.state.type,
    labels: issue.labels.nodes.map((label) => label.name),
    ...(issue.assignee?.name && { assignee: issue.assignee.name }),
    updatedAt: issue.updatedAt,
    // Everything else a workflow might template, under the key the SDK
    // flattens into {{trigger.item.<key>}}.
    data: {
      createdAt: issue.createdAt,
      stateName: issue.state.name,
      teamKey: issue.team.key
    }
  }
}

export function createLinearConnector(options: LinearConnectorOptions = {}) {
  const fetchImpl = options.fetchImpl

  async function fetchIssues(context: FetchContext): Promise<ConnectorItem[]> {
    const config = context.config as Record<string, unknown>
    const apiKey = required(config, 'apiKey', 'LINEAR_API_KEY')
    const teamKey = text(config.teamKey)
    const stateType = text(config.stateType)
    const limit = Number(config.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT

    const filter: Record<string, unknown> = {}
    if (teamKey) filter.team = { key: { eq: teamKey } }
    if (stateType) filter.state = { type: { eq: stateType } }
    // The SDK dedupes on updatedAt, so asking for everything since the
    // watermark is both correct and much less to page through. Returning
    // something already seen is safe; missing something is not.
    if (context.since) filter.updatedAt = { gte: context.since }

    const data = await linearGraphQL<{ issues: { nodes: LinearIssue[] } }>({
      apiKey,
      ...(fetchImpl && { fetchImpl }),
      query: `
        query ListIssues($filter: IssueFilter, $first: Int!) {
          issues(filter: $filter, first: $first, orderBy: updatedAt) {
            nodes { ${ISSUE_FIELDS} }
          }
        }
      `,
      variables: {
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        first: limit
      }
    })

    return data.issues.nodes.map(issueToItem)
  }

  return defineConnector({
    id: 'linear',
    name: 'Linear',
    ...(options.version && { version: options.version }),
    description: 'Trigger workflows from Linear issues, and comment or close them from a step.',
    // Linear's own mark.
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M3.035 12.943c.207 1.98 1.07 3.904 2.587 5.421 1.517 1.517 3.441 2.38 5.42 2.587z',
        'M3 11.494L12.492 20.986c.806-.045 1.606-.198 2.378-.459L3.459 9.115A9.6 9.6 0 003 11.494z',
        'M3.867 8.11l12.009 12.009a9.6 9.6 0 001.773-1.123L4.99 6.337a9.6 9.6 0 00-1.123 1.773z',
        'M5.663 5.595c3.518-3.474 9.186-3.46 12.687.04 3.501 3.501 3.515 9.169.041 12.687z'
      ]
    },
    config: [
      {
        key: 'apiKey',
        env: 'LINEAR_API_KEY',
        label: 'Linear API key',
        // Stored encrypted by Vorn and never printed by the CLI.
        secret: true,
        required: true,
        description: 'Create a personal API key at linear.app/settings/api.'
      },
      {
        key: 'teamKey',
        env: 'LINEAR_TEAM_KEY',
        label: 'Team key',
        description: 'Upper-case key such as ENG. Leave blank for every team you can see.'
      },
      {
        key: 'stateType',
        env: 'LINEAR_STATE_TYPE',
        label: 'State',
        description:
          'One of backlog, unstarted, started, completed, canceled. Blank for all states.'
      },
      {
        key: 'limit',
        env: 'LINEAR_LIMIT',
        label: 'Maximum per poll',
        default: String(DEFAULT_LIMIT)
      }
    ],
    triggers: [
      {
        type: 'issueCreated',
        label: 'An issue is created or changed',
        description: 'Fires for each issue the query returns that Vorn has not seen at this time.',
        // Issues carry updatedAt, so the watermark advances on it rather than
        // re-reading everything the filter still matches.
        dedupe: 'timestamp',
        // What each Linear state type should become as a Vorn task. Without
        // these every issue imports as `todo`, including ones closed a year
        // ago.
        statusMapping: [
          { upstream: 'backlog', suggestedLocal: 'todo' },
          { upstream: 'unstarted', suggestedLocal: 'todo' },
          { upstream: 'started', suggestedLocal: 'in_progress' },
          { upstream: 'completed', suggestedLocal: 'done' },
          { upstream: 'canceled', suggestedLocal: 'cancelled' }
        ],
        defaultWorkflow: { name: 'Linear: issues', defaultCronFromMinutes: 5 },
        fetch: fetchIssues
      }
    ],
    actions: [
      {
        type: 'commentOnIssue',
        label: 'Comment on an issue',
        description: 'Post a comment on a Linear issue.',
        // Two identical calls make two comments.
        idempotent: false,
        inputs: [
          { key: 'identifier', label: 'Issue', required: true, description: 'e.g. ENG-123' },
          { key: 'body', label: 'Comment', required: true }
        ],
        outputs: [{ key: 'url', description: 'Where to read the comment' }],
        async run(args, { config }) {
          const apiKey = required(config as Record<string, unknown>, 'apiKey', 'LINEAR_API_KEY')
          const identifier = text(args.identifier)
          const body = text(args.body)
          if (!identifier) throw new Error('identifier is required (e.g. ENG-123)')
          if (!body) throw new Error('body is required')

          const issueId = await resolveIssueId(apiKey, identifier, fetchImpl)
          if (!issueId) throw new Error(`Issue ${identifier} not found`)

          const data = await linearGraphQL<{
            commentCreate: { success: boolean; comment: { id: string; url: string } }
          }>({
            apiKey,
            ...(fetchImpl && { fetchImpl }),
            query: `mutation CreateComment($input: CommentCreateInput!) {
               commentCreate(input: $input) { success comment { id url } }
             }`,
            variables: { input: { issueId, body } }
          })
          // Linear answers 200 with success=false rather than an error, so a
          // step that only caught throws would report a comment nobody posted.
          if (!data.commentCreate.success) throw new Error('Linear refused to create the comment')
          return { url: data.commentCreate.comment.url }
        }
      },
      {
        type: 'createIssue',
        label: 'Create an issue',
        description: 'Open a new Linear issue and return its identifier and url.',
        idempotent: false,
        inputs: [
          { key: 'title', label: 'Title', required: true },
          { key: 'description', label: 'Description' },
          { key: 'teamKey', label: 'Team key', description: 'Defaults to the connection’s team.' }
        ],
        outputs: [
          { key: 'identifier', description: 'e.g. ENG-123' },
          { key: 'url', description: 'Where to open it' }
        ],
        async run(args, { config }) {
          const cfg = config as Record<string, unknown>
          const apiKey = required(cfg, 'apiKey', 'LINEAR_API_KEY')
          const title = text(args.title)
          if (!title) throw new Error('title is required')

          const teamKey = text(args.teamKey) ?? text(cfg.teamKey)
          if (!teamKey) {
            throw new Error('teamKey is required: set one on the connection or pass it here.')
          }
          const teamId = await resolveTeamId(apiKey, teamKey, fetchImpl)
          if (!teamId) throw new Error(`Team ${teamKey} not found`)

          const input: Record<string, unknown> = { teamId, title }
          const description = text(args.description)
          if (description) input.description = description

          const data = await linearGraphQL<{
            issueCreate: { success: boolean; issue: { identifier: string; url: string } }
          }>({
            apiKey,
            ...(fetchImpl && { fetchImpl }),
            query: `mutation CreateIssue($input: IssueCreateInput!) {
               issueCreate(input: $input) { success issue { id identifier url } }
             }`,
            variables: { input }
          })
          if (!data.issueCreate.success) throw new Error('Linear refused to create the issue')
          return {
            identifier: data.issueCreate.issue.identifier,
            url: data.issueCreate.issue.url
          }
        }
      },
      {
        type: 'closeIssue',
        label: 'Close an issue',
        description: 'Move an issue to the first completed state its team defines.',
        // Closing an issue that is already closed lands it in the same place.
        idempotent: true,
        inputs: [
          { key: 'identifier', label: 'Issue', required: true, description: 'e.g. ENG-123' }
        ],
        outputs: [{ key: 'state', description: 'The state it now holds' }],
        async run(args, { config }) {
          const apiKey = required(config as Record<string, unknown>, 'apiKey', 'LINEAR_API_KEY')
          const identifier = text(args.identifier)
          if (!identifier) throw new Error('identifier is required (e.g. ENG-123)')

          const issue = await resolveIssueWithTeam(apiKey, identifier, fetchImpl)
          if (!issue) throw new Error(`Issue ${identifier} not found`)

          const stateId = await resolveCompletedStateId(apiKey, issue.teamId, fetchImpl)
          if (!stateId) {
            throw new Error(`Team ${issue.teamKey} has no completed state to move it to.`)
          }

          const data = await linearGraphQL<{
            issueUpdate: { success: boolean; issue: { state: { name: string } } }
          }>({
            apiKey,
            ...(fetchImpl && { fetchImpl }),
            query: `mutation CloseIssue($id: String!, $input: IssueUpdateInput!) {
               issueUpdate(id: $id, input: $input) { success issue { id state { name } } }
             }`,
            variables: { id: issue.id, input: { stateId } }
          })
          if (!data.issueUpdate.success) throw new Error('Linear refused to close the issue')
          return { state: data.issueUpdate.issue.state.name }
        }
      }
    ]
  })
}
