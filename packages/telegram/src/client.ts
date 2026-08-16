/**
 * Telegram's HTTP Bot API, called directly.
 *
 * The repo's rule is to prefer a maintained vendor client. Here there is none
 * to prefer: `core.telegram.org/bots/samples` lists only libraries "developed
 * by the Telegram community" and "not maintained by Telegram", and the only
 * code Telegram itself publishes is the server. The real candidates were
 * checked on 2026-08-14 — `grammy` is healthy, `telegraf` is four Bot API
 * majors behind, `node-telegram-bot-api` is mid-rewrite — and all three are bot
 * runtimes we would install to use about 5% of, while inheriting their release
 * cadence for Bot API currency. This connector needs four methods, each a JSON
 * POST to a URL, so it hand-rolls them at zero dependencies. That is the whole
 * reason, recorded here so nobody has to guess whether it was a decision.
 *
 * Telegram publishes no machine-readable schema — the reference is prose HTML —
 * so the types below are hand-written for the fields actually consumed.
 *
 * Two properties of this API shape everything in this file:
 *
 * 1. The bot token is a **path segment**, so the request URL is itself a
 *    secret. It is built in one place and never reaches an error message.
 * 2. Calling `getUpdates` with an offset **confirms** every update below it,
 *    and a confirmed update cannot be fetched again. A negative offset is
 *    documented to forget every previous update, so it is refused outright.
 *
 * Every call takes `fetch` as an argument, so tests never touch the network.
 */

const API_ROOT = 'https://api.telegram.org'

/** How long an ordinary call may take before it is abandoned. */
export const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Slack between a long poll's own timeout and the abort.
 *
 * `getUpdates` is *supposed* to hold the connection open for `timeout`
 * seconds, so an abort at the same deadline would cancel every long poll it
 * was meant to allow.
 */
export const LONG_POLL_SLACK_MS = 15_000

export type FetchLike = typeof fetch

export interface TelegramUser {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
  /** Only present on `getMe`. See `privacyModeWarning` in connector.ts. */
  can_read_all_group_messages?: boolean
}

export interface TelegramChat {
  id: number
  type: string
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

export interface TelegramMessage {
  /** Unique *inside this chat* only — never globally. */
  message_id: number
  /** Unix seconds. */
  date: number
  edit_date?: number
  chat: TelegramChat
  /** Absent on channel posts, which have no author. */
  from?: TelegramUser
  text?: string
  caption?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  channel_post?: TelegramMessage
  edited_channel_post?: TelegramMessage
}

/** https://core.telegram.org/bots/api#responseparameters */
export interface ResponseParameters {
  /** The chat's new id after a group became a supergroup. Up to 52 bits. */
  migrate_to_chat_id?: number
  /** Seconds to wait before repeating the request, on flood control. */
  retry_after?: number
}

interface Envelope<T> {
  ok?: boolean
  result?: T
  description?: string
  error_code?: number
  parameters?: ResponseParameters
}

/**
 * Replace the bot token wherever it appears in text bound for a human.
 *
 * The token is in the URL, and Node's own network errors quote the URL they
 * failed on. Redacting centrally is the only way this stays true as callers
 * are added.
 */
export function redactToken(text: string, token: string): string {
  if (!token) return text
  return text.split(token).join('<bot token>')
}

/**
 * A chat id read back out of a Telegram response.
 *
 * The reference says `migrate_to_chat_id` "has at most 52 significant bits",
 * which is exactly the range a double represents without loss — so a plain
 * number is correct and a 32-bit read is not. Anything outside that range is
 * refused rather than silently rounded into a different chat.
 */
function safeChatId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function positiveSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * A failure Telegram described in its own envelope.
 *
 * `retry_after` and `migrate_to_chat_id` are lifted onto the error because they
 * are the two things a caller can *act* on, and both are specified in the
 * reference — unlike `error_code: 429`, which the FAQ uses and the API
 * reference never defines. Control flow therefore branches on `retryAfter`,
 * never on the code.
 */
export class TelegramError extends Error {
  readonly method: string
  readonly errorCode: number | undefined
  readonly retryAfterSeconds: number | undefined
  readonly migrateToChatId: number | undefined

