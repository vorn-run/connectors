import { describe, expect, it, vi } from 'vitest'
import { createConnectorHarness, runConformance, type ConnectorConfig } from '@vornrun/connector-sdk'
import {
  INDEXING_MARGIN_MS,
  STAGE_LOOKBACK_MS,
  connector as packaged,
  count,
  createHubSpotConnector,
  filterGroupsArg,
  isEmail,
  namesArg,
  propertiesArg
} from './connector'
import { API_ROOT, RATE_LIMIT_RETRY_MS } from './client'
import { DEFAULT_PROPERTIES, SAMPLE_COMPANY, SAMPLE_CONTACT, SAMPLE_DEAL } from './items'

const NOW = '2026-09-05T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const HOUR_BEFORE_MS = String(NOW_MS - 60 * 60_000)
const CONFIG: ConnectorConfig = { accessToken: 'pat-test' }

interface Sent {
  method: string
  url: string
  headers: Record<string, string>
  body?: Record<string, unknown>
}

interface Route {
  when: RegExp
  status?: number
  body?: unknown
  headers?: Record<string, string>
  /** Answers in order for repeated hits; the last one repeats. */
  bodies?: unknown[]
}

// A fake api.hubapi.com driven by the URL asked for, so a test says what the account holds and asserts on what was sent.
function hubspotServing(routes: Route[]) {
  const sent: Sent[] = []
  const hits = new Map<Route, number>()
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    sent.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === 'string' && { body: JSON.parse(init.body) as Record<string, unknown> })
    })
    const route = routes.find((candidate) => candidate.when.test(url))
    if (!route) throw new Error(`No fake route for ${url}`)
    const hit = hits.get(route) ?? 0
    hits.set(route, hit + 1)
    const body = route.bodies ? route.bodies[Math.min(hit, route.bodies.length - 1)] : route.body
    return new Response(JSON.stringify(body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...route.headers }
    })
  }) as unknown as typeof fetch
  return { fetchImpl, sent }
}

function harnessOver(routes: Route[], options: { config?: ConnectorConfig; env?: NodeJS.ProcessEnv } = {}) {
  const { fetchImpl, sent } = hubspotServing(routes)
  const waits: number[] = []
  let clock = NOW_MS
  const connector = createHubSpotConnector({
    env: options.env ?? {},
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms)
      clock += ms
    },
    random: () => 0.5
  })
  const harness = createConnectorHarness(connector, {
    config: options.config ?? CONFIG,
    now: () => NOW,
    fetchImpl,
    sleep: async () => undefined
  })
  return { connector, harness, sent, waits }
}

const at = (minutesBeforeNow: number) => new Date(NOW_MS - minutesBeforeNow * 60_000).toISOString()

const contact = (id: string, createdate: string, extra: Record<string, string | null> = {}) => ({
  id,
  properties: { createdate, email: `${id}@example.com`, firstname: 'Ann', lastname: id, hs_object_id: id, ...extra },
  createdAt: createdate,
  updatedAt: createdate,
  archived: false
})

const deal = (id: string, createdate: string, stage: string, modified = createdate) => ({
  id,
  properties: { dealname: `Deal ${id}`, dealstage: stage, pipeline: 'default', createdate, hs_lastmodifieddate: modified, hs_object_id: id },
  createdAt: createdate,
  updatedAt: modified,
  archived: false
})

const CONTACT_SEARCH = /\/crm\/v3\/objects\/contacts\/search$/
const DEAL_SEARCH = /\/crm\/v3\/objects\/deals\/search$/
const COMPANY_SEARCH = /\/crm\/v3\/objects\/companies\/search$/

const searchBody = (property: string, since: string, extra: unknown[] = []) => ({
  filterGroups: [{ filters: [{ propertyName: property, operator: 'GTE', value: since }, ...extra] }],
  sorts: [{ propertyName: property, direction: 'ASCENDING' }],
  limit: 100
})

