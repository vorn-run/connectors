import { defineConnector, type ConnectorItem, type FetchContext } from '@vornrun/connector-sdk'
import {
  ambientToken,
  connect,
  queryWorkItemIds,
  readWorkItems,
  workItemUrl,
  type WitApi
} from './client'

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

export type AdoConnectorOptions = {
  version?: string
  /** Injected in tests; production resolves an Entra token via @azure/identity. */
  getToken?: () => Promise<string>

  /** Injected in tests, so a fetch never needs a real organization. */
  connectImpl?: (organization: string, token: string) => Promise<WitApi>
}

function required(config: Record<string, unknown>, key: string, env: string): string {
  const value = String(config[key] ?? '').trim()
  if (!value) throw new Error(`${env} is required`)
  return value
}

export function createAdoConnector(options: AdoConnectorOptions = {}) {
  const getToken = options.getToken ?? ambientToken

  const connectTo = options.connectImpl ?? connect
  let cached: { organization: string; token: string; api: Promise<WitApi> } | undefined

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
  function connectionFor(organization: string, token: string): Promise<WitApi> {
    if (!cached || cached.organization !== organization || cached.token !== token) {
      cached = { organization, token, api: connectTo(organization, token) }
    }
    return cached.api
  }

  async function fetchWorkItems(context: FetchContext): Promise<ConnectorItem[]> {
    const config = context.config as Record<string, unknown>
    const organization = required(config, 'organization', 'ADO_ORGANIZATION')
    const project = required(config, 'project', 'ADO_PROJECT')
    const query = required(config, 'query', 'ADO_QUERY')
    const top = Number(config.top ?? DEFAULT_TOP) || DEFAULT_TOP

    const token = await getToken()
    const wit = await connectionFor(organization, token)
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
    description: 'Trigger workflows from the work items a WIQL query returns.',
    // Three stacked lanes with a card moving between them: a board.
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M4 4h5v16H4a1 1 0 01-1-1V5a1 1 0 011-1z',
        'M10.5 4h3v9h-3z',
        'M15 4h5a1 1 0 011 1v14a1 1 0 01-1 1h-5z'
      ]
    },
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
        required: true,
        description:
          'Work items to poll, e.g. SELECT [System.Id] FROM WorkItems ' +
          "WHERE [System.State] = 'New' ORDER BY [System.ChangedDate] DESC"
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
      }
    ]
  })
}
