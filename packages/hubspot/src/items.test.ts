import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROPERTIES,
  NOTE_ASSOCIATION_TYPE_IDS,
  OBJECT_TYPE_IDS,
  SAMPLE_COMPANY,
  SAMPLE_CONTACT,
  SAMPLE_DEAL,
  companyTitle,
  contactTitle,
  createdToItem,
  dealTitle,
  epochMillis,
  filter,
  modifiedAt,
  property,
  recordOutput,
  recordUrl,
  stageToItem
} from './items'

describe('the constants the spec names', () => {
  it('names the object type ids and note association ids', () => {
    expect(OBJECT_TYPE_IDS).toEqual({ contacts: '0-1', companies: '0-2', deals: '0-3' })
    expect(NOTE_ASSOCIATION_TYPE_IDS).toEqual({ contact: 202, company: 190, deal: 214 })
    expect(DEFAULT_PROPERTIES.contacts).toContain('hs_object_id')
    expect(DEFAULT_PROPERTIES.deals).toContain('dealstage')
    expect(DEFAULT_PROPERTIES.companies).toContain('domain')
  })
})

describe('property', () => {
  it('reads a property and treats null, blank and missing alike', () => {
    expect(property(SAMPLE_CONTACT, 'email')).toBe('lorelai@thedragonfly.com')
    expect(property(SAMPLE_CONTACT, 'phone')).toBeUndefined()
    expect(property({ id: '1', properties: { x: '' } }, 'x')).toBeUndefined()
    expect(property({ id: '1', properties: {} }, 'x')).toBeUndefined()
    expect(property({ id: '1' } as never, 'x')).toBeUndefined()
  })
})

describe('recordUrl', () => {
  it('needs a portal id and an id', () => {
    expect(recordUrl('123', 'contacts', '33451')).toBe('https://app.hubspot.com/contacts/123/record/0-1/33451')
    expect(recordUrl(undefined, 'contacts', '33451')).toBeUndefined()
    expect(recordUrl('123', 'deals', '')).toBeUndefined()
  })
})

describe('titles', () => {
  it('names a contact by name and email, falling back to either or the id', () => {
    expect(contactTitle(SAMPLE_CONTACT)).toBe('Lorelai Gilmore <lorelai@thedragonfly.com>')
    expect(contactTitle({ id: '1', properties: { firstname: 'Ann' } })).toBe('Ann')
    expect(contactTitle({ id: '1', properties: { email: 'a@b.c' } })).toBe('a@b.c')
    expect(contactTitle({ id: '1', properties: {} })).toBe('1')
  })

  it('names a deal by name, stage and amount', () => {
    expect(dealTitle(SAMPLE_DEAL)).toBe('New deal (contractsent, 1500.00)')
    expect(dealTitle({ id: '7', properties: {} })).toBe('7')
  })

  it('names a company by name and domain', () => {
    expect(companyTitle(SAMPLE_COMPANY)).toBe('HubSpot (hubspot.com)')
    expect(companyTitle({ id: '1', properties: { domain: 'x.io' } })).toBe('x.io')
    expect(companyTitle({ id: '1', properties: {} })).toBe('1')
  })
})

describe('createdToItem', () => {
  it('stamps the item with createdate and links it when the portal is known', () => {
    expect(createdToItem(SAMPLE_CONTACT, { objectType: 'contacts', portalId: '123' })).toEqual({
      externalId: '33451',
      title: 'Lorelai Gilmore <lorelai@thedragonfly.com>',
      url: 'https://app.hubspot.com/contacts/123/record/0-1/33451',
      updatedAt: '2022-06-01T14:31:48.469Z',
      data: {
        id: '33451',
        properties: SAMPLE_CONTACT.properties,
        createdAt: '2022-06-01T14:31:48.469Z',
        updatedAt: '2025-07-07T20:27:17.947Z',
        archived: false
      }
    })
    const bare = createdToItem({ id: '9', properties: {}, createdAt: '2020-01-01T00:00:00.000Z' }, { objectType: 'deals' })
    expect(bare).not.toHaveProperty('url')
    expect(bare.updatedAt).toBe('2020-01-01T00:00:00.000Z')
    expect(createdToItem({ id: '9' } as never, { objectType: 'companies' })).toMatchObject({ updatedAt: '', data: { properties: {}, createdAt: '' } })
  })
})

describe('stageToItem', () => {
  it('keys the item on the deal and its stage', () => {
    expect(stageToItem(SAMPLE_DEAL, '123')).toMatchObject({
      externalId: '21678228008:contractsent',
      title: 'New deal moved to contractsent',
      url: 'https://app.hubspot.com/contacts/123/record/0-3/21678228008',
      status: 'contractsent',
      data: { updatedAt: '2019-12-07T16:50:06.678Z' }
    })
    expect(stageToItem(SAMPLE_DEAL)).not.toHaveProperty('updatedAt')
    expect(stageToItem({ id: '5', properties: {} })).toMatchObject({ externalId: '5:', title: '5 moved to no stage' })
  })

  it('reads when a record last changed from whichever property carries it', () => {
    expect(modifiedAt(SAMPLE_DEAL)).toBe('2019-12-07T16:50:06.678Z')
    expect(modifiedAt(SAMPLE_CONTACT)).toBe('2025-07-07T20:27:17.947Z')
    expect(modifiedAt({ id: '1', properties: {}, updatedAt: '2020-01-01T00:00:00.000Z' })).toBe('2020-01-01T00:00:00.000Z')
    expect(modifiedAt({ id: '1', properties: {} })).toBe('')
  })
})

describe('recordOutput', () => {
  it('fills what the answer left out', () => {
    expect(recordOutput({ id: '1' } as never)).toEqual({ id: '1', properties: {}, createdAt: '', updatedAt: '', archived: false })
  })
})

describe('search helpers', () => {
  it('builds a filter and turns an instant into epoch milliseconds', () => {
    expect(filter('createdate', 'GTE', '1')).toEqual({ propertyName: 'createdate', operator: 'GTE', value: '1' })
    expect(epochMillis('2020-01-20T10:00:00.000Z')).toBe('1579514400000')
    expect(() => epochMillis('never')).toThrow('Not an instant: "never"')
  })
})
