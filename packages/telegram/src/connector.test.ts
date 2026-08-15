import { describe, it, expect, vi } from 'vitest'
import { createConnectorHarness, type ConnectorConfig } from '@vornrun/connector-sdk'
import {
  MAX_MESSAGE_LENGTH,
  SUPPORTED_UPDATE_TYPES,
  chatLabel,
  createTelegramConnector,
  formatCursor,
  matchesChat,
  messageOf,
  nextOffset,
  parseCursor,
  parseUpdateTypes,
  privacyModeWarning,
  readCredentials,
  readSettings,
  updateToItem
} from './connector'
import type { FetchLike, TelegramChat, TelegramMessage, TelegramUpdate } from './client'

const TOKEN = '123456:AAH-secret-bot-token'
const NOW = '2026-08-14T12:00:00.000Z'
/** 2023-11-14T22:13:20.000Z, so the ISO conversions below are checkable. */
const SENT_AT_UNIX = 1_700_000_000

/* ------------------------------------------------------------- fixtures -- */

interface Reply {
  status?: number
  envelope: unknown
}

const ok = (result: unknown): Reply => ({ envelope: { ok: true, result } })
const fail = (description: string, extra: Record<string, unknown> = {}): Reply => ({
  status: 400,
  envelope: { ok: false, description, ...extra }
})

/** A bot with privacy mode off, which is the quiet case. */
const READING_BOT = ok({
  id: 1,
  is_bot: true,
  first_name: 'Vorn',
  username: 'vornbot',
  can_read_all_group_messages: true
})

/**
 * A stand-in for Telegram that answers per method.
 *
 * Each method gets a queue of replies; the last one repeats, so a test only
 * has to describe the calls it cares about. Every request is recorded, because
 * what this connector *sends* — the offset above all — is the part it owns.
 */
function stubTelegram(routes: Record<string, Reply[]>): {
  fetchImpl: FetchLike
  calls: Array<{ method: string; body: Record<string, unknown> }>
} {
  const queues: Record<string, Reply[]> = { getMe: [READING_BOT], ...routes }
  const calls: Array<{ method: string; body: Record<string, unknown> }> = []

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop() ?? ''
    calls.push({ method, body: JSON.parse(String(init?.body ?? '{}')) })
    const queue = queues[method]
    if (!queue || queue.length === 0) throw new Error(`no stubbed reply for ${method}`)
    const reply = queue.length > 1 ? queue.shift()! : queue[0]
    return {
      ok: (reply.status ?? 200) < 300,
      status: reply.status ?? 200,
      text: async () => JSON.stringify(reply.envelope)
    } as Response
  }) as unknown as FetchLike

  return { fetchImpl, calls }
}

function messageUpdate(
  updateId: number,
  message: Partial<TelegramMessage> = {},
  chat: Partial<TelegramChat> = {}
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: SENT_AT_UNIX,
      chat: { id: -1001234567890, type: 'supergroup', title: 'Ops', ...chat },
      from: { id: 5, is_bot: false, first_name: 'Ada', last_name: 'Lovelace', username: 'ada' },
      text: `message ${updateId}`,
      ...message
    }
  }
}

function harnessFor(
  routes: Record<string, Reply[]>,
  config: ConnectorConfig = {},
  options: { warn?: (message: string) => void; sleep?: (ms: number) => Promise<void> } = {}
) {
  const { fetchImpl, calls } = stubTelegram(routes)
  const connector = createTelegramConnector({
    fetchImpl,
    sleep: options.sleep ?? (async () => {}),
    warn: options.warn ?? (() => {})
  })
  const harness = createConnectorHarness(connector, {
    config: { token: TOKEN, ...config },
    now: () => NOW
  })
  return { harness, calls, connector }
}

/** The body of the nth getUpdates request. */
function updatesCall(calls: Array<{ method: string; body: Record<string, unknown> }>, index = 0) {
  return calls.filter((call) => call.method === 'getUpdates')[index].body
}

/* --------------------------------------------------------------- config -- */

