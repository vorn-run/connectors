import { defineConnector, type ConnectorItem, type FetchContext } from '@vornrun/connector-sdk'
import {
  ambientToken,
  commentOnWorkItem,
  connect,
  createWorkItem,
  getWorkItem,
  queryWorkItemIds,
  readWorkItems,
  updateWorkItem,
  workItemUrl,
  type AdoApi
} from './client'
import {
  MERGE_STRATEGIES,
  THREAD_STATUSES,
  VOTES,
  comment,
  completePullRequest,
  createPullRequest,
  describePullRequest,
  findPullRequest,
  listActivePullRequests,
  listChanges,
  listThreads,
  pullRequestUrl,
  branchName,
  setThreadStatus,
  threadStatusName,
  vote,
  voteName,
  type PullRequest
} from './git'

const DEFAULT_TOP = 100

/**
 * Fields every item carries back, whatever the query selected.
 *
 * WIQL lets an author pick columns, but the connector still needs a title and
 * a state to present a row, so these are read explicitly rather than hoping
 * the query asked for them.
 */
const TITLE_FIELD = 'System.Title'
const STATE_FIELD = 'System.State'
const CHANGED_FIELD = 'System.ChangedDate'
const TYPE_FIELD = 'System.WorkItemType'
const DESCRIPTION_FIELD = 'System.Description'
const ASSIGNED_FIELD = 'System.AssignedTo'

/** The type every board has, so an action can be called without picking one. */
const DEFAULT_WORK_ITEM_TYPE = 'Task'

export type AdoConnectorOptions = {
  version?: string
  /** Injected in tests; production resolves an Entra token via @azure/identity. */
  getToken?: () => Promise<string>

  /** Injected in tests, so a fetch never needs a real organization. */
  connectImpl?: (organization: string, token: string) => Promise<AdoApi>
}

function required(config: Record<string, unknown>, key: string, env: string): string {
  const value = String(config[key] ?? '').trim()
  if (!value) throw new Error(`${env} is required`)
  return value
}

