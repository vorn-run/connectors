import {
  defineConnector,
  type ConnectorConfig,
  type ConnectorItem,
  type FetchContext,
  type PostReceiveOp
} from '@vornrun/connector-sdk'
import {
  DEFAULT_BASE_URL,
  createGitLabClient,
  createTokenSource,
  gitlabPreflight,
  normalizeBaseUrl,
  projectSegment,
  type RunGlab,
  type TokenSource
} from './client'
import {
  SAMPLE_ISSUE,
  SAMPLE_MERGE_REQUEST,
  SAMPLE_PIPELINE,
  isFinishedPipeline,
  issueToItem,
  mergeRequestToItem,
  pipelineToItem,
  type GitLabIssue,
  type GitLabMergeRequest,
  type GitLabPipeline
} from './items'

export interface GitLabConnectorOptions {
  version?: string
  /** Injected in tests so nothing spawns `glab`. */
  glab?: RunGlab
  /** Where preflight reads the token and instance from; defaults to the process environment. */
  env?: NodeJS.ProcessEnv
}

/** Read a config value as trimmed text, treating blank and absent the same. */
function text(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim()
  return trimmed || undefined
}

/**
 * The declared header every action sends.
 *
 * Under Vorn the `token` field is filled either by the person or by the host,
 * which runs the borrow command at spawn; either way it is the same bearer.
 */
const AUTH_HEADERS = { Authorization: 'Bearer {{config.token}}' }

/** The API root every declared request is built on. */
const API = '{{config.baseUrl}}/api/v4'

/** GitLab's snake_case keys under the names a workflow step would reach for. */
function renames(mapping: Record<string, string>, path?: string): PostReceiveOp[] {
  return Object.entries(mapping).map(([from, to]) => ({
    op: 'rename',
    from,
    to,
    ...(path !== undefined && { path })
  }))
}

/** Reshape one issue as an action returns it. */
const ISSUE_SHAPE: PostReceiveOp[] = [
  {
    op: 'pick',
    keys: [
      'id',
      'iid',
      'project_id',
      'title',
      'description',
      'state',
      'web_url',
      'labels',
      'author',
      'assignees',
      'created_at',
      'updated_at',
      'closed_at',
      'issue_type',
      'confidential'
    ]
  },
  ...renames({
    project_id: 'projectId',
    web_url: 'url',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
    closed_at: 'closedAt',
    issue_type: 'issueType'
  }),
  { op: 'pick', keys: ['id', 'username', 'name'], path: 'author' },
  { op: 'pick', keys: ['id', 'username', 'name'], path: 'assignees' }
]

/** Reshape one merge request as an action returns it. */
const MERGE_REQUEST_SHAPE: PostReceiveOp[] = [
  {
    op: 'pick',
    keys: [
      'id',
      'iid',
      'project_id',
      'title',
      'description',
      'state',
      'draft',
      'web_url',
      'labels',
      'author',
      'assignees',
      'source_branch',
      'target_branch',
      'sha',
      'created_at',
      'updated_at',
      'merged_at',
      'closed_at',
      'has_conflicts',
      'detailed_merge_status'
    ]
  },
  ...renames({
    project_id: 'projectId',
    web_url: 'url',
    source_branch: 'sourceBranch',
    target_branch: 'targetBranch',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
    merged_at: 'mergedAt',
    closed_at: 'closedAt',
    has_conflicts: 'hasConflicts',
    detailed_merge_status: 'detailedMergeStatus'
  }),
  { op: 'pick', keys: ['id', 'username', 'name'], path: 'author' },
  { op: 'pick', keys: ['id', 'username', 'name'], path: 'assignees' }
]

/** A note, as both comment actions return it. The documented response has no `web_url`. */
const NOTE_SHAPE: PostReceiveOp[] = [
  {
    op: 'pick',
    keys: ['id', 'body', 'author', 'created_at', 'noteable_iid', 'noteable_type', 'internal']
  },
  ...renames({ created_at: 'createdAt', noteable_iid: 'noteableIid', noteable_type: 'noteableType' }),
  { op: 'pick', keys: ['id', 'username', 'name'], path: 'author' }
]

const NOTE_OUTPUTS = [
  { key: 'id', type: 'number' as const, description: 'The note id' },
  { key: 'body', description: 'The comment as posted' },
  { key: 'author', description: 'Who posted it, as {id, username, name}' },
  { key: 'createdAt', description: 'When it was posted' },
  { key: 'noteableIid', type: 'number' as const, description: 'The iid it was posted on' },
  { key: 'noteableType', description: 'Issue or MergeRequest' },
  { key: 'internal', type: 'boolean' as const, description: 'Whether only members can see it' }
]