describe('readCredentials', () => {
  it('names the environment variable when the token is missing', () => {
    expect(() => readCredentials({})).toThrow('TELEGRAM_BOT_TOKEN is required')
    expect(() => readCredentials({ token: '   ' })).toThrow('TELEGRAM_BOT_TOKEN is required')
  })

  it('trims the token and treats a blank chat as every chat', () => {
    expect(readCredentials({ token: ` ${TOKEN} `, chatId: '  ' })).toEqual({ token: TOKEN })
  })

  it('keeps the chat when one was set', () => {
    expect(readCredentials({ token: TOKEN, chatId: '@ops' }).chatId).toBe('@ops')
  })
})

describe('parseUpdateTypes', () => {
  it('defaults to both halves of the message/edit pair', () => {
    // An update carries at most one of these, so defaulting to `message` alone
    // would make the `edited` status unreachable.
    expect(parseUpdateTypes(undefined)).toEqual(['message', 'edited_message'])
    expect(parseUpdateTypes('  ')).toEqual(['message', 'edited_message'])
    expect(parseUpdateTypes(', ,')).toEqual(['message', 'edited_message'])
  })

  it('takes a comma-separated list, trimmed and de-duplicated', () => {
    expect(parseUpdateTypes(' message , channel_post ,message')).toEqual([
      'message',
      'channel_post'
    ])
  })

  it('refuses a type it cannot map, rather than confirming it unread', () => {
    // Reading is acking: an update this connector asked for but cannot turn
    // into an item would be confirmed and then unrecoverable.
    expect(() => parseUpdateTypes('message,callback_query')).toThrow(
      /does not support callback_query/
    )
    expect(() => parseUpdateTypes('message,callback_query')).toThrow(
      SUPPORTED_UPDATE_TYPES.join(', ')
    )
  })
})

describe('readSettings', () => {
  it('fills in Telegram’s documented maximum and a ten-second long poll', () => {
    expect(readSettings({ token: TOKEN })).toEqual({
      token: TOKEN,
      updateTypes: ['message', 'edited_message'],
      pollTimeoutSeconds: 10,
      limit: 100
    })
  })

  it('accepts 0 for short polling, which Telegram documents as testing-only', () => {
    expect(readSettings({ token: TOKEN, pollTimeout: '0' }).pollTimeoutSeconds).toBe(0)
  })

  it('rejects a long poll that could outlive the schedule that started it', () => {
    expect(() => readSettings({ token: TOKEN, pollTimeout: '600' })).toThrow(
      'TELEGRAM_POLL_TIMEOUT must be between 0 and 50'
    )
  })

  it('rejects values that are not whole numbers', () => {
    expect(() => readSettings({ token: TOKEN, limit: 'lots' })).toThrow(
      'TELEGRAM_LIMIT must be a whole number, got "lots"'
    )
    expect(() => readSettings({ token: TOKEN, pollTimeout: '2.5' })).toThrow('whole number')
  })

  it('rejects a limit Telegram would refuse', () => {
    expect(() => readSettings({ token: TOKEN, limit: '500' })).toThrow(
      'TELEGRAM_LIMIT must be between 1 and 100'
    )
    expect(() => readSettings({ token: TOKEN, limit: '0' })).toThrow('between 1 and 100')
  })
})

/* --------------------------------------------------------------- cursor -- */

describe('parseCursor', () => {
  const warn = vi.fn()

  it('reads back what formatCursor wrote', () => {
    expect(parseCursor(formatCursor(42), warn)).toBe(42)
    expect(parseCursor(formatCursor(0), warn)).toBe(0)
  })

  it('has no offset before the first poll', () => {
    expect(parseCursor(undefined, warn)).toBeUndefined()
    expect(parseCursor('   ', warn)).toBeUndefined()
  })

  it('starts from the oldest unconfirmed update rather than refusing to run', () => {
    // A poll that throws is a poll not draining a queue that expires in 24
    // hours, and that costs messages. Re-delivery costs nothing: Vorn dedupes.
    const noted = vi.fn()
    expect(parseCursor('not json at all', noted)).toBeUndefined()
    expect(noted).toHaveBeenCalledWith(expect.stringContaining('unreadable cursor'))
  })

  it('ignores a cursor some other connector wrote', () => {
    const noted = vi.fn()
    expect(parseCursor(JSON.stringify({ v: 1, s: 'timestamp', t: NOW }), noted)).toBeUndefined()
    expect(parseCursor(JSON.stringify({ v: 2, offset: 5 }), noted)).toBeUndefined()
    expect(parseCursor('null', noted)).toBeUndefined()
    expect(noted).toHaveBeenCalledTimes(3)
  })

  it('refuses a negative or fractional offset, which must never reach the wire', () => {
    const noted = vi.fn()
    expect(parseCursor(JSON.stringify({ v: 1, offset: -1 }), noted)).toBeUndefined()
    expect(parseCursor(JSON.stringify({ v: 1, offset: 1.5 }), noted)).toBeUndefined()
    expect(parseCursor(JSON.stringify({ v: 1, offset: '9' }), noted)).toBeUndefined()
    expect(noted).toHaveBeenCalledTimes(3)
  })
})