describe('the definition', () => {
  const connector = createHubSpotConnector({ version: '1.2.3', env: {} })

  it('asks for a key exactly as the spec declares it', () => {
    expect(connector.auth).toEqual({ rung: 'key', keys: ['accessToken'] })
    const token = connector.config.find((field) => field.key === 'accessToken')
    expect(token).toMatchObject({ env: 'HUBSPOT_ACCESS_TOKEN', secret: true, required: true })
  })

  it('reads its settings from the documented variables', () => {
    expect(connector.config.map((field) => field.env)).toEqual([
      'HUBSPOT_ACCESS_TOKEN',
      'HUBSPOT_PORTAL_ID',
      'HUBSPOT_PROPERTIES',
      'HUBSPOT_PIPELINE',
      'HUBSPOT_DEAL_STAGE'
    ])
  })

  it('leaves a hint for whoever builds on it, on every setting and every input', () => {
    for (const field of connector.config) expect(field.builderHint, field.key).toBeTruthy()
    for (const action of connector.actions) {
      expect(typeof action.idempotent, action.type).toBe('boolean')
      expect(action.outputs?.length, action.type).toBeGreaterThan(0)
      for (const input of action.inputs ?? []) {
        expect(input.builderHint, `${action.type}.${input.key}`).toBeTruthy()
        expect(input.description, `${action.type}.${input.key}`).toBeTruthy()
      }
    }
  })

  it('offers the triggers and actions the spec lists', () => {
    expect(connector.triggers.map((trigger) => trigger.type)).toEqual(['newContact', 'newDeal', 'newCompany', 'dealStageChanged'])
    expect(connector.actions.map((action) => action.type)).toEqual([
      'createContact',
      'updateContact',
      'createDeal',
      'updateDeal',
      'createCompany',
      'createNote',
      'associate',
      'getContact',
      'searchContacts',
      'listDealPipelines',
      'listOwners'
    ])
    const idempotent = connector.actions.filter((action) => action.idempotent).map((action) => action.type)
    expect(idempotent).toEqual(['associate', 'getContact', 'searchContacts', 'listDealPipelines', 'listOwners'])
  })

  it('draws HubSpot’s sprocket as one path', () => {
    expect(connector.icon?.viewBox).toBe('0 0 24 24')
    expect(connector.icon?.paths).toHaveLength(1)
    expect(connector.icon?.paths[0]).toMatch(/^M[\d.]+ [\d.]+a5\.2 5\.2 .*z$/)
  })

  it('names the version it was built with, and the package version otherwise', () => {
    expect(connector.version).toBe('1.2.3')
    expect(packaged.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(createHubSpotConnector().version).toBe(packaged.version)
  })

  it('carries the reference’s example records as samples', () => {
    const samples = connector.triggers.map((trigger) => trigger.sample?.[0])
    expect(samples[0]).toMatchObject({ externalId: SAMPLE_CONTACT.id, title: 'Lorelai Gilmore <lorelai@thedragonfly.com>', updatedAt: '2022-06-01T14:31:48.469Z' })
    expect(samples[1]).toMatchObject({ externalId: SAMPLE_DEAL.id, title: 'New deal (contractsent, 1500.00)' })
    expect(samples[2]).toMatchObject({ externalId: SAMPLE_COMPANY.id, title: 'HubSpot (hubspot.com)' })
    expect(samples[3]).toMatchObject({ externalId: '21678228008:contractsent', status: 'contractsent' })
    expect(samples[3]).not.toHaveProperty('updatedAt')
    for (const sample of samples) expect(sample).not.toHaveProperty('url')
  })

  it('names live samples only where the environment gives real ids', () => {
    const byType = Object.fromEntries(connector.actions.map((action) => [action.type, action.sample]))
    expect(byType.searchContacts).toEqual({ query: 'test' })
    expect(byType.listDealPipelines).toEqual({})
    expect(byType.listOwners).toEqual({})
    expect(byType.getContact).toBeUndefined()
    expect(byType.associate).toBeUndefined()

    const live = createHubSpotConnector({ env: { HUBSPOT_CONTACT_ID: '33451', HUBSPOT_COMPANY_ID: '5000526215' } })
    const liveByType = Object.fromEntries(live.actions.map((action) => [action.type, action.sample]))
    expect(liveByType.getContact).toEqual({ contactId: '33451' })
    expect(liveByType.associate).toEqual({ fromObjectType: 'contact', fromObjectId: '33451', toObjectType: 'company', toObjectId: '5000526215' })
  })
})

describe('argument helpers', () => {
  it('reads properties as strings, parsed or as text, dropping nulls', () => {
    expect(propertiesArg({ a: 'x', n: 1, b: true, o: { k: 1 }, l: [1], gone: null })).toEqual({ a: 'x', n: '1', b: 'true', o: '{"k":1}', l: '[1]' })
    expect(propertiesArg('{"a":"x"}')).toEqual({ a: 'x' })
    expect(propertiesArg(undefined)).toEqual({})
    expect(propertiesArg('')).toEqual({})
    expect(() => propertiesArg('[]')).toThrow('properties must be a JSON object')
    expect(() => propertiesArg('{nope', 'extra')).toThrow('extra must be JSON')
  })

  it('reads property names from a comma-separated line', () => {
    expect(namesArg('email, phone ,')).toEqual(['email', 'phone'])
    expect(namesArg(undefined)).toEqual([])
    expect(namesArg('  ')).toEqual([])
  })

  it('reads filter groups, wrapping a bare filter and ignoring an empty object', () => {
    const group = { filters: [{ propertyName: 'email', operator: 'EQ', value: 'a@b.c' }] }
    expect(filterGroupsArg([group])).toEqual([group])
    expect(filterGroupsArg(JSON.stringify(group))).toEqual([group])
    expect(filterGroupsArg({ propertyName: 'email', operator: 'HAS_PROPERTY' })).toEqual([{ filters: [{ propertyName: 'email', operator: 'HAS_PROPERTY' }] }])
    expect(filterGroupsArg({})).toBeUndefined()
    expect(filterGroupsArg(undefined)).toBeUndefined()
    expect(filterGroupsArg('')).toBeUndefined()
    expect(() => filterGroupsArg([1])).toThrow('filterGroups must be a JSON array')
    expect(() => filterGroupsArg({ foo: 1 })).toThrow('filterGroups must be a JSON array')
  })

  it('bounds a count', () => {
    expect(count(undefined, 'n')).toBeUndefined()
    expect(count('', 'n')).toBeUndefined()
    expect(count('7', 'n', 200)).toBe(7)
    expect(count(3, 'n')).toBe(3)
    expect(() => count(0, 'n')).toThrow('n must be a whole number of at least 1, got "0"')
    expect(() => count(201, 'n', 200)).toThrow('n must be a whole number from 1 to 200, got "201"')
  })

  it('tells an email from a record id', () => {
    expect(isEmail('a@b.c')).toBe(true)
    expect(isEmail('33451')).toBe(false)
  })
})

describe('newContact', () => {
  it('searches for contacts created at or after the watermark and delivers them oldest first', async () => {
    const { harness, sent } = harnessOver([{ when: CONTACT_SEARCH, body: { results: [contact('2', at(20)), contact('1', at(30))] } }])
    const page = await harness.poll('newContact', { since: at(40) })
    expect(page.items.map((item) => item.externalId)).toEqual(['1', '2'])
    expect(page.items[0]).toMatchObject({ title: 'Ann 1 <1@example.com>', updatedAt: at(30), url: '' })
    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: `${API_ROOT}/crm/v3/objects/contacts/search`,
      headers: { Authorization: 'Bearer pat-test' },
      body: { ...searchBody('createdate', String(NOW_MS - 40 * 60_000)), properties: DEFAULT_PROPERTIES.contacts }
    })
  })

  it('starts an hour back on the first poll and adds the extra properties and portal from the settings', async () => {
    const { harness, sent } = harnessOver([{ when: CONTACT_SEARCH, body: { results: [contact('1', at(30))] } }], {
      config: { ...CONFIG, portalId: '123', properties: 'jobtitle, hs_lead_status' }
    })
    const page = await harness.poll('newContact')
    expect(page.items[0].url).toBe('https://app.hubspot.com/contacts/123/record/0-1/1')
    expect(sent[0].body).toEqual({
      ...searchBody('createdate', HOUR_BEFORE_MS),
      properties: [...DEFAULT_PROPERTIES.contacts, 'jobtitle', 'hs_lead_status']
    })
  })

  it('does not deliver the same contact twice', async () => {
    const { harness } = harnessOver([{ when: CONTACT_SEARCH, body: { results: [contact('1', at(30))] } }])
    expect(await harness.pollTwice('newContact')).toEqual([])
  })

  it('leaves a contact created inside the indexing margin for the next poll', async () => {
    const fresh = new Date(NOW_MS - INDEXING_MARGIN_MS + 1000).toISOString()
    const settled = new Date(NOW_MS - INDEXING_MARGIN_MS).toISOString()
    const { harness } = harnessOver([{ when: CONTACT_SEARCH, body: { results: [contact('old', settled), contact('new', fresh)] } }])
    const page = await harness.poll('newContact')
    expect(page.items.map((item) => item.externalId)).toEqual(['old'])
    expect(page.nextCursor).toContain(settled)
  })

  it('walks paging.next.after across pages', async () => {
    const { harness, sent } = harnessOver([
      {
        when: CONTACT_SEARCH,
        bodies: [{ results: [contact('1', at(30))], paging: { next: { after: '100' } } }, { results: [contact('2', at(20))] }]
      }
    ])
    const page = await harness.poll('newContact')
    expect(page.items).toHaveLength(2)
    expect(sent[1].body?.after).toBe('100')
  })

  it('needs the token', async () => {
    const { harness } = harnessOver([], { config: {} })
    await expect(harness.poll('newContact')).rejects.toThrow('HUBSPOT_ACCESS_TOKEN is required')
  })

  it('waits a second on a 429 and polls once more', async () => {
    const { harness, sent, waits } = harnessOver([
      { when: CONTACT_SEARCH, status: 429, body: { message: 'slow', category: 'RATE_LIMITS', correlationId: 'c' } }
    ])
    await expect(harness.poll('newContact')).rejects.toThrow('RATE_LIMITS: slow (c)')
    expect(sent.length).toBeGreaterThanOrEqual(2)
    expect(waits).toContain(RATE_LIMIT_RETRY_MS)
  })
})

