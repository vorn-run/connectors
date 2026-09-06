import type { ConnectorItem } from '@vornrun/connector-sdk'
import type { TrelloAction, TrelloCard } from './client'

// The reference's own placeholder id, used wherever a sample needs one.
export const SAMPLE_ID = '5abbe4b7ddc1b351ef961414'

const CARD_URL = 'https://trello.com/c/'

export interface NamedRef {
  id?: string
  name?: string
  shortLink?: string
  idShort?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ref(value: unknown): NamedRef | undefined {
  return isRecord(value) ? (value as NamedRef) : undefined
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

// A card's link from its shortUrl, else from the short link an action carries.
export function cardUrl(card: { shortUrl?: string; shortLink?: string } | undefined): string | undefined {
  if (card === undefined) return undefined
  return card.shortUrl ?? (card.shortLink ? `${CARD_URL}${card.shortLink}` : undefined)
}

// Where the item's card, board and list live on an action, however partial the action came back.
export function actionParts(action: TrelloAction) {
  const data = isRecord(action.data) ? action.data : {}
  const member = isRecord(action.memberCreator) ? action.memberCreator : {}
  return {
    data,
    card: ref(data.card),
    board: ref(data.board),
    list: ref(data.list),
    text: textOf(data.text),
    memberName: textOf(member.fullName) ?? textOf(member.username)
  }
}

function base(action: TrelloAction, title: string, card: NamedRef | undefined): ConnectorItem {
  const url = cardUrl(card)
  return {
    externalId: action.id,
    title,
    ...(url && { url }),
    ...(action.date && { updatedAt: action.date })
  }
}

export function createdItem(action: TrelloAction): ConnectorItem {
  const { card } = actionParts(action)
  return {
    ...base(action, `Card created: ${card?.name ?? card?.id ?? action.id}`, card),
    data: { ...action }
  }
}

// The origin and destination lists, from listBefore and listAfter, else from old.idList and list.
export function movedLists(action: TrelloAction): { before: NamedRef | undefined; after: NamedRef | undefined } {
  const { data, list } = actionParts(action)
  const old = isRecord(data.old) ? data.old : {}
  const before = ref(data.listBefore) ?? (typeof old.idList === 'string' ? { id: old.idList } : undefined)
  const after = ref(data.listAfter) ?? list
  return { before, after }
}

export function movedItem(action: TrelloAction): ConnectorItem {
  const { card, board } = actionParts(action)
  const { before, after } = movedLists(action)
  const from = before?.name ?? before?.id ?? '?'
  const to = after?.name ?? after?.id ?? '?'
  return {
    ...base(action, `Card moved: ${card?.name ?? card?.id ?? action.id} (${from} → ${to})`, card),
    data: {
      id: action.id,
      type: action.type,
      date: action.date,
      card,
      listBefore: before,
      listAfter: after,
      board,
      memberCreator: action.memberCreator
    }
  }
}

export function commentItem(action: TrelloAction): ConnectorItem {
  const { card, text, memberName } = actionParts(action)
  const who = memberName ?? 'Someone'
  const on = card?.name ?? card?.id ?? 'a card'
  return {
    ...base(action, text ? `${who} commented on ${on}: ${text}` : `${who} commented on ${on}`, card),
    ...(text && { description: text }),
    data: { ...action }
  }
}

// A card fires once per due date: no updatedAt, so the SDK remembers the key for as long as the card stays in the window.
export function dueSoonItem(card: TrelloCard): ConnectorItem {
  const due = String(card.due)
  const url = cardUrl(card)
  return {
    externalId: `${card.id}:${due}`,
    title: `Due ${due}: ${card.name ?? card.id}`,
    ...(url && { url }),
    data: { ...card }
  }
}

// Keep the cards whose due date is open and falls between now and the end of the window.
export function dueWithin(cards: TrelloCard[], now: string, withinHours: number): TrelloCard[] {
  const start = Date.parse(now)
  const end = start + withinHours * 3_600_000
  return cards.filter((card) => {
    if (typeof card.due !== 'string' || card.dueComplete === true) return false
    const at = Date.parse(card.due)
    return !Number.isNaN(at) && at >= start && at <= end
  })
}

export const SAMPLE_CREATE_ACTION: TrelloAction = {
  id: SAMPLE_ID,
  idMemberCreator: SAMPLE_ID,
  type: 'createCard',
  date: '2020-03-09T19:41:51.396Z',
  data: {
    card: { id: SAMPLE_ID, name: 'Bowie', idShort: 7, shortLink: '3CsPkqOF' },
    list: { id: SAMPLE_ID, name: 'Amazing' },
    board: { id: SAMPLE_ID, name: 'Mullets', shortLink: '3CsPkqOF' }
  },
  memberCreator: { id: SAMPLE_ID, fullName: 'Bob Loblaw', username: 'bobloblaw' }
}

export const SAMPLE_MOVE_ACTION: TrelloAction = {
  id: '5abbe4b7ddc1b351ef961415',
  idMemberCreator: SAMPLE_ID,
  type: 'updateCard',
  date: '2020-03-09T19:45:00.000Z',
  data: {
    card: { id: SAMPLE_ID, name: 'Bowie', idShort: 7, shortLink: '3CsPkqOF' },
    listBefore: { id: SAMPLE_ID, name: 'Amazing' },
    listAfter: { id: '5abbe4b7ddc1b351ef961416', name: 'Done' },
    old: { idList: SAMPLE_ID },
    board: { id: SAMPLE_ID, name: 'Mullets', shortLink: '3CsPkqOF' }
  },
  memberCreator: { id: SAMPLE_ID, fullName: 'Bob Loblaw', username: 'bobloblaw' }
}

export const SAMPLE_COMMENT_ACTION: TrelloAction = {
  id: SAMPLE_ID,
  idMemberCreator: SAMPLE_ID,
  type: 'commentCard',
  date: '2020-03-09T19:41:51.396Z',
  data: {
    text: 'Can never go wrong with bowie',
    card: { id: SAMPLE_ID, name: 'Bowie', idShort: 7, shortLink: '3CsPkqOF' },
    board: { id: SAMPLE_ID, name: 'Mullets', shortLink: '3CsPkqOF' },
    list: { id: SAMPLE_ID, name: 'Amazing' }
  },
  memberCreator: { id: SAMPLE_ID, fullName: 'Bob Loblaw (Trello)', username: 'bobloblaw' }
}

export const SAMPLE_DUE_CARD: TrelloCard = {
  id: SAMPLE_ID,
  name: '👋 What? Why? How?',
  due: '2019-09-18T12:00:00.000Z',
  dueComplete: false,
  closed: false,
  idBoard: SAMPLE_ID,
  idList: SAMPLE_ID,
  idMembers: [SAMPLE_ID],
  labels: [{ id: SAMPLE_ID, idBoard: SAMPLE_ID, name: 'Overdue', color: 'yellow' }],
  dateLastActivity: '2019-09-16T16:19:17.156Z',
  shortUrl: 'https://trello.com/c/H0TZyzbK',
  url: 'https://trello.com/c/H0TZyzbK/4-%F0%9F%91%8B-what-why-how'
}