export function createAdoConnector(options: AdoConnectorOptions = {}) {
  const getToken = options.getToken ?? ambientToken

  const connectTo = options.connectImpl ?? connect
  let cached: { organization: string; token: string; api: Promise<AdoApi> } | undefined

  /**
   * One connection per organization, held until the token changes.
   *
   * `getWorkItemTrackingApi()` asks the location service where the API lives,
   * so connecting is a network round trip and doing it per poll is waste. It
   * cannot simply be cached forever either: `getBearerHandler` captures the
   * token it was given, so a connection kept past the token's hour would start
   * failing. Keying on the token gets both — `DefaultAzureCredential` returns
   * the same string until it nears expiry, and a new one invalidates this.
   */
  function connectionFor(organization: string, token: string): Promise<AdoApi> {
    if (!cached || cached.organization !== organization || cached.token !== token) {
      cached = { organization, token, api: connectTo(organization, token) }
    }
    return cached.api
  }

  /** The organization and project a step works in, and a live connection to them. */
  async function session(config: unknown) {
    const cfg = config as Record<string, unknown>
    const organization = required(cfg, 'organization', 'ADO_ORGANIZATION')
    const project = required(cfg, 'project', 'ADO_PROJECT')
    const api = await connectionFor(organization, await getToken())
    return { cfg, organization, project, api }
  }

  /**
   * The pull request a step names, looked up so its repository is known —
   * and, for a step that acts as someone, who is signed in, asked for at the
   * same time since neither answer waits on the other.
   */
  async function pullRequestFor(args: Record<string, unknown>, config: unknown, asUser = false) {
    const context = await session(config)
    const id = positiveId(args.pullRequestId, 'pullRequestId')
    const git = await context.api.git()
    const [pr, userId] = await Promise.all([
      findPullRequest(git, context.project, id),
      asUser ? context.api.userId() : Promise.resolve('')
    ])
    return { ...context, git, pr, userId }
  }

  async function fetchPullRequests(context: FetchContext): Promise<ConnectorItem[]> {
    const { cfg, organization, project, api } = await session(context.config)
    const top = Number(cfg.top ?? DEFAULT_TOP) || DEFAULT_TOP
    const pulls = await listActivePullRequests(await api.git(), {
      project,
      repository: text(cfg.repository),
      top
    })
    return pulls.map((pr) => pullRequestItem(organization, pr))
  }

  async function fetchWorkItems(context: FetchContext): Promise<ConnectorItem[]> {
    const { cfg, organization, project, api } = await session(context.config)
    const query = required(cfg, 'query', 'ADO_QUERY')
    const top = Number(cfg.top ?? DEFAULT_TOP) || DEFAULT_TOP

    const wit = await api.wit()
    const ids = await queryWorkItemIds(wit, { project, query, top })
    const items = await readWorkItems(wit, ids)

    return items.map((item) => {
      const fields = item.fields ?? {}
      if (item.id === undefined) {
        // Vorn dedupes on this. A placeholder id would collapse every such
        // work item into one event rather than surfacing the problem.
        throw new Error('Azure DevOps returned a work item with no id')
      }
      const id = item.id
      return {
        externalId: String(id),
        // The SDK returns the REST resource url; a person following the link
        // wants the board, so the browser url is built instead.
        url: workItemUrl(organization, project, id),
        title: String(fields[TITLE_FIELD] ?? `Work item ${id}`),
        description: String(fields['System.Description'] ?? ''),
        status: String(fields[STATE_FIELD] ?? ''),
        updatedAt: String(fields[CHANGED_FIELD] ?? new Date(0).toISOString()),
        labels: [String(fields[TYPE_FIELD] ?? '')].filter(Boolean)
      }
    })
  }

  return defineConnector({
    id: 'ado',
    name: 'Azure DevOps',
    ...(options.version && { version: options.version }),
    description:
      'Trigger workflows from work items and pull requests, and review, comment, vote and update from a step.',
    // The Azure DevOps mark itself, rather than something board-shaped: a
    // connector people recognize at a glance is one they trust they picked
    // right.
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z'
      ]
    },
    auth: { rung: 'cli', probe: { command: 'az', args: ['account', 'show'] } },
    config: [
      {
        key: 'organization',
        env: 'ADO_ORGANIZATION',
        label: 'Organization',
        required: true,
        description: 'Name or URL, e.g. "contoso" or https://dev.azure.com/contoso'
      },
      { key: 'project', env: 'ADO_PROJECT', label: 'Project', required: true },
      {
        key: 'query',
        env: 'ADO_QUERY',
        label: 'WIQL query',
        // Needed by the work item trigger only; a connection that watches pull
        // requests, or only runs actions, has no query to give.
        description:
          'Work items to poll, for the work item trigger, e.g. SELECT [System.Id] FROM WorkItems ' +
          "WHERE [System.State] = 'New' ORDER BY [System.ChangedDate] DESC"
      },
      {
        key: 'repository',
        env: 'ADO_REPOSITORY',
        label: 'Repository',
        description:
          'Repository name. Narrows the pull request trigger to it, and is where ' +
          'createPullRequest opens one. Blank watches every repository in the project.'
      },
      {
        key: 'top',
        env: 'ADO_TOP',
        label: 'Maximum per poll',
        default: String(DEFAULT_TOP),
        description: 'Upper bound on work items read in one poll.'
      }
    ],
    triggers: [
      {
        type: 'workItem',
        label: 'Work item matches the query',
        description: 'Fires once per work item the WIQL query newly returns.',
        // Work items carry System.ChangedDate, so the watermark advances on it
        // rather than re-reading everything the query still matches.
        dedupe: 'timestamp',
        fetch: fetchWorkItems
      },
      {
        type: 'pullRequestOpened',
        label: 'A pull request is opened',
        description:
          'Fires once for each active pull request opened since the last poll — the start of an automated review.',
        // Creation date, not a change date: the list API carries no "last
        // updated", and a review should start once per pull request rather
        // than on every reviewer's vote.
        dedupe: 'timestamp',
        fetch: fetchPullRequests
      }
    ],
    actions: [
      {
        type: 'createWorkItem',
        label: 'Create a work item',
        description: 'Add a work item to the board and return its id and url.',
        // Calling this twice makes two work items. An agent retrying a failed
        // step has no other way to know that.
        idempotent: false,
        inputs: [
          { key: 'title', label: 'Title', required: true },
          {
            key: 'type',
            label: 'Work item type',
            description: `Bug, Task, User Story… Defaults to ${DEFAULT_WORK_ITEM_TYPE}.`
          },
          { key: 'description', label: 'Description' },
          { key: 'assignedTo', label: 'Assign to', description: 'An email address.' },
          { key: 'project', label: 'Project', description: 'Defaults to ADO_PROJECT.' }
        ],
        outputs: [
          { key: 'id', type: 'number', description: 'Id of the work item created' },
          { key: 'url', description: 'Where to open it on the board' }
        ],
        async run(args, { config }) {
          const cfg = config as Record<string, unknown>
          const organization = required(cfg, 'organization', 'ADO_ORGANIZATION')
          const project = text(args.project) ?? required(cfg, 'project', 'ADO_PROJECT')
          const title = text(args.title)
          if (!title) throw new Error('title is required')

          const wit = await (await connectionFor(organization, await getToken())).wit()
          const item = await createWorkItem(wit, {
            project,
            type: text(args.type) ?? DEFAULT_WORK_ITEM_TYPE,
            fields: {
              [TITLE_FIELD]: title,
              [DESCRIPTION_FIELD]: text(args.description),
              [ASSIGNED_FIELD]: text(args.assignedTo)
            }
          })
          return describe(item, organization, project)
        }
      },
      {
        type: 'updateWorkItem',
        label: 'Update a work item',
        description: 'Change the title, state, description or assignee of a work item.',
        // Setting the same fields to the same values again lands the work item
        // in the same place, so a retry is safe.
        idempotent: true,
        inputs: [
          { key: 'id', label: 'Work item id', type: 'number', required: true },
          { key: 'title', label: 'Title' },
          { key: 'state', label: 'State', description: 'Active, Resolved, Closed…' },
          { key: 'description', label: 'Description' },
          { key: 'assignedTo', label: 'Assign to', description: 'An email address.' }
        ],
        outputs: [
          { key: 'id', type: 'number' },
          { key: 'url', description: 'Where to open it on the board' },
          { key: 'state', description: 'State after the update' }
        ],
        async run(args, { config }) {
          const id = positiveId(args.id, 'id')
          const { organization, project, api } = await session(config)
          const item = await updateWorkItem(await api.wit(), {
            id,
            fields: {
              [TITLE_FIELD]: text(args.title),
              [STATE_FIELD]: text(args.state),
              [DESCRIPTION_FIELD]: text(args.description),
              [ASSIGNED_FIELD]: text(args.assignedTo)
            }
          })
          return describe(item, organization, project)
        }
      },
      {
        type: 'getWorkItem',
        label: 'Read a work item',
        description: 'Every field of one work item, for a step that needs more than the trigger carried.',
        idempotent: true,
        inputs: [{ key: 'id', label: 'Work item id', type: 'number', required: true, description: 'The work item number.' }],
        outputs: [
          { key: 'id', type: 'number' },
          { key: 'url', description: 'Where to open it on the board' },
          { key: 'title' },
          { key: 'state' },
          { key: 'type', description: 'Bug, Task, User Story…' },
          { key: 'description', description: 'HTML, as the board stores it' },
          { key: 'assignedTo', description: 'Display name of the assignee, if any' },
          { key: 'fields', type: 'object', description: 'Every field, by reference name' }
        ],
        async run(args, { config }) {
          const { organization, project, api } = await session(config)
          const item = await getWorkItem(await api.wit(), positiveId(args.id, 'id'))
          const fields = item?.fields ?? {}
          const assignee = fields[ASSIGNED_FIELD] as { displayName?: string } | string | undefined
          return {
            ...describe(item ?? {}, organization, project),
            type: String(fields[TYPE_FIELD] ?? ''),
            description: String(fields[DESCRIPTION_FIELD] ?? ''),
            assignedTo: typeof assignee === 'object' ? (assignee?.displayName ?? '') : (assignee ?? ''),
            fields
          }
        }
      },
      {
        type: 'commentOnWorkItem',
        label: 'Comment on a work item',
        description: "Add a comment to a work item's discussion.",
        // Two identical calls make two comments.
        idempotent: false,
        inputs: [
          { key: 'id', label: 'Work item id', type: 'number', required: true, description: 'The work item number.' },
          {
            key: 'text',
            label: 'Comment',
            required: true,
            description: 'Plain text, or HTML for links and lists.'
          }
        ],
        outputs: [
          { key: 'commentId', type: 'number' },
          { key: 'url', description: 'The work item the comment is on' }
        ],
        async run(args, { config }) {
          const { organization, project, api } = await session(config)
          const id = positiveId(args.id, 'id')
          const posted = await commentOnWorkItem(await api.wit(), {
            project,
            id,
            text: requiredText(args.text, 'text')
          })
          return { commentId: posted?.id ?? 0, url: workItemUrl(organization, project, id) }
        }
      },
      {
        type: 'createPullRequest',
        label: 'Open a pull request',
        description: 'Open a pull request from a pushed branch, optionally linked to work items.',
        // A second identical call is refused: a branch pair has one active pull request.
        idempotent: false,
        inputs: [
          { key: 'sourceBranch', label: 'Branch', required: true, description: 'The pushed branch.' },
          {
            key: 'targetBranch',
            label: 'Into',
            description: "Defaults to the repository's default branch."
          },
          { key: 'title', label: 'Title', required: true, description: 'Pull request title.' },
          { key: 'description', label: 'Description', description: 'Markdown.' },
          {
            key: 'repository',
            label: 'Repository',
            description: 'Repository name. Defaults to ADO_REPOSITORY.'
          },
          { key: 'draft', label: 'Draft', type: 'boolean', description: 'Open it as a draft.' },
          {
            key: 'workItems',
            label: 'Work items',
            description: 'Comma-separated work item ids to link.'
          }
        ],
        outputs: [
          { key: 'id', type: 'number', description: 'The new pull request number' },
          { key: 'url', description: 'Where to review it' }
        ],
        async run(args, { config }) {
          const { cfg, organization, project, api } = await session(config)
          const repository = text(args.repository) ?? text(cfg.repository)
          if (!repository) throw new Error('repository is required: name it, or set ADO_REPOSITORY.')
          const pr = await createPullRequest(await api.git(), {
            project,
            repository,
            sourceBranch: requiredText(args.sourceBranch, 'sourceBranch'),
            targetBranch: text(args.targetBranch),
            title: requiredText(args.title, 'title'),
            description: text(args.description),
            isDraft: flag(args.draft),
            workItems: String(args.workItems ?? '')
              .split(',')
              .map((id) => id.trim().replace(/^#/, ''))
              .filter(Boolean)
          })
          return { id: pr?.pullRequestId ?? 0, url: pullRequestUrl(organization, pr ?? {}) }
        }
      },
      {
        type: 'getPullRequest',
        label: 'Read a pull request',
        description:
          'Title, description, branches, commits, merge status and every reviewer\'s vote.',
        idempotent: true,
        inputs: [PULL_REQUEST_INPUT],
        outputs: [
          { key: 'id', type: 'number' },
          { key: 'url', description: 'Where to review it' },
          { key: 'title' },
          { key: 'description' },
          { key: 'status', description: 'active, completed or abandoned' },
          { key: 'isDraft', type: 'boolean' },
          { key: 'repository' },
          { key: 'sourceBranch' },
          { key: 'targetBranch' },
          { key: 'author' },
          { key: 'mergeStatus', description: 'succeeded, conflicts, queued…' },
          { key: 'sourceCommit', description: 'Head of the branch being merged' },
          { key: 'targetCommit', description: 'Head of the branch merged into' },
          { key: 'reviewers', type: 'array', description: '{ name, vote, isRequired } for each' }
        ],
        async run(args, { config }) {
          const { organization, pr } = await pullRequestFor(args, config)
          return describePullRequest(organization, pr)
        }
      },
      {
        type: 'listPullRequestChanges',
        label: 'List the files a pull request changes',
        description:
          'Every changed path as of the latest push, with the two commits to diff between.',
        idempotent: true,
        inputs: [PULL_REQUEST_INPUT],
        outputs: [
          { key: 'files', type: 'array', description: '{ path, changeType, originalPath? } for each' },
          { key: 'count', type: 'number' },
          { key: 'sourceCommit', description: 'git diff <targetCommit> <sourceCommit> shows the change' },
          { key: 'targetCommit' }
        ],
        async run(args, { config }) {
          const { project, git, pr } = await pullRequestFor(args, config)
          const files = await listChanges(git, project, pr)
          return {
            files,
            count: files.length,
            sourceCommit: pr.lastMergeSourceCommit?.commitId ?? '',
            targetCommit: pr.lastMergeTargetCommit?.commitId ?? ''
          }
        }
      },
      {
        type: 'listPullRequestComments',
        label: 'Read the review discussion',
        description:
          'Comment threads on a pull request, most recently active first, with status and the line each is on — so a review does not repeat itself.',
        idempotent: true,
        inputs: [
          PULL_REQUEST_INPUT,
          {
            key: 'status',
            label: 'Only these statuses',
            description:
              'Comma-separated: active, fixed, wontFix, closed, byDesign. "active" is what triage wants. Blank reads every thread.'
          },
          {
            key: 'top',
            label: 'At most',
            type: 'number',
            description: 'Keep only the most recently active threads. Blank keeps every one that matched.'
          }
        ],
        outputs: [
          {
            key: 'threads',
            type: 'array',
            description:
              '{ id, status, filePath, line, updatedAt, comments: [{ id, author, content }] } for each; filePath and line are null off a file or line'
          },
          { key: 'count', type: 'number', description: 'Threads returned' },
          { key: 'total', type: 'number', description: 'Threads that matched, before top' }
        ],
        async run(args, { config }) {
          const statuses = threadStatuses(args.status)
          const top = optionalId(args.top, 'top')
          const { project, git, pr } = await pullRequestFor(args, config)
          const { threads, total } = await listThreads(git, project, pr, { statuses, top })
          return { threads, count: threads.length, total }
        }
      },
      {
        type: 'commentOnPullRequest',
        label: 'Comment on a pull request',
        description:
          'Start a thread on the overview or on a line of a file, or reply to an existing thread.',
        // Two identical calls make two comments.
        idempotent: false,
        inputs: [
          PULL_REQUEST_INPUT,
          { key: 'text', label: 'Comment', required: true, description: 'Markdown.' },
          {
            key: 'filePath',
            label: 'File',
            description: 'Path in the repository, e.g. /src/app.ts. Blank comments on the overview.'
          },
          {
            key: 'line',
            label: 'Line',
            type: 'number',
            description: 'Line in the new version of the file. Needs a file.'
          },
          {
            key: 'threadId',
            label: 'Reply to thread',
            type: 'number',
            description: 'A thread id from listPullRequestComments. Replies instead of starting a thread.'
          },
          {
            key: 'status',
            label: 'Thread status',
            type: 'select',
            options: THREAD_STATUS_OPTIONS,
            description: 'Defaults to active for a new thread; unchanged for a reply.'
          }
        ],
        outputs: [
          { key: 'threadId', type: 'number', description: 'Thread the comment is in' },
          { key: 'commentId', type: 'number' },
          { key: 'url', description: 'The thread, on the pull request' }
        ],
        async run(args, { config }) {
          const { organization, project, git, pr } = await pullRequestFor(args, config)
          const posted = await comment(git, project, pr, {
            text: requiredText(args.text, 'text'),
            filePath: text(args.filePath),
            line: optionalId(args.line, 'line'),
            threadId: optionalId(args.threadId, 'threadId'),
            status: threadStatus(args.status)
          })
          return {
            ...posted,
            url: `${pullRequestUrl(organization, pr)}?discussionId=${posted.threadId}`
          }
        }
      },
      {
        type: 'resolvePullRequestThread',
        label: 'Resolve a review thread',
        description: 'Mark a comment thread fixed, won\'t fix, closed, by design — or active again.',
        // Setting a thread to the status it already has leaves it there.
        idempotent: true,
        inputs: [
          PULL_REQUEST_INPUT,
          {
            key: 'threadId',
            label: 'Thread',
            type: 'number',
            required: true,
            description: 'A thread id from listPullRequestComments.'
          },
          {
            key: 'status',
            label: 'Status',
            type: 'select',
            options: THREAD_STATUS_OPTIONS,
            description: 'Defaults to fixed.'
          }
        ],
        outputs: [
          { key: 'threadId', type: 'number' },
          { key: 'status', description: 'Status after the change' }
        ],
        async run(args, { config }) {
          const { project, git, pr } = await pullRequestFor(args, config)
          const threadId = positiveId(args.threadId, 'threadId')
          const thread = await setThreadStatus(
            git,
            project,
            pr,
            threadId,
            threadStatus(args.status) ?? THREAD_STATUSES.fixed
          )
          return { threadId, status: threadStatusName(thread?.status) }
        }
      },
      {
        type: 'votePullRequest',
        label: 'Approve or reject a pull request',
        description:
          'Cast your vote as the signed-in identity: approve, approve with suggestions, wait for author, reject, or reset.',
        // A vote replaces your previous one, so casting it again changes nothing.
        idempotent: true,
        inputs: [
          PULL_REQUEST_INPUT,
          {
            key: 'vote',
            label: 'Vote',
            type: 'select',
            required: true,
            options: [
              { value: 'approve', label: 'Approve' },
              { value: 'approveWithSuggestions', label: 'Approve with suggestions' },
              { value: 'waitForAuthor', label: 'Wait for author' },
              { value: 'reject', label: 'Reject' },
              { value: 'reset', label: 'Reset vote' }
            ],
            description: 'Pair it with commentOnPullRequest to say why.'
          }
        ],
        outputs: [
          { key: 'vote', description: 'The vote now recorded' },
          { key: 'url', description: 'Where to review it' }
        ],
        async run(args, { config }) {
          const name = String(args.vote ?? '').trim()
          if (!(name in VOTES)) {
            throw new Error(`vote must be one of ${Object.keys(VOTES).join(', ')}, got "${name}"`)
          }
          const { organization, project, git, pr, userId } = await pullRequestFor(args, config, true)
          const cast = await vote(git, project, pr, userId, VOTES[name as keyof typeof VOTES])
          return { vote: voteName(cast?.vote), url: pullRequestUrl(organization, pr) }
        }
      },
      {
        type: 'completePullRequest',
        label: 'Complete (merge) a pull request',
        description:
          'Merge now, or set auto-complete so it merges itself once approvals and policies pass.',
        // Completing twice fails on the second call — there is nothing left to merge.
        idempotent: false,
        inputs: [
          PULL_REQUEST_INPUT,
          {
            key: 'autoComplete',
            label: 'Auto-complete',
            type: 'boolean',
            description:
              'Merge when every required approval and policy passes, rather than now. Recommended where approvals are required.'
          },
          {
            key: 'mergeStrategy',
            label: 'Merge type',
            type: 'select',
            options: [
              { value: 'squash', label: 'Squash commit' },
              { value: 'noFastForward', label: 'Merge (no fast-forward)' },
              { value: 'rebase', label: 'Rebase and fast-forward' },
              { value: 'rebaseMerge', label: 'Semi-linear merge' }
            ],
            description: 'Defaults to squash.'
          },
          {
            key: 'keepSourceBranch',
            label: 'Keep branch',
            type: 'boolean',
            description: 'Keep the source branch after merging. It is deleted by default.'
          },
          {
            key: 'transitionWorkItems',
            label: 'Close linked work items',
            type: 'boolean',
            description: 'Move linked work items to their completed state.'
          },
          { key: 'message', label: 'Merge commit message', description: 'Defaults to the one Azure DevOps writes.' },
          {
            key: 'commitId',
            label: 'Reviewed commit',
            description:
              'The sourceCommit a review step read, e.g. {{steps.getPullRequest.sourceCommit}}. Merging now is refused if the branch has moved past it. Blank merges the branch as it is when this step runs.'
          }
        ],
        outputs: [
          { key: 'status', description: 'completed when merged now; active while auto-complete waits' },
          { key: 'autoComplete', type: 'boolean', description: 'Whether auto-complete is set' },
          { key: 'mergeStatus', description: 'succeeded, conflicts, queued…' },
          { key: 'url', description: 'Where to review it' }
        ],
        async run(args, { config }) {
          const strategy = text(args.mergeStrategy) ?? 'squash'
          if (!(strategy in MERGE_STRATEGIES)) {
            throw new Error(
              `mergeStrategy must be one of ${Object.keys(MERGE_STRATEGIES).join(', ')}, got "${strategy}"`
            )
          }
          const { organization, project, git, pr, userId } = await pullRequestFor(args, config, true)
          const done = await completePullRequest(git, project, pr, userId, {
            commitId: text(args.commitId),
            autoComplete: flag(args.autoComplete),
            mergeStrategy: MERGE_STRATEGIES[strategy as keyof typeof MERGE_STRATEGIES],
            deleteSourceBranch: !flag(args.keepSourceBranch),
            transitionWorkItems: flag(args.transitionWorkItems),
            message: text(args.message)
          })
          const described = describePullRequest(organization, { ...pr, ...done })
          return {
            status: described.status,
            autoComplete: Boolean(done?.autoCompleteSetBy?.id),
            mergeStatus: described.mergeStatus,
            url: described.url
          }
        }
      }
    ]
  })
}

