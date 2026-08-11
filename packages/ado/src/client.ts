import * as azdev from 'azure-devops-node-api'

/**
 * Azure DevOps work item queries, through Microsoft's own client.
 *
 * `azure-devops-node-api` is used rather than raw REST because this connector
 * will grow past work items — comments, pull requests, pipelines — and each of
 * those is another versioned endpoint whose paging and error shapes somebody
 * would otherwise have to re-derive. The trade is a ~5MB dependency, which
 * `npx` caches once per version rather than paying per launch.
 *
 * What the SDK does not do is batch: getWorkItems has a server-side cap, so
 * that logic stays here.
 */

/**
 * The Azure DevOps resource in Entra ID. A token for anything else is not
 * rejected cleanly — the service answers with a sign-in page rather than a
 * 401 — so this value is pinned in a test.
 */
export const ADO_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default'

/** The API caps a single work-item read; larger queries are read in pages. */
const BATCH_LIMIT = 200

export type WorkItem = {
  id?: number
  url?: string
  fields?: Record<string, unknown>
}

/**
 * The slice of the SDK's WorkItemTracking API this connector uses.
 *
 * Declared structurally so a test can supply a fake without standing up a
 * WebApi, and so the surface actually depended upon is visible in one place.
 */
export type WitApi = {
  queryByWiql(
    wiql: { query: string },
    teamContext?: { project?: string },
    timePrecision?: boolean,
    top?: number
  ): Promise<{ workItems?: { id?: number }[] }>
  getWorkItems(ids: number[]): Promise<WorkItem[]>
  createWorkItem(
    customHeaders: unknown,
    document: JsonPatchOperation[],
    project: string,
    type: string
  ): Promise<WorkItem>
  updateWorkItem(
    customHeaders: unknown,
    document: JsonPatchOperation[],
    id: number
  ): Promise<WorkItem>
}

/**
 * How Azure DevOps takes a write.
 *
 * Work items are edited with a JSON Patch document rather than a body of
 * fields, which is what makes a partial update possible at all: the request
 * says which fields to touch and leaves everything else alone.
 */
export interface JsonPatchOperation {
  op: 'add' | 'replace' | 'remove'
  path: string
  value?: unknown
}

/**
 * Turn a map of fields into the patch the API expects.
 *
 * `add` rather than `replace` throughout: on a work item being created there is
 * nothing to replace, and on an existing one Azure DevOps treats `add` on a
 * field that is already set as an overwrite. `replace` would fail on any field
 * that happened to be empty.
 */
export function fieldPatch(fields: Record<string, unknown>): JsonPatchOperation[] {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([field, value]) => ({
      op: 'add' as const,
      // A field reference name is a path segment, and one containing a slash
      // would otherwise be read as two.
      path: `/fields/${field.replace(/~/g, '~0').replace(/\//g, '~1')}`,
      value
    }))
}