describe('nextOffset', () => {
  it('is one past the highest update in the response', () => {
    // The reference says to recalculate from each response rather than
    // incrementing a counter we hold.
    expect(nextOffset([messageUpdate(7), messageUpdate(9), messageUpdate(8)])).toBe(10)
  })

  it('keeps the previous offset when the response was empty', () => {
    expect(nextOffset([], 42)).toBe(42)
    expect(nextOffset([])).toBeUndefined()
  })

  it('never walks backwards over updates the host already holds', () => {
    expect(nextOffset([messageUpdate(3)], 42)).toBe(42)
  })

  it('ignores an update_id that could not be a real offset', () => {
    expect(nextOffset([{ update_id: -5 }, { update_id: Number.NaN }, messageUpdate(6)], 2)).toBe(7)
  })
})

/* ---------------------------------------------------------------- items -- */

describe('messageOf', () => {
  it('finds whichever of the four fields the update carries', () => {
    expect(messageOf(messageUpdate(1))?.type).toBe('message')
    const edited: TelegramUpdate = { update_id: 2, edited_message: messageUpdate(2).message! }
    expect(messageOf(edited)?.type).toBe('edited_message')
  })

  it('is undefined for an update with nothing mappable in it', () => {
    expect(messageOf({ update_id: 3 })).toBeUndefined()
  })
})

describe('chatLabel', () => {
  it('prefers the title, then the handle, then the person’s name', () => {
    expect(chatLabel({ id: 1, type: 'supergroup', title: 'Ops' })).toBe('Ops')
    expect(chatLabel({ id: 1, type: 'channel', username: 'releases' })).toBe('@releases')
    expect(chatLabel({ id: 1, type: 'private', first_name: 'Ada', last_name: 'L' })).toBe('Ada L')
  })

  it('falls back to the id when a chat has no name at all', () => {
    expect(chatLabel({ id: -42, type: 'group' })).toBe('-42')
  })
})

describe('matchesChat', () => {
  const chat: TelegramChat = { id: -1001234567890, type: 'supergroup', username: 'Ops' }

  it('watches every chat when the connection named none', () => {
    expect(matchesChat(chat)).toBe(true)
  })

  it('matches the numeric id as a string', () => {
    expect(matchesChat(chat, '-1001234567890')).toBe(true)
    expect(matchesChat(chat, '-1009999999999')).toBe(false)
  })

  it('matches a handle with or without the @, ignoring case', () => {
    expect(matchesChat(chat, '@ops')).toBe(true)
    expect(matchesChat(chat, 'OPS')).toBe(true)
    expect(matchesChat({ id: 1, type: 'group' }, '@ops')).toBe(false)
  })
})