describe('newDeal and newCompany', () => {
  it('searches deals by createdate, in the configured pipeline', async () => {
    const { harness, sent } = harnessOver([{ when: DEAL_SEARCH, body: { results: [deal('1', at(30), 'appointmentscheduled')] } }], {
      config: { ...CONFIG, pipeline: 'default', dealstage: 'closedwon' }
    })
    const page = await harness.poll('newDeal')
    expect(page.items[0]).toMatchObject({ externalId: '1', title: 'Deal 1 (appointmentscheduled)', updatedAt: at(30) })
    expect(sent[0].body).toEqual({
      ...searchBody('createdate', HOUR_BEFORE_MS, [{ propertyName: 'pipeline', operator: 'EQ', value: 'default' }]),
      properties: DEFAULT_PROPERTIES.deals
    })
  })

  it('searches every pipeline when none is set', async () => {
    const { harness, sent } = harnessOver([{ when: DEAL_SEARCH, body: { results: [] } }])
    expect((await harness.poll('newDeal')).items).toEqual([])
    expect(sent[0].body?.filterGroups).toEqual([{ filters: [{ propertyName: 'createdate', operator: 'GTE', value: HOUR_BEFORE_MS }] }])
  })

  it('searches companies by createdate', async () => {
    const company = { ...SAMPLE_COMPANY, properties: { ...SAMPLE_COMPANY.properties, createdate: at(30) } }
    const { harness, sent } = harnessOver([{ when: COMPANY_SEARCH, body: { results: [company] } }])
    const page = await harness.poll('newCompany')
    expect(page.items[0]).toMatchObject({ externalId: SAMPLE_COMPANY.id, title: 'HubSpot (hubspot.com)', updatedAt: at(30) })
    expect(sent[0].body?.properties).toEqual(DEFAULT_PROPERTIES.companies)
  })
})

