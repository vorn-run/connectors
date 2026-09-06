import { describe, expect, it } from 'vitest'
import {
  SAMPLE_COMMENT_ACTION,
  SAMPLE_CREATE_ACTION,
  SAMPLE_DUE_CARD,
  SAMPLE_ID,
  SAMPLE_MOVE_ACTION,
  actionParts,
  cardUrl,
  commentItem,
  createdItem,
  dueSoonItem,
  dueWithin,
  movedItem,
  movedLists
} from './items'

describe('cardUrl', () => {
  it('prefers shortUrl, builds one from shortLink, and gives up otherwise', () => {
    expect(cardUrl({ shortUrl: 'https://trello.com/c/x', shortLink: 'y' })).toBe('https://trello.com/c/x')
    expect(cardUrl({ shortLink: 'y' })).toBe('https://trello.com/c/y')
    expect(cardUrl({})).toBeUndefined()
    expect(cardUrl(undefined)).toBeUndefined()
  })
})

describe('actionParts', () => {
  it('reads what is there and tolerates what is not', () => {
    const parts = actionParts(SAMPLE_COMMENT_ACTION)
    expect(parts.card?.name).toBe('Bowie')
    expect(parts.text).toBe('Can never go wrong with bowie')
    expect(parts.memberName).toBe('Bob Loblaw (Trello)')
    const bare = actionParts({ id: 'a', data: { card: 'not an object', text: '' }, memberCreator: { username: 'u' } })
    expect(bare.card).toBeUndefined()
    expect(bare.text).toBeUndefined()
    expect(bare.memberName).toBe('u')
    expect(actionParts({ id: 'a' })).toMatchObject({ data: {}, memberName: undefined })
  })
})

describe('createdItem', () => {
  it('matches the spec sample', () => {
    expect(createdItem(SAMPLE_CREATE_ACTION)).toEqual({
      externalId: SAMPLE_ID,
      title: 'Card created: Bowie',
      url: 'https://trello.com/c/3CsPkqOF',
      updatedAt: '2020-03-09T19:41:51.396Z',
      data: SAMPLE_CREATE_ACTION
    })
  })

  it('falls back to the card id, then the action id, for a title', () => {
    expect(createdItem({ id: 'a', data: { card: { id: 'c' } } }).title).toBe('Card created: c')
    const item = createdItem({ id: 'a' })
    expect(item.title).toBe('Card created: a')
    expect(item.url).toBeUndefined()
    expect(item.updatedAt).toBeUndefined()
  })
})

describe('movedLists', () => {
  it('reads listBefore and listAfter, else old.idList and list', () => {
    expect(movedLists(SAMPLE_MOVE_ACTION)).toEqual({
      before: { id: SAMPLE_ID, name: 'Amazing' },
      after: { id: '5abbe4b7ddc1b351ef961416', name: 'Done' }
    })
    expect(movedLists({ id: 'a', data: { old: { idList: 'o' }, list: { id: 'n', name: 'New' } } })).toEqual({
      before: { id: 'o' },
      after: { id: 'n', name: 'New' }
    })
    expect(movedLists({ id: 'a', data: { old: 'x' } })).toEqual({ before: undefined, after: undefined })
  })
})

describe('movedItem', () => {
  it('matches the spec sample', () => {
    expect(movedItem(SAMPLE_MOVE_ACTION)).toEqual({
      externalId: '5abbe4b7ddc1b351ef961415',
      title: 'Card moved: Bowie (Amazing → Done)',
      url: 'https://trello.com/c/3CsPkqOF',
      updatedAt: '2020-03-09T19:45:00.000Z',
      data: {
        id: '5abbe4b7ddc1b351ef961415',
        type: 'updateCard',
        date: '2020-03-09T19:45:00.000Z',
        card: { id: SAMPLE_ID, name: 'Bowie', idShort: 7, shortLink: '3CsPkqOF' },
        listBefore: { id: SAMPLE_ID, name: 'Amazing' },
        listAfter: { id: '5abbe4b7ddc1b351ef961416', name: 'Done' },
        board: { id: SAMPLE_ID, name: 'Mullets', shortLink: '3CsPkqOF' },
        memberCreator: { id: SAMPLE_ID, fullName: 'Bob Loblaw', username: 'bobloblaw' }
      }
    })
  })

  it('degrades to a partial item when the lists are missing', () => {
    expect(movedItem({ id: 'a', data: { card: { id: 'c' }, old: { idList: 'o' } } }).title).toBe('Card moved: c (o → ?)')
    expect(movedItem({ id: 'a' }).title).toBe('Card moved: a (? → ?)')
  })
})

describe('commentItem', () => {
  it('matches the spec sample', () => {
    expect(commentItem(SAMPLE_COMMENT_ACTION)).toEqual({
      externalId: SAMPLE_ID,
      title: 'Bob Loblaw (Trello) commented on Bowie: Can never go wrong with bowie',
      url: 'https://trello.com/c/3CsPkqOF',
      updatedAt: '2020-03-09T19:41:51.396Z',
      description: 'Can never go wrong with bowie',
      data: SAMPLE_COMMENT_ACTION
    })
  })

  it('still names the event without a member, a card or text', () => {
    const item = commentItem({ id: 'a' })
    expect(item.title).toBe('Someone commented on a card')
    expect(item.description).toBeUndefined()
    expect(commentItem({ id: 'a', data: { card: { id: 'c' } } }).title).toBe('Someone commented on c')
  })
})

describe('dueSoonItem', () => {
  it('keys on the card id and due date and carries no updatedAt', () => {
    expect(dueSoonItem(SAMPLE_DUE_CARD)).toEqual({
      externalId: `${SAMPLE_ID}:2019-09-18T12:00:00.000Z`,
      title: 'Due 2019-09-18T12:00:00.000Z: 👋 What? Why? How?',
      url: 'https://trello.com/c/H0TZyzbK',
      data: SAMPLE_DUE_CARD
    })
    const bare = dueSoonItem({ id: 'c', due: 'D' })
    expect(bare.title).toBe('Due D: c')
    expect(bare.url).toBeUndefined()
  })
})

describe('dueWithin', () => {
  const now = '2026-09-06T12:00:00.000Z'

  it('keeps open cards due between now and the end of the window', () => {
    const cards = [
      { id: 'in', due: '2026-09-06T20:00:00.000Z', dueComplete: false },
      { id: 'edge', due: '2026-09-07T12:00:00.000Z', dueComplete: false },
      { id: 'late', due: '2026-09-07T12:00:00.001Z', dueComplete: false },
      { id: 'past', due: '2026-09-06T11:59:59.000Z', dueComplete: false },
      { id: 'done', due: '2026-09-06T20:00:00.000Z', dueComplete: true },
      { id: 'none', due: null },
      { id: 'bad', due: 'not a date' }
    ]
    expect(dueWithin(cards, now, 24).map((card) => card.id)).toEqual(['in', 'edge'])
    expect(dueWithin(cards, now, 1)).toEqual([])
  })
})
