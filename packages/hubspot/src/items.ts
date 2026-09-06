import type { ConnectorItem } from '@vornrun/connector-sdk'
import type { CrmRecord } from './client'

export type ObjectType = 'contacts' | 'companies' | 'deals'

// The object type ids the record URL and the associations API name each object by.
export const OBJECT_TYPE_IDS: Record<ObjectType, string> = {
  contacts: '0-1',
  companies: '0-2',
  deals: '0-3'
}

// HubSpot's own default property set per object, asked for explicitly so a search answer is never bare.
export const DEFAULT_PROPERTIES: Record<ObjectType, string[]> = {
  contacts: ['createdate', 'email', 'firstname', 'lastname', 'phone', 'company', 'lifecyclestage', 'hs_object_id', 'lastmodifieddate'],
  deals: ['dealname', 'amount', 'closedate', 'pipeline', 'dealstage', 'hubspot_owner_id', 'createdate', 'hs_lastmodifieddate', 'hs_object_id'],
  companies: ['name', 'domain', 'createdate', 'hs_lastmodifieddate', 'hs_object_id']
}

// The association type id of a note attached to each object, from the associations reference.
export const NOTE_ASSOCIATION_TYPE_IDS: Record<string, number> = {
  contact: 202,
  company: 190,
  deal: 214
}

export function property(record: CrmRecord, name: string): string | undefined {
  const value = record.properties?.[name]
  return value === null || value === undefined || value === '' ? undefined : String(value)
}

// Records open in the account's UI, which only the portal id from the settings can name.
export function recordUrl(portalId: string | undefined, objectType: ObjectType, id: string): string | undefined {
  if (!portalId || !id) return undefined
  return `https://app.hubspot.com/contacts/${encodeURIComponent(portalId)}/record/${OBJECT_TYPE_IDS[objectType]}/${encodeURIComponent(id)}`
}

export function contactTitle(record: CrmRecord): string {
  const name = [property(record, 'firstname'), property(record, 'lastname')].filter(Boolean).join(' ')
  const email = property(record, 'email')
  if (name && email) return `${name} <${email}>`
  return name || email || record.id
}

export function dealTitle(record: CrmRecord): string {
  const name = property(record, 'dealname') ?? record.id
  const detail = [property(record, 'dealstage'), property(record, 'amount')].filter(Boolean).join(', ')
  return detail ? `${name} (${detail})` : name
}

export function companyTitle(record: CrmRecord): string {
  const name = property(record, 'name')
  const domain = property(record, 'domain')
  if (name && domain) return `${name} (${domain})`
  return name || domain || record.id
}

export interface ItemScope {
  objectType: ObjectType
  portalId?: string
}

function recordData(record: CrmRecord): Record<string, unknown> {
  return {
    id: record.id,
    properties: record.properties ?? {},
    createdAt: record.createdAt ?? '',
    updatedAt: record.updatedAt ?? '',
    archived: record.archived === true
  }
}

const TITLES: Record<ObjectType, (record: CrmRecord) => string> = {
  contacts: contactTitle,
  deals: dealTitle,
  companies: companyTitle
}

// A created record, stamped with its createdate so the watermark follows creation order.
export function createdToItem(record: CrmRecord, scope: ItemScope): ConnectorItem {
  const url = recordUrl(scope.portalId, scope.objectType, record.id)
  return {
    externalId: record.id,
    title: TITLES[scope.objectType](record),
    ...(url !== undefined && { url }),
    updatedAt: property(record, 'createdate') ?? record.createdAt ?? '',
    data: recordData(record)
  }
}

// A deal at a stage: the id carries the stage so the same deal fires once per stage it reaches.
// No updatedAt on purpose: the SDK then remembers the id itself, so an edit that bumps the modified date is not a redelivery.
export function stageToItem(record: CrmRecord, portalId?: string): ConnectorItem {
  const stage = property(record, 'dealstage') ?? ''
  const url = recordUrl(portalId, 'deals', record.id)
  return {
    externalId: `${record.id}:${stage}`,
    title: `${property(record, 'dealname') ?? record.id} moved to ${stage || 'no stage'}`,
    ...(url !== undefined && { url }),
    status: stage,
    data: recordData(record)
  }
}

// When a record last changed, from the property HubSpot keeps it in.
export function modifiedAt(record: CrmRecord): string {
  return property(record, 'hs_lastmodifieddate') ?? property(record, 'lastmodifieddate') ?? record.updatedAt ?? ''
}

export function recordOutput(record: CrmRecord): Record<string, unknown> {
  return recordData(record)
}

export interface SearchFilter {
  propertyName: string
  operator: string
  value?: string
  highValue?: string
  values?: string[]
}

export function filter(propertyName: string, operator: string, value: string): SearchFilter {
  return { propertyName, operator, value }
}

// Date filters take epoch milliseconds as strings, per the search reference.
export function epochMillis(iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) throw new Error(`Not an instant: "${iso}"`)
  return String(at)
}

// The reference's own example records, which `check --mock` replays through the dedupe pipeline.
export const SAMPLE_CONTACT: CrmRecord = {
  id: '33451',
  properties: {
    createdate: '2022-06-01T14:31:48.469Z',
    email: 'lorelai@thedragonfly.com',
    firstname: 'Lorelai',
    lastname: 'Gilmore',
    phone: null,
    company: null,
    lifecyclestage: 'lead',
    hs_object_id: '33451',
    lastmodifieddate: '2025-07-07T20:27:17.947Z'
  },
  createdAt: '2022-06-01T14:31:48.469Z',
  updatedAt: '2025-07-07T20:27:17.947Z',
  archived: false
}

export const SAMPLE_DEAL: CrmRecord = {
  id: '21678228008',
  properties: {
    dealname: 'New deal',
    amount: '1500.00',
    closedate: '2019-12-07T16:50:06.678Z',
    pipeline: 'default',
    dealstage: 'contractsent',
    hubspot_owner_id: '910901',
    createdate: '2019-12-07T16:50:06.678Z',
    hs_lastmodifieddate: '2019-12-07T16:50:06.678Z',
    hs_object_id: '21678228008'
  },
  createdAt: '2019-12-07T16:50:06.678Z',
  updatedAt: '2019-12-07T16:50:06.678Z',
  archived: false
}

export const SAMPLE_COMPANY: CrmRecord = {
  id: '5000526215',
  properties: {
    name: 'HubSpot',
    domain: 'hubspot.com',
    createdate: '2019-10-30T03:30:17.883Z',
    hs_lastmodifieddate: '2019-12-07T16:50:06.678Z',
    hs_object_id: '5000526215'
  },
  createdAt: '2019-10-30T03:30:17.883Z',
  updatedAt: '2019-12-07T16:50:06.678Z',
  archived: false
}
