/**
 * Linear's GraphQL API, called directly.
 *
 * Linear publishes `@linear/sdk`, and this deliberately does not use it. The
 * SDK is a generated client over the whole schema — megabytes of types for the
 * four queries and three mutations below — and `npx` pays that download on
 * every launch. The repo's rule is to prefer a maintained vendor client; this
 * is the exception it allows, recorded here so nobody has to guess whether it
 * was a decision.
 *
 * Every call takes `fetch` as an argument so tests never touch the network.
 */

const LINEAR_API = 'https://api.linear.app/graphql'

/** How long a single call may take before it is abandoned. */
const TIMEOUT_MS = 15_000

export type FetchLike = typeof fetch

export interface LinearIssue {
  id: string
  identifier: string
  title: string
  description: string | null
  url: string
  createdAt: string
  updatedAt: string
  state: { name: string; type: string }
  labels: { nodes: Array<{ name: string }> }
  assignee: { name: string } | null
  team: { key: string }
}

/** Fields every issue query selects, so one shape reaches every caller. */
export const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  createdAt
  updatedAt
  state { name type }
  labels { nodes { name } }
  assignee { name }
  team { key }
`

export interface GraphQLOptions {
  apiKey: string
  query: string
  variables?: Record<string, unknown>
  fetchImpl?: FetchLike
}

/**
 * Run one GraphQL call and hand back its data.
 *
 * GraphQL answers 200 with an `errors` array rather than a status code, so a
 * failure that only checked `res.ok` would read as success and then throw
 * somewhere further along on a missing field.
 */
export async function linearGraphQL<T>(options: GraphQLOptions): Promise<T> {
  const doFetch = options.fetchImpl ?? fetch
  const res = await doFetch(LINEAR_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: options.apiKey
    },
    body: JSON.stringify({ query: options.query, variables: options.variables ?? {} }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Linear API ${res.status}: ${body.slice(0, 200)}`)
  }

  const payload = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
  if (payload.errors?.length) {
    throw new Error(`Linear GraphQL error: ${payload.errors.map((e) => e.message).join('; ')}`)
  }
  if (!payload.data) throw new Error('Linear API returned no data')
  return payload.data
}

/** Look up an issue's internal id from the identifier people actually use. */
export async function resolveIssueId(
  apiKey: string,
  identifier: string,
  fetchImpl?: FetchLike
): Promise<string | null> {
  const data = await linearGraphQL<{ issues: { nodes: Array<{ id: string }> } }>({
    apiKey,
    ...(fetchImpl && { fetchImpl }),
    query: `query IssueIdByIdentifier($identifier: String!) {
       issues(filter: { identifier: { eq: $identifier } }, first: 1) { nodes { id } }
     }`,
    variables: { identifier }
  })
  return data.issues.nodes[0]?.id ?? null
}

/** An issue plus the team it belongs to, which closing it needs. */
export async function resolveIssueWithTeam(
  apiKey: string,
  identifier: string,
  fetchImpl?: FetchLike
): Promise<{ id: string; teamId: string; teamKey: string } | null> {
  const data = await linearGraphQL<{
    issues: { nodes: Array<{ id: string; team: { id: string; key: string } }> }
  }>({
    apiKey,
    ...(fetchImpl && { fetchImpl }),
    query: `query IssueWithTeam($identifier: String!) {
       issues(filter: { identifier: { eq: $identifier } }, first: 1) {
         nodes { id team { id key } }
       }
     }`,
    variables: { identifier }
  })
  const node = data.issues.nodes[0]
  return node ? { id: node.id, teamId: node.team.id, teamKey: node.team.key } : null
}

export async function resolveTeamId(
  apiKey: string,
  teamKey: string,
  fetchImpl?: FetchLike
): Promise<string | null> {
  const data = await linearGraphQL<{ teams: { nodes: Array<{ id: string }> } }>({
    apiKey,
    ...(fetchImpl && { fetchImpl }),
    query: `query TeamIdByKey($key: String!) {
       teams(filter: { key: { eq: $key } }, first: 1) { nodes { id } }
     }`,
    variables: { key: teamKey }
  })
  return data.teams.nodes[0]?.id ?? null
}

/**
 * The state an issue moves to when it is closed.
 *
 * Linear has no canonical "Done": each team configures its own states, and a
 * team may have several of completed type — Merged, Released, Shipped. The
 * lowest position is the one that reads as done, and the list is sorted here
 * as well as in the query because relying on a server's ordering for something
 * that decides where an issue lands is a bet not worth taking.
 */
export async function resolveCompletedStateId(
  apiKey: string,
  teamId: string,
  fetchImpl?: FetchLike
): Promise<string | null> {
  const data = await linearGraphQL<{
    workflowStates: { nodes: Array<{ id: string; type: string; position: number }> }
  }>({
    apiKey,
    ...(fetchImpl && { fetchImpl }),
    query: `query CompletedStates($teamId: ID!) {
       workflowStates(
         filter: { team: { id: { eq: $teamId } }, type: { eq: "completed" } }
         orderBy: position
         first: 50
       ) { nodes { id type position } }
     }`,
    variables: { teamId }
  })
  const nodes = data.workflowStates.nodes
  if (nodes.length === 0) return null
  return nodes.slice().sort((a, b) => a.position - b.position)[0].id
}
