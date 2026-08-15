import {
  defineConnector,
  type ConnectorItem,
  type PollContext,
  type PollOutcome
} from '@vornrun/connector-sdk'
import {
  TelegramError,
  editMessageText,
  explainGetUpdatesFailure,
  getMe,
  getUpdates,
  redactToken,
  sendMessage,
  withFloodRetry,
  type FetchLike,
  type TelegramChat,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser
} from './client'

/** Telegram's documented maximum for `getUpdates`, and our default. */
export const MAX_LIMIT = 100

/** `sendMessage` refuses more than this, "after entities parsing". */
export const MAX_MESSAGE_LENGTH = 4096

const DEFAULT_POLL_TIMEOUT_SECONDS = 10

/**
 * The longest long poll this connector will hold open.
 *
 * Telegram documents no ceiling. This one is ours: the seeded workflow polls
 * every minute, and a poll that can outlive its own schedule stacks runs.
 */
const MAX_POLL_TIMEOUT_SECONDS = 50

/** How much of a message's first line becomes the item title. */
const TITLE_LIMIT = 120

/**
 * The update types this connector can turn into an item.
 *
 * Anything else is refused at config time rather than skipped at poll time.
 * Skipping would still *confirm* the update — reading is acking — so an
 * unmappable type asked for here would quietly destroy updates.
 */
export const SUPPORTED_UPDATE_TYPES = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post'
] as const

export type SupportedUpdateType = (typeof SUPPORTED_UPDATE_TYPES)[number]

/**
 * Defaults to both halves of the pair.
 *
 * An update carries at most one of these, so defaulting to `message` alone
 * would make the `edited` status below unreachable.
 */
const DEFAULT_UPDATE_TYPES: SupportedUpdateType[] = ['message', 'edited_message']

const EDIT_TYPES = new Set<SupportedUpdateType>(['edited_message', 'edited_channel_post'])

export interface TelegramConnectorOptions {
  version?: string
  /** Injected in tests, so nothing reaches the network. */
  fetchImpl?: FetchLike
  /** Injected in tests, so no test spends real time asleep. */
  sleep?: (ms: number) => Promise<void>
  /**
   * Where advisories go. Defaults to stderr: stdout carries the MCP protocol,
   * and the SDK gives a trigger no channel for a warning.
   */
  warn?: (message: string) => void
}

/* --------------------------------------------------------------- config -- */

function text(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim()
  return trimmed === '' ? undefined : trimmed
}

export interface Credentials {
  token: string
  /** The chat to watch and to default actions to. Blank means every chat. */
  chatId?: string
}

export function readCredentials(config: Record<string, unknown>): Credentials {
  const token = text(config.token)
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required. Create a bot with @BotFather.')
  const chatId = text(config.chatId)
  return { token, ...(chatId && { chatId }) }
}

function integer(value: unknown, env: string, fallback: number, min: number, max: number): number {
  const raw = text(value)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed)) throw new Error(`${env} must be a whole number, got "${raw}"`)
  if (parsed < min || parsed > max) {
    throw new Error(`${env} must be between ${min} and ${max}, got ${parsed}`)
  }
  return parsed
}

export function parseUpdateTypes(value: unknown): SupportedUpdateType[] {
  const raw = text(value)
  if (raw === undefined) return DEFAULT_UPDATE_TYPES
  const requested = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  if (requested.length === 0) return DEFAULT_UPDATE_TYPES

  const unsupported = requested.filter(
    (entry) => !SUPPORTED_UPDATE_TYPES.includes(entry as SupportedUpdateType)
  )
  if (unsupported.length > 0) {
    throw new Error(
      `TELEGRAM_UPDATE_TYPES does not support ${unsupported.join(', ')}. This connector reads ` +
        `${SUPPORTED_UPDATE_TYPES.join(', ')}. Asking for anything else would confirm those ` +
        'updates without turning them into items, and Telegram cannot hand them back.'
    )
  }
  // De-duplicated so `message,message` cannot become two identical items.
  return [...new Set(requested as SupportedUpdateType[])]
}