describe('updateToItem', () => {
  const itemFor = (update: TelegramUpdate) => {
    const found = messageOf(update)!
    return updateToItem(update, found.type, found.message)
  }

  it('builds a compound id, because message_id is unique only inside its chat', () => {
    const item = itemFor(messageUpdate(1))
    expect(item.externalId).toBe('-1001234567890:10')
  })

  it('carries the message, its author and when it was sent', () => {
    const item = itemFor(messageUpdate(1, { text: 'deploy failed\non staging' }))

    expect(item.title).toBe('deploy failed')
    expect(item.description).toBe('deploy failed\non staging')
    expect(item.status).toBe('received')
    expect(item.assignee).toBe('@ada')
    expect(item.updatedAt).toBe('2023-11-14T22:13:20.000Z')
    expect(item.data).toMatchObject({
      updateId: 1,
      updateType: 'message',
      // A string: 52 significant bits do not survive being rendered as a
      // rounded number into some other chat's id.
      chatId: '-1001234567890',
      chatTitle: 'Ops',
      messageId: 10,
      fromUsername: 'ada',
      sentAt: '2023-11-14T22:13:20.000Z'
    })
  })

  it('has no url, because the Bot API documents no permalink for a message', () => {
    expect(itemFor(messageUpdate(1)).url).toBeUndefined()
  })

  it('reports an edit as edited, and dates it from the edit', () => {
    const message = { ...messageUpdate(1).message!, edit_date: SENT_AT_UNIX + 60 }
    const item = updateToItem({ update_id: 1, edited_message: message }, 'edited_message', message)

    expect(item.status).toBe('edited')
    expect(item.updatedAt).toBe('2023-11-14T22:14:20.000Z')
    expect(item.data).toMatchObject({
      sentAt: '2023-11-14T22:13:20.000Z',
      editedAt: '2023-11-14T22:14:20.000Z'
    })
  })

  it('leaves the author off a channel post, which has none', () => {
    const post: TelegramMessage = {
      message_id: 4,
      date: SENT_AT_UNIX,
      chat: { id: -100999, type: 'channel', username: 'releases' },
      text: 'v2 is out'
    }
    const item = updateToItem({ update_id: 9, channel_post: post }, 'channel_post', post)

    expect(item.assignee).toBeUndefined()
    expect(item.status).toBe('received')
    expect(item.data).not.toHaveProperty('fromUsername')
  })

  it('reads a caption when there is no text, and names the chat when there is neither', () => {
    expect(itemFor(messageUpdate(1, { text: undefined, caption: 'a screenshot' })).title).toBe(
      'a screenshot'
    )
    // The SDK rejects an item with an empty title, and a photo with no caption
    // has no text at all.
    expect(itemFor(messageUpdate(1, { text: undefined })).title).toBe('Message 10 in Ops')
  })

  it('shortens a long first line for the title but keeps the whole body', () => {
    const long = 'x'.repeat(300)
    const item = itemFor(messageUpdate(1, { text: long }))

    expect(item.title).toHaveLength(120)
    expect(item.title.endsWith('…')).toBe(true)
    expect(item.description).toBe(long)
  })

  it('names a person without a handle by their name', () => {
    const item = itemFor(
      messageUpdate(1, { from: { id: 5, is_bot: false, first_name: 'Ada', last_name: 'L' } })
    )
    expect(item.assignee).toBe('Ada L')
  })

  it('falls back to the author’s id when they have no name Telegram sent', () => {
    const item = itemFor(messageUpdate(1, { from: { id: 5, is_bot: false, first_name: '' } }))
    expect(item.assignee).toBe('5')
  })
})

describe('privacyModeWarning', () => {
  it('says nothing when the bot already reads everything', () => {
    expect(
      privacyModeWarning({ id: 1, is_bot: true, first_name: 'V', can_read_all_group_messages: true })
    ).toBeUndefined()
  })

  it('words it as a possibility, because an admin bot reads everything anyway', () => {
    // The same paragraph that documents privacy mode exempts admins, so a
    // flat verdict here would be wrong for every admin bot.
    const message = privacyModeWarning({
      id: 1,
      is_bot: true,
      first_name: 'Vorn',
      username: 'vornbot',
      can_read_all_group_messages: false
    })

    expect(message).toContain('@vornbot')
    expect(message).toContain('may not see')
    expect(message).toContain('unless it is a group admin')
    // The half of the fix people miss.
    expect(message).toContain('re-add the bot')
  })

  it('uses the bot’s name when it somehow has no handle', () => {
    expect(privacyModeWarning({ id: 1, is_bot: true, first_name: 'Vorn' })).toContain('@Vorn')
  })
})

/* ----------------------------------------------------------------- poll -- */

