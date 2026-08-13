import { defineConnector, type ConnectorItem, type PollContext } from '@vornrun/connector-sdk'
import {
  createGitHubClient,
  type GitHubClient,
  type GitHubClientOptions
} from './client'
import {
  GITHUB_POLL_PAGE_SIZE,
  assertCompleteSearch,
  buildSearchQuery,
  issueSort,
  nextSearchCursor,
  parsePollCursor,
  type GitHubIssue,
  type GitHubSearchResponse
} from './search'

export interface GitHubConnectorOptions extends GitHubClientOptions {
  version?: string
  /** Injected in tests so no client is built and nothing spawns `gh`. */
  client?: GitHubClient
  now?: () => string
}

/** Read an argument as trimmed text, treating blank and absent the same. */
function text(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim()
  return trimmed || undefined
}

function required(config: Record<string, unknown>, key: string, env: string): string {
  const value = String(config[key] ?? '').trim()
  if (!value) throw new Error(`${env} is required`)
  return value
}

/** Map a GitHub issue or pull request onto the shape Vorn indexes. */
export function issueToItem(issue: GitHubIssue): ConnectorItem {
  return {
    externalId: String(issue.number),
    title: issue.title,
    url: issue.html_url,
    description: issue.body ?? '',
    status: issue.state,
    updatedAt: issue.updated_at,
    data: {
      labels: issue.labels?.map((label) => label.name) ?? [],
      ...(issue.assignee?.login && { assignee: issue.assignee.login }),
      createdAt: issue.created_at
    }
  }
}