export interface Settings extends Credentials {
  updateTypes: SupportedUpdateType[]
  pollTimeoutSeconds: number
  limit: number
}

export function readSettings(config: Record<string, unknown>): Settings {
  return {
    ...readCredentials(config),
    updateTypes: parseUpdateTypes(config.updateTypes),
    pollTimeoutSeconds: integer(
      config.pollTimeout,
      'TELEGRAM_POLL_TIMEOUT',
      DEFAULT_POLL_TIMEOUT_SECONDS,
      0,
      MAX_POLL_TIMEOUT_SECONDS
    ),
    limit: integer(config.limit, 'TELEGRAM_LIMIT', MAX_LIMIT, 1, MAX_LIMIT)
  }
}

/* --------------------------------------------------------------- cursor -- */

/**
 * The cursor is the ack.
 *
 * `getUpdates(offset: N)` confirms everything below N and returns from N, so
 * the offset carried into the *next* poll is what confirms *this* poll's
 * messages. The host persists the items and this cursor from one response
 * together, which is the only reason nothing is ever confirmed that Vorn does
 * not already hold. It is opaque JSON so the shape can change without a
 * migration.
 */
interface CursorState {
  v: 1
  offset: number
}

export function formatCursor(offset: number): string {
  return JSON.stringify({ v: 1, offset } satisfies CursorState)
}

/**
 * Read a cursor back, treating anything unreadable as "start from what is
 * unconfirmed".
 *
 * Deliberately not a throw. A poll that refuses to run is a poll that is not
 * draining a 24-hour queue, and that costs messages; starting from the oldest
 * unconfirmed update costs at worst a few re-delivered items, which Vorn
 * dedupes on `externalId`. A negative or non-integer offset is treated the same
 * way — it must never reach the wire.
 */
export function parseCursor(
  raw: string | undefined,
  warn: (message: string) => void
): number | undefined {
  const resume = (why: string): undefined => {
    warn(`Telegram: ignoring ${why} (${raw?.slice(0, 80)}); resuming from the oldest unconfirmed update.`)
    return undefined
  }

  if (raw === undefined || raw.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return resume('an unreadable cursor')
  }

  const state = parsed as Partial<CursorState> | null
  const offset = state?.offset
  if (state?.v !== 1 || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    return resume('a cursor this connector did not write')
  }
  return offset
}

/**
 * The offset for the next poll, recalculated from this response.
 *
 * The reference instructs exactly this — "recalculate offset after each server
 * response" — rather than incrementing a counter we hold, which drifts the
 * moment a response is short, reordered or retried. It can only move forwards,
 * so a stray low `update_id` cannot walk the watermark back over messages the
 * host has already stored.
 */
export function nextOffset(updates: TelegramUpdate[], previous?: number): number | undefined {
  let next = previous
  for (const update of updates) {
    const id = update.update_id
    if (!Number.isSafeInteger(id) || id < 0) continue
    const candidate = id + 1
    if (next === undefined || candidate > next) next = candidate
  }
  return next
}

/* ---------------------------------------------------------------- items -- */

export function messageOf(
  update: TelegramUpdate
): { type: SupportedUpdateType; message: TelegramMessage } | undefined {
  for (const type of SUPPORTED_UPDATE_TYPES) {
    const message = update[type]
    if (message) return { type, message }
  }
  return undefined
}

/** What a person would call this chat. */
export function chatLabel(chat: TelegramChat): string {
  if (chat.title) return chat.title
  if (chat.username) return `@${chat.username}`
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ')
  return name || String(chat.id)
}

function authorLabel(user: TelegramUser): string {
  if (user.username) return `@${user.username}`
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || String(user.id)
}

function isoFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

/**
 * Does this message belong to the chat the connection watches?
 *
 * Matched on the numeric id as a string, or on `@username` for a public chat,
 * because both are things a person can get hold of and paste.
 */