describe('the messageReceived trigger', () => {
  it('asks for no offset on the first poll, and returns what came back', async () => {
    const { harness, calls } = harnessFor({
      getUpdates: [ok([messageUpdate(7), messageUpdate(8)])]
    })

    const page = await harness.poll('messageReceived')

    expect(updatesCall(calls)).not.toHaveProperty('offset')
    expect(page.items.map((item) => item.externalId)).toEqual([
      '-1001234567890:70',
      '-1001234567890:80'
    ])
  })

  it('returns a cursor that confirms exactly the page it returned', async () => {
    // This is the whole design. The cursor *is* the ack: it only reaches
    // Telegram on the next poll, by which time Vorn has stored these items.
    const { harness } = harnessFor({ getUpdates: [ok([messageUpdate(7), messageUpdate(8)])] })

    const page = await harness.poll('messageReceived')

    expect(page.nextCursor).toBe(formatCursor(9))
  })

  it('sends the offset it was handed back, and nothing else', async () => {
    const { harness, calls } = harnessFor({
      getUpdates: [ok([messageUpdate(7)]), ok([])]
    })

    const first = await harness.poll('messageReceived')
    await harness.poll('messageReceived', { cursor: first.nextCursor! })

    expect(updatesCall(calls, 1)).toMatchObject({ offset: 8 })
  })

  it('never reports more pages, so nothing can ack ahead of the host', async () => {
    // `hasMore: true` would invite a drainer to call again, and that second
    // call's offset would confirm this page before Vorn had stored it.
    // Telegram cannot give a confirmed update back, so a backlog waits for the
    // next scheduled poll instead.
    const full = Array.from({ length: 100 }, (_, index) => messageUpdate(index + 1))
    const replies = () => ({ getUpdates: [ok(full), ok([messageUpdate(101)])] })

    expect(await harnessFor(replies()).harness.poll('messageReceived')).toMatchObject({
      hasMore: false
    })

    // Even the SDK's drainer — which `vorn-connector check` and the in-process
    // harness use — stops after one page, and makes exactly one call.
    const drainer = harnessFor(replies())
    const drained = await drainer.harness.drain('messageReceived')

    expect(drained).toHaveLength(100)
    expect(drainer.calls.filter((call) => call.method === 'getUpdates')).toHaveLength(1)
  })

  it('holds its cursor when Telegram had nothing to say', async () => {
    const { harness } = harnessFor({ getUpdates: [ok([])] })
    const page = await harness.poll('messageReceived', { cursor: formatCursor(42) })

    expect(page.items).toEqual([])
    expect(page.nextCursor).toBe(formatCursor(42))
  })

  it('has no cursor to hold when the first poll was empty', async () => {
    const { harness } = harnessFor({ getUpdates: [ok([])] })
    expect(await harness.poll('messageReceived')).toMatchObject({ items: [], hasMore: false })
  })

  it('sends the configured update types and long poll on every call', async () => {
    const { harness, calls } = harnessFor(
      { getUpdates: [ok([])] },
      { updateTypes: 'message,channel_post', pollTimeout: '25', limit: '20' }
    )

    await harness.poll('messageReceived')

    expect(updatesCall(calls)).toMatchObject({
      limit: 20,
      timeout: 25,
      allowed_updates: ['message', 'channel_post']
    })
  })

  it('takes the smaller of the host’s limit and the connection’s', async () => {
    const { harness, calls } = harnessFor({ getUpdates: [ok([])] }, { limit: '20' })

    await harness.poll('messageReceived', { limit: 5 })
    await harness.poll('messageReceived', { limit: 90 })

    expect(updatesCall(calls, 0)).toMatchObject({ limit: 5 })
    expect(updatesCall(calls, 1)).toMatchObject({ limit: 20 })
  })

  it('confirms updates it drops, so they cannot be re-read forever', async () => {
    // Filtering advances the offset past what was filtered. That is
    // deliberate: leaving another chat's messages unconfirmed would re-read
    // them on every poll for as long as the connection lives.
    const { harness } = harnessFor(
      {
        getUpdates: [
          ok([
            messageUpdate(7, {}, { id: -1009999999999, title: 'Other' }),
            messageUpdate(8),
            // message_id 0 is documented for ephemeral and scheduled messages,
            // "unusable until actually sent".
            messageUpdate(9, { message_id: 0 }),
            // An update type we did not ask for and cannot map.
            { update_id: 10 } as unknown as TelegramUpdate
          ])
        ]
      },
      { chatId: '-1001234567890' }
    )

    const page = await harness.poll('messageReceived')

    expect(page.items.map((item) => item.externalId)).toEqual(['-1001234567890:80'])
    expect(page.nextCursor).toBe(formatCursor(11))
  })

  it('collapses a message and its own edit when both land in one batch', async () => {
    // They share an externalId, and the SDK rejects a page with a duplicate.
    // A page that always throws is never confirmed, so this batch would block
    // the queue until it expired 24 hours later — which is data loss.
    const original = messageUpdate(7, { text: 'deploy started' })
    const edit: TelegramUpdate = {
      update_id: 8,
      edited_message: {
        ...original.message!,
        text: 'deploy finished',
        edit_date: SENT_AT_UNIX + 30
      }
    }
    const { harness } = harnessFor({ getUpdates: [ok([original, edit])] })

    const page = await harness.poll('messageReceived')

    expect(page.items).toHaveLength(1)
    // The later update wins, so what survives is the message's newest state.
    expect(page.items[0]).toMatchObject({
      externalId: '-1001234567890:70',
      title: 'deploy finished',
      status: 'edited'
    })
    expect(page.nextCursor).toBe(formatCursor(9))
  })

  it('waits out a flood control answer and polls again', async () => {
    const sleep = vi.fn(async () => {})
    const { harness, calls } = harnessFor(
      {
        getUpdates: [
          { status: 429, envelope: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 4 } } },
          ok([messageUpdate(7)])
        ]
      },
      {},
      { sleep }
    )

    const page = await harness.poll('messageReceived')

    expect(sleep).toHaveBeenCalledWith(4000)
    expect(page.items).toHaveLength(1)
    expect(calls.filter((call) => call.method === 'getUpdates')).toHaveLength(2)
  })

  it('explains what a failed getUpdates usually means', async () => {
    const { harness } = harnessFor({
      getUpdates: [fail('Conflict: can not use getUpdates while webhook is active')]
    })

    await expect(harness.poll('messageReceived')).rejects.toThrow(/outgoing webhook/)
  })

  it('warns about privacy mode once per process, not once per poll', async () => {
    const warn = vi.fn()
    const { harness, calls } = harnessFor(
      {
        getMe: [ok({ id: 1, is_bot: true, first_name: 'V', username: 'vornbot' })],
        getUpdates: [ok([])]
      },
      {},
      { warn }
    )

    await harness.poll('messageReceived')
    await harness.poll('messageReceived')

    expect(calls.filter((call) => call.method === 'getMe')).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('privacy mode')
  })

  it('polls anyway when the privacy check itself fails', async () => {
    // Advisory only: it must never be the reason a queue that expires in 24
    // hours goes undrained.
    const warn = vi.fn()
    const { harness } = harnessFor(
      { getMe: [fail('Unauthorized')], getUpdates: [ok([messageUpdate(7)])] },
      {},
      { warn }
    )

    const page = await harness.poll('messageReceived')

    expect(page.items).toHaveLength(1)
    expect(warn.mock.calls[0][0]).toContain('could not check privacy mode')
  })

  it('never lets the token out through the privacy check either', async () => {
    const warn = vi.fn()
    const { harness } = harnessFor(
      { getMe: [{ status: 401, envelope: `no bot${TOKEN}` }], getUpdates: [ok([])] },
      {},
      { warn }
    )

    await harness.poll('messageReceived')

    expect(warn.mock.calls[0][0]).not.toContain(TOKEN)
  })

  it('reports a bad configuration before it calls anything', async () => {
    const { harness, calls } = harnessFor({ getUpdates: [ok([])] }, { limit: '9000' })
    await expect(harness.poll('messageReceived')).rejects.toThrow('TELEGRAM_LIMIT')
    expect(calls).toHaveLength(0)
  })
})

