import { defineConnector, type ConnectorItem, type FetchContext } from '@vornrun/connector-sdk'
import {
  ambientToken,
  connect,
  createWorkItem,
  queryWorkItemIds,
  readWorkItems,
  updateWorkItem,
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
const DESCRIPTION_FIELD = 'System.Description'
const ASSIGNED_FIELD = 'System.AssignedTo'

/** The type every board has, so an action can be called without picking one. */
const DEFAULT_WORK_ITEM_TYPE = 'Task'

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
    // The Azure DevOps mark itself, rather than something board-shaped: a
    // connector people recognize at a glance is one they trust they picked
    // right.
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z'
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

          const wit = await connectionFor(organization, await getToken())
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
          const cfg = config as Record<string, unknown>
          const organization = required(cfg, 'organization', 'ADO_ORGANIZATION')
          const project = required(cfg, 'project', 'ADO_PROJECT')
          const id = Number(args.id)
          if (!Number.isInteger(id) || id <= 0) {
            throw new Error(`id must be a work item number, got ${JSON.stringify(args.id)}`)
          }

          const wit = await connectionFor(organization, await getToken())
          const item = await updateWorkItem(wit, {
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
