import {
  defineConnector,
  type ActionContext,
  type ConnectorConfig,
  type ConnectorItem,
  type FetchContext,
  type PreflightResult
} from '@vornrun/connector-sdk'
import {
  API_ROOT,
  MAX_ACTION_LIMIT,
  MAX_ACTION_PAGES,
  TrelloApiError,
  createTrelloClient,
  type TrelloAction,
  type TrelloCard
} from './client'
import {
  SAMPLE_COMMENT_ACTION,
  SAMPLE_CREATE_ACTION,
  SAMPLE_DUE_CARD,
  SAMPLE_ID,
  SAMPLE_MOVE_ACTION,
  commentItem,
  createdItem,
  dueSoonItem,
  dueWithin,
  movedItem,
  movedLists
} from './items'
// Bundled at build time: a pack is one file, so a version read from disk is not there to read.
import pkg from '../package.json'

export interface TrelloConnectorOptions {
  version?: string
  /** Where preflight and live samples read from; defaults to the process environment. */
  env?: NodeJS.ProcessEnv
  /** Replaced in tests so a rate-limit wait costs no real time. */
  sleep?: (ms: number) => Promise<void>
  /** The fetch preflight uses; defaults to the global one. */
  fetch?: typeof fetch
}

// How far back the very first poll looks, before any watermark exists.
export const FIRST_POLL_LOOKBACK_MS = 24 * 3_600_000

export const DEFAULT_WITHIN_HOURS = 24

// The fields every card read asks for, so an item and an output carry the same shape.
export const CARD_FIELDS =
  'id,name,desc,closed,due,start,dueComplete,dateLastActivity,idBoard,idList,idLabels,idMembers,idShort,labels,pos,shortLink,shortUrl,url,badges,cover'

const DUE_CARD_FIELDS = 'id,name,due,dueComplete,closed,idList,idBoard,shortUrl,url,dateLastActivity,idMembers,labels'

const SEARCH_CARD_FIELDS = 'id,name,desc,closed,due,dueComplete,idBoard,idList,labels,shortUrl,url,dateLastActivity'

const CARD_KEYS = CARD_FIELDS.split(',')

const ACTION_KEYS = ['id', 'idMemberCreator', 'type', 'date', 'data', 'memberCreator']

const AUTH_QUERY = { key: '{{config.apiKey}}', token: '{{config.token}}' }

const ADMIN_URL = 'https://trello.com/power-ups/admin'

export function text(value: unknown): string | undefined {
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

// A comma-separated list as the API wants it, with the whitespace a person types around the commas removed.
export function listArg(value: unknown): string | undefined {
  const raw = text(value)
  if (raw === undefined) return undefined
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  return entries.length > 0 ? entries.join(',') : undefined
}

// A positive number; unset stays unset so the API or the connector applies its own default.
export function count(value: unknown, key: string, max?: number): number | undefined {
  if (value === undefined || value === '') return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0 || (max !== undefined && number > max)) {
    const bound = max === undefined ? 'above 0' : `from 1 to ${max}`
    throw new Error(`${key} must be a number ${bound}, got "${String(value)}"`)
  }
  return number
}

function flag(value: unknown): 'true' | 'false' | undefined {
  if (value === true || value === 'true') return 'true'
  if (value === false || value === 'false') return 'false'
  return undefined
}

function pickKeys(value: unknown, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!isRecord(value)) return out
  for (const key of keys) if (key in value) out[key] = value[key]
  return out
}

export function cardOutput(value: unknown): Record<string, unknown> {
  return pickKeys(value, CARD_KEYS)
}

// The cards a search answered with: under `cards` when the answer is an object, the card-shaped entries when it is a list.
export function searchCards(value: unknown): TrelloCard[] {
  if (Array.isArray(value)) return value.filter((entry): entry is TrelloCard => isRecord(entry) && 'idList' in entry)
  if (isRecord(value) && Array.isArray(value.cards)) return value.cards.filter(isRecord) as TrelloCard[]
  return []
}