  constructor(
    method: string,
    description: string,
    details: { errorCode?: number; parameters?: ResponseParameters } = {}
  ) {
    super(`Telegram ${method} failed: ${description}`)
    this.name = 'TelegramError'
    this.method = method
    this.errorCode = details.errorCode
    this.retryAfterSeconds = positiveSeconds(details.parameters?.retry_after)
    this.migrateToChatId = safeChatId(details.parameters?.migrate_to_chat_id)
  }
}

export interface CallOptions {
  token: string
  method: string
  params?: Record<string, unknown>
  fetchImpl?: FetchLike
  timeoutMs?: number
}

/**
 * Run one Bot API method and hand back its `result`.
 *
 * Telegram answers every call with `{ok, result}` or `{ok: false, description,
 * error_code, parameters}`, and the HTTP status mirrors the envelope rather
 * than replacing it. So the envelope is what is read: a check on `res.ok`
 * alone would pass a body that says `ok: false` straight through to a caller
 * expecting a result.
 */
export async function callTelegram<T>(options: CallOptions): Promise<T> {
  const { token, method, params, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required')

  // The one place the token is interpolated. Nothing below may quote `url`.
  const url = `${API_ROOT}/bot${token}/${method}`

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    throw new TelegramError(method, redactToken(cause, token))
  }

  const body = redactToken(await response.text().catch(() => ''), token)
  let envelope: Envelope<T>
  try {
    envelope = JSON.parse(body) as Envelope<T>
  } catch {
    // A proxy or captive portal answering HTML, not Telegram.
    throw new TelegramError(method, `HTTP ${response.status}: ${body.slice(0, 200) || 'empty body'}`)
  }

  if (!envelope || envelope.ok !== true) {
    throw new TelegramError(method, envelope?.description ?? `HTTP ${response.status}`, {
      ...(envelope?.error_code !== undefined && { errorCode: envelope.error_code }),
      ...(envelope?.parameters && { parameters: envelope.parameters })
    })
  }
  if (envelope.result === undefined) {
    throw new TelegramError(method, 'response carried no result')
  }
  return envelope.result
}

/* ---------------------------------------------------------------- retry -- */

/** Attempts after the first. Small: the poll schedule is the real backstop. */
const MAX_FLOOD_RETRIES = 2

/**
 * The longest flood wait worth sitting through inside one poll.
 *
 * Telegram can answer with a `retry_after` of many minutes. Holding a poll open
 * that long overruns the schedule that would have retried anyway, so past this
 * the error is raised and the next poll picks it up. Nothing is lost by
 * failing: `getUpdates` confirmed nothing.
 */
const MAX_FLOOD_WAIT_SECONDS = 60

export interface FloodRetryOptions {
  /** Injected in tests, so no test spends real time asleep. */
  sleep?: (ms: number) => Promise<void>
  retries?: number
  maxWaitSeconds?: number
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Retry a call the one time Telegram says to, and never otherwise.
 *
 * The FAQ's published pacing — about one message a second per chat, 20 a minute
 * in a group — is documentation, not control flow: Telegram warns the limits
 * change, so the only number obeyed here is the `retry_after` it sends back.
 */
export async function withFloodRetry<T>(
  run: () => Promise<T>,
  options: FloodRetryOptions = {}
): Promise<T> {
  const {
    sleep = realSleep,
    retries = MAX_FLOOD_RETRIES,
    maxWaitSeconds = MAX_FLOOD_WAIT_SECONDS
  } = options

  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      const wait = error instanceof TelegramError ? error.retryAfterSeconds : undefined
      if (wait === undefined || wait > maxWaitSeconds || attempt >= retries) throw error
      await sleep(wait * 1000)
    }
  }
}

/* --------------------------------------------------------------- methods -- */

export async function getMe(token: string, fetchImpl?: FetchLike): Promise<TelegramUser> {
  return callTelegram<TelegramUser>({
    token,
    method: 'getMe',
    ...(fetchImpl && { fetchImpl })
  })
}

