import { describe, expect, it, vi } from 'vitest'
import { createConnectorHarness, type ConnectorConfig } from '@vornrun/connector-sdk'
import {
  CARD_FIELDS,
  alreadyLabelled,
  cardOutput,
  connector as packaged,
  count,
  createTrelloConnector,
  listArg,
  searchCards,
  text,
  trelloPreflight
} from './connector'
import { MAX_ACTION_LIMIT, TrelloApiError } from './client'
import { SAMPLE_COMMENT_ACTION, SAMPLE_CREATE_ACTION, SAMPLE_DUE_CARD, SAMPLE_ID, SAMPLE_MOVE_ACTION } from './items'

const NOW = '2026-09-06T12:00:00.000Z'
const DAY_BEFORE = '2026-09-05T12:00:00.000Z'
const CONFIG: ConnectorConfig = { apiKey: 'key-1', token: 'token-1', boardId: 'board-1' }

interface Sent {
  method: string
  url: URL
}

interface Route {
  when: RegExp
  status?: number
  body?: unknown
  headers?: Record<string, string>
  /** Answers in order for repeated hits; the last one repeats. */
  bodies?: unknown[]
}

// A fake api.trello.com driven by the URL asked for, so a test says what the board holds and asserts on what was sent.
function trelloServing(routes: Route[]) {
  const sent: Sent[] = []
  const hits = new Map<Route, number>()
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    sent.push({ method: (init?.method ?? 'GET').toUpperCase(), url })
    const route = routes.find((candidate) => candidate.when.test(url.pathname))
    if (!route) throw new Error(`No fake route for ${url.pathname}`)
    const hit = hits.get(route) ?? 0
    hits.set(route, hit + 1)
    const body = route.bodies ? route.bodies[Math.min(hit, route.bodies.length - 1)] : route.body
    const isText = typeof body === 'string'
    return new Response(isText ? body : JSON.stringify(body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': isText ? 'text/plain' : 'application/json', ...route.headers }
    })
  }) as unknown as typeof fetch
  return { fetchImpl, sent }
}

function harnessFor(routes: Route[], config: ConnectorConfig = CONFIG, env: NodeJS.ProcessEnv = {}) {
  const { fetchImpl, sent } = trelloServing(routes)
  const sleep = vi.fn(async () => {})
  const connector = createTrelloConnector({ env, sleep })
  const harness = createConnectorHarness(connector, { config, now: () => NOW, fetchImpl, sleep })
  return { harness, sent, sleep, connector }
}

function action(id: string, date: string, extra: Record<string, unknown> = {}) {
  return { id, type: 'createCard', date, data: { card: { id: `card-${id}`, name: `Card ${id}`, shortLink: `s${id}` } }, ...extra }
}

describe('helpers', () => {
  it('text trims and blanks to undefined', () => {
    expect(text('  a ')).toBe('a')
    expect(text('')).toBeUndefined()
    expect(text(undefined)).toBeUndefined()
  })

  it('listArg normalises a comma-separated list', () => {
    expect(listArg(' a, b ,,c ')).toBe('a,b,c')
    expect(listArg(',')).toBeUndefined()
    expect(listArg('')).toBeUndefined()
  })

  it('count accepts a positive number within the bound and refuses the rest', () => {
    expect(count(undefined, 'n')).toBeUndefined()
    expect(count('', 'n')).toBeUndefined()
    expect(count('12', 'n')).toBe(12)
    expect(count(1000, 'n', 1000)).toBe(1000)
    expect(() => count('0', 'n')).toThrow('n must be a number above 0, got "0"')
    expect(() => count('1001', 'n', 1000)).toThrow('n must be a number from 1 to 1000, got "1001"')
    expect(() => count('x', 'n')).toThrow(/must be a number/)
  })

  it('cardOutput keeps the card keys and ignores a non-object', () => {
    expect(cardOutput({ id: 'c', name: 'n', extra: 1 })).toEqual({ id: 'c', name: 'n' })
    expect(cardOutput('x')).toEqual({})
  })

  it('searchCards reads an object or a mixed list', () => {
    expect(searchCards({ cards: [{ id: 'c' }, 'x'] })).toEqual([{ id: 'c' }])
    expect(searchCards([{ id: 'c', idList: 'l' }, { id: 'b', idOrganization: 'o' }, 'x'])).toEqual([{ id: 'c', idList: 'l' }])
    expect(searchCards({})).toEqual([])
    expect(searchCards('x')).toEqual([])
  })

  it('alreadyLabelled recognises only the 400 that says so', () => {
    expect(alreadyLabelled(new TrelloApiError(400, 'that label is already on the card'))).toBe(true)
    expect(alreadyLabelled(new TrelloApiError(400, 'invalid id'))).toBe(false)
    expect(alreadyLabelled(new TrelloApiError(401, 'already'))).toBe(false)
    expect(alreadyLabelled(new Error('already'))).toBe(false)
  })
})