/** Trim an argument, treating blank as absent so it is left out of the patch. */
function text(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * What an action hands back to the step that called it.
 *
 * The board url rather than the API one, so `{{steps.createWorkItem.url}}` in a
 * message is a link somebody can follow.
 */
function describe(
  item: { id?: number; fields?: Record<string, unknown> },
  organization: string,
  project: string
): Record<string, unknown> {
  const id = item.id ?? 0
  return {
    id,
    url: workItemUrl(organization, project, id),
    title: String(item.fields?.[TITLE_FIELD] ?? ''),
    state: String(item.fields?.[STATE_FIELD] ?? '')
  }
}

/** Every pull request action names one the same way. */
const PULL_REQUEST_INPUT = {
  key: 'pullRequestId',
  label: 'Pull request',
  type: 'number' as const,
  required: true,
  description: 'The pull request number, e.g. {{trigger.item.externalId}}.'
}

const THREAD_STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'fixed', label: 'Resolved' },
  { value: 'wontFix', label: "Won't fix" },
  { value: 'closed', label: 'Closed' },
  { value: 'byDesign', label: 'By design' }
]

function threadStatus(value: unknown): number | undefined {
  const name = text(value)
  if (name === undefined) return undefined
  if (!(name in THREAD_STATUSES)) {
    throw new Error(
      `status must be one of ${Object.keys(THREAD_STATUSES).join(', ')}, got "${name}"`
    )
  }
  return THREAD_STATUSES[name as keyof typeof THREAD_STATUSES]
}