describe('dealStageChanged', () => {
  it('searches by last modified date with the pipeline and stage filters, keyed on deal and stage', async () => {
    const { harness, sent } = harnessOver([{ when: DEAL_SEARCH, body: { results: [deal('1', at(90), 'closedwon', at(20))] } }], {
      config: { ...CONFIG, pipeline: 'default', dealstage: 'closedwon', portalId: '123' }
    })
    const page = await harness.poll('dealStageChanged', { since: at(10) })
    expect(page.items[0]).toMatchObject({
      externalId: '1:closedwon',
      title: 'Deal 1 moved to closedwon',
      status: 'closedwon',
      url: 'https://app.hubspot.com/contacts/123/record/0-3/1',
      updatedAt: NOW
    })
    expect(sent[0].body).toEqual({
      ...searchBody('hs_lastmodifieddate', HOUR_BEFORE_MS, [
        { propertyName: 'pipeline', operator: 'EQ', value: 'default' },
        { propertyName: 'dealstage', operator: 'EQ', value: 'closedwon' }
      ]),
      properties: DEFAULT_PROPERTIES.deals
    })
  })

  it('fires a deal again only when it reaches a stage it has not fired for', async () => {
    const { harness } = harnessOver([
      {
        when: DEAL_SEARCH,
        bodies: [
          { results: [deal('1', at(90), 'contractsent', at(30))] },
          { results: [deal('1', at(90), 'contractsent', at(20))] },
          { results: [deal('1', at(90), 'closedwon', at(10))] }
        ]
      }
    ])
    const first = await harness.poll('dealStageChanged')
    expect(first.items.map((item) => item.externalId)).toEqual(['1:contractsent'])
    const edited = await harness.poll('dealStageChanged', { cursor: first.nextCursor })
    expect(edited.items).toEqual([])
    const moved = await harness.poll('dealStageChanged', { cursor: edited.nextCursor })
    expect(moved.items.map((item) => item.externalId)).toEqual(['1:closedwon'])
    const back = await harness.poll('dealStageChanged', { cursor: moved.nextCursor })
    expect(back.items).toEqual([])
    expect(await harness.pollTwice('dealStageChanged')).toEqual([])
  })

  it('always looks an hour back and leaves a deal modified inside the indexing margin for the next poll', async () => {
    const fresh = new Date(NOW_MS - INDEXING_MARGIN_MS + 1000).toISOString()
    const { harness, sent } = harnessOver([{ when: DEAL_SEARCH, body: { results: [deal('1', at(90), 'closedwon', fresh), deal('2', at(90), 'closedwon', at(5))] } }])
    const page = await harness.poll('dealStageChanged', { since: at(3) })
    expect(page.items.map((item) => item.externalId)).toEqual(['2:closedwon'])
    expect(sent[0].body?.filterGroups).toEqual([{ filters: [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(NOW_MS - STAGE_LOOKBACK_MS) }] }])
  })
})