export function matchesChat(chat: TelegramChat, wanted?: string): boolean {
  if (!wanted) return true
  if (String(chat.id) === wanted) return true
  const handle = wanted.startsWith('@') ? wanted.slice(1) : wanted
  return chat.username !== undefined && chat.username.toLowerCase() === handle.toLowerCase()
}

/**
 * One Telegram message as Vorn holds it.
 *
 * `externalId` is compound — `chatId:messageId` — because the reference defines
 * `message_id` as "unique message identifier inside this chat". Every other
 * connector here has a globally unique id; this one cannot.
 *
 * There is no `url`. Telegram's Bot API documents no permalink for a message,
 * and the `t.me` forms that circulate are not in the reference and do not work
 * for private chats. An invented link that 404s is worse than no link.
 */
export function updateToItem(
  update: TelegramUpdate,
  type: SupportedUpdateType,
  message: TelegramMessage
): ConnectorItem {
  const body = (message.text ?? message.caption ?? '').trim()
  const firstLine = body.split('\n')[0].trim()
  const title =
    firstLine.length > TITLE_LIMIT ? `${firstLine.slice(0, TITLE_LIMIT - 1)}…` : firstLine
  const author = message.from

  return {
    externalId: `${message.chat.id}:${message.message_id}`,
    // A photo with no caption has no text at all, and the SDK rejects an item
    // with an empty title.
    title: title || `Message ${message.message_id} in ${chatLabel(message.chat)}`,
    description: body,
    status: EDIT_TYPES.has(type) ? 'edited' : 'received',
    // Channel posts have no `from`, so there is not always an author.
    ...(author && { assignee: authorLabel(author) }),
    updatedAt: isoFromUnix(message.edit_date ?? message.date),
    data: {
      updateId: update.update_id,
      updateType: type,
      // A string: a chat id carries up to 52 significant bits, and a template
      // that rendered it as a rounded number would address the wrong chat.
      chatId: String(message.chat.id),
      chatType: message.chat.type,
      chatTitle: chatLabel(message.chat),
      messageId: message.message_id,
      ...(author && { fromUsername: author.username ?? '' }),
      sentAt: isoFromUnix(message.date),
      ...(message.edit_date !== undefined && { editedAt: isoFromUnix(message.edit_date) })
    }
  }
}

/* -------------------------------------------------------- privacy mode -- */

/**
 * What to say about privacy mode, if anything.
 *
 * A bot added to a group runs in privacy mode by default and sees only
 * commands and replies — the commonest way this connector looks broken while
 * being configured correctly. It is detectable, because `getMe` reports
 * `can_read_all_group_messages`.
 *
 * But the same paragraph exempts admins: "bot admins always receive all
 * messages". An admin bot can read everything while still reporting `false`,
 * so this is worded as a possibility and never as a verdict, and it never
 * blocks a poll.
 */
export function privacyModeWarning(me: TelegramUser): string | undefined {
  if (me.can_read_all_group_messages) return undefined
  return (
    `Telegram: @${me.username ?? me.first_name} has privacy mode on, so it may not see ordinary ` +
    'group messages — unless it is a group admin, which overrides privacy mode. To change it: ' +
    '@BotFather → /setprivacy → Disable, then remove and re-add the bot to the group, which is ' +
    'what makes the change take effect. Private chats are unaffected.'
  )
}

/* ------------------------------------------------------------ connector -- */