// Whether a 400 says the label is already on the card, which is the state the action asked for.
export function alreadyLabelled(error: unknown): boolean {
  return error instanceof TrelloApiError && error.status === 400 && /already/i.test(error.body)
}

export interface PreflightOptions {
  apiKey?: string | undefined
  token?: string | undefined
  fetch?: typeof fetch
}

// The cheapest read that proves both values at once, called at connect time only: /members/ has a budget of 100 per 900 seconds.
export async function trelloPreflight(options: PreflightOptions): Promise<PreflightResult> {
  const apiKey = text(options.apiKey)
  const token = text(options.token)
  if (apiKey === undefined || token === undefined) {
    return {
      ok: false,
      message: `Set TRELLO_API_KEY and TRELLO_TOKEN: generate an API key at ${ADMIN_URL}, then open its Token link to grant a read and write token.`
    }
  }
  try {
    const me = await createTrelloClient({ apiKey, token, fetch: options.fetch ?? fetch }).me()
    return { ok: true, message: `Signed in as ${me.fullName ?? me.username ?? me.id ?? 'a Trello member'}` }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      message: `Trello refused the key and token (${reason}); grant a new token from the API key's Token link at ${ADMIN_URL}.`
    }
  }
}

const CARD_ID_INPUT = {
  key: 'cardId',
  label: 'Card',
  required: true,
  description: 'The card id (24 hex characters) or the short link from its URL, trello.com/c/<shortLink>.',
  builderHint: 'Sent URL-encoded as the path segment of /cards/{id}; an unknown id answers 400 with a plain-text body such as "invalid id", or 404.'
}

const POSITION_INPUT = {
  key: 'position',
  label: 'Position',
  description: 'top, bottom, or a positive number for the card’s place in the list.',
  builderHint: 'Sent as pos; the reference allows "top, bottom, or a positive float".'
}

const BOARD_ID_INPUT = {
  key: 'boardId',
  label: 'Board',
  required: true,
  description: 'The board id or the short link from its URL, trello.com/b/<shortLink>/….',
  builderHint: 'Sent URL-encoded as the path segment of /boards/{id}; the API accepts the short link in place of the id.'
}

const CARD_OUTPUTS = [
  { key: 'id', description: 'Card id' },
  { key: 'name', description: 'Card name' },
  { key: 'desc', description: 'Card description, Markdown' },
  { key: 'closed', type: 'boolean' as const, description: 'True when the card is archived' },
  { key: 'due', description: 'Due date, ISO 8601, or null' },
  { key: 'dueComplete', type: 'boolean' as const, description: 'Whether the due date is marked complete' },
  { key: 'idBoard', description: 'The board the card is on' },
  { key: 'idList', description: 'The list the card is in' },
  { key: 'idLabels', description: 'Label ids on the card' },
  { key: 'idMembers', description: 'Member ids on the card' },
  { key: 'labels', description: 'Labels on the card: id, name, color' },
  { key: 'pos', type: 'number' as const, description: 'Position within the list' },
  { key: 'shortLink', description: 'The short link in the card URL' },
  { key: 'shortUrl', description: 'https://trello.com/c/<shortLink>' },
  { key: 'url', description: 'The full card URL' },
  { key: 'dateLastActivity', description: 'When the card last changed, ISO 8601' }
]