describe('record actions', () => {
  const saved = contact('33451', at(30))

  it('creates a contact from the named inputs over the extra properties', async () => {
    const { harness, sent } = harnessOver([{ when: /\/crm\/v3\/objects\/contacts$/, body: saved }])
    const output = await harness.execute('createContact', {
      email: 'a@b.c',
      firstname: 'Ann',
      lastname: 'Lee',
      phone: '555',
      company: 'Acme',
      properties: '{"lifecyclestage":"lead","email":"ignored@b.c"}'
    })
    expect(output).toEqual({ id: '33451', properties: saved.properties, createdAt: at(30), updatedAt: at(30), archived: false })
    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: `${API_ROOT}/crm/v3/objects/contacts`,
      body: { properties: { email: 'a@b.c', firstname: 'Ann', lastname: 'Lee', phone: '555', company: 'Acme', lifecyclestage: 'lead' } }
    })
  })

  it('creates a contact from the email alone', async () => {
    const { harness, sent } = harnessOver([{ when: /\/contacts$/, body: saved }])
    await harness.execute('createContact', { email: 'a@b.c' })
    expect(sent[0].body).toEqual({ properties: { email: 'a@b.c' } })
  })

  it('refuses a create without an email or with malformed properties before any call', async () => {
    const { harness, sent } = harnessOver([])
    await expect(harness.execute('createContact', {})).rejects.toThrow(/requires "email"/)
    await expect(harness.execute('createContact', { email: 'a@b.c', properties: 'nope' })).rejects.toThrow(/Expected JSON/)
    expect(sent).toEqual([])
  })

  it('carries the existing id when the email is taken', async () => {
    const { harness } = harnessOver([
      { when: /\/contacts$/, status: 409, body: { status: 'error', message: 'Contact already exists. Existing ID: 33451', category: 'CONFLICT', correlationId: 'x' } }
    ])
    await expect(harness.execute('createContact', { email: 'a@b.c' })).rejects.toThrow('CONFLICT: Contact already exists. Existing ID: 33451 (x)')
  })

  it('patches a contact and a deal', async () => {
    const { harness, sent } = harnessOver([{ when: /\/contacts\/33451$/, body: saved }, { when: /\/deals\/7$/, body: deal('7', at(30), 'closedwon') }])
    expect(await harness.execute('updateContact', { contactId: '33451', properties: '{"phone":"555"}' })).toMatchObject({ id: '33451' })
    expect(sent[0]).toMatchObject({ method: 'PATCH', url: `${API_ROOT}/crm/v3/objects/contacts/33451`, body: { properties: { phone: '555' } } })
    expect(await harness.execute('updateDeal', { dealId: '7', properties: '{"dealstage":"closedwon"}' })).toMatchObject({ id: '7' })
    expect(sent[1]).toMatchObject({ method: 'PATCH', url: `${API_ROOT}/crm/v3/objects/deals/7`, body: { properties: { dealstage: 'closedwon' } } })
  })

  it('creates a deal with the amount and owner written as properties', async () => {
    const { harness, sent } = harnessOver([{ when: /\/deals$/, body: deal('7', at(30), 'contractsent') }])
    const output = await harness.execute('createDeal', {
      dealname: 'New deal',
      dealstage: 'contractsent',
      pipeline: 'default',
      amount: '1500',
      closedate: '2019-12-07T16:50:06.678Z',
      ownerId: '910901',
      properties: '{"hs_priority":"high"}'
    })
    expect(output).toMatchObject({ id: '7', properties: { dealname: 'Deal 7' } })
    expect(sent[0].body).toEqual({
      properties: {
        dealname: 'New deal',
        dealstage: 'contractsent',
        pipeline: 'default',
        amount: '1500',
        closedate: '2019-12-07T16:50:06.678Z',
        hubspot_owner_id: '910901',
        hs_priority: 'high'
      }
    })
    await harness.execute('createDeal', { dealname: 'Bare', dealstage: 'closedwon' })
    expect(sent[1].body).toEqual({ properties: { dealname: 'Bare', dealstage: 'closedwon' } })
  })

  it('creates a company with its domain', async () => {
    const { harness, sent } = harnessOver([{ when: /\/companies$/, body: SAMPLE_COMPANY }])
    expect(await harness.execute('createCompany', { name: 'HubSpot', domain: 'hubspot.com', properties: '{"city":"Cambridge"}' })).toMatchObject({ id: SAMPLE_COMPANY.id })
    expect(sent[0]).toMatchObject({ method: 'POST', url: `${API_ROOT}/crm/v3/objects/companies`, body: { properties: { name: 'HubSpot', domain: 'hubspot.com', city: 'Cambridge' } } })
    await harness.execute('createCompany', { name: 'Bare' })
    expect(sent[1].body).toEqual({ properties: { name: 'Bare' } })
  })

  it('adds a note to a record with the association for its type and the current time', async () => {
    const note = { id: '99', properties: { hs_note_body: 'Called', hs_timestamp: NOW }, createdAt: NOW, updatedAt: NOW, archived: false }
    const { harness, sent } = harnessOver([{ when: /\/notes$/, body: note }])
    expect(await harness.execute('createNote', { objectType: 'deal', objectId: '7', body: 'Called', ownerId: '910901' })).toMatchObject({ id: '99' })
    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: `${API_ROOT}/crm/v3/objects/notes`,
      body: {
        properties: { hs_timestamp: NOW, hs_note_body: 'Called', hubspot_owner_id: '910901' },
        associations: [{ to: { id: '7' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }] }]
      }
    })
    await harness.execute('createNote', { objectType: 'contact', objectId: '1', body: 'Hi' })
    expect(sent[1].body).toMatchObject({ properties: { hs_note_body: 'Hi' }, associations: [{ types: [{ associationTypeId: 202 }] }] })
    await harness.execute('createNote', { objectType: 'company', objectId: '1', body: 'Hi' })
    expect(sent[2].body).toMatchObject({ associations: [{ types: [{ associationTypeId: 190 }] }] })
  })

  it('refuses a note on an unknown record type before any call', async () => {
    const { harness, sent } = harnessOver([])
    await expect(harness.execute('createNote', { objectType: 'ticket', objectId: '1', body: 'Hi' })).rejects.toThrow('objectType must be one of contact, company or deal, got "ticket"')
    expect(sent).toEqual([])
  })

  it('associates two records by default or by a labelled type', async () => {
    const answer = { fromObjectTypeId: '0-1', fromObjectId: 29851, toObjectTypeId: '0-3', toObjectId: 21678228008, labels: ['Point of contact'] }
    const { harness, sent } = harnessOver([{ when: /\/associations\//, body: answer }])
    expect(await harness.execute('associate', { fromObjectType: 'contact', fromObjectId: '29851', toObjectType: 'deal', toObjectId: '21678228008' })).toEqual(answer)
    expect(sent[0]).toMatchObject({ method: 'PUT', url: `${API_ROOT}/crm/v4/objects/contact/29851/associations/default/deal/21678228008` })
    await harness.execute('associate', { fromObjectType: 'contact', fromObjectId: '1', toObjectType: 'company', toObjectId: '2', associationTypeId: '1' })
    expect(sent[1]).toMatchObject({
      url: `${API_ROOT}/crm/v4/objects/contact/1/associations/company/2`,
      body: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 1 }]
    })
    const silent = harnessOver([{ when: /\/associations\//, body: {} }])
    expect(await silent.harness.execute('associate', { fromObjectType: 'contact', fromObjectId: '1', toObjectType: 'company', toObjectId: '2' })).toEqual({
      fromObjectTypeId: '',
      fromObjectId: '1',
      toObjectTypeId: '',
      toObjectId: '2',
      labels: []
    })
  })

  it('gets a contact by id or by email, with the standard or the named properties', async () => {
    const { harness, sent } = harnessOver([{ when: /\/contacts\//, body: saved }])
    expect(await harness.execute('getContact', { contactId: '33451' })).toMatchObject({ id: '33451' })
    expect(sent[0].url).toBe(`${API_ROOT}/crm/v3/objects/contacts/33451?properties=${encodeURIComponent(DEFAULT_PROPERTIES.contacts.join(','))}`)
    await harness.execute('getContact', { contactId: 'lorelai@thedragonfly.com', properties: 'email, phone' })
    expect(sent[1].url).toBe(`${API_ROOT}/crm/v3/objects/contacts/lorelai%40thedragonfly.com?properties=email%2Cphone&idProperty=email`)
  })

  it('surfaces what HubSpot said when a contact is missing', async () => {
    const { harness } = harnessOver([
      { when: /\/contacts\//, status: 404, body: { status: 'error', message: 'resource not found', category: 'OBJECT_NOT_FOUND', correlationId: 'k' } }
    ])
    await expect(harness.execute('getContact', { contactId: '1' })).rejects.toThrow('OBJECT_NOT_FOUND: resource not found (k)')
  })

  it('searches contacts one page at a time', async () => {
    const { harness, sent } = harnessOver([{ when: CONTACT_SEARCH, body: { total: 12, results: [saved], paging: { next: { after: '10' } } } }])
    const output = await harness.execute('searchContacts', {
      query: 'test',
      filterGroups: '[{"filters":[{"propertyName":"lifecyclestage","operator":"EQ","value":"lead"}]}]',
      properties: 'email',
      limit: '10',
      after: '20'
    })
    expect(output).toEqual({
      total: 12,
      contacts: [{ id: '33451', properties: saved.properties, createdAt: at(30), updatedAt: at(30), archived: false }],
      nextAfter: '10'
    })
    expect(sent[0].body).toEqual({
      query: 'test',
      filterGroups: [{ filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'lead' }] }],
      properties: ['email'],
      limit: 10,
      after: '20'
    })
    const empty = harnessOver([{ when: CONTACT_SEARCH, body: {} }])
    expect(await empty.harness.execute('searchContacts', {})).toEqual({ total: 0, contacts: [], nextAfter: '' })
    expect(empty.sent[0].body).toEqual({ properties: DEFAULT_PROPERTIES.contacts })
    await expect(harness.execute('searchContacts', { limit: '201' })).rejects.toThrow('limit must be a whole number from 1 to 200')
  })
})

describe('declared actions', () => {
  it('lists deal pipelines with their stages', async () => {
    const pipelines = [{ id: 'default', label: 'Sales Pipeline', stages: [{ id: 'closedwon', label: 'Closed Won', metadata: { probability: '1.0' } }] }]
    const { harness, sent } = harnessOver([{ when: /\/crm\/v3\/pipelines\/deals$/, body: { results: pipelines } }])
    expect(await harness.execute('listDealPipelines', {})).toEqual({ pipelines })
    expect(sent[0]).toMatchObject({ method: 'GET', url: `${API_ROOT}/crm/v3/pipelines/deals`, headers: { Authorization: 'Bearer pat-test' } })
  })

})

describe('listOwners', () => {
  it('lists owners with the filters passed through as query parameters and the next cursor lifted out', async () => {
    const owners = [{ id: '910901', email: 'owner@example.com', userId: 12, teams: [] }]
    const { harness, sent } = harnessOver([{ when: /\/crm\/v3\/owners/, body: { results: owners, paging: { next: { after: '5' } }, extra: 1 } }])
    expect(await harness.execute('listOwners', {})).toEqual({ owners, nextAfter: '5' })
    expect(sent[0]).toMatchObject({ method: 'GET', url: `${API_ROOT}/crm/v3/owners`, headers: { Authorization: 'Bearer pat-test' } })
    await harness.execute('listOwners', { email: 'owner@example.com', limit: '5', after: '5', archived: true })
    expect(sent[1].url).toBe(`${API_ROOT}/crm/v3/owners?email=owner%40example.com&limit=5&after=5&archived=true`)
    await harness.execute('listOwners', { archived: false })
    expect(sent[2].url).toBe(`${API_ROOT}/crm/v3/owners?archived=false`)
  })

  it('answers an empty list and no cursor from a bare reply, and refuses a bad limit', async () => {
    const { harness } = harnessOver([{ when: /\/crm\/v3\/owners/, body: {} }])
    expect(await harness.execute('listOwners', {})).toEqual({ owners: [], nextAfter: '' })
    await expect(harness.execute('listOwners', { limit: '0' })).rejects.toThrow('limit must be a whole number of at least 1')
  })
})

describe('the conformance run', () => {
  it('runs every action against served HTTP with placeholder arguments', async () => {
    const { harness } = harnessOver([{ when: /.*/, body: {} }])
    const args: Record<string, Record<string, string>> = {
      createContact: { email: 'check', firstname: 'check', lastname: 'check', phone: 'check', company: 'check', properties: '{}' },
      updateContact: { contactId: 'check', properties: '{}' },
      createDeal: { dealname: 'check', dealstage: 'check', pipeline: 'check', amount: '1', closedate: 'check', ownerId: 'check', properties: '{}' },
      updateDeal: { dealId: 'check', properties: '{}' },
      createCompany: { name: 'check', domain: 'check', properties: '{}' },
      createNote: { objectType: 'contact', objectId: 'check', body: 'check', ownerId: 'check' },
      associate: { fromObjectType: 'check', fromObjectId: 'check', toObjectType: 'check', toObjectId: 'check', associationTypeId: '1' },
      getContact: { contactId: 'check', properties: 'check' },
      searchContacts: { query: 'check', filterGroups: '{}', properties: 'check', limit: '1', after: 'check' },
      listDealPipelines: {},
      listOwners: { email: 'check', limit: '1', after: 'check', archived: 'false' }
    }
    expect(Object.keys(args)).toEqual(packaged.actions.map((action) => action.type))
    for (const [type, input] of Object.entries(args)) {
      await expect(harness.execute(type, input), type).resolves.toBeDefined()
    }
  })

  it('passes the SDK mock conformance run', async () => {
    const run = await runConformance(packaged, { mock: true })
    expect(run.findings.filter((item) => item.level === 'error')).toEqual([])
    expect(run.passed).toEqual(expect.arrayContaining(['manifest', 'auth', 'secrets', 'actions', 'dedupe', 'mock']))
  })
})