export function createGitHubConnector(options: GitHubConnectorOptions = {}) {
  const now = options.now ?? (() => new Date().toISOString())
  let cached: GitHubClient | undefined
  const client = (): GitHubClient => options.client ?? (cached ??= createGitHubClient(options))

  /**
   * One search page, translated into a poll outcome.
   *
   * Both triggers are the same request with a different `is:` term, so they
   * share this rather than each growing its own copy of the cursor handling —
   * which is the part that is easy to get subtly wrong.
   */
  async function pollSearch(
    kind: 'issue' | 'pr',
    context: PollContext,
    labels?: unknown
  ): Promise<{ items: ConnectorItem[]; nextCursor: string; hasMore: boolean }> {
    const config = context.config as Record<string, unknown>
    const owner = required(config, 'owner', 'GITHUB_OWNER')
    const repo = required(config, 'repo', 'GITHUB_REPO')

    // Same clock for both: the default cursor is derived from "a minute ago",
    // and reading that from a different source than pollStartedAt would make
    // the two disagree in tests and drift under a mocked clock.
    const cursor = parsePollCursor(context.cursor, () => Date.parse(now()))
    const pollStartedAt = now()
    const q = buildSearchQuery(owner, repo, kind, cursor, labels)

    const response = await client().run(async (api) => {
      const result = await api.rest.search.issuesAndPullRequests({
        q,
        sort: issueSort,
        order: 'asc',
        per_page: GITHUB_POLL_PAGE_SIZE,
        page: cursor.page
      })
      return result.data as unknown as GitHubSearchResponse
    })

    assertCompleteSearch(response)
    const next = nextSearchCursor(cursor, response, pollStartedAt)
    return {
      items: response.items.map(issueToItem),
      nextCursor: next.cursor,
      hasMore: next.hasMore
    }
  }

  return defineConnector({
    id: 'github',
    name: 'GitHub',
    ...(options.version && { version: options.version }),
    description:
      'Trigger workflows from GitHub issues and pull requests, and open, close or comment on them from a step.',
    // GitHub's own mark.
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12'
      ]
    },
    // No credential field. `gh` owns the token, which is the point: nothing to
    // paste, nothing stored here, and it expires and renews on its own.
    config: [
      {
        key: 'owner',
        env: 'GITHUB_OWNER',
        label: 'Owner',
        required: true,
        description: 'User or organisation, e.g. vorn-run'
      },
      {
        key: 'repo',
        env: 'GITHUB_REPO',
        label: 'Repository',
        required: true,
        description: 'Repository name on its own, without the owner'
      },
      {
        key: 'labels',
        env: 'GITHUB_LABELS',
        label: 'Filter issues by label',
        description: 'Comma-separated. Applies to the issue trigger only.'
      }
    ],
    triggers: [
      {
        type: 'issueCreated',
        label: 'An issue is created',
        description: 'Fires for each issue opened since the last poll.',
        // Hand-written rather than declarative: GitHub search pages by an
        // opaque {since, page} cursor and caps results at 1,000, which
        // "give me everything since X" cannot express. See search.ts.
        poll: (context) => pollSearch('issue', context, (context.config as Record<string, unknown>).labels),
        statusMapping: [
          { upstream: 'open', suggestedLocal: 'todo' },
          { upstream: 'closed', suggestedLocal: 'done' }
        ],
        defaultWorkflow: { name: 'GitHub: issues', defaultCronFromMinutes: 5 }
      },
      {
        type: 'prOpened',
        label: 'A pull request is opened',
        description: 'Fires for each pull request opened since the last poll.',
        // Labels deliberately not applied: the filter is described as an issue
        // filter, and silently narrowing pull requests by it would be a
        // surprise no field on the form explains.
        poll: (context) => pollSearch('pr', context),
        statusMapping: [
          { upstream: 'open', suggestedLocal: 'todo' },
          { upstream: 'closed', suggestedLocal: 'done' }
        ],
        defaultWorkflow: { name: 'GitHub: pull requests', defaultCronFromMinutes: 5 }
      }
    ],
    actions: [
      {
        type: 'createIssue',
        label: 'Create an issue',
        description: 'Open a new issue in the connected repository.',
        // Two identical calls make two issues; GitHub offers no idempotency key.
        idempotent: false,
        inputs: [
          { key: 'title', label: 'Title', required: true },
          { key: 'body', label: 'Body' },
          { key: 'labels', label: 'Labels', description: 'Comma-separated' }
        ],
        outputs: [
          { key: 'number', type: 'number', description: 'The new issue number' },
          { key: 'url', description: 'Where to read it' }
        ],
        async run(args, { config }) {
          const cfg = config as Record<string, unknown>
          const owner = required(cfg, 'owner', 'GITHUB_OWNER')
          const repo = required(cfg, 'repo', 'GITHUB_REPO')
          const body = text(args.body)
          const labels = String(args.labels ?? '')
            .split(',')
            .map((label) => label.trim())
            .filter(Boolean)
          const issue = await client().run(async (api) =>
            api.rest.issues.create({
              owner,
              repo,
              title: requiredArg(args.title, 'title'),
              ...(body && { body }),
              ...(labels.length > 0 && { labels })
            })
          )
          return { number: issue.data.number, url: issue.data.html_url }
        }
      },
      {
        type: 'closeIssue',
        label: 'Close an issue',
        description: 'Close an issue or pull request in the connected repository.',
        // Closing an already-closed issue leaves it closed.
        idempotent: true,
        inputs: [{ key: 'number', label: 'Issue #', required: true }],
        outputs: [
          { key: 'number', type: 'number' },
          { key: 'url', description: 'Where to read it' }
        ],
        async run(args, { config }) {
          const cfg = config as Record<string, unknown>
          const owner = required(cfg, 'owner', 'GITHUB_OWNER')
          const repo = required(cfg, 'repo', 'GITHUB_REPO')
          const issue = await client().run(async (api) =>
            api.rest.issues.update({
              owner,
              repo,
              issue_number: issueNumber(args.number),
              state: 'closed'
            })
          )
          return { number: issue.data.number, url: issue.data.html_url }
        }
      },
      {
        type: 'commentOnIssue',
        label: 'Comment on an issue',
        description: 'Post a comment on an issue or pull request.',
        // Two identical calls make two comments.
        idempotent: false,
        inputs: [
          { key: 'number', label: 'Issue #', required: true },
          { key: 'body', label: 'Comment', required: true }
        ],
        outputs: [{ key: 'url', description: 'Where to read the comment' }],
        async run(args, { config }) {
          const cfg = config as Record<string, unknown>
          const owner = required(cfg, 'owner', 'GITHUB_OWNER')
          const repo = required(cfg, 'repo', 'GITHUB_REPO')
          const comment = await client().run(async (api) =>
            api.rest.issues.createComment({
              owner,
              repo,
              issue_number: issueNumber(args.number),
              body: requiredArg(args.body, 'body')
            })
          )
          return { url: comment.data.html_url }
        }
      }
    ]
  })
}

/**
 * Coerce an issue number, which arrives as a string because Vorn renders
 * action arguments from templates. Rejected here rather than sent, so a
 * mistyped `{{...}}` names itself instead of returning a 404 from GitHub.
 */
/** An action argument that must be present, named when it is not. */
export function requiredArg(value: unknown, name: string): string {
  const found = text(value)
  if (!found) throw new Error(`${name} is required`)
  return found
}

export function issueNumber(value: unknown): number {
  const parsed = Number(String(value ?? '').trim().replace(/^#/, ''))
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Issue number must be a positive integer, got "${String(value)}"`)
  }
  return parsed
}