export interface GetUpdatesOptions {
  token: string
  /** The first update to return. Everything below it is confirmed. */
  offset?: number
  limit: number
  timeoutSeconds: number
  allowedUpdates: string[]
  fetchImpl?: FetchLike
}

/**
 * Fetch a page of updates, confirming everything below `offset`.
 *
 * The offset guard is the single most important line in this package. Telegram
 * documents a negative offset as forgetting every previous update, and there is
 * no history endpoint to recover from it — so a cursor that was corrupted,
 * hand-edited or arithmetically underflowed must fail here rather than reach
 * the wire.
 */
export async function getUpdates(options: GetUpdatesOptions): Promise<TelegramUpdate[]> {
  const { offset } = options
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
    throw new Error(
      `Refusing to call getUpdates with offset ${offset}: Telegram documents a negative ` +
        'offset as forgetting every previous update, and they cannot be fetched back.'
    )
  }

  return callTelegram<TelegramUpdate[]>({
    token: options.token,
    method: 'getUpdates',
    params: {
      ...(offset !== undefined && { offset }),
      limit: options.limit,
      timeout: options.timeoutSeconds,
      // Sent on every call, though the reference says "if not specified, the
      // previous setting will be used" — precisely because that setting is
      // remembered per token, outlives this process, and is writable by anything
      // else holding the same token. Restating it each time is how a poll gets
      // the types this connection asked for rather than the ones something else
      // left behind.
      allowed_updates: options.allowedUpdates
    },
    ...(options.fetchImpl && { fetchImpl: options.fetchImpl }),
    timeoutMs: options.timeoutSeconds * 1000 + LONG_POLL_SLACK_MS
  })
}

export interface SendMessageOptions {
  token: string
  /** Passed as a string so a 52-bit chat id cannot be rounded on the way out. */
  chatId: string
  text: string
  replyToMessageId?: number
  fetchImpl?: FetchLike
}

export async function sendMessage(options: SendMessageOptions): Promise<TelegramMessage> {
  return callTelegram<TelegramMessage>({
    token: options.token,
    method: 'sendMessage',
    params: {
      chat_id: options.chatId,
      text: options.text,
      ...(options.replyToMessageId !== undefined && {
        reply_parameters: { message_id: options.replyToMessageId }
      })
    },
    ...(options.fetchImpl && { fetchImpl: options.fetchImpl })
  })
}

export interface EditMessageTextOptions {
  token: string
  chatId: string
  messageId: number
  text: string
  fetchImpl?: FetchLike
}

/**
 * Edit a message's text.
 *
 * The reference is explicit that this returns the edited `Message` *or* `true`
 * — `true` for a message sent via an inline bot, which the connector cannot
 * address — so the return type is a union and callers must handle both. A
 * `Message | true` collapsed to `Message` would crash on `.message_id`.
 */
export async function editMessageText(
  options: EditMessageTextOptions
): Promise<TelegramMessage | true> {
  return callTelegram<TelegramMessage | true>({
    token: options.token,
    method: 'editMessageText',
    params: {
      chat_id: options.chatId,
      message_id: options.messageId,
      text: options.text
    },
    ...(options.fetchImpl && { fetchImpl: options.fetchImpl })
  })
}

/**
 * Say what a failed `getUpdates` could mean, without inventing a status code.
 *
 * `getUpdates` "will not work if an outgoing webhook is set up", and a second
 * consumer on the same token quietly steals updates. Both are common setup
 * mistakes and neither is distinguishable from the other by any code the
 * reference promises — the `409` usually quoted for the webhook case appears
 * nowhere in it. So the possibilities are listed and Telegram's own description
 * is left to say which, rather than branching on a code that might change.
 */
export function explainGetUpdatesFailure(error: unknown): Error {
  if (!(error instanceof TelegramError)) {
    return error instanceof Error ? error : new Error(String(error))
  }
  return new Error(
    `${error.message}. getUpdates fails outright when an outgoing webhook is set on this ` +
      'bot, when another connection is already polling the same token, and when the token ' +
      'is wrong — the description above is Telegram saying which.',
    { cause: error }
  )
}
