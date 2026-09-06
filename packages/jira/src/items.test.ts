import { describe, expect, it } from 'vitest'
import {
  SAMPLE_ISSUE,
  SAMPLE_SITE,
  SAMPLE_TRANSITIONED_ISSUE,
  SAMPLE_UPDATED_ISSUE,
  isoOf,
  issueSummary,
  issueToItem,
  projectSummary,
  transitionSummary,
  userSummary
} from './items'

describe('isoOf', () => {
  it('reads Jira’s offset timestamps and refuses the rest', () => {
    expect(isoOf('2023-06-24T19:24:50.000+0000')).toBe('2023-06-24T19:24:50.000Z')
    expect(isoOf('2023-06-24T21:24:50.000+0200')).toBe('2023-06-24T19:24:50.000Z')
    expect(isoOf('')).toBeUndefined()
    expect(isoOf(undefined)).toBeUndefined()
    expect(isoOf('not a date')).toBeUndefined()
  })
})

describe('issueSummary', () => {
  it('flattens the fields a step reaches for', () => {
    expect(issueSummary(SAMPLE_ISSUE, SAMPLE_SITE)).toEqual({
      id: '10002',
      key: 'EX-1',
      url: 'https://example.atlassian.net/browse/EX-1',
      summary: 'Main order flow broken',
      status: 'To Do',
      statusCategory: 'To Do',
      issueType: 'Bug',
      priority: 'Medium',
      assignee: null,
      reporter: { accountId: '5b10a2844c20165700ede21g', displayName: 'Mia Krystof' },
      project: { id: '10000', key: 'EX', name: 'Example' },
      labels: ['bugfix'],
      created: '2023-06-24T19:24:50.000Z',
      updated: '2023-06-24T19:24:50.000Z',
      resolution: null,
      descriptionText: ''
    })
  })

  it('tolerates an empty issue and reads a description', () => {
    const empty = issueSummary({}, SAMPLE_SITE)
    expect(empty.key).toBe('')
    expect(empty.url).toBe('')
    expect(empty.project).toEqual({ id: '', key: '', name: '' })
    expect(empty.labels).toEqual([])
    const described = issueSummary(
      {
        key: 'EX-2',
        fields: {
          description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }] },
          assignee: { accountId: 'u1' },
          resolution: { name: 'Done' }
        }
      },
      SAMPLE_SITE
    )
    expect(described.descriptionText).toBe('Body')
    expect(described.assignee).toEqual({ accountId: 'u1', displayName: '' })
    expect(described.resolution).toBe('Done')
  })
})

describe('issueToItem', () => {
  it('keys a created issue by id with the created time', () => {
    expect(issueToItem(SAMPLE_ISSUE, SAMPLE_SITE, 'created')).toEqual({
      externalId: '10002',
      title: 'EX-1: Main order flow broken',
      url: 'https://example.atlassian.net/browse/EX-1',
      description: '',
      status: 'To Do',
      labels: ['bugfix'],
      updatedAt: '2023-06-24T19:24:50.000Z',
      data: { id: '10002', key: 'EX-1', self: SAMPLE_ISSUE.self, fields: SAMPLE_ISSUE.fields }
    })
  })

  it('keys an update by id and updated time', () => {
    const item = issueToItem(SAMPLE_UPDATED_ISSUE, SAMPLE_SITE, 'updated')
    expect(item.externalId).toBe('10002:2023-06-25T08:10:00.000+0000')
    expect(item.title).toBe('EX-1 updated: Main order flow broken')
    expect(item.updatedAt).toBe('2023-06-25T08:10:00.000Z')
  })

  it('names the status an issue moved to', () => {
    const item = issueToItem(SAMPLE_TRANSITIONED_ISSUE, SAMPLE_SITE, 'transitioned')
    expect(item.externalId).toBe('10002:2023-06-26T14:00:00.000+0000')
    expect(item.title).toBe('EX-1 is now Done: Main order flow broken')
    expect(item.status).toBe('Done')
  })

  it('copes with an issue missing most of its fields', () => {
    const item = issueToItem({ key: 'EX-9', fields: { assignee: { displayName: 'Mia' }, labels: ['a', 1] } }, SAMPLE_SITE, 'updated')
    expect(item.externalId).toBe('EX-9:')
    expect(item.assignee).toBe('Mia')
    expect(item.labels).toEqual(['a'])
    expect(item.updatedAt).toBeUndefined()
    const bare = issueToItem({}, SAMPLE_SITE, 'created')
    expect(bare.externalId).toBe('')
    expect(bare.url).toBeUndefined()
    expect(bare.title).toBe(': ')
  })
})

describe('summaries', () => {
  it('shapes a transition, a project and a user, filling gaps', () => {
    expect(
      transitionSummary({ id: '31', name: 'Done', to: { id: '10001', name: 'Done', statusCategory: { name: 'Done' } }, hasScreen: true })
    ).toEqual({ id: '31', name: 'Done', to: { id: '10001', name: 'Done', statusCategory: 'Done' }, hasScreen: true, isAvailable: true })
    expect(transitionSummary({ isAvailable: false })).toEqual({
      id: '',
      name: '',
      to: { id: '', name: '', statusCategory: '' },
      hasScreen: false,
      isAvailable: false
    })
    expect(projectSummary({ id: '1', key: 'EX', name: 'Example', projectTypeKey: 'software', simplified: true, style: 'next-gen' }, SAMPLE_SITE)).toEqual({
      id: '1',
      key: 'EX',
      name: 'Example',
      projectTypeKey: 'software',
      simplified: true,
      style: 'next-gen',
      url: 'https://example.atlassian.net/browse/EX'
    })
    expect(projectSummary({}, SAMPLE_SITE).url).toBe('')
    expect(userSummary({ accountId: 'a', displayName: 'Mia', emailAddress: 'mia@example.com', timeZone: 'Europe/Paris' })).toEqual({
      accountId: 'a',
      accountType: '',
      displayName: 'Mia',
      emailAddress: 'mia@example.com',
      active: true,
      timeZone: 'Europe/Paris',
      locale: '',
      self: ''
    })
    expect(userSummary({ active: false }).active).toBe(false)
    expect(userSummary({})).not.toHaveProperty('emailAddress')
  })
})