export function createTrelloConnector(options: TrelloConnectorOptions = {}) {
  const env = options.env ?? process.env

  function client(context: { config: ConnectorConfig; fetch: typeof fetch }) {
    return createTrelloClient({
      apiKey: required(context.config, 'apiKey', 'TRELLO_API_KEY'),
      token: required(context.config, 'token', 'TRELLO_TOKEN'),
      fetch: context.fetch,
      ...(options.sleep && { sleep: options.sleep })
    })
  }

  // The watermark, or the day before now on the very first poll rather than the board's whole history.
  function watermarkOf(context: FetchContext): string {
    return context.since ?? new Date(Date.parse(context.now()) - FIRST_POLL_LOOKBACK_MS).toISOString()
  }

  // Newest first from the API, walked back with `before` while pages are full, then reversed so the oldest is delivered first.
  async function fetchActions(context: FetchContext, filter: string): Promise<TrelloAction[]> {
    const boardId = required(context.config, 'boardId', 'TRELLO_BOARD_ID')
    const since = watermarkOf(context)
    const api = client(context)
    const collected: TrelloAction[] = []
    let before: string | undefined
    for (let page = 0; page < MAX_ACTION_PAGES; page++) {
      const batch = await api.boardActions(boardId, { filter, since, before, limit: MAX_ACTION_LIMIT })
      collected.push(...batch)
      const oldest = batch[batch.length - 1]?.date
      if (batch.length < MAX_ACTION_LIMIT || oldest === undefined) break
      before = oldest
    }
    return collected.reverse()
  }

  async function fetchCreated(context: FetchContext): Promise<ConnectorItem[]> {
    return (await fetchActions(context, 'createCard')).map(createdItem)
  }

  async function fetchMoved(context: FetchContext): Promise<ConnectorItem[]> {
    const toListId = text(context.config.toListId)
    const actions = await fetchActions(context, 'updateCard:idList')
    return actions
      .filter((action) => toListId === undefined || movedLists(action).after?.id === toListId)
      .map(movedItem)
  }

  async function fetchComments(context: FetchContext): Promise<ConnectorItem[]> {
    return (await fetchActions(context, 'commentCard')).map(commentItem)
  }

  // No cursor: the window moves with the clock, so every poll re-reads the board and dedupe does the filtering.
  async function fetchDueSoon(context: FetchContext): Promise<ConnectorItem[]> {
    const boardId = required(context.config, 'boardId', 'TRELLO_BOARD_ID')
    const withinHours = count(context.config.withinHours, 'TRELLO_WITHIN_HOURS') ?? DEFAULT_WITHIN_HOURS
    const cards = await client(context).boardCards(boardId, DUE_CARD_FIELDS)
    return dueWithin(cards, context.now(), withinHours)
      .sort((left, right) => String(left.due).localeCompare(String(right.due)))
      .map(dueSoonItem)
  }

  async function createCard(args: Record<string, unknown>, context: ActionContext) {
    const card = await client(context).createCard({
      idList: String(args.listId),
      name: String(args.name),
      desc: text(args.description),
      due: text(args.due),
      idLabels: listArg(args.labelIds),
      idMembers: listArg(args.memberIds),
      pos: text(args.position)
    })
    return cardOutput(card)
  }

  async function addComment(args: Record<string, unknown>, context: ActionContext) {
    const action = await client(context).addComment(String(args.cardId), String(args.text))
    return pickKeys(action, ACTION_KEYS)
  }

  async function addLabel(args: Record<string, unknown>, context: ActionContext) {
    const labelId = String(args.labelId)
    try {
      const result = await client(context).addLabel(String(args.cardId), labelId)
      return { labelIds: Array.isArray(result) ? result : [], alreadyPresent: false }
    } catch (error) {
      if (!alreadyLabelled(error)) throw error
      return { labelIds: [labelId], alreadyPresent: true }
    }
  }

  async function search(args: Record<string, unknown>, context: ActionContext) {
    const result = await client(context).search({
      query: String(args.query),
      idBoards: listArg(args.boardIds),
      cards_limit: count(args.limit, 'limit', 1000),
      partial: flag(args.partial),
      modelTypes: 'cards',
      card_list: 'true',
      card_board: 'true',
      card_fields: SEARCH_CARD_FIELDS
    })
    const cards = searchCards(result)
    return { cards, count: cards.length }
  }

  // Live samples come from the environment; the reference's placeholder id stands in where a real one is not known.
  const sampleBoard = text(env.TRELLO_BOARD_ID) ?? SAMPLE_ID
  const sampleList = text(env.TRELLO_LIST_ID) ?? SAMPLE_ID
  const sampleCard = text(env.TRELLO_CARD_ID) ?? SAMPLE_ID
  const throwawayCard = text(env.TRELLO_ARCHIVE_CARD_ID)

  return defineConnector({
    id: 'trello',
    name: 'Trello',
    version: options.version ?? pkg.version,
    description:
      'Trigger workflows from cards created, moved, commented on or due soon on a Trello board, and create, update, move, comment on, label, archive, read and search cards from a step.',
    // Trello's tile: a rounded square with two list columns cut out, the left one reaching lower than the right.
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M5 2h14a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3zm1.5 3.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-11a1 1 0 0 0-1-1h-3zm8 0a1 1 0 0 0-1 1V12a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1h-3z'
      ]
    },
    auth: { rung: 'key', keys: ['apiKey', 'token'] },
    config: [
      {
        key: 'apiKey',
        env: 'TRELLO_API_KEY',
        label: 'API key',
        secret: true,
        required: true,
        description: `The Power-Up API key: create a Power-Up at ${ADMIN_URL}, open its API Key tab and generate a key.`,
        builderHint:
          'Sent as the key query parameter on every call, never as a header. The guide calls keys public, but one is only useful with the token it authorized, so it is kept secret too. There is no Trello CLI to borrow a login from.'
      },
      {
        key: 'token',
        env: 'TRELLO_TOKEN',
        label: 'Token',
        secret: true,
        required: true,
        description:
          'The member token the API key’s Token link grants: approve read and write access with expiration never, then copy the token shown.',
        builderHint:
          'Sent as the token query parameter on every call. The link is /1/authorize?expiration=never&scope=read,write&response_type=token&key=<apiKey>. A revoked or wrong token answers 401 with the text "invalid token".'
      },
      {
        key: 'boardId',
        env: 'TRELLO_BOARD_ID',
        label: 'Board',
        required: true,
        description: 'The board the triggers watch, by id or by the short link from its URL (trello.com/b/<shortLink>/…).',
        builderHint: 'Only the triggers read it; every action takes its own ids. listBoards returns the ids of every board the token can see.'
      },
      {
        key: 'toListId',
        env: 'TRELLO_TO_LIST_ID',
        label: 'Destination list',
        description: 'For the card-moved trigger: only fire when a card lands in this list. Blank fires on every move.',
        builderHint: 'Compared with data.listAfter.id of each updateCard:idList action; listLists returns the ids of a board’s lists.'
      },
      {
        key: 'withinHours',
        env: 'TRELLO_WITHIN_HOURS',
        label: 'Due within hours',
        default: String(DEFAULT_WITHIN_HOURS),
        description: 'For the card-due-soon trigger: how many hours ahead a due date must fall to fire.',
        builderHint: 'Applied here, not by the API: the board’s open cards are read and kept when due is between now and now plus this many hours and dueComplete is false.'
      }
    ],
    preflight: () =>
      trelloPreflight({
        apiKey: env.TRELLO_API_KEY,
        token: env.TRELLO_TOKEN,
        ...(options.fetch && { fetch: options.fetch })
      }),
    triggers: [
      {
        type: 'cardCreated',
        label: 'A card is created',
        description: 'Fires once for each card created on the board since the last poll, oldest first.',
        dedupe: 'timestamp',
        fetch: fetchCreated,
        defaultWorkflow: { name: 'Trello: new cards', defaultCronFromMinutes: 5 },
        sample: [createdItem(SAMPLE_CREATE_ACTION)]
      },
      {
        type: 'cardMoved',
        label: 'A card moves to another list',
        description:
          'Fires once for each card moved between lists on the board, with the list before and after. Set a destination list to fire only on arrivals there.',
        dedupe: 'timestamp',
        fetch: fetchMoved,
        defaultWorkflow: { name: 'Trello: moved cards', defaultCronFromMinutes: 5 },
        sample: [movedItem(SAMPLE_MOVE_ACTION)]
      },
      {
        type: 'commentAdded',
        label: 'A comment is added',
        description: 'Fires once for each comment added to a card on the board since the last poll.',
        dedupe: 'timestamp',
        fetch: fetchComments,
        defaultWorkflow: { name: 'Trello: new comments', defaultCronFromMinutes: 5 },
        sample: [commentItem(SAMPLE_COMMENT_ACTION)]
      },
      {
        type: 'cardDueSoon',
        label: 'A card is due soon',
        description:
          'Fires once per due date for each open card on the board whose due date falls within the configured hours and is not marked complete. A changed due date fires again.',
        dedupe: 'timestamp',
        fetch: fetchDueSoon,
        defaultWorkflow: { name: 'Trello: cards due soon', defaultCronFromMinutes: 30 },
        sample: [dueSoonItem(SAMPLE_DUE_CARD)]
      }
    ],
    actions: [
      {
        type: 'createCard',
        label: 'Create a card',
        description: 'Add a card to a list.',
        // Two calls make two cards; Trello offers no idempotency key.
        idempotent: false,
        inputs: [
          {
            key: 'listId',
            label: 'List',
            required: true,
            description: 'The id of the list the card should be created in.',
            builderHint: 'Sent as idList on POST /cards; listLists returns the ids of a board’s lists.'
          },
          {
            key: 'name',
            label: 'Name',
            required: true,
            description: 'The name for the card.',
            builderHint: 'Sent as name; the API allows it empty, the connector does not.'
          },
          {
            key: 'description',
            label: 'Description',
            description: 'The description for the card, Markdown.',
            builderHint: 'Sent as desc, only when given.'
          },
          {
            key: 'due',
            label: 'Due date',
            description: 'A due date for the card, ISO 8601 such as 2026-09-18T12:00:00.000Z.',
            builderHint: 'Sent as due; "The API expects a ISO 8601 date format".'
          },
          {
            key: 'labelIds',
            label: 'Label ids',
            description: 'Comma-separated ids of labels to add to the card.',
            builderHint: 'Sent as idLabels, comma-separated as the reference wants; whitespace around commas is removed.'
          },
          {
            key: 'memberIds',
            label: 'Member ids',
            description: 'Comma-separated ids of members to add to the card.',
            builderHint: 'Sent as idMembers, comma-separated; whitespace around commas is removed.'
          },
          POSITION_INPUT
        ],
        outputs: CARD_OUTPUTS,
        run: createCard
      },
      {
        type: 'updateCard',
        label: 'Update a card',
        description: 'Change the name, description, due date, due-complete flag or archived state of a card; only the inputs given are sent.',
        // A repeat sets the same values, so a retry lands the same card.
        idempotent: true,
        inputs: [
          CARD_ID_INPUT,
          {
            key: 'name',
            label: 'Name',
            description: 'The new name for the card.',
            builderHint: 'Sent as name on PUT /cards/{id}, only when given.'
          },
          {
            key: 'description',
            label: 'Description',
            description: 'The new description for the card.',
            builderHint: 'Sent as desc, only when given.'
          },
          {
            key: 'due',
            label: 'Due date',
            description: 'When the card is due, ISO 8601, or the word null to clear it.',
            builderHint: 'Sent as due; the reference documents "null" as the value that clears the date.'
          },
          {
            key: 'dueComplete',
            label: 'Due complete',
            type: 'boolean',
            description: 'Whether the due date is marked complete.',
            builderHint: 'Sent as dueComplete=true or false, only when given.'
          },
          {
            key: 'closed',
            label: 'Archived',
            type: 'boolean',
            description: 'True archives the card, false restores it.',
            builderHint: 'Sent as closed=true or false, only when given.'
          }
        ],
        outputs: CARD_OUTPUTS,
        request: {
          method: 'PUT',
          url: `${API_ROOT}/cards/{{args.cardId}}`,
          query: {
            ...AUTH_QUERY,
            name: '{{args.name}}',
            desc: '{{args.description}}',
            due: '{{args.due}}',
            dueComplete: '{{args.dueComplete}}',
            closed: '{{args.closed}}'
          }
        },
        postReceive: [{ op: 'pick', keys: CARD_KEYS }]
      },
      {
        type: 'moveCard',
        label: 'Move a card',
        description: 'Move a card to a list, optionally at a position or onto another board.',
        idempotent: true,
        inputs: [
          CARD_ID_INPUT,
          {
            key: 'listId',
            label: 'List',
            required: true,
            description: 'The id of the list the card should be in.',
            builderHint: 'Sent as idList on PUT /cards/{id}.'
          },
          POSITION_INPUT,
          {
            key: 'boardId',
            label: 'Board',
            description: 'The id of the board the card should be on, for a move across boards.',
            builderHint: 'Sent as idBoard, only when given; the list must belong to that board.'
          }
        ],
        outputs: CARD_OUTPUTS,
        request: {
          method: 'PUT',
          url: `${API_ROOT}/cards/{{args.cardId}}`,
          query: { ...AUTH_QUERY, idList: '{{args.listId}}', pos: '{{args.position}}', idBoard: '{{args.boardId}}' }
        },
        postReceive: [{ op: 'pick', keys: CARD_KEYS }]
      },
      {
        type: 'addComment',
        label: 'Add a comment',
        description: 'Comment on a card.',
        // Two calls make two comments.
        idempotent: false,
        inputs: [
          CARD_ID_INPUT,
          {
            key: 'text',
            label: 'Text',
            required: true,
            description: 'The comment, Markdown.',
            builderHint: 'Sent as text on POST /cards/{id}/actions/comments.'
          }
        ],
        outputs: [
          { key: 'id', description: 'The comment action id' },
          { key: 'type', description: 'commentCard' },
          { key: 'date', description: 'When the comment was posted, ISO 8601' },
          { key: 'data', description: 'text, card { id, name, shortLink }, board and list' },
          { key: 'memberCreator', description: 'Who commented: id, fullName, username' }
        ],
        run: addComment
      },
      {
        type: 'addLabel',
        label: 'Add a label to a card',
        description: 'Put a label on a card. A label already on the card is reported as present rather than as a failure.',
        idempotent: true,
        inputs: [
          CARD_ID_INPUT,
          {
            key: 'labelId',
            label: 'Label',
            required: true,
            description: 'The id of the label to add.',
            builderHint: 'Sent as value on POST /cards/{id}/idLabels; a repeat answers 400 saying the label is already on the card, which the action treats as success.'
          }
        ],
        outputs: [
          { key: 'labelIds', description: 'The card’s label ids as the API returned them' },
          { key: 'alreadyPresent', type: 'boolean', description: 'True when the label was on the card before the call' }
        ],
        run: addLabel
      },
      {
        type: 'archiveCard',
        label: 'Archive a card',
        description: 'Archive a card. A second call leaves it archived.',
        idempotent: true,
        inputs: [CARD_ID_INPUT],
        outputs: CARD_OUTPUTS,
        ...(throwawayCard && { sample: { cardId: throwawayCard } }),
        request: {
          method: 'PUT',
          url: `${API_ROOT}/cards/{{args.cardId}}`,
          query: { ...AUTH_QUERY, closed: 'true' }
        },
        postReceive: [{ op: 'pick', keys: CARD_KEYS }]
      },
      {
        type: 'getCard',
        label: 'Get a card',
        description: 'Read one card with its list and board.',
        idempotent: true,
        inputs: [CARD_ID_INPUT],
        outputs: [
          ...CARD_OUTPUTS,
          { key: 'list', description: 'The list the card is in: id, name' },
          { key: 'board', description: 'The board the card is on: id, name, shortUrl' }
        ],
        sample: { cardId: sampleCard },
        request: {
          url: `${API_ROOT}/cards/{{args.cardId}}`,
          query: { ...AUTH_QUERY, fields: 'all', list: 'true', board: 'true', board_fields: 'name,shortUrl' }
        },
        postReceive: [{ op: 'pick', keys: [...CARD_KEYS, 'list', 'board'] }]
      },
      {
        type: 'listBoards',
        label: 'List boards',
        description: 'The boards the token’s member belongs to, open ones by default.',
        idempotent: true,
        inputs: [
          {
            key: 'filter',
            label: 'Filter',
            description: 'all, or a comma-separated list of closed, members, open, organization, public, starred. Defaults to open.',
            builderHint: 'Sent as filter on GET /members/me/boards; this route is under /members/, whose budget is 100 requests per 900 seconds.'
          }
        ],
        outputs: [{ key: 'items', description: 'One entry per board: id, name, desc, closed, idOrganization, url, shortUrl, dateLastActivity' }],
        sample: {},
        request: {
          url: `${API_ROOT}/members/me/boards`,
          query: {
            ...AUTH_QUERY,
            filter: '{{args.filter}}',
            fields: 'id,name,desc,closed,idOrganization,url,shortUrl,dateLastActivity'
          }
        }
      },
      {
        type: 'listLists',
        label: 'List lists on a board',
        description: 'The lists of a board, open ones by default.',
        idempotent: true,
        inputs: [
          BOARD_ID_INPUT,
          {
            key: 'filter',
            label: 'Filter',
            description: 'all, closed, none or open. Defaults to open.',
            builderHint: 'Sent as filter on GET /boards/{id}/lists.'
          }
        ],
        outputs: [{ key: 'items', description: 'One entry per list: id, name, closed, idBoard, pos' }],
        sample: { boardId: sampleBoard },
        request: {
          url: `${API_ROOT}/boards/{{args.boardId}}/lists`,
          query: { ...AUTH_QUERY, filter: '{{args.filter}}', fields: 'id,name,closed,idBoard,pos' }
        }
      },
      {
        type: 'listCards',
        label: 'List cards in a list',
        description: 'The open cards of a list.',
        idempotent: true,
        inputs: [
          {
            key: 'listId',
            label: 'List',
            required: true,
            description: 'The id of the list.',
            builderHint: 'Sent URL-encoded as the path segment of GET /lists/{id}/cards; the answer is one unpaged array.'
          }
        ],
        outputs: [{ key: 'items', description: 'One entry per card, in the card shape getCard returns' }],
        sample: { listId: sampleList },
        request: {
          url: `${API_ROOT}/lists/{{args.listId}}/cards`,
          query: { ...AUTH_QUERY, fields: CARD_FIELDS }
        }
      },
      {
        type: 'searchCards',
        label: 'Search cards',
        description: 'Find cards matching a query across the member’s boards or the given ones.',
        idempotent: true,
        inputs: [
          {
            key: 'query',
            label: 'Query',
            required: true,
            description: 'The search query, 1 to 16384 characters; Trello’s search operators such as due:week and label:red work here.',
            builderHint: 'Sent as query on GET /search with modelTypes=cards.'
          },
          {
            key: 'boardIds',
            label: 'Board ids',
            description: 'mine, or a comma-separated list of board ids to search in. Blank searches every board the member can see.',
            builderHint: 'Sent as idBoards, comma-separated; whitespace around commas is removed.'
          },
          {
            key: 'limit',
            label: 'Limit',
            type: 'number',
            description: 'The maximum number of cards to return, 1 to 1000. Defaults to 10.',
            builderHint: 'Sent as cards_limit; cards_page is not exposed, so one call reads one page.'
          },
          {
            key: 'partial',
            label: 'Partial',
            type: 'boolean',
            description: 'Match content that starts with any of the words in the query.',
            builderHint: 'Sent as partial=true only when set.'
          }
        ],
        outputs: [
          { key: 'cards', description: 'The matching cards with their list and board' },
          { key: 'count', type: 'number', description: 'How many cards came back' }
        ],
        sample: { query: 'test' },
        run: search
      }
    ]
  })
}

export const connector = createTrelloConnector()
