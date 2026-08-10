/**
 * Azure Data Explorer queries, through Microsoft's own client.
 *
 * `azure-kusto-data` replaced a hand-rolled v1 REST call. The v1 endpoint was
 * adequate for reading a whole result set, but three things it left to us are
 * worth having done properly:
 *
 * - **The token scope.** We assumed `<cluster>/.default`, which is right for
 *   the public cloud and wrong elsewhere. The SDK asks the cluster for its own
 *   `KustoServiceResourceId` and authority, so a sovereign or air-gapped
 *   cluster authenticates without the connector knowing anything about it.
 * - **Typed values.** v1 hands back datetimes as strings with a variable number
 *   of fractional digits, and dynamic columns as JSON text. The SDK parses both.
 * - **Token acquisition and caching**, which was ours to get right and is now
 *   `withTokenCredential` plus the SDK's own cache.
 *
 * Marginal cost is small, since `@azure/identity` was already a dependency and
 * is the bulk of the install.
 *
 * What stays here is the part the SDK does not do: completing a bare cluster
 * name, digging the real message out of a failed query, and building records
 * that survive a column called `__proto__`.
 */

/** Minimal shape of an Entra credential, so tests can supply their own. */
export interface TokenCredentialLike {
  getToken(
    scopes: string | string[],
    options?: unknown
  ): Promise<{ token: string; expiresOnTimestamp: number } | null>
}

/** Accepts `help`, `help.kusto.windows.net`, or a full https URL. */
export function normalizeClusterUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('Kusto cluster is empty')
  if (/^http:\/\//i.test(trimmed)) {
    // Every request carries an Entra bearer token, so plaintext is refused
    // rather than silently upgraded — a misconfigured cluster should be a
    // setup error, not a token on the wire.
    throw new Error(`Kusto cluster must use https, got "${trimmed}"`)
  }
  if (/^https:\/\//i.test(trimmed)) return trimmed
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new Error(`Kusto cluster must be a cluster name or an https URL, got "${trimmed}"`)
  }
  // A bare name is by far the most common way people refer to a cluster, and
  // the regional suffix is not guessable, so only the well-known public form
  // is completed for them.
  if (trimmed.includes('.')) return `https://${trimmed}`
  return `https://${trimmed}.kusto.windows.net`
}

/**
 * The slice of the SDK's client this connector uses.
 *
 * Declared structurally so a test can inject a fake without standing up a real
 * KustoClient, and so the surface actually depended upon is visible in one
 * place.
 */
export interface ResultRowLike {
  getValueAt(index: number): unknown
}

export interface ResultTableLike {
  columns: { name: string | null }[]
  rows(): Iterable<ResultRowLike>
}

export interface KustoClientLike {
  executeQuery(
    database: string,
    query: string,
    properties?: unknown
  ): Promise<{ primaryResults: ResultTableLike[] }>
}

/**
 * Connect to a cluster with an Entra credential.
 *
 * Kusto has no personal-access-token equivalent, and none is wanted: a token
 * minted from the signed-in credential expires on its own and carries that
 * person's real permissions. The SDK holds the credential and refreshes on its
 * own schedule, which is why callers keep the client rather than reconnecting.
 *
 * The SDK is loaded lazily so that importing the connector — which
 * `vorn-connector check` and the unit tests both do — never pulls it in.
 */
export async function connect(
  clusterUrl: string,
  credential: TokenCredentialLike
): Promise<KustoClientLike> {
  const { Client, KustoConnectionStringBuilder } = await import('azure-kusto-data')
  const connection = KustoConnectionStringBuilder.withTokenCredential(
    clusterUrl,
    credential as never
  )
  return new Client(connection) as unknown as KustoClientLike
}

/* v8 ignore next 3 -- both halves are tested; composing them reaches the network */
export async function ambientClient(clusterUrl: string): Promise<KustoClientLike> {
  return connect(clusterUrl, await defaultCredential())
}

let cachedCredential: TokenCredentialLike | undefined

/**
 * The ambient Azure credential.
 *
 * `DefaultAzureCredential` walks the usual chain — environment service
 * principal, workload identity, managed identity, Azure CLI, Azure Developer
 * CLI — so a developer who has run `az login` and a service running under a
 * managed identity both work without the connector knowing which one it got.
 * Imported lazily so importing the connector never pulls in the identity chain.
 */
