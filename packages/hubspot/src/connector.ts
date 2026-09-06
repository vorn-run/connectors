import {
  defineConnector,
  type ConnectorConfig,
  type ConnectorItem,
  type FetchContext
} from '@vornrun/connector-sdk'
import {
  API_ROOT,
  CRM_PATH,
  MAX_SEARCH_LIMIT,
  createHubSpotClient,
  type CrmRecord,
  type SearchBody
} from './client'
import {
  DEFAULT_PROPERTIES,
  NOTE_ASSOCIATION_TYPE_IDS,
  SAMPLE_COMPANY,
  SAMPLE_CONTACT,
  SAMPLE_DEAL,
  createdToItem,
  epochMillis,
  filter,
  modifiedAt,
  property,
  recordOutput,
  stageToItem,
  type ObjectType,
  type SearchFilter
} from './items'
// Bundled at build time: a pack is one file, so a version read from disk is not there to read.
import pkg from '../package.json'

export interface HubSpotConnectorOptions {
  version?: string
  /** Where live samples are read from; defaults to the process environment. */
  env?: NodeJS.ProcessEnv
  /** Replaced in tests so a rate-limit wait costs no real time. */
  sleep?: (ms: number) => Promise<void>
  /** The clock rate-limit windows are measured by, in milliseconds. */
  now?: () => number
  random?: () => number
}

// How far back the very first poll looks, before any watermark exists.
const FIRST_POLL_LOOKBACK_MS = 60 * 60_000

// How far back every stage-change poll looks: the SDK remembers the ids it delivered, so the window need only cover a few polls.
export const STAGE_LOOKBACK_MS = 60 * 60_000

// "It may take a few moments for newly created or updated CRM objects to appear in search results".
export const INDEXING_MARGIN_MS = 30_000

const POLL_PAGE_SIZE = 100

function text(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim()
  return trimmed || undefined
}