export function createTelegramConnector(options: TelegramConnectorOptions = {}) {
  const fetchImpl = options.fetchImpl
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const retryOptions = { ...(options.sleep && { sleep: options.sleep }) }

  // Checked once per process rather than once per poll: the answer only changes
  // when someone reconfigures the bot, and a connector process is per
  // connection.
  let privacyChecked = false

  async function warnOnPrivacyMode(token: string): Promise<void> {
    if (privacyChecked) return
    privacyChecked = true
    try {
      const message = privacyModeWarning(await getMe(token, fetchImpl))
      if (message) warn(message)
    } catch (error) {
      // Advisory only. A failure here is either transient or the same failure
      // the poll is about to report properly.
      warn(`Telegram: could not check privacy mode (${redactToken(String(error), token)}).`)
    }
  }

  /**
   * One page of updates.
   *
   * Hand-written rather than declarative because the cursor *is* the ack, so
   * the connector has to own its exact value. `context.since` is ignored:
   * Telegram has no time filter and no history endpoint, so the only thing that
   * decides what a poll returns is the offset.
   */
  async function pollUpdates(context: PollContext): Promise<PollOutcome> {
    const settings = readSettings(context.config as Record<string, unknown>)
    const offset = parseCursor(context.cursor, warn)
    await warnOnPrivacyMode(settings.token)

    const limit = Math.max(1, Math.min(settings.limit, context.limit ?? settings.limit))

    let updates: TelegramUpdate[]
    try {
      updates = await withFloodRetry(
        () =>
          getUpdates({
            token: settings.token,
            ...(offset !== undefined && { offset }),
            limit,
            timeoutSeconds: settings.pollTimeoutSeconds,
            allowedUpdates: settings.updateTypes,
            ...(fetchImpl && { fetchImpl })
          }),
        retryOptions
      )
    } catch (error) {
      throw explainGetUpdatesFailure(error)
    }

    // Keyed by externalId, because a message and an edit of it can land in the
    // same batch and both map to the same id. The SDK rejects a page with a
    // duplicate id, and a page that always throws is never confirmed — the
    // batch would block the queue until it expired. The later update wins, so
    // what survives is the message's newest state.
    const items = new Map<string, ConnectorItem>()
    for (const update of updates) {
      const found = messageOf(update)
      // Nothing mappable, `message_id: 0` (documented for ephemeral and
      // scheduled messages, "unusable until actually sent"), or a chat this
      // connection does not watch. All three are still confirmed by the cursor
      // below, which is intended: they are not ours, and leaving them
      // unconfirmed would re-read them on every poll forever.
      if (!found || found.message.message_id === 0) continue
      if (!matchesChat(found.message.chat, settings.chatId)) continue
      const item = updateToItem(update, found.type, found.message)
      items.set(String(item.externalId), item)
    }

    const next = nextOffset(updates, offset)
    return {
      items: [...items.values()],
      ...(next !== undefined && { nextCursor: formatCursor(next) }),
      // Never true, and this is the most expensive line in the package. The
      // cursor returned above is also the ack for this page: a drainer that
      // followed `hasMore` would confirm these messages on its next call,
      // before the host had stored them, and Telegram cannot give a confirmed
      // update back. A backlog waits for the next scheduled poll — that costs
      // latency, and the alternative costs messages.
      hasMore: false
    }
  }

  /* ---------------------------------------------------------- actions -- */

  function chatFor(args: Record<string, unknown>, credentials: Credentials): string {
    const chatId = text(args.chatId) ?? credentials.chatId
    if (!chatId) {
      throw new Error(
        'chatId is required: set one on the connection or pass it to this step. Use the ' +
          'numeric id, or @username for a public channel.'
      )
    }
    return chatId
  }

  function positiveMessageId(value: unknown): number {
    const messageId = Number(value)
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
      throw new Error(`messageId must be a positive whole number, got "${value}"`)
    }
    return messageId
  }

  function sendable(value: unknown): string {
    const body = text(value)
    if (!body) throw new Error('text is required')
    if (body.length > MAX_MESSAGE_LENGTH) {
      throw new Error(
        `text is ${body.length} characters; Telegram refuses more than ${MAX_MESSAGE_LENGTH} ` +
          'after entities parsing. Shorten it or split it across steps — truncating here would ' +
          'silently drop what the workflow meant to say.'
      )
    }
    return body
  }

  /**
   * Send, following a migration once if Telegram reports one.
   *
   * A group that becomes a supergroup gets a new id and the old one stops
   * working. `migrate_to_chat_id` is the reference's answer to that, so it is
   * followed rather than surfaced as a failure — and the id actually used comes
   * back in the output, so the workflow can see the connection needs updating.
   */
  async function sendFollowingMigration(
    token: string,
    chatId: string,
    body: string,
    replyToMessageId?: number
  ): Promise<{ message: TelegramMessage; chatId: string }> {
    const attempt = (target: string) =>
      withFloodRetry(
        () =>
          sendMessage({
            token,
            chatId: target,
            text: body,
            ...(replyToMessageId !== undefined && { replyToMessageId }),
            ...(fetchImpl && { fetchImpl })
          }),
        retryOptions
      )

    try {
      return { message: await attempt(chatId), chatId }
    } catch (error) {
      const migrated = error instanceof TelegramError ? error.migrateToChatId : undefined
      if (migrated === undefined) throw error
      const moved = String(migrated)
      warn(
        `Telegram: chat ${chatId} has become a supergroup and is now ${moved}. Sent to the new ` +
          'id; update the connection so the trigger watches it too.'
      )
      return { message: await attempt(moved), chatId: moved }
    }
  }

  return defineConnector({
    id: 'telegram',
    name: 'Telegram',
    ...(options.version && { version: options.version }),
    description:
      'Trigger workflows from Telegram messages, and send, reply or edit from a step.',
    // Telegram's own paper plane.
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z'
      ]
    },
    config: [
      {
        key: 'token',
        env: 'TELEGRAM_BOT_TOKEN',
        label: 'Bot token',
        // Stored encrypted by Vorn and never printed by the CLI. It is also a
        // path segment in every request, so the client never logs a URL.
        secret: true,
        required: true,
        description:
          'Create a bot with @BotFather in Telegram and paste the token it gives you. One token ' +
          'can only be read by one connection — a second one steals this one’s messages.'
      },
      {
        key: 'chatId',
        env: 'TELEGRAM_CHAT_ID',
        label: 'Chat',
        description:
          'Numeric chat id, or @username for a public channel. Blank watches every chat the bot ' +
          'is in.'
      },
      {
        key: 'updateTypes',
        env: 'TELEGRAM_UPDATE_TYPES',
        label: 'Update types',
        default: DEFAULT_UPDATE_TYPES.join(','),
        description: `Comma-separated. One or more of ${SUPPORTED_UPDATE_TYPES.join(', ')}.`
      },
      {
        key: 'pollTimeout',
        env: 'TELEGRAM_POLL_TIMEOUT',
        label: 'Long poll seconds',
        default: String(DEFAULT_POLL_TIMEOUT_SECONDS),
        description:
          'How long Telegram may hold the connection open waiting for a message. 0 is short ' +
          'polling, which Telegram documents as being for testing only.'
      },
      {
        key: 'limit',
        env: 'TELEGRAM_LIMIT',
        label: 'Maximum per poll',
        default: String(MAX_LIMIT),
        description: `1 to ${MAX_LIMIT}. Anything left over is read by the next poll.`
      }
    ],
    triggers: [
      {
        type: 'messageReceived',
        label: 'A message arrives',
        description:
          'Fires for each new or edited message the bot can see. Telegram deletes unread ' +
          'updates after 24 hours and has no history endpoint, so this sees nothing sent ' +
          'before the connection was made.',
        // A Telegram message has no lifecycle — there is no "done" — so this is
        // deliberately thin. It exists only so imported items do not silently
        // inherit a default status that implies more than is known.
        statusMapping: [
          { upstream: 'received', suggestedLocal: 'todo' },
          { upstream: 'edited', suggestedLocal: 'todo' }
        ],
        // One minute, not the five most connectors use. Unread updates expire
        // after 24 hours, so a slow poll here risks messages rather than just
        // latency.
        defaultWorkflow: { name: 'Telegram: messages', defaultCronFromMinutes: 1 },
        poll: pollUpdates
      }
    ],
    actions: [
      {
        type: 'sendMessage',
        label: 'Send a message',
        description: 'Post a message to a chat the bot is in.',
        // Telegram has no idempotency key: two calls post two messages.
        idempotent: false,
        inputs: [
          { key: 'text', label: 'Message', required: true },
          {
            key: 'chatId',
            label: 'Chat',
            description: 'Defaults to the connection’s chat.'
          }
        ],
        outputs: [
          { key: 'messageId', description: 'Id of the message, unique within its chat' },
          { key: 'chatId', description: 'The chat it landed in' }
        ],
        async run(args, { config }) {
          const credentials = readCredentials(config as Record<string, unknown>)
          const body = sendable(args.text)
          const sent = await sendFollowingMigration(
            credentials.token,
            chatFor(args, credentials),
            body
          )
          return { messageId: sent.message.message_id, chatId: sent.chatId }
        }
      },
      {
        type: 'replyToMessage',
        label: 'Reply to a message',
        description: 'Post a message as a reply, so it threads under the original.',
        idempotent: false,
        inputs: [
          {
            key: 'messageId',
            label: 'Message to reply to',
            type: 'number',
            required: true,
            description: 'From {{trigger.item.messageId}}.'
          },
          { key: 'text', label: 'Message', required: true },
          {
            key: 'chatId',
            label: 'Chat',
            description: 'Defaults to the connection’s chat. Must be the message’s own chat.'
          }
        ],
        outputs: [
          { key: 'messageId', description: 'Id of the reply' },
          { key: 'chatId', description: 'The chat it landed in' }
        ],
        async run(args, { config }) {
          const credentials = readCredentials(config as Record<string, unknown>)
          const body = sendable(args.text)
          const replyTo = positiveMessageId(args.messageId)
          const sent = await sendFollowingMigration(
            credentials.token,
            chatFor(args, credentials),
            body,
            replyTo
          )
          return { messageId: sent.message.message_id, chatId: sent.chatId }
        }
      },
      {
        type: 'editMessageText',
        label: 'Edit a message',
        description: 'Replace the text of a message this bot sent.',
        // Setting the same text twice leaves the message in the same state.
        // That is a claim about semantics, not about any error Telegram
        // returns — see the `changed` output below.
        idempotent: true,
        inputs: [
          {
            key: 'messageId',
            label: 'Message to edit',
            type: 'number',
            required: true,
            description: 'From {{steps.sendMessage.messageId}}.'
          },
          { key: 'text', label: 'New text', required: true },
          { key: 'chatId', label: 'Chat', description: 'Defaults to the connection’s chat.' }
        ],
        outputs: [
          { key: 'messageId', description: 'Id of the edited message' },
          { key: 'chatId', description: 'The chat it is in' },
          { key: 'changed', description: 'false when the message already had this text' }
        ],
        async run(args, { config }) {
          const credentials = readCredentials(config as Record<string, unknown>)
          const body = sendable(args.text)
          const chatId = chatFor(args, credentials)
          const messageId = positiveMessageId(args.messageId)

          try {
            const edited = await withFloodRetry(
              () =>
                editMessageText({
                  token: credentials.token,
                  chatId,
                  messageId,
                  text: body,
                  ...(fetchImpl && { fetchImpl })
                }),
              retryOptions
            )
            // `true` rather than a Message means an inline message, which this
            // action cannot address — but the union is real and must not crash.
            return {
              messageId: edited === true ? messageId : edited.message_id,
              chatId,
              changed: true
            }
          } catch (error) {
            // Telegram rejects an edit that would change nothing. The wording
            // it uses is not in the reference, so this match is a convenience
            // and nothing rests on it: if the wording changes, the step fails
            // and re-running it is still safe, which is what `idempotent: true`
            // above actually claims.
            if (error instanceof TelegramError && /not modified/i.test(error.message)) {
              return { messageId, chatId, changed: false }
            }
            throw error
          }
        }
      }
    ]
  })
}