export async function defaultCredential(): Promise<TokenCredentialLike> {
  if (!cachedCredential) {
    const { DefaultAzureCredential } = await import('@azure/identity')
    cachedCredential = new DefaultAzureCredential() as unknown as TokenCredentialLike
  }
  return cachedCredential
}

/**
 * Bind values as real KQL query parameters.
 *
 * The query text is user-supplied, so the poll window is never interpolated
 * into it: that would be a KQL injection with the connector's credentials
 * behind it.
 */
export async function toRequestProperties(
  parameters: Record<string, string | number> | undefined
): Promise<unknown> {
  if (!parameters || Object.keys(parameters).length === 0) return undefined
  const { ClientRequestProperties } = await import('azure-kusto-data')
  const properties = new ClientRequestProperties()
  for (const [name, value] of Object.entries(parameters)) {
    properties.setParameter(name, value)
  }
  return properties
}

export interface KustoTable {
  columns: string[]
  /** One null-prototype record per row, keyed by column name. */
  records: Record<string, unknown>[]
}

/**
 * Turn a row into a keyed object using the table's column names.
 *
 * Null-prototype, because the query author picks the column names: on a plain
 * object a column projected as `__proto__` would set the record's prototype
 * instead of becoming a property, so the value would vanish from the item and
 * the record would carry whatever the row supplied. The SDK's own
 * `KustoResultRow` assigns columns onto the row object and has exactly that
 * hole, which is why records are built here rather than taken from `toJSON()`.
 */
export function rowToRecord(columns: string[], values: unknown[]): Record<string, unknown> {
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  columns.forEach((column, index) => {
    record[column] = values[index]
  })
  return record
}

/** Flatten a primary result table into column names and null-prototype rows. */
export function tableToRecords(table: ResultTableLike): KustoTable {
  const columns = table.columns.map((column, index) => column?.name ?? `Column${index}`)
  const records: Record<string, unknown>[] = []
  for (const row of table.rows()) {
    records.push(rowToRecord(columns, columns.map((_, index) => row.getValueAt(index))))
  }
  return { columns, records }
}

export interface KustoQueryOptions {
  database: string
  query: string
  /** Bound as KQL query parameters, never interpolated into the query text. */
  parameters?: Record<string, string | number>
}

export async function runKustoQuery(
  client: KustoClientLike,
  options: KustoQueryOptions
): Promise<KustoTable> {
  let response
  try {
    response = await client.executeQuery(
      options.database,
      options.query,
      await toRequestProperties(options.parameters)
    )
  } catch (error) {
    explain(error)
  }

  // A query returns its own result first, then tables describing the run. The
  // SDK separates them, but an empty list would otherwise index to undefined.
  const table = response.primaryResults?.[0]
  if (!table) throw new Error('Kusto returned no tables')
  return tableToRecords(table)
}

/**
 * Re-throw an SDK failure as something that names the cause.
 *
 * Two shapes matter. A failed query arrives as an axios error whose message is
 * only "Request failed with status code 400" — Kusto nests the useful text
 * several levels inside the response body. A failed sign-in arrives as
 * KustoAuthenticationError, where the actionable part is which credential to
 * set up, not the chain's internal complaint.
 */
function explain(error: unknown): never {
  const detail = kustoErrorMessage(error)
  if (detail) throw new Error(`Kusto query failed: ${detail}`, { cause: error })

  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof Error && error.name === 'KustoAuthenticationError') {
    throw new Error(
      `Could not get an Azure token for Kusto. Sign in with \`az login\`, or set ` +
        `AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_CLIENT_SECRET for a service principal. ` +
        `(${message})`,
      { cause: error }
    )
  }
  throw error instanceof Error ? error : new Error(message)
}

/**
 * Kusto repeats a generic message at the top of an error and puts the specific
 * one — the column that does not exist, the syntax it choked on — underneath.
 */
export function kustoErrorMessage(error: unknown): string | undefined {
  const body = (
    error as {
      response?: { data?: unknown }
    }
  )?.response?.data
  const parsed = (typeof body === 'string' ? safeParse(body) : body) as
    | {
        error?: { message?: string; '@message'?: string; innererror?: { message?: string } }
      }
    | undefined
  const wrapper = parsed?.error
  if (!wrapper) return undefined
  return wrapper.innererror?.message ?? wrapper['@message'] ?? wrapper.message
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