describe('trelloPreflight', () => {
  it('says what to set when a value is missing', async () => {
    const result = await trelloPreflight({ apiKey: 'k' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('TRELLO_TOKEN')
    expect(result.message).toContain('https://trello.com/power-ups/admin')
  })

  it('names the member when the pair is accepted', async () => {
    const { fetchImpl, sent } = trelloServing([{ when: /members\/me$/, body: { id: 'm', username: 'bob', fullName: 'Bob' } }])
    await expect(trelloPreflight({ apiKey: 'k', token: 't', fetch: fetchImpl })).resolves.toEqual({ ok: true, message: 'Signed in as Bob' })
    expect(sent[0].url.searchParams.get('key')).toBe('k')
    const anonymous = trelloServing([{ when: /members\/me$/, body: {} }])
    await expect(trelloPreflight({ apiKey: 'k', token: 't', fetch: anonymous.fetchImpl })).resolves.toMatchObject({
      message: 'Signed in as a Trello member'
    })
  })

  it('says how to recover when Trello refuses the pair', async () => {
    const { fetchImpl } = trelloServing([{ when: /members\/me$/, status: 401, body: 'invalid token' }])
    const result = await trelloPreflight({ apiKey: 'k', token: 't', fetch: fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('401: invalid token')
    const thrown = vi.fn(async () => {
      throw 'offline'
    }) as unknown as typeof fetch
    await expect(trelloPreflight({ apiKey: 'k', token: 't', fetch: thrown })).resolves.toMatchObject({ ok: false, message: expect.stringContaining('offline') })
  })

  it('is wired to the environment on the connector', async () => {
    const { fetchImpl } = trelloServing([{ when: /members\/me$/, body: { id: 'm' } }])
    const connector = createTrelloConnector({ env: { TRELLO_API_KEY: 'k', TRELLO_TOKEN: 't' }, fetch: fetchImpl })
    await expect(connector.preflight?.()).resolves.toMatchObject({ ok: true })
    await expect(createTrelloConnector({ env: {} }).preflight?.()).resolves.toMatchObject({ ok: false })
  })
})

describe('the connector definition', () => {
  it('declares the key rung with both secrets and carries its own mark', () => {
    expect(packaged.id).toBe('trello')
    expect(packaged.auth).toEqual({ rung: 'key', keys: ['apiKey', 'token'] })
    const secrets = packaged.config.filter((field) => field.secret).map((field) => field.key)
    expect(secrets).toEqual(['apiKey', 'token'])
    expect(packaged.icon?.paths).toHaveLength(1)
    expect(packaged.triggers.map((trigger) => trigger.type)).toEqual(['cardCreated', 'cardMoved', 'commentAdded', 'cardDueSoon'])
    expect(packaged.actions.map((entry) => entry.type)).toEqual([
      'createCard', 'updateCard', 'moveCard', 'addComment', 'addLabel', 'archiveCard', 'getCard', 'listBoards', 'listLists', 'listCards', 'searchCards'
    ])
  })

  it('describes every input and config field for the builder', () => {
    for (const field of packaged.config) expect(field.builderHint, field.key).toBeTruthy()
    for (const entry of packaged.actions) {
      for (const input of entry.inputs ?? []) {
        expect(input.description, `${entry.type}.${input.key}`).toBeTruthy()
        expect(input.builderHint, `${entry.type}.${input.key}`).toBeTruthy()
      }
    }
  })

  it('takes live sample ids from the environment and placeholders otherwise', () => {
    const samples = (connector: ReturnType<typeof createTrelloConnector>) =>
      Object.fromEntries(connector.actions.map((entry) => [entry.type, entry.sample]))
    const placeholders = samples(createTrelloConnector({ env: {} }))
    expect(placeholders.getCard).toEqual({ cardId: SAMPLE_ID })
    expect(placeholders.listLists).toEqual({ boardId: SAMPLE_ID })
    expect(placeholders.listCards).toEqual({ listId: SAMPLE_ID })
    expect(placeholders.listBoards).toEqual({})
    expect(placeholders.searchCards).toEqual({ query: 'test' })
    expect(placeholders.archiveCard).toBeUndefined()
    expect(placeholders.createCard).toBeUndefined()
    const live = samples(
      createTrelloConnector({ env: { TRELLO_BOARD_ID: 'b', TRELLO_LIST_ID: 'l', TRELLO_CARD_ID: 'c', TRELLO_ARCHIVE_CARD_ID: 'x' } })
    )
    expect(live.getCard).toEqual({ cardId: 'c' })
    expect(live.listLists).toEqual({ boardId: 'b' })
    expect(live.listCards).toEqual({ listId: 'l' })
    expect(live.archiveCard).toEqual({ cardId: 'x' })
    expect(createTrelloConnector({ version: '9.9.9' }).version).toBe('9.9.9')
  })

  it('exposes a manifest the app can read', () => {
    const { harness } = harnessFor([])
    const manifest = harness.manifest()
    expect(manifest.id).toBe('trello')
  })
})

describe('cardCreated', () => {
  it('asks for createCard actions since the watermark and delivers oldest first', async () => {
    const { harness, sent } = harnessFor([{ when: /\/actions$/, body: [action('a2', '2026-09-06T11:00:00.000Z'), action('a1', '2026-09-06T10:00:00.000Z')] }])
    const items = await harness.drain('cardCreated', { since: '2026-09-06T09:00:00.000Z' })
    expect(items.map((item) => item.externalId)).toEqual(['a1', 'a2'])
    expect(items[0]).toMatchObject({ title: 'Card created: Card a1', url: 'https://trello.com/c/sa1', updatedAt: '2026-09-06T10:00:00.000Z' })
    const [{ url }] = sent
    expect(url.pathname).toBe('/1/boards/board-1/actions')
    expect(url.searchParams.get('filter')).toBe('createCard')
    expect(url.searchParams.get('since')).toBe('2026-09-06T09:00:00.000Z')
    expect(url.searchParams.get('limit')).toBe(String(MAX_ACTION_LIMIT))
    expect(url.searchParams.get('key')).toBe('key-1')
    expect(url.searchParams.get('token')).toBe('token-1')
    expect(url.searchParams.has('before')).toBe(false)
  })

  it('starts a day back on the very first poll', async () => {
    const { harness, sent } = harnessFor([{ when: /\/actions$/, body: [] }])
    await expect(harness.drain('cardCreated')).resolves.toEqual([])
    expect(sent[0].url.searchParams.get('since')).toBe(DAY_BEFORE)
  })

  it('walks back with before while pages are full, at most five pages', async () => {
    const full = (page: number) =>
      Array.from({ length: MAX_ACTION_LIMIT }, (_, index) => action(`p${page}-${String(index).padStart(4, '0')}`, `2026-09-06T0${page}:00:00.000Z`))
    const { harness, sent } = harnessFor([{ when: /\/actions$/, bodies: [full(9), full(8), full(7), full(6), full(5), full(4)] }])
    const items = await harness.drain('cardCreated', { since: '2026-09-01T00:00:00.000Z' })
    expect(items).toHaveLength(5 * MAX_ACTION_LIMIT)
    expect(items[0].externalId).toBe('p5-0000')
    expect(sent).toHaveLength(5)
    expect(sent[1].url.searchParams.get('before')).toBe('2026-09-06T09:00:00.000Z')
    expect(sent[4].url.searchParams.get('before')).toBe('2026-09-06T06:00:00.000Z')
  })

  it('stops paging when a full page carries no date to walk back from', async () => {
    const undated = Array.from({ length: MAX_ACTION_LIMIT }, (_, index) => ({ id: `u${index}` }))
    const { harness, sent } = harnessFor([{ when: /\/actions$/, body: undated }])
    const items = await harness.drain('cardCreated', { since: '2026-09-01T00:00:00.000Z' })
    expect(items).toHaveLength(MAX_ACTION_LIMIT)
    expect(sent).toHaveLength(1)
  })

  it('does not redeliver what the watermark already covers', async () => {
    const { harness } = harnessFor([{ when: /\/actions$/, body: [action('a2', '2026-09-06T11:00:00.000Z'), action('a1', '2026-09-06T10:00:00.000Z')] }])
    await expect(harness.pollTwice('cardCreated')).resolves.toEqual([])
  })

  it('needs a board', async () => {
    const { harness } = harnessFor([], { apiKey: 'k', token: 't' })
    await expect(harness.drain('cardCreated')).rejects.toThrow('TRELLO_BOARD_ID is required')
    const noKey = harnessFor([], { boardId: 'b' })
    await expect(noKey.harness.drain('cardCreated')).rejects.toThrow('TRELLO_API_KEY is required')
  })

  it('retries a 429 once, then reports the failure with the body and without the URL', async () => {
    const { harness, sleep } = harnessFor([{ when: /\/actions$/, status: 429, body: 'API_TOKEN_LIMIT_EXCEEDED', headers: { 'retry-after': '0' } }])
    await expect(harness.drain('cardCreated')).rejects.toThrow(/^429: API_TOKEN_LIMIT_EXCEEDED$/)
    expect(sleep).toHaveBeenCalled()
  })

  it('replays its sample through dedupe', async () => {
    const trigger = packaged.triggers.find((entry) => entry.type === 'cardCreated')
    expect(trigger?.sample?.[0]).toMatchObject({ externalId: SAMPLE_CREATE_ACTION.id, updatedAt: SAMPLE_CREATE_ACTION.date })
  })
})

describe('cardMoved', () => {
  const move = (id: string, date: string, after: string) => ({
    id,
    type: 'updateCard',
    date,
    data: {
      card: { id: 'c', name: 'Bowie', shortLink: 'sl' },
      listBefore: { id: 'l1', name: 'Doing' },
      listAfter: { id: after, name: after === 'l2' ? 'Done' : 'Elsewhere' },
      old: { idList: 'l1' }
    }
  })

  it('carries the card and the lists before and after', async () => {
    const { harness, sent } = harnessFor([{ when: /\/actions$/, body: [move('m1', '2026-09-06T10:00:00.000Z', 'l2')] }])
    const [item] = await harness.drain('cardMoved', { since: '2026-09-06T09:00:00.000Z' })
    expect(sent[0].url.searchParams.get('filter')).toBe('updateCard:idList')
    expect(item).toMatchObject({
      externalId: 'm1',
      title: 'Card moved: Bowie (Doing → Done)',
      url: 'https://trello.com/c/sl',
      listBefore: { id: 'l1', name: 'Doing' },
      listAfter: { id: 'l2', name: 'Done' }
    })
  })

  it('keeps only arrivals in the destination list when one is set', async () => {
    const routes = [{ when: /\/actions$/, body: [move('m2', '2026-09-06T11:00:00.000Z', 'l3'), move('m1', '2026-09-06T10:00:00.000Z', 'l2')] }]
    const { harness } = harnessFor(routes, { ...CONFIG, toListId: 'l2' })
    const items = await harness.drain('cardMoved', { since: '2026-09-06T09:00:00.000Z' })
    expect(items.map((item) => item.externalId)).toEqual(['m1'])
  })

  it('replays its sample through dedupe', () => {
    const trigger = packaged.triggers.find((entry) => entry.type === 'cardMoved')
    expect(trigger?.sample?.[0]).toMatchObject({ externalId: SAMPLE_MOVE_ACTION.id })
  })
})

describe('commentAdded', () => {
  it('asks for commentCard actions and titles the comment', async () => {
    const comment = { ...SAMPLE_COMMENT_ACTION, date: '2026-09-06T10:00:00.000Z' }
    const { harness, sent } = harnessFor([{ when: /\/actions$/, body: [comment] }])
    const [item] = await harness.drain('commentAdded', { since: '2026-09-06T09:00:00.000Z' })
    expect(sent[0].url.searchParams.get('filter')).toBe('commentCard')
    expect(item).toMatchObject({
      externalId: SAMPLE_ID,
      title: 'Bob Loblaw (Trello) commented on Bowie: Can never go wrong with bowie',
      description: 'Can never go wrong with bowie'
    })
  })
})

describe('cardDueSoon', () => {
  const card = (id: string, due: string | null, dueComplete = false) => ({ id, name: `Card ${id}`, due, dueComplete, shortUrl: `https://trello.com/c/${id}` })

  it('reads the board’s cards and keeps those due inside the window, soonest first', async () => {
    const cards = [card('late', '2026-09-08T00:00:00.000Z'), card('b', '2026-09-06T20:00:00.000Z'), card('a', '2026-09-06T13:00:00.000Z'), card('done', '2026-09-06T14:00:00.000Z', true), card('none', null)]
    const { harness, sent } = harnessFor([{ when: /\/cards$/, body: cards }])
    const items = await harness.drain('cardDueSoon')
    expect(items.map((item) => item.externalId)).toEqual(['a:2026-09-06T13:00:00.000Z', 'b:2026-09-06T20:00:00.000Z'])
    expect(items[0]).toMatchObject({ title: 'Due 2026-09-06T13:00:00.000Z: Card a', url: 'https://trello.com/c/a', updatedAt: NOW })
    const [{ url }] = sent
    expect(url.pathname).toBe('/1/boards/board-1/cards')
    expect(url.searchParams.get('fields')).toContain('dueComplete')
  })

  it('honours the configured window', async () => {
    const cards = [card('b', '2026-09-06T20:00:00.000Z'), card('a', '2026-09-06T13:00:00.000Z')]
    const { harness } = harnessFor([{ when: /\/cards$/, body: cards }], { ...CONFIG, withinHours: '2' })
    const items = await harness.drain('cardDueSoon')
    expect(items.map((item) => item.externalId)).toEqual(['a:2026-09-06T13:00:00.000Z'])
    const bad = harnessFor([{ when: /\/cards$/, body: cards }], { ...CONFIG, withinHours: '-1' })
    await expect(bad.harness.drain('cardDueSoon')).rejects.toThrow('TRELLO_WITHIN_HOURS must be a number above 0')
  })

  it('fires a card once per due date across polls, and again when the due date moves', async () => {
    const { harness } = harnessFor([{ when: /\/cards$/, bodies: [[card('a', '2026-09-06T13:00:00.000Z')], [card('a', '2026-09-06T13:00:00.000Z')], [card('a', '2026-09-06T15:00:00.000Z')]] }])
    const first = await harness.poll('cardDueSoon')
    expect(first.items.map((item) => item.externalId)).toEqual(['a:2026-09-06T13:00:00.000Z'])
    const second = await harness.poll('cardDueSoon', { cursor: first.nextCursor })
    expect(second.items).toEqual([])
    const third = await harness.poll('cardDueSoon', { cursor: second.nextCursor })
    expect(third.items.map((item) => item.externalId)).toEqual(['a:2026-09-06T15:00:00.000Z'])
  })

  it('replays its sample through dedupe', () => {
    const trigger = packaged.triggers.find((entry) => entry.type === 'cardDueSoon')
    expect(trigger?.sample?.[0]).toMatchObject({ externalId: `${SAMPLE_DUE_CARD.id}:${SAMPLE_DUE_CARD.due}` })
    expect(trigger?.sample?.[0].updatedAt).toBeUndefined()
  })
})

describe('actions', () => {
  const CARD = { id: 'c1', name: 'Bowie', idList: 'l1', closed: false, shortLink: 'sl', nonCard: true }

  it('createCard posts every given argument as a query parameter', async () => {
    const { harness, sent } = harnessFor([{ when: /^\/1\/cards$/, body: CARD }])
    const output = await harness.execute('createCard', {
      listId: 'l1',
      name: 'Bowie',
      description: 'd',
      due: '2026-09-18T12:00:00.000Z',
      labelIds: 'a, b',
      memberIds: '',
      position: 'top'
    })
    expect(output).toEqual({ id: 'c1', name: 'Bowie', idList: 'l1', closed: false, shortLink: 'sl' })
    const [{ method, url }] = sent
    expect(method).toBe('POST')
    expect(url.searchParams.get('idList')).toBe('l1')
    expect(url.searchParams.get('name')).toBe('Bowie')
    expect(url.searchParams.get('desc')).toBe('d')
    expect(url.searchParams.get('due')).toBe('2026-09-18T12:00:00.000Z')
    expect(url.searchParams.get('idLabels')).toBe('a,b')
    expect(url.searchParams.has('idMembers')).toBe(false)
    expect(url.searchParams.get('pos')).toBe('top')
    await expect(harness.execute('createCard', { listId: 'l1' })).rejects.toThrow(/requires "name"/)
  })

  it('updateCard sends only the inputs given', async () => {
    const { harness, sent } = harnessFor([{ when: /^\/1\/cards\/c1$/, body: CARD }])
    const output = await harness.execute('updateCard', { cardId: 'c1', name: 'New', dueComplete: 'true' })
    expect(output).toMatchObject({ id: 'c1' })
    expect(output).not.toHaveProperty('nonCard')
    const [{ method, url }] = sent
    expect(method).toBe('PUT')
    expect(url.pathname).toBe('/1/cards/c1')
    expect(url.searchParams.get('name')).toBe('New')
    expect(url.searchParams.get('dueComplete')).toBe('true')
    expect(url.searchParams.has('desc')).toBe(false)
    expect(url.searchParams.has('closed')).toBe(false)
    expect(url.searchParams.get('key')).toBe('key-1')
    expect(url.searchParams.get('token')).toBe('token-1')
  })

  it('moveCard puts the list, position and board', async () => {
    const { harness, sent } = harnessFor([{ when: /^\/1\/cards\/c1$/, body: CARD }])
    await harness.execute('moveCard', { cardId: 'c1', listId: 'l2', position: 'bottom', boardId: 'b2' })
    const [{ method, url }] = sent
    expect(method).toBe('PUT')
    expect(url.searchParams.get('idList')).toBe('l2')
    expect(url.searchParams.get('pos')).toBe('bottom')
    expect(url.searchParams.get('idBoard')).toBe('b2')
  })

  it('addComment posts the text and returns the action', async () => {
    const reply = { id: 'a1', type: 'commentCard', date: NOW, data: { text: 'hi' }, memberCreator: { id: 'm' }, limits: {} }
    const { harness, sent } = harnessFor([{ when: /actions\/comments$/, body: reply }])
    await expect(harness.execute('addComment', { cardId: 'c1', text: 'hi' })).resolves.toEqual({
      id: 'a1',
      type: 'commentCard',
      date: NOW,
      data: { text: 'hi' },
      memberCreator: { id: 'm' }
    })
    expect(sent[0].method).toBe('POST')
    expect(sent[0].url.searchParams.get('text')).toBe('hi')
  })

  it('addLabel returns the label ids, and treats an already-present label as done', async () => {
    const { harness, sent } = harnessFor([{ when: /idLabels$/, body: ['l1', 'l2'] }])
    await expect(harness.execute('addLabel', { cardId: 'c1', labelId: 'l2' })).resolves.toEqual({ labelIds: ['l1', 'l2'], alreadyPresent: false })
    expect(sent[0].url.searchParams.get('value')).toBe('l2')
    const repeat = harnessFor([{ when: /idLabels$/, status: 400, body: 'that label is already on the card' }])
    await expect(repeat.harness.execute('addLabel', { cardId: 'c1', labelId: 'l2' })).resolves.toEqual({ labelIds: ['l2'], alreadyPresent: true })
    const other = harnessFor([{ when: /idLabels$/, status: 400, body: 'invalid id' }])
    await expect(other.harness.execute('addLabel', { cardId: 'c1', labelId: 'l2' })).rejects.toThrow('400: invalid id')
  })

  it('archiveCard puts closed=true', async () => {
    const { harness, sent } = harnessFor([{ when: /^\/1\/cards\/c1$/, body: { ...CARD, closed: true } }])
    await expect(harness.execute('archiveCard', { cardId: 'c1' })).resolves.toMatchObject({ closed: true })
    expect(sent[0].method).toBe('PUT')
    expect(sent[0].url.searchParams.get('closed')).toBe('true')
  })

  it('getCard reads the card with its list and board', async () => {
    const { harness, sent } = harnessFor([{ when: /^\/1\/cards\/sl$/, body: { ...CARD, list: { id: 'l1' }, board: { id: 'b' } } }])
    const output = await harness.execute('getCard', { cardId: 'sl' })
    expect(output).toMatchObject({ id: 'c1', list: { id: 'l1' }, board: { id: 'b' } })
    expect(output).not.toHaveProperty('nonCard')
    const [{ url }] = sent
    expect(url.searchParams.get('fields')).toBe('all')
    expect(url.searchParams.get('list')).toBe('true')
    expect(url.searchParams.get('board_fields')).toBe('name,shortUrl')
  })

  it('listBoards, listLists and listCards return the bare list as items', async () => {
    const { harness, sent } = harnessFor([
      { when: /members\/me\/boards$/, body: [{ id: 'b1' }] },
      { when: /boards\/b1\/lists$/, body: [{ id: 'l1' }] },
      { when: /lists\/l1\/cards$/, body: [CARD] }
    ])
    await expect(harness.execute('listBoards', { filter: 'closed' })).resolves.toEqual({ items: [{ id: 'b1' }] })
    expect(sent[0].url.searchParams.get('filter')).toBe('closed')
    expect(sent[0].url.searchParams.get('fields')).toContain('shortUrl')
    await expect(harness.execute('listLists', { boardId: 'b1' })).resolves.toEqual({ items: [{ id: 'l1' }] })
    expect(sent[1].url.searchParams.has('filter')).toBe(false)
    await expect(harness.execute('listCards', { listId: 'l1' })).resolves.toEqual({ items: [CARD] })
    expect(sent[2].url.searchParams.get('fields')).toBe(CARD_FIELDS)
  })

  it('searchCards asks for cards only and reads either answer shape', async () => {
    const { harness, sent } = harnessFor([{ when: /search$/, bodies: [{ cards: [CARD] }, [CARD, { id: 'b', idOrganization: 'o' }]] }])
    await expect(harness.execute('searchCards', { query: 'bowie', boardIds: 'b1 , b2', limit: '5', partial: 'true' })).resolves.toEqual({ cards: [CARD], count: 1 })
    const [{ url }] = sent
    expect(url.searchParams.get('query')).toBe('bowie')
    expect(url.searchParams.get('modelTypes')).toBe('cards')
    expect(url.searchParams.get('idBoards')).toBe('b1,b2')
    expect(url.searchParams.get('cards_limit')).toBe('5')
    expect(url.searchParams.get('partial')).toBe('true')
    expect(url.searchParams.get('card_list')).toBe('true')
    await expect(harness.execute('searchCards', { query: 'bowie' })).resolves.toEqual({ cards: [CARD], count: 1 })
    expect(sent[1].url.searchParams.has('cards_limit')).toBe(false)
    expect(sent[1].url.searchParams.has('partial')).toBe(false)
  })

  it('every action survives the placeholder run the mock check makes', async () => {
    const { harness } = harnessFor([{ when: /.*/, body: {} }])
    for (const entry of packaged.actions) {
      const args = Object.fromEntries((entry.inputs ?? []).map((input) => [input.key, input.type === 'boolean' ? 'false' : input.type === 'number' ? '1' : 'check']))
      await expect(harness.execute(entry.type, args), entry.type).resolves.toBeTypeOf('object')
    }
  })

  it('reports a declared request failure with the body text', async () => {
    const { harness } = harnessFor([{ when: /.*/, status: 401, body: 'invalid token' }])
    await expect(harness.execute('getCard', { cardId: 'c1' })).rejects.toThrow(/401.*invalid token/)
  })
})