/** A boolean argument, which a template may still render as the text "true". */
function flag(value: unknown): boolean {
  return value === true || String(value ?? '').trim().toLowerCase() === 'true'
}

/** `active, fixed` → the statuses to keep; blank keeps all. */
function threadStatuses(value: unknown): number[] | undefined {
  const names = String(value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (names.length === 0) return undefined
  return names.map((name) => threadStatus(name) as number)
}

function requiredText(value: unknown, name: string): string {
  const found = text(value)
  if (!found) throw new Error(`${name} is required`)
  return found
}

/**
 * An id or line number, which must be a positive whole number. 0 and -1 are
 * numbers, so nothing upstream stops them, and the API's answer to either
 * talks about a malformed url rather than the argument.
 */
function positiveId(value: unknown, name: string): number {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`${name} must be a positive whole number, got ${JSON.stringify(value)}`)
  }
  return id
}

function optionalId(value: unknown, name: string): number | undefined {
  return text(value) === undefined ? undefined : positiveId(value, name)
}

/** A pull request as the trigger delivers it. */
function pullRequestItem(organization: string, pr: PullRequest): ConnectorItem {
  if (pr.pullRequestId === undefined) {
    // Vorn dedupes on this, as with work items.
    throw new Error('Azure DevOps returned a pull request with no id')
  }
  const created = pr.creationDate
  return {
    externalId: String(pr.pullRequestId),
    url: pullRequestUrl(organization, pr),
    title: pr.title ?? `Pull request ${pr.pullRequestId}`,
    description: pr.description ?? '',
    status: pr.isDraft ? 'draft' : 'active',
    updatedAt:
      created instanceof Date ? created.toISOString() : String(created ?? new Date(0).toISOString()),
    labels: (pr.labels ?? []).map((label) => label.name ?? '').filter(Boolean),
    ...(pr.createdBy?.displayName && { assignee: pr.createdBy.displayName }),
    data: {
      repository: pr.repository?.name ?? '',
      sourceBranch: branchName(pr.sourceRefName),
      targetBranch: branchName(pr.targetRefName),
      author: pr.createdBy?.displayName ?? '',
      isDraft: pr.isDraft === true
    }
  }
}