const PROJECT_INPUT = {
  key: 'project',
  label: 'Project',
  required: true,
  description: 'Project path such as group/project, or its numeric id',
  builderHint:
    'The path is what the URL shows after the host; the id is on the project page. Either is sent URL-encoded as the :id segment.'
}

const BODY_INPUT = {
  key: 'body',
  label: 'Comment',
  required: true,
  description: 'Markdown, up to 1,000,000 characters'
}

const INTERNAL_INPUT = {
  key: 'internal',
  label: 'Internal note',
  type: 'boolean' as const,
  description: 'Visible to project members only. Defaults to false.',
  builderHint: 'The documented replacement for the deprecated confidential flag on notes.'
}

export function createGitLabConnector(options: GitLabConnectorOptions = {}) {
  const env = options.env ?? process.env

  // One token source per instance and pasted token, kept across polls so a
  // borrowed credential is read from `glab` once rather than on every call.
  const sources = new Map<string, TokenSource>()
  function tokensFor(config: ConnectorConfig): TokenSource {
    const baseUrl = normalizeBaseUrl(config.baseUrl)
    const token = text(config.token)
    const key = `${baseUrl} ${token ?? ''}`
    let source = sources.get(key)
    if (!source) {
      source = createTokenSource({
        ...(token !== undefined && { token }),
        baseUrl,
        ...(options.glab && { glab: options.glab })
      })
      sources.set(key, source)
    }
    return source
  }

  function client(context: FetchContext) {
    return createGitLabClient({
      config: context.config,
      fetch: context.fetch,
      tokens: tokensFor(context.config)
    })
  }

  /**
   * The lower bound for a list: everything at or after the SDK's watermark.
   *
   * Passed through untouched. GitLab compares "on or after" at second
   * precision while the watermark carries milliseconds, so the item sitting
   * exactly on it comes back again; the SDK recognises it by id. Adding a
   * second here would skip whatever else was created in that same second.
   */
  function sinceOf(context: FetchContext): string | undefined {
    return context.since
  }

  function fetchIssues(context: FetchContext): Promise<ConnectorItem[]> {
    return client(context)
      .list<GitLabIssue>(
        `/projects/${projectSegment(context.config.project)}/issues`,
        {
          state: 'all',
          order_by: 'created_at',
          sort: 'asc',
          created_after: sinceOf(context)
        },
        { ...(context.limit !== undefined && { limit: context.limit }) }
      )
      .then((issues) => issues.map(issueToItem))
  }

  function fetchMergeRequests(context: FetchContext): Promise<ConnectorItem[]> {
    return client(context)
      .list<GitLabMergeRequest>(
        `/projects/${projectSegment(context.config.project)}/merge_requests`,
        {
          state: 'all',
          order_by: 'created_at',
          sort: 'asc',
          created_after: sinceOf(context)
        },
        { ...(context.limit !== undefined && { limit: context.limit }) }
      )
      .then((mrs) => mrs.map(mergeRequestToItem))
  }

  async function fetchPipelines(context: FetchContext): Promise<ConnectorItem[]> {
    const pipelines = await client(context).list<GitLabPipeline>(
      `/projects/${projectSegment(context.config.project)}/pipelines`,
      {
        order_by: 'updated_at',
        sort: 'asc',
        updated_after: sinceOf(context),
        ref: text(context.config.ref)
      }
      // No `limit` here: a page is mostly pipelines still running, and cutting
      // the walk short on the raw count would starve the finished ones behind them.
    )
    // A pipeline seen while running is not delivered and not remembered, so it
    // fires once it finishes. A retried pipeline keeps its id and finishes
    // again; dedupe on id means that second result is not redelivered.
    return pipelines.filter(isFinishedPipeline).map(pipelineToItem)
  }

  return defineConnector({
    id: 'gitlab',
    name: 'GitLab',
    ...(options.version && { version: options.version }),
    description:
      'Trigger workflows from GitLab issues, merge requests and pipeline results, and create or comment on issues and merge requests from a step.',
    // GitLab's own mark.
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'm23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8627 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8627 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z'
      ]
    },
    auth: {
      rung: 'cli',
      probe: { command: 'glab', args: ['auth', 'status'] },
      // `glab auth token` does not exist; `config get token` is the documented
      // way to read what `glab auth login` stored. The host runs it at spawn
      // and hands the answer over as GITLAB_TOKEN, which is why that variable
      // is also the `token` field's env: a host refuses to borrow a name the
      // connector does not openly read. This is the gitlab.com default; the
      // connector's own token source adds `--host` from `baseUrl` when it has
      // to borrow for itself.
      borrow: {
        env: ['GITLAB_TOKEN'],
        tokenArgs: ['glab', 'config', 'get', 'token'],
        tokenEnv: 'GITLAB_TOKEN'
      }
    },
    config: [
      {
        key: 'baseUrl',
        env: 'GITLAB_BASE_URL',
        label: 'GitLab URL',
        default: DEFAULT_BASE_URL,
        description: 'Instance URL without a trailing slash. Leave the default for gitlab.com.',
        builderHint:
          'Every request goes to <baseUrl>/api/v4. A self-managed instance under a relative root (https://host/gitlab) works as-is. Declared requests append the path verbatim, so a trailing slash here would double it.'
      },
      {
        key: 'project',
        env: 'GITLAB_PROJECT',
        label: 'Project',
        required: true,
        description: 'Path such as group/project, or the numeric id. The triggers poll this project.',
        builderHint:
          'Sent URL-encoded (group%2Fproject) as the :id segment, as the docs require for namespaced paths. Actions take their own project input so one connection can act on several.'
      },
      {
        key: 'token',
        env: 'GITLAB_TOKEN',
        label: 'Personal access token',
        secret: true,
        description:
          'Leave empty to borrow the glab CLI login. Needs scope api, or read_api for the triggers and read-only actions.',
        builderHint:
          'Created under Edit profile, Access, Personal access tokens, Generate token; prefixed glpat-, 365-day default expiry. Filled, it is sent as-is and glab is never run; empty, the connector asks glab config get token --host <host>.'
      },
      {
        key: 'ref',
        env: 'GITLAB_REF',
        label: 'Pipeline ref',
        description: 'Branch or tag whose pipelines to watch. Blank for every ref.',
        builderHint: 'Sent as the ref filter on GET /projects/:id/pipelines; the other two triggers ignore it.'
      }
    ],
    preflight: () =>
      gitlabPreflight({
        ...(text(env.GITLAB_TOKEN) !== undefined && { token: env.GITLAB_TOKEN }),
        baseUrl: text(env.GITLAB_BASE_URL) ?? DEFAULT_BASE_URL,
        ...(options.glab && { glab: options.glab })
      }),
    triggers: [
      {
        type: 'issueCreated',
        label: 'An issue is created',
        description: 'Fires once for each issue created in the project since the last poll.',
        // The SDK keeps the watermark and the ids sitting on it; the fetch
        // asks GitLab for everything created on or after it.
        dedupe: 'timestamp',
        fetch: fetchIssues,
        statusMapping: [
          { upstream: 'opened', suggestedLocal: 'todo' },
          { upstream: 'closed', suggestedLocal: 'done' }
        ],
        defaultWorkflow: { name: 'GitLab: issues', defaultCronFromMinutes: 5 },
        sample: [issueToItem(SAMPLE_ISSUE)]
      },
      {
        type: 'mergeRequestOpened',
        label: 'A merge request is opened',
        description: 'Fires once for each merge request opened in the project since the last poll.',
        dedupe: 'timestamp',
        fetch: fetchMergeRequests,
        statusMapping: [
          { upstream: 'opened', suggestedLocal: 'in_progress' },
          { upstream: 'merged', suggestedLocal: 'done' },
          { upstream: 'closed', suggestedLocal: 'done' }
        ],
        defaultWorkflow: { name: 'GitLab: merge requests', defaultCronFromMinutes: 5 },
        sample: [mergeRequestToItem(SAMPLE_MERGE_REQUEST)]
      },
      {
        type: 'pipelineFinished',
        label: 'A pipeline finishes',
        description:
          'Fires once for each pipeline that reaches success, failed, canceled or skipped, with the status on the item.',
        dedupe: 'timestamp',
        fetch: fetchPipelines,
        // A failed pipeline is work to pick up; Vorn has no `blocked` status
        // to suggest, so it lands as todo.
        statusMapping: [
          { upstream: 'success', suggestedLocal: 'done' },
          { upstream: 'failed', suggestedLocal: 'todo' },
          { upstream: 'canceled', suggestedLocal: 'cancelled' },
          { upstream: 'skipped', suggestedLocal: 'cancelled' }
        ],
        defaultWorkflow: { name: 'GitLab: pipelines', defaultCronFromMinutes: 5 },
        sample: [pipelineToItem(SAMPLE_PIPELINE)]
      }
    ],
    actions: [
      {
        type: 'createIssue',
        label: 'Create an issue',
        description: 'Open a new issue in a project.',
        // Two identical calls make two issues; GitLab offers no idempotency key.
        idempotent: false,
        inputs: [
          PROJECT_INPUT,
          { key: 'title', label: 'Title', required: true, description: 'Issue title' },
          {
            key: 'description',
            label: 'Description',
            description: 'Markdown body, up to 1,048,576 characters'
          },
          {
            key: 'labels',
            label: 'Labels',
            description: 'Comma-separated label names',
            builderHint:
              'GitLab takes labels as one comma-separated string, so this is passed through as typed.'
          }
        ],
        outputs: [
          { key: 'id', type: 'number', description: 'Global issue id' },
          { key: 'iid', type: 'number', description: 'The number shown in the project, as in #12' },
          { key: 'url', description: 'Where to read it' },
          { key: 'title', description: 'The title as saved' },
          { key: 'state', description: 'opened' },
          { key: 'createdAt', description: 'When it was created' }
        ],
        request: {
          method: 'POST',
          url: `${API}/projects/{{args.project}}/issues`,
          headers: AUTH_HEADERS,
          body: {
            title: '{{args.title}}',
            description: '{{args.description}}',
            labels: '{{args.labels}}'
          }
        },
        postReceive: [
          { op: 'pick', keys: ['id', 'iid', 'web_url', 'title', 'state', 'created_at'] },
          ...renames({ web_url: 'url', created_at: 'createdAt' })
        ]
      },
      {
        type: 'commentOnIssue',
        label: 'Comment on an issue',
        description: 'Post a note on an issue.',
        // Two identical calls make two notes.
        idempotent: false,
        inputs: [
          PROJECT_INPUT,
          {
            key: 'iid',
            label: 'Issue number',
            type: 'number',
            required: true,
            description: 'The issue number shown in the project (its iid, not the global id)'
          },
          BODY_INPUT,
          INTERNAL_INPUT
        ],
        outputs: NOTE_OUTPUTS,
        request: {
          method: 'POST',
          url: `${API}/projects/{{args.project}}/issues/{{args.iid}}/notes`,
          headers: AUTH_HEADERS,
          body: { body: '{{args.body}}', internal: '{{args.internal}}' }
        },
        postReceive: NOTE_SHAPE
      },
      {
        type: 'commentOnMergeRequest',
        label: 'Comment on a merge request',
        description: 'Post a note on a merge request.',
        idempotent: false,
        inputs: [
          PROJECT_INPUT,
          {
            key: 'iid',
            label: 'Merge request number',
            type: 'number',
            required: true,
            description: 'The merge request number shown in the project (its iid)'
          },
          BODY_INPUT,
          INTERNAL_INPUT
        ],
        outputs: NOTE_OUTPUTS,
        request: {
          method: 'POST',
          url: `${API}/projects/{{args.project}}/merge_requests/{{args.iid}}/notes`,
          headers: AUTH_HEADERS,
          body: { body: '{{args.body}}', internal: '{{args.internal}}' }
        },
        postReceive: NOTE_SHAPE
      },
      {
        type: 'getProject',
        label: 'Get a project',
        description: 'Read a project by path or id.',
        // Reading changes nothing.
        idempotent: true,
        inputs: [PROJECT_INPUT],
        outputs: [
          { key: 'id', type: 'number', description: 'Project id' },
          { key: 'name', description: 'Display name' },
          { key: 'path', description: 'The last segment of the path' },
          { key: 'pathWithNamespace', description: 'group/project' },
          { key: 'description', description: 'Project description' },
          { key: 'defaultBranch', description: 'Usually main or master' },
          { key: 'visibility', description: 'private, internal or public' },
          { key: 'url', description: 'Where to open it' },
          { key: 'httpUrlToRepo', description: 'Clone URL over HTTPS' },
          { key: 'sshUrlToRepo', description: 'Clone URL over SSH' },
          { key: 'createdAt', description: 'When the project was created' },
          { key: 'lastActivityAt', description: 'When something last happened in it' },
          { key: 'archived', type: 'boolean', description: 'Whether it is archived' },
          {
            key: 'namespace',
            description: 'The owning group or user, as {id, name, path, fullPath, kind}'
          },
          { key: 'starCount', type: 'number', description: 'Stars' },
          { key: 'forksCount', type: 'number', description: 'Forks' },
          { key: 'topics', description: 'Topic names' }
        ],
        // A public project on gitlab.com, so the live check works with read_api.
        sample: { project: 'gitlab-org/gitlab' },
        request: {
          url: `${API}/projects/{{args.project}}`,
          headers: AUTH_HEADERS
        },
        postReceive: [
          {
            op: 'pick',
            keys: [
              'id',
              'name',
              'path',
              'path_with_namespace',
              'description',
              'default_branch',
              'visibility',
              'web_url',
              'http_url_to_repo',
              'ssh_url_to_repo',
              'created_at',
              'last_activity_at',
              'archived',
              'namespace',
              'star_count',
              'forks_count',
              'topics'
            ]
          },
          ...renames({
            path_with_namespace: 'pathWithNamespace',
            default_branch: 'defaultBranch',
            web_url: 'url',
            http_url_to_repo: 'httpUrlToRepo',
            ssh_url_to_repo: 'sshUrlToRepo',
            created_at: 'createdAt',
            last_activity_at: 'lastActivityAt',
            star_count: 'starCount',
            forks_count: 'forksCount'
          }),
          { op: 'pick', keys: ['id', 'name', 'path', 'full_path', 'kind'], path: 'namespace' },
          ...renames({ full_path: 'fullPath' }, 'namespace')
        ]
      },
      {
        type: 'listOpenMergeRequests',
        label: 'List open merge requests',
        description: 'The open merge requests of a project, most recently updated first.',
        idempotent: true,
        inputs: [
          PROJECT_INPUT,
          {
            key: 'limit',
            label: 'Maximum',
            type: 'number',
            description: 'How many to return, 1 to 100. Defaults to 20.',
            builderHint: 'Sent as per_page; 100 is the documented maximum.'
          },
          {
            key: 'targetBranch',
            label: 'Target branch',
            description: 'Only merge requests into this branch. Blank for all.'
          }
        ],
        outputs: [
          {
            key: 'items',
            description:
              'One entry per merge request: id, iid, projectId, title, description, state, draft, url, labels, author, assignees, sourceBranch, targetBranch, sha, createdAt, updatedAt, mergedAt, closedAt, hasConflicts, detailedMergeStatus'
          }
        ],
        sample: { project: 'gitlab-org/gitlab' },
        request: {
          url: `${API}/projects/{{args.project}}/merge_requests`,
          headers: AUTH_HEADERS,
          query: {
            state: 'opened',
            order_by: 'updated_at',
            sort: 'desc',
            per_page: '{{args.limit}}',
            target_branch: '{{args.targetBranch}}'
          }
        },
        // The response is a list, which the SDK hands back as `items`.
        postReceive: [{ op: 'map', ops: MERGE_REQUEST_SHAPE }]
      },
      {
        type: 'getIssue',
        label: 'Get an issue',
        description: 'Read one issue by its number.',
        idempotent: true,
        inputs: [
          PROJECT_INPUT,
          {
            key: 'iid',
            label: 'Issue number',
            type: 'number',
            required: true,
            description: 'The issue number shown in the project (its iid)'
          }
        ],
        outputs: [
          { key: 'id', type: 'number', description: 'Global issue id' },
          { key: 'iid', type: 'number', description: 'The number shown in the project' },
          { key: 'projectId', type: 'number', description: 'The project it belongs to' },
          { key: 'title', description: 'Issue title' },
          { key: 'description', description: 'Markdown body' },
          { key: 'state', description: 'opened or closed' },
          { key: 'url', description: 'Where to read it' },
          { key: 'labels', description: 'Label names' },
          { key: 'author', description: 'Who opened it, as {id, username, name}' },
          { key: 'assignees', description: 'Each as {id, username, name}' },
          { key: 'createdAt', description: 'When it was opened' },
          { key: 'updatedAt', description: 'When it last changed' },
          { key: 'closedAt', description: 'When it was closed, or null' },
          { key: 'issueType', description: 'issue, incident, test_case or task' },
          { key: 'confidential', type: 'boolean', description: 'Whether only members can see it' }
        ],
        sample: { project: 'gitlab-org/gitlab', iid: '1' },
        request: {
          url: `${API}/projects/{{args.project}}/issues/{{args.iid}}`,
          headers: AUTH_HEADERS
        },
        postReceive: ISSUE_SHAPE
      }
    ]
  })
}