/* -------------------------------------------------------------- actions -- */

describe('sendMessage', () => {
  const sent = (id: number) =>
    ok({ message_id: id, date: SENT_AT_UNIX, chat: { id: -1001234567890, type: 'supergroup' } })

  it('sends to the connection’s chat and reports where it landed', async () => {
    const { harness, calls } = harnessFor({ sendMessage: [sent(11)] }, { chatId: '-1001234567890' })

    const result = await harness.execute('sendMessage', { text: 'deploying' })

    expect(calls[0].body).toEqual({ chat_id: '-1001234567890', text: 'deploying' })
    expect(result).toEqual({ messageId: 11, chatId: '-1001234567890' })
  })

  it('lets the step choose a different chat', async () => {
    const { harness, calls } = harnessFor({ sendMessage: [sent(11)] }, { chatId: '-100111' })
    await harness.execute('sendMessage', { text: 'hi', chatId: '@releases' })
    expect(calls[0].body).toMatchObject({ chat_id: '@releases' })
  })

  it('asks for a chat when neither the connection nor the step named one', async () => {
    const { harness } = harnessFor({ sendMessage: [sent(11)] })
    await expect(harness.execute('sendMessage', { text: 'hi' })).rejects.toThrow(
      'chatId is required'
    )
  })

  it('refuses text over Telegram’s limit rather than truncating it', async () => {
    // The house treatment: dropping the end of what a workflow meant to say is
    // worse than failing the step.
    const { harness, calls } = harnessFor({ sendMessage: [sent(11)] }, { chatId: '1' })

    await expect(
      harness.execute('sendMessage', { text: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) })
    ).rejects.toThrow(/4097 characters; Telegram refuses more than 4096/)
    expect(calls).toHaveLength(0)
  })

  it('refuses text that is only whitespace, which the SDK lets through', async () => {
    const { harness, calls } = harnessFor({ sendMessage: [sent(11)] }, { chatId: '1' })
    await expect(harness.execute('sendMessage', { text: '   ' })).rejects.toThrow(
      'text is required'
    )
    expect(calls).toHaveLength(0)
  })

  it('sends text of exactly the limit', async () => {
    const { harness } = harnessFor({ sendMessage: [sent(11)] }, { chatId: '1' })
    await expect(
      harness.execute('sendMessage', { text: 'x'.repeat(MAX_MESSAGE_LENGTH) })
    ).resolves.toMatchObject({ messageId: 11 })
  })

  it('follows a supergroup migration and reports the id it actually used', async () => {
    const { harness, calls } = harnessFor(
      {
        sendMessage: [
          fail('Bad Request: group chat was upgraded to a supergroup chat', {
            parameters: { migrate_to_chat_id: -1002147483649 }
          }),
          sent(12)
        ]
      },
      { chatId: '-100777' }
    )

    const result = await harness.execute('sendMessage', { text: 'hi' })

    expect(calls[1].body).toMatchObject({ chat_id: '-1002147483649' })
    expect(result).toEqual({ messageId: 12, chatId: '-1002147483649' })
  })

  it('does not retry a failure that is not a migration', async () => {
    const { harness, calls } = harnessFor(
      { sendMessage: [fail('Bad Request: chat not found')] },
      { chatId: '-100777' }
    )

    await expect(harness.execute('sendMessage', { text: 'hi' })).rejects.toThrow('chat not found')
    expect(calls.filter((call) => call.method === 'sendMessage')).toHaveLength(1)
  })
})