function required(config: ConnectorConfig, key: string, env: string): string {
  const value = text(config[key])
  if (value === undefined) throw new Error(`${env} is required`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A json input arrives parsed from the harness and as text from a direct call; both are read.
function parsed(value: unknown, key: string): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${key} must be JSON`)
  }
}

// HubSpot stores every property as a string, so numbers and booleans are written out and nulls dropped.
export function propertiesArg(value: unknown, key = 'properties'): Record<string, string> {
  if (value === undefined || value === '') return {}
  const object = parsed(value, key)
  if (!isRecord(object)) throw new Error(`${key} must be a JSON object of property values keyed by property name`)
  const out: Record<string, string> = {}
  for (const [name, entry] of Object.entries(object)) {
    if (entry === undefined || entry === null) continue
    out[name] = typeof entry === 'string' ? entry : isRecord(entry) || Array.isArray(entry) ? JSON.stringify(entry) : String(entry)
  }
  return out
}

// Property names as one comma-separated line, trimmed and without blanks.
export function namesArg(value: unknown): string[] {
  const raw = text(value)
  if (raw === undefined) return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

// Filter groups as the search API takes them; a bare filter is a group of one, and an empty object is no filter.
export function filterGroupsArg(value: unknown): Array<{ filters: SearchFilter[] }> | undefined {
  if (value === undefined || value === '') return undefined
  const raw = parsed(value, 'filterGroups')
  const entries = Array.isArray(raw) ? raw : [raw]
  const groups: Array<{ filters: SearchFilter[] }> = []
  for (const entry of entries) {
    if (!isRecord(entry)) throw new Error('filterGroups must be a JSON array of { filters: [...] } groups')
    if (Array.isArray(entry.filters)) groups.push(entry as { filters: SearchFilter[] })
    else if (typeof entry.propertyName === 'string') groups.push({ filters: [entry as unknown as SearchFilter] })
    else if (Object.keys(entry).length > 0) throw new Error('filterGroups must be a JSON array of { filters: [...] } groups')
  }
  return groups.length > 0 ? groups : undefined
}

// A whole number within the search API's bounds; unset stays unset so the API applies its own default.
export function count(value: unknown, key: string, max?: number): number | undefined {
  if (value === undefined || value === '') return undefined
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || (max !== undefined && number > max)) {
    const bound = max === undefined ? 'of at least 1' : `from 1 to ${max}`
    throw new Error(`${key} must be a whole number ${bound}, got "${String(value)}"`)
  }
  return number
}

export function isEmail(value: string): boolean {
  return value.includes('@')
}

const PROPERTIES_INPUT = (what: string, required = false) => ({
  key: 'properties',
  label: 'Properties',
  type: 'json' as const,
  required,
  description: `A JSON object of ${what} keyed by internal property name, e.g. {"lifecyclestage":"customer"}.`,
  builderHint:
    'Sent as the properties object of the JSON body; values are written as strings because HubSpot stores every property as one, and a name the account lacks answers 400 VALIDATION_ERROR.'
})

const OWNER_INPUT = {
  key: 'ownerId',
  label: 'Owner',
  description: 'The owner id from listOwners, its id rather than its userId.',
  builderHint: 'Sent as hubspot_owner_id; a userId in its place answers 400 VALIDATION_ERROR.'
}

const PROPERTY_NAMES_INPUT = {
  key: 'properties',
  label: 'Properties to return',
  description: 'Comma-separated internal property names to return; blank returns the standard set.',
  builderHint: 'Sent as the properties list; a name the account lacks is ignored rather than refused.'
}

const AFTER_INPUT = {
  key: 'after',
  label: 'After',
  description: 'The paging.next.after cursor from an earlier page.',
  builderHint: 'Sent as after; HubSpot wants a numeric string and refuses paging past 10,000 results with 400.'
}

const RECORD_OUTPUTS = [
  { key: 'id', description: 'Record id, a numeric string' },
  { key: 'properties', description: 'The properties HubSpot returned, every value a string or null' },
  { key: 'createdAt', description: 'When the record was created, ISO 8601' },
  { key: 'updatedAt', description: 'When the record last changed, ISO 8601' },
  { key: 'archived', type: 'boolean' as const, description: 'Whether the record is archived' }
]

const OBJECT_TYPE_OPTIONS = [
  { value: 'contact', label: 'Contact' },
  { value: 'company', label: 'Company' },
  { value: 'deal', label: 'Deal' }
]

export function createHubSpotConnector(options: HubSpotConnectorOptions = {}) {
  const env = options.env ?? process.env
  const clock = options.now ?? Date.now

  function client(context: { config: ConnectorConfig; fetch: typeof fetch }) {
    return createHubSpotClient({
      accessToken: required(context.config, 'accessToken', 'HUBSPOT_ACCESS_TOKEN'),
      fetch: context.fetch,
      now: clock,
      ...(options.sleep && { sleep: options.sleep }),
      ...(options.random && { random: options.random })
    })
  }

  // The watermark, or the hour before now on the very first poll rather than the account's whole history.
  function windowOf(context: FetchContext, lookback?: number): { since: string; until: number } {
    const nowMs = Date.parse(context.now())
    const since =
      lookback !== undefined || context.since === undefined
        ? String(nowMs - (lookback ?? FIRST_POLL_LOOKBACK_MS))
        : epochMillis(context.since)
    return { since, until: nowMs - INDEXING_MARGIN_MS }
  }

  // Everything changed at or after the watermark on the cursor property, oldest first, up to ten pages of 100.
  async function searchSince(
    context: FetchContext,
    objectType: ObjectType,
    cursorProperty: string,
    extra: SearchFilter[],
    lookback?: number
  ): Promise<{ records: CrmRecord[]; until: number }> {
    const { since, until } = windowOf(context, lookback)
    const body: SearchBody = {
      filterGroups: [{ filters: [filter(cursorProperty, 'GTE', since), ...extra] }],
      sorts: [{ propertyName: cursorProperty, direction: 'ASCENDING' }],
      properties: [...DEFAULT_PROPERTIES[objectType], ...namesArg(context.config.properties)],
      limit: POLL_PAGE_SIZE
    }
    return { records: await client(context).search(objectType, body), until }
  }

  // A record HubSpot indexed in the last half minute waits for the next poll, so the watermark never passes what search has not shown yet.
  function settled(records: CrmRecord[], until: number, stamp: (record: CrmRecord) => string): CrmRecord[] {
    return records.filter((record) => !(Date.parse(stamp(record)) > until))
  }

  function pipelineFilters(config: ConnectorConfig, withStage: boolean): SearchFilter[] {
    const filters: SearchFilter[] = []
    const pipeline = text(config.pipeline)
    if (pipeline !== undefined) filters.push(filter('pipeline', 'EQ', pipeline))
    const stage = withStage ? text(config.dealstage) : undefined
    if (stage !== undefined) filters.push(filter('dealstage', 'EQ', stage))
    return filters
  }

  function fetchCreated(objectType: ObjectType, extra: (config: ConnectorConfig) => SearchFilter[] = () => []) {
    return async (context: FetchContext): Promise<ConnectorItem[]> => {
      const { records, until } = await searchSince(context, objectType, 'createdate', extra(context.config))
      const portalId = text(context.config.portalId)
      return settled(records, until, (record) => property(record, 'createdate') ?? record.createdAt ?? '').map((record) =>
        createdToItem(record, { objectType, portalId })
      )
    }
  }

  // Windowed on the clock rather than the watermark: the items carry no time, so the SDK keeps their ids instead of a boundary.
  async function fetchStageChanges(context: FetchContext): Promise<ConnectorItem[]> {
    const { records, until } = await searchSince(context, 'deals', 'hs_lastmodifieddate', pipelineFilters(context.config, true), STAGE_LOOKBACK_MS)
    const portalId = text(context.config.portalId)
    return settled(records, until, modifiedAt).map((record) => stageToItem(record, portalId))
  }

  // Live samples come from the environment; without them the actions that need a real id are left out of the live run.
  const sampleContact = text(env.HUBSPOT_CONTACT_ID)
  const sampleCompany = text(env.HUBSPOT_COMPANY_ID)

  return defineConnector({
    id: 'hubspot',
    name: 'HubSpot',
    version: options.version ?? pkg.version,
    description:
      'Trigger workflows from new HubSpot contacts, companies and deals or deal stage changes, and create, update, search, annotate or associate CRM records from a step.',
    // HubSpot's sprocket: the hub ring with three spokes ending in nodes.
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M9.8 14a5.2 5.2 0 1 0 10.4 0a5.2 5.2 0 1 0 -10.4 0zM12.4 14a2.6 2.6 0 1 1 5.2 0a2.6 2.6 0 1 1 -5.2 0zM4.85 4.62L10.97 11.07L12.28 9.83L6.15 3.38zM3.9 4a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0zM7.59 21.68L11.91 17.9L10.72 16.55L6.41 20.32zM5.7 21a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0 -2.6 0zM2.96 14.4L10.07 14.7L10.14 12.9L3.04 12.6zM1.7 13.5a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0 -2.6 0z'
      ]
    },
    auth: { rung: 'key', keys: ['accessToken'] },
    config: [
      {
        key: 'accessToken',
        env: 'HUBSPOT_ACCESS_TOKEN',
        label: 'Private app access token',
        secret: true,
        required: true,
        description:
          'The access token of a private app from Settings, Integrations, Private Apps, with the crm.objects.contacts, crm.objects.companies and crm.objects.deals read and write scopes, crm.objects.owners.read and crm.schemas.deals.read.',
        builderHint:
          'Sent as Authorization: Bearer on every call. A wrong or revoked token answers 401; a token missing a scope answers 403 MISSING_SCOPES naming the scope. There is no HubSpot CLI to borrow a CRM login from.'
      },
      {
        key: 'portalId',
        env: 'HUBSPOT_PORTAL_ID',
        label: 'Portal id',
        description: 'The account number in the app.hubspot.com URL, used to give each item a link to open the record. Blank leaves items without a URL.',
        builderHint: 'No API answer carries it, so the record URL https://app.hubspot.com/contacts/{portalId}/record/{objectTypeId}/{id} can only be built when it is set.'
      },
      {
        key: 'properties',
        env: 'HUBSPOT_PROPERTIES',
        label: 'Extra properties',
        description: 'Comma-separated internal property names every trigger fetches on top of the standard set.',
        builderHint: 'Appended to the search body’s properties list; HubSpot ignores a name the account lacks.'
      },
      {
        key: 'pipeline',
        env: 'HUBSPOT_PIPELINE',
        label: 'Deal pipeline',
        description: 'A pipeline id from listDealPipelines; the deal triggers then watch only that pipeline. Blank watches every pipeline.',
        builderHint: 'Adds { propertyName: "pipeline", operator: "EQ" } to the deal searches; the default pipeline’s id is "default".'
      },
      {
        key: 'dealstage',
        env: 'HUBSPOT_DEAL_STAGE',
        label: 'Deal stage',
        description: 'A stage id such as closedwon or a numeric custom stage id; the stage-changed trigger then fires only for deals reaching it.',
        builderHint: 'Adds { propertyName: "dealstage", operator: "EQ" } to the stage-changed search only; stage ids come from listDealPipelines.'
      }
    ],
    triggers: [
      {
        type: 'newContact',
        label: 'A contact is created',
        description: 'Fires once for each contact created since the last poll, oldest first.',
        dedupe: 'timestamp',
        fetch: fetchCreated('contacts'),
        defaultWorkflow: { name: 'HubSpot: new contacts', defaultCronFromMinutes: 5 },
        sample: [createdToItem(SAMPLE_CONTACT, { objectType: 'contacts' })]
      },
      {
        type: 'newDeal',
        label: 'A deal is created',
        description: 'Fires once for each deal created since the last poll, oldest first, in the configured pipeline or in all of them.',
        dedupe: 'timestamp',
        fetch: fetchCreated('deals', (config) => pipelineFilters(config, false)),
        defaultWorkflow: { name: 'HubSpot: new deals', defaultCronFromMinutes: 5 },
        sample: [createdToItem(SAMPLE_DEAL, { objectType: 'deals' })]
      },
      {
        type: 'newCompany',
        label: 'A company is created',
        description: 'Fires once for each company created since the last poll, oldest first.',
        dedupe: 'timestamp',
        fetch: fetchCreated('companies'),
        defaultWorkflow: { name: 'HubSpot: new companies', defaultCronFromMinutes: 5 },
        sample: [createdToItem(SAMPLE_COMPANY, { objectType: 'companies' })]
      },
      {
        type: 'dealStageChanged',
        label: 'A deal moves to a stage',
        description:
          'Fires once per deal and stage when a deal is found at a stage it has not fired for; a deal edited without changing stage is dropped. Filter by pipeline and stage in the settings.',
        dedupe: 'timestamp',
        fetch: fetchStageChanges,
        defaultWorkflow: { name: 'HubSpot: deal stage changes', defaultCronFromMinutes: 5 },
        sample: [stageToItem(SAMPLE_DEAL)]
      }
    ],
    actions: [
      {
        type: 'createContact',
        label: 'Create a contact',
        description: 'Add a contact by email. An email that already exists answers 409 with the existing id in the message.',
        // A repeat answers 409 CONFLICT rather than a second contact, but the call is still not one to retry blindly.
        idempotent: false,
        inputs: [
          {
            key: 'email',
            label: 'Email',
            required: true,
            description: 'The contact’s email address, HubSpot’s unique identifier for contacts.',
            builderHint: 'Sent as properties.email; a duplicate answers 409 CONFLICT "Contact already exists. Existing ID: <id>", which the thrown message carries.'
          },
          { key: 'firstname', label: 'First name', description: 'First name.', builderHint: 'Sent as properties.firstname.' },
          { key: 'lastname', label: 'Last name', description: 'Last name.', builderHint: 'Sent as properties.lastname.' },
          { key: 'phone', label: 'Phone', description: 'Phone number.', builderHint: 'Sent as properties.phone, unformatted.' },
          {
            key: 'company',
            label: 'Company',
            description: 'Company name, as a text property on the contact rather than an association.',
            builderHint: 'Sent as properties.company; use associate to link the contact to a company record.'
          },
          PROPERTIES_INPUT('extra properties to set')
        ],
        outputs: RECORD_OUTPUTS,
        async run(args, context) {
          const properties = {
            ...propertiesArg(args.properties),
            email: String(args.email),
            ...(text(args.firstname) && { firstname: text(args.firstname) }),
            ...(text(args.lastname) && { lastname: text(args.lastname) }),
            ...(text(args.phone) && { phone: text(args.phone) }),
            ...(text(args.company) && { company: text(args.company) })
          }
          return recordOutput(await client(context).createObject('contacts', { properties }))
        }
      },
      {
        type: 'updateContact',
        label: 'Update a contact',
        description: 'Set the given properties of a contact and leave the rest as they were.',
        // Harmless to repeat with real values, but the mock check sends placeholders, so it is kept out of the live run.
        idempotent: false,
        inputs: [
          {
            key: 'contactId',
            label: 'Contact',
            required: true,
            description: 'The contact’s record id, such as 33451.',
            builderHint: 'Sent URL-encoded as the path segment of PATCH /crm/v3/objects/contacts/{id}; an unknown id answers 404 OBJECT_NOT_FOUND.'
          },
          PROPERTIES_INPUT('properties to set', true)
        ],
        outputs: RECORD_OUTPUTS,
        async run(args, context) {
          const record = await client(context).updateObject('contacts', String(args.contactId), {
            properties: propertiesArg(args.properties)
          })
          return recordOutput(record)
        }
      },
      {
        type: 'createDeal',
        label: 'Create a deal',
        description: 'Add a deal at a stage of a pipeline. Every call makes a new deal.',
        idempotent: false,
        inputs: [
          { key: 'dealname', label: 'Deal name', required: true, description: 'The deal’s name.', builderHint: 'Sent as properties.dealname.' },
          {
            key: 'dealstage',
            label: 'Stage',
            required: true,
            description: 'A stage id from listDealPipelines, such as appointmentscheduled or closedwon in the default pipeline; custom stages are numeric.',
            builderHint: 'Sent as properties.dealstage; a stage outside the chosen pipeline answers 400 VALIDATION_ERROR.'
          },
          {
            key: 'pipeline',
            label: 'Pipeline',
            description: 'A pipeline id from listDealPipelines. Blank uses the default pipeline.',
            builderHint: 'Sent as properties.pipeline when set; "If a pipeline isn’t specified, the default pipeline will be used".'
          },
          {
            key: 'amount',
            label: 'Amount',
            type: 'number',
            description: 'The deal amount in the account’s currency.',
            builderHint: 'Sent as properties.amount written out as a decimal string such as 1500.00.'
          },
          {
            key: 'closedate',
            label: 'Close date',
            description: 'The expected close date as an ISO 8601 instant, such as 2019-12-07T16:50:06.678Z.',
            builderHint: 'Sent as properties.closedate; HubSpot answers it back in the same form.'
          },
          OWNER_INPUT,
          PROPERTIES_INPUT('extra properties to set')
        ],
        outputs: RECORD_OUTPUTS,
        async run(args, context) {
          const amount = text(args.amount)
          const properties = {
            ...propertiesArg(args.properties),
            dealname: String(args.dealname),
            dealstage: String(args.dealstage),
            ...(text(args.pipeline) && { pipeline: text(args.pipeline) }),
            ...(amount && { amount }),
            ...(text(args.closedate) && { closedate: text(args.closedate) }),
            ...(text(args.ownerId) && { hubspot_owner_id: text(args.ownerId) })
          }
          return recordOutput(await client(context).createObject('deals', { properties }))
        }
      },
      {
        type: 'updateDeal',
        label: 'Update a deal',
        description: 'Set the given properties of a deal, such as {"dealstage":"closedwon"}, and leave the rest as they were.',
        idempotent: false,
        inputs: [
          {
            key: 'dealId',
            label: 'Deal',
            required: true,
            description: 'The deal’s record id.',
            builderHint: 'Sent URL-encoded as the path segment of PATCH /crm/v3/objects/deals/{id}; an unknown id answers 404 OBJECT_NOT_FOUND.'
          },
          PROPERTIES_INPUT('properties to set', true)
        ],
        outputs: RECORD_OUTPUTS,
        async run(args, context) {
          const record = await client(context).updateObject('deals', String(args.dealId), {
            properties: propertiesArg(args.properties)
          })
          return recordOutput(record)
        }
      },
      {
        type: 'createCompany',
        label: 'Create a company',
        description: 'Add a company by name, with its domain when known. Every call makes a new company.',
        idempotent: false,
        inputs: [
          { key: 'name', label: 'Name', required: true, description: 'The company name.', builderHint: 'Sent as properties.name.' },
          {
            key: 'domain',
            label: 'Domain',
            description: 'The website domain such as hubspot.com, HubSpot’s unique identifier for companies.',
            builderHint: 'Sent as properties.domain; HubSpot does not refuse a duplicate domain, so a repeat makes a second company.'
          },
          PROPERTIES_INPUT('extra properties to set')
        ],
        outputs: RECORD_OUTPUTS,
        async run(args, context) {
          const properties = {
            ...propertiesArg(args.properties),
            name: String(args.name),
            ...(text(args.domain) && { domain: text(args.domain) })
          }
          return recordOutput(await client(context).createObject('companies', { properties }))
        }
      },
      {
        type: 'createNote',
        label: 'Add a note to a record',
        description: 'Attach a note to a contact, company or deal, stamped with the current time.',
        idempotent: false,
        inputs: [
          {
            key: 'objectType',
            label: 'Record type',
            type: 'select',
            required: true,
            options: OBJECT_TYPE_OPTIONS,
            description: 'What the note is attached to: contact, company or deal.',
            builderHint: 'Picks the association type id of the note: 202 to a contact, 190 to a company, 214 to a deal.'
          },
          {
            key: 'objectId',
            label: 'Record',
            required: true,
            description: 'The record id to attach the note to.',
            builderHint: 'Sent as associations[0].to.id; an unknown id answers 400 VALIDATION_ERROR.'
          },
          {
            key: 'body',
            label: 'Note',
            required: true,
            description: 'The note text, up to 65,536 characters.',
            builderHint: 'Sent as properties.hs_note_body; hs_timestamp is filled with the current instant because HubSpot requires it.'
          },
          OWNER_INPUT
        ],
        outputs: RECORD_OUTPUTS,
        async run(args, context) {
          const objectType = String(args.objectType)
          const associationTypeId = NOTE_ASSOCIATION_TYPE_IDS[objectType]
          if (associationTypeId === undefined) {
            throw new Error(`objectType must be one of contact, company or deal, got "${objectType}"`)
          }
          const record = await client(context).createObject('notes', {
            properties: {
              hs_timestamp: context.now(),
              hs_note_body: String(args.body),
              ...(text(args.ownerId) && { hubspot_owner_id: text(args.ownerId) })
            },
            associations: [
              {
                to: { id: String(args.objectId) },
                types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId }]
              }
            ]
          })
          return recordOutput(record)
        }
      },
      {
        type: 'associate',
        label: 'Associate two records',
        description: 'Link two records with the default association for their types, or with a labelled type id.',
        // A PUT states the association; a repeat answers the same record.
        idempotent: true,
        inputs: [
          {
            key: 'fromObjectType',
            label: 'From type',
            required: true,
            description: 'contact, company, deal or note, or an object type id such as 0-1.',
            builderHint: 'Sent URL-encoded as the first path segment of PUT /crm/v4/objects/{from}/{id}/associations/...'
          },
          { key: 'fromObjectId', label: 'From record', required: true, description: 'The record id to link from.', builderHint: 'Sent URL-encoded as the second path segment.' },
          {
            key: 'toObjectType',
            label: 'To type',
            required: true,
            description: 'contact, company, deal or note, or an object type id.',
            builderHint: 'Sent URL-encoded after /associations/default/ or /associations/ when a type id is given.'
          },
          { key: 'toObjectId', label: 'To record', required: true, description: 'The record id to link to.', builderHint: 'Sent URL-encoded as the last path segment.' },
          {
            key: 'associationTypeId',
            label: 'Association type id',
            type: 'number',
            description: 'A labelled type id such as 1 for a contact’s primary company. Blank uses the default association for the two types.',
            builderHint: 'When set the labelled form is used: PUT .../associations/{to}/{toId} with body [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId }]; the defaults are contact→company 279, company→contact 280, contact→deal 4, deal→contact 3, deal→company 341, company→deal 342.'
          }
        ],
        outputs: [
          { key: 'fromObjectTypeId', description: 'The from record’s object type id, such as 0-1' },
          { key: 'fromObjectId', description: 'The from record id' },
          { key: 'toObjectTypeId', description: 'The to record’s object type id, such as 0-3' },
          { key: 'toObjectId', description: 'The to record id' },
          { key: 'labels', description: 'The association labels now in place, such as ["Point of contact"]' }
        ],
        ...(sampleContact &&
          sampleCompany && {
            sample: { fromObjectType: 'contact', fromObjectId: sampleContact, toObjectType: 'company', toObjectId: sampleCompany }
          }),
        async run(args, context) {
          const typeId = count(args.associationTypeId, 'associationTypeId')
          const result = await client(context).associate(
            { type: String(args.fromObjectType), id: String(args.fromObjectId) },
            { type: String(args.toObjectType), id: String(args.toObjectId) },
            typeId
          )
          return {
            fromObjectTypeId: result.fromObjectTypeId ?? '',
            fromObjectId: result.fromObjectId ?? String(args.fromObjectId),
            toObjectTypeId: result.toObjectTypeId ?? '',
            toObjectId: result.toObjectId ?? String(args.toObjectId),
            labels: Array.isArray(result.labels) ? result.labels : []
          }
        }
      },
      {
        type: 'getContact',
        label: 'Get a contact',
        description: 'Read one contact by record id or by email address.',
        idempotent: true,
        inputs: [
          {
            key: 'contactId',
            label: 'Contact',
            required: true,
            description: 'The contact’s record id, or an email address to look it up by.',
            builderHint: 'A value with an @ is sent as GET /crm/v3/objects/contacts/{email}?idProperty=email; anything else as the record id. An unknown one answers 404 OBJECT_NOT_FOUND.'
          },
          PROPERTY_NAMES_INPUT
        ],
        outputs: RECORD_OUTPUTS,
        ...(sampleContact && { sample: { contactId: sampleContact } }),
        async run(args, context) {
          const contactId = String(args.contactId)
          const names = namesArg(args.properties)
          const record = await client(context).getObject('contacts', contactId, {
            properties: (names.length > 0 ? names : DEFAULT_PROPERTIES.contacts).join(','),
            ...(isEmail(contactId) && { idProperty: 'email' })
          })
          return recordOutput(record)
        }
      },
      {
        type: 'searchContacts',
        label: 'Search contacts',
        description: 'Find contacts by free text or by filter groups, one page at a time.',
        idempotent: true,
        inputs: [
          {
            key: 'query',
            label: 'Query',
            description: 'Text matched against the default searchable properties: name, email, phone and company.',
            builderHint: 'Sent as query, at most 3,000 characters; archived contacts are excluded from search.'
          },
          {
            key: 'filterGroups',
            label: 'Filter groups',
            type: 'json',
            description: 'A JSON array of { "filters": [{ "propertyName", "operator", "value" }] } groups exactly as the search API takes them; groups are ORed and filters within one ANDed.',
            builderHint: 'Sent as filterGroups, at most 5 groups of 6 filters; a bare filter object is taken as a group of one. Date values are epoch milliseconds as strings.'
          },
          PROPERTY_NAMES_INPUT,
          {
            key: 'limit',
            label: 'Limit',
            type: 'number',
            description: 'Contacts per page, 1 to 200. Defaults to 10.',
            builderHint: 'Sent as limit; the search API is limited to five requests per second and 10,000 results per query.'
          },
          AFTER_INPUT
        ],
        outputs: [
          { key: 'total', type: 'number', description: 'How many contacts match in all' },
          { key: 'contacts', description: 'The page of matching records, each { id, properties, createdAt, updatedAt, archived }' },
          { key: 'nextAfter', description: 'Pass back as after to fetch the next page; empty on the last one' }
        ],
        sample: { query: 'test' },
        async run(args, context) {
          const names = namesArg(args.properties)
          const page = await client(context).searchPage('contacts', {
            query: text(args.query),
            filterGroups: filterGroupsArg(args.filterGroups),
            properties: names.length > 0 ? names : DEFAULT_PROPERTIES.contacts,
            limit: count(args.limit, 'limit', MAX_SEARCH_LIMIT),
            after: text(args.after)
          })
          return {
            total: page.total ?? 0,
            contacts: (page.results ?? []).map(recordOutput),
            nextAfter: page.paging?.next?.after ?? ''
          }
        }
      },
      {
        type: 'listDealPipelines',
        label: 'List deal pipelines',
        description: 'The deal pipelines of the account with their stages.',
        idempotent: true,
        inputs: [],
        outputs: [
          {
            key: 'pipelines',
            description: 'One entry per pipeline: id, label, displayOrder, archived, stages [{ id, label, displayOrder, metadata: { probability } }]'
          }
        ],
        sample: {},
        request: {
          url: `${API_ROOT}${CRM_PATH}/pipelines/deals`,
          headers: { Authorization: 'Bearer {{config.accessToken}}' }
        },
        postReceive: [
          { op: 'rename', from: 'results', to: 'pipelines' },
          { op: 'pick', keys: ['pipelines'] }
        ]
      },
      {
        type: 'listOwners',
        label: 'List owners',
        description: 'The users who can own records, with the id to assign a record by.',
        idempotent: true,
        inputs: [
          {
            key: 'email',
            label: 'Email',
            description: 'Only the owner with this email address.',
            builderHint: 'Sent as the email query parameter; the answer is then a list of one or none.'
          },
          {
            key: 'limit',
            label: 'Limit',
            type: 'number',
            description: 'Owners per page. Defaults to 100.',
            builderHint: 'Sent as the limit query parameter.'
          },
          { ...AFTER_INPUT, builderHint: 'Sent as the after query parameter; the answer’s paging.next.after names the next page.' },
          {
            key: 'archived',
            label: 'Archived',
            type: 'boolean',
            description: 'List deactivated users instead of active ones.',
            builderHint: 'Sent as the archived query parameter.'
          }
        ],
        outputs: [
          {
            key: 'owners',
            description: 'One entry per owner: id, email, firstName, lastName, userId, type, archived, createdAt, updatedAt, teams; assign records by id, never userId'
          },
          { key: 'paging', description: 'Present when another page exists, as { next: { after } }' }
        ],
        sample: {},
        request: {
          url: `${API_ROOT}${CRM_PATH}/owners`,
          headers: { Authorization: 'Bearer {{config.accessToken}}' },
          query: {
            email: '{{args.email}}',
            limit: '{{args.limit}}',
            after: '{{args.after}}',
            archived: '{{args.archived}}'
          }
        },
        postReceive: [
          { op: 'rename', from: 'results', to: 'owners' },
          { op: 'pick', keys: ['owners', 'paging'] }
        ]
      }
    ]
  })
}

export const connector = createHubSpotConnector()