/** Organization name from either a bare name or the URL people paste. */
export function organizationName(organization: string): string {
  return organization
    .trim()
    .replace(/^https?:\/\/dev\.azure\.com\//i, '')
    .replace(/\/+$/, '')
}

export function organizationUrl(organization: string): string {
  return `https://dev.azure.com/${encodeURIComponent(organizationName(organization))}`
}

/** Where a person clicking a result should land. */
export function workItemUrl(organization: string, project: string, id: number): string {
  return `${organizationUrl(organization)}/${encodeURIComponent(project.trim())}/_workitems/edit/${id}`
}

/** The part of the SDK's WebApi used to reach the work-item API. */
export type Connection = { getWorkItemTrackingApi(): Promise<unknown> }

/**
 * Build a connection to an organization from an Entra bearer token.
 *
 * Deliberately `getBearerHandler` and not `getPersonalAccessTokenHandler`: a
 * PAT is a long-lived secret that has to be pasted into a config file, and one
 * most organizations now issue for days at a time or refuse outright. The token
 * here comes from whoever is signed in and expires on its own.
 */
export function createConnection(organization: string, token: string): Connection {
  return new azdev.WebApi(organizationUrl(organization), azdev.getBearerHandler(token))
}

/**
 * Resolve the work-item API for an organization.
 *
 * `getWorkItemTrackingApi()` asks the location service where the API actually
 * lives, so this is a network round trip — which is why callers hold on to the
 * result rather than connecting per request.
 */
export async function witApi(connection: Connection): Promise<WitApi> {
  return (await connection.getWorkItemTrackingApi()) as WitApi
}

/* v8 ignore next 3 -- both halves are tested; composing them reaches the network */
export async function connect(organization: string, token: string): Promise<WitApi> {
  return witApi(createConnection(organization, token))
}

/** Minimal shape of an Entra credential, so tests can supply their own. */
export interface TokenCredentialLike {
  getToken(scope: string): Promise<{ token: string } | null>
}

let cachedCredential: TokenCredentialLike | undefined

/**
 * The ambient Azure credential.
 *
 * `DefaultAzureCredential` walks the usual chain — environment service
 * principal, workload identity, managed identity, Azure CLI, Azure Developer
 * CLI — so a developer who has run `az login` and a service running under a
 * managed identity both work without the connector knowing which one it got.
 * Imported lazily so `vorn-connector check` can validate the manifest on a
 * machine that has never signed in to Azure.
 */
export async function defaultCredential(): Promise<TokenCredentialLike> {
  if (!cachedCredential) {
    const { DefaultAzureCredential } = await import('@azure/identity')
    cachedCredential = new DefaultAzureCredential() as unknown as TokenCredentialLike
  }
  return cachedCredential
}

/** Acquire a token for Azure DevOps, or explain how to get one. */
export async function entraToken(credential: TokenCredentialLike): Promise<string> {
  const token = await credential.getToken(ADO_SCOPE)
  if (!token?.token) {
    throw new Error(
      'No Azure credential was available for Azure DevOps. Sign in with `az login`, or set ' +
        'AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_CLIENT_SECRET for a service principal.'
    )
  }
  return token.token
}

/* v8 ignore next 3 -- both halves are tested; composing them reaches the network */
export async function ambientToken(): Promise<string> {
  return entraToken(await defaultCredential())
}

/**
 * Re-throw an SDK failure as something that names the likely cause.
 *
 * A token for the wrong resource does not come back as 401: Azure DevOps
 * serves an HTML sign-in page, which surfaces from the client as a parse error
 * about an unexpected `<`. That sends people looking at their query rather
 * than their credentials.
 */
function explain(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (/<!DOCTYPE|<html|Unexpected token|non-JSON|203/i.test(message)) {
    throw new Error(
      'Azure DevOps returned a sign-in page rather than data: the token is not valid for this ' +
        'organization. Check `az login` and that the signed-in account can see it.'
    )
  }
  throw error instanceof Error ? error : new Error(message)
}

/** Run a WIQL query and return the ids it matched. */
export async function queryWorkItemIds(
  wit: WitApi,
  opts: { project: string; query: string; top: number }
): Promise<number[]> {
  try {
    const result = await wit.queryByWiql(
      { query: opts.query },
      { project: opts.project },
      undefined,
      opts.top
    )
    return (result.workItems ?? [])
      .map((w) => w.id)
      .filter((id): id is number => typeof id === 'number')
  } catch (error) {
    explain(error)
  }
}

/** Read the fields of the ids a query returned, in pages the API accepts. */
export async function readWorkItems(wit: WitApi, ids: number[]): Promise<WorkItem[]> {
  if (ids.length === 0) return []

  const items: WorkItem[] = []
  try {
    for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
      items.push(...(await wit.getWorkItems(ids.slice(i, i + BATCH_LIMIT))))
    }
  } catch (error) {
    explain(error)
  }
  return items
}

/**
 * Create a work item.
 *
 * Never idempotent: calling it twice makes two work items, which is why the
 * action declares itself as such and an agent retrying a failed step is told.
 */
export async function createWorkItem(
  wit: WitApi,
  opts: { project: string; type: string; fields: Record<string, unknown> }
): Promise<WorkItem> {
  try {
    return await wit.createWorkItem(null, fieldPatch(opts.fields), opts.project, opts.type)
  } catch (error) {
    explain(error)
  }
}

/** Change fields on an existing work item, leaving the rest alone. */
export async function updateWorkItem(
  wit: WitApi,
  opts: { id: number; fields: Record<string, unknown> }
): Promise<WorkItem> {
  const patch = fieldPatch(opts.fields)
  if (patch.length === 0) {
    // An empty patch is accepted and changes nothing, which reads in a run as
    // a step that worked. It did not do what it was asked.
    throw new Error('No fields to update. Set at least one of title, state or description.')
  }
  try {
    return await wit.updateWorkItem(null, patch, opts.id)
  } catch (error) {
    explain(error)
  }
}