describe('replyToMessage', () => {
  const sent = ok({ message_id: 20, date: SENT_AT_UNIX, chat: { id: 1, type: 'private' } })

  it('threads the reply under the message it was given', async () => {
    const { harness, calls } = harnessFor({ sendMessage: [sent] }, { chatId: '1' })

    const result = await harness.execute('replyToMessage', { messageId: '10', text: 'on it' })

    expect(calls[0].body).toEqual({
      chat_id: '1',
      text: 'on it',
      reply_parameters: { message_id: 10 }
    })
    expect(result).toEqual({ messageId: 20, chatId: '1' })
  })

  it('refuses a message id that could not identify a message', async () => {
    const { harness } = harnessFor({ sendMessage: [sent] }, { chatId: '1' })
    await expect(
      harness.execute('replyToMessage', { messageId: '0', text: 'hi' })
    ).rejects.toThrow('messageId must be a positive whole number')
  })
})

describe('editMessageText', () => {
  it('replaces the text and reports the message it edited', async () => {
    const { harness, calls } = harnessFor(
      {
        editMessageText: [
          ok({ message_id: 30, date: SENT_AT_UNIX, chat: { id: 1, type: 'private' } })
        ]
      },
      { chatId: '1' }
    )

    const result = await harness.execute('editMessageText', { messageId: '30', text: 'done' })

    expect(calls[0].body).toEqual({ chat_id: '1', message_id: 30, text: 'done' })
    expect(result).toEqual({ messageId: 30, chatId: '1', changed: true })
  })

  it('survives the plain true the reference says it can return', async () => {
    const { harness } = harnessFor({ editMessageText: [ok(true)] }, { chatId: '1' })
    await expect(
      harness.execute('editMessageText', { messageId: '30', text: 'done' })
    ).resolves.toEqual({ messageId: 30, chatId: '1', changed: true })
  })

  it('treats an edit that changes nothing as success, and says so', async () => {
    // A convenience built on wording the reference does not publish. Nothing
    // rests on it: if Telegram changes the wording the step fails, and
    // re-running it is still safe — which is all `idempotent: true` claims.
    const { harness } = harnessFor(
      {
        editMessageText: [
          fail('Bad Request: message is not modified: specified new message content is the same')
        ]
      },
      { chatId: '1' }
    )

    await expect(
      harness.execute('editMessageText', { messageId: '30', text: 'same' })
    ).resolves.toEqual({ messageId: 30, chatId: '1', changed: false })
  })

  it('still fails on an edit that genuinely could not be made', async () => {
    const { harness } = harnessFor(
      { editMessageText: [fail("Bad Request: message can't be edited")] },
      { chatId: '1' }
    )

    await expect(
      harness.execute('editMessageText', { messageId: '30', text: 'x' })
    ).rejects.toThrow("message can't be edited")
  })

  it('refuses a message id that could not identify a message', async () => {
    const { harness, calls } = harnessFor({ editMessageText: [ok(true)] }, { chatId: '1' })
    await expect(
      harness.execute('editMessageText', { messageId: '0', text: 'x' })
    ).rejects.toThrow('messageId must be a positive whole number')
    expect(calls).toHaveLength(0)
  })
})

/* ------------------------------------------------------------- manifest -- */

describe('the manifest', () => {
  it('declares which actions are safe to repeat', () => {
    const connector = createTelegramConnector()
    const idempotence = Object.fromEntries(
      connector.actions.map((action) => [action.type, action.idempotent])
    )

    // Telegram has no idempotency key, so a repeated send posts twice.
    expect(idempotence).toEqual({
      sendMessage: false,
      replyToMessage: false,
      editMessageText: true
    })
  })

  it('polls every minute, because unread updates expire after 24 hours', () => {
    const [trigger] = createTelegramConnector().triggers
    expect(trigger.defaultWorkflow).toEqual({
      name: 'Telegram: messages',
      defaultCronFromMinutes: 1
    })
  })

  it('is a hand-written poll, not a declarative fetch, because the cursor is the ack', () => {
    const [trigger] = createTelegramConnector().triggers
    expect(typeof trigger.poll).toBe('function')
    expect(trigger.dedupe).toBeUndefined()
  })

  it('sends advisories to stderr, because stdout carries the MCP protocol', async () => {
    // The SDK gives a trigger no channel for a warning, and anything written
    // to stdout would be parsed as a protocol frame.
    const stderr = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fetchImpl } = stubTelegram({
      getMe: [ok({ id: 1, is_bot: true, first_name: 'V', username: 'vornbot' })],
      getUpdates: [ok([])]
    })
    const connector = createTelegramConnector({ fetchImpl })

    await createConnectorHarness(connector, { config: { token: TOKEN } }).poll('messageReceived')

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('privacy mode'))
    stderr.mockRestore()
  })

  it('marks the token secret, since it is a path segment in every request', () => {
    const token = createTelegramConnector().config.find((field) => field.key === 'token')
    expect(token).toMatchObject({ env: 'TELEGRAM_BOT_TOKEN', secret: true, required: true })
  })
})
