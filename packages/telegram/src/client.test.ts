import { describe, it, expect, vi } from 'vitest'
import {
  DEFAULT_TIMEOUT_MS,
  LONG_POLL_SLACK_MS,
  TelegramError,
  callTelegram,
  editMessageText,
  explainGetUpdatesFailure,
  getMe,
  getUpdates,
  redactToken,
  sendMessage,
  withFloodRetry,
  type FetchLike,
  type TelegramUpdate
} from './client'

const TOKEN = '123456:AAH-secret-bot-token'

interface Sent {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  signal: AbortSignal | null | undefined
}

/**
 * A stand-in for `fetch` that records what the client sent.
 *
 * The tests assert the request this connector builds — the part we own —
 * rather than reimplementing Telegram's server.
 */
function fakeFetch(
  ...responses: Array<{ status?: number; body?: unknown; text?: string }>
): { fetchImpl: FetchLike; sent: Sent[] } {
  const sent: Sent[] = []
  const queue = [...responses]
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')),
      signal: init?.signal
    })
    const next = queue.length > 1 ? queue.shift()! : (queue[0] ?? {})
    const { status = 200, body, text } = next
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text ?? JSON.stringify(body ?? { ok: true, result: {} })
    } as Response
  }) as unknown as FetchLike
  return { fetchImpl, sent }
}

/** A `fetch` that fails the way Node does, quoting the URL it tried. */
function failingFetch(message: string): FetchLike {
  return (async () => {
    throw new Error(message)
  }) as unknown as FetchLike
}

describe('redactToken', () => {
  it('replaces the token everywhere it appears', () => {
    const text = `request to https://api.telegram.org/bot${TOKEN}/getUpdates failed (${TOKEN})`
    const redacted = redactToken(text, TOKEN)
    expect(redacted).not.toContain(TOKEN)
    expect(redacted).toBe(
      'request to https://api.telegram.org/bot<bot token>/getUpdates failed (<bot token>)'
    )
  })

  it('leaves text alone when there is no token to hide', () => {
    expect(redactToken('nothing secret here', '')).toBe('nothing secret here')
  })
})

describe('callTelegram', () => {
  it('posts JSON to the method URL with the token as a path segment', async () => {
    const { fetchImpl, sent } = fakeFetch({ body: { ok: true, result: { id: 7 } } })

    const result = await callTelegram<{ id: number }>({
      token: TOKEN,
      method: 'getMe',
      params: { a: 1 },
      fetchImpl
    })

    expect(result).toEqual({ id: 7 })
    expect(sent[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`)
    expect(sent[0].headers['Content-Type']).toBe('application/json')
    expect(sent[0].body).toEqual({ a: 1 })
  })

  it('sends an empty object when the caller passes no params', async () => {
    const { fetchImpl, sent } = fakeFetch({ body: { ok: true, result: true } })
    await callTelegram({ token: TOKEN, method: 'getMe', fetchImpl })
    expect(sent[0].body).toEqual({})
  })

  it('refuses to build a URL without a token rather than calling /bot/', async () => {
    const { fetchImpl, sent } = fakeFetch({ body: { ok: true, result: {} } })
    await expect(callTelegram({ token: '', method: 'getMe', fetchImpl })).rejects.toThrow(
      'TELEGRAM_BOT_TOKEN is required'
    )
    expect(sent).toHaveLength(0)
  })

  it('reads the envelope rather than the HTTP status, so ok:false is a failure', async () => {
    // Telegram mirrors the envelope in the status, but the envelope is the
    // contract: checking res.ok alone would hand `undefined` to the caller.
    const { fetchImpl } = fakeFetch({
      status: 200,
      body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' }
    })

    const error = (await callTelegram({ token: TOKEN, method: 'sendMessage', fetchImpl }).catch(
      (e: unknown) => e
    )) as TelegramError

    expect(error).toBeInstanceOf(TelegramError)
    expect(error.message).toBe('Telegram sendMessage failed: Bad Request: chat not found')
    expect(error.errorCode).toBe(400)
    expect(error.retryAfterSeconds).toBeUndefined()
  })

  it('lifts retry_after off the envelope, which is the specified field', async () => {
    // The FAQ mentions 429, but the API reference only ever specifies
    // parameters.retry_after — so that is what callers get to branch on.
    const { fetchImpl } = fakeFetch({
      status: 429,
      body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 12 } }
    })

    const error = (await callTelegram({ token: TOKEN, method: 'sendMessage', fetchImpl }).catch(
      (e: unknown) => e
    )) as TelegramError

    expect(error.retryAfterSeconds).toBe(12)
  })

  it('ignores a retry_after that is not a positive number', async () => {
    const { fetchImpl } = fakeFetch({
      body: { ok: false, description: 'nope', parameters: { retry_after: 0 } }
    })
    const error = (await callTelegram({ token: TOKEN, method: 'x', fetchImpl }).catch(
      (e: unknown) => e
    )) as TelegramError
    expect(error.retryAfterSeconds).toBeUndefined()
  })

  it('reads migrate_to_chat_id as a full 52-bit number', async () => {
    // "has at most 52 significant bits" — a 32-bit read would land the caller
    // in a different chat, so this asserts a value no int32 can hold.
    const migrated = -1_002_147_483_649
    const { fetchImpl } = fakeFetch({
      body: {
        ok: false,
        description: 'Bad Request: group chat was upgraded to a supergroup chat',
        parameters: { migrate_to_chat_id: migrated }
      }
    })

    const error = (await callTelegram({ token: TOKEN, method: 'sendMessage', fetchImpl }).catch(
      (e: unknown) => e
    )) as TelegramError

    expect(error.migrateToChatId).toBe(migrated)
    expect(String(error.migrateToChatId)).toBe('-1002147483649')
  })

  it('refuses a migrate_to_chat_id outside the range a number holds exactly', async () => {
    const { fetchImpl } = fakeFetch({
      body: { ok: false, description: 'moved', parameters: { migrate_to_chat_id: 1e21 } }
    })
    const error = (await callTelegram({ token: TOKEN, method: 'sendMessage', fetchImpl }).catch(
      (e: unknown) => e
    )) as TelegramError
    // Silently rounding it would address some other chat entirely.
    expect(error.migrateToChatId).toBeUndefined()
  })

  it('reports a body that is not Telegram JSON, with the status', async () => {
    const { fetchImpl } = fakeFetch({ status: 502, text: '<html>Bad gateway</html>' })
    await expect(callTelegram({ token: TOKEN, method: 'getMe', fetchImpl })).rejects.toThrow(
      'Telegram getMe failed: HTTP 502: <html>Bad gateway</html>'
    )
  })

  it('reports an empty body rather than an empty message', async () => {
    const { fetchImpl } = fakeFetch({ status: 500, text: '' })
    await expect(callTelegram({ token: TOKEN, method: 'getMe', fetchImpl })).rejects.toThrow(
      'HTTP 500: empty body'
    )
  })

  it('never lets the token escape in a network error, because the URL contains it', async () => {
    const fetchImpl = failingFetch(
      `fetch failed for https://api.telegram.org/bot${TOKEN}/getUpdates`
    )
    const error = (await callTelegram({ token: TOKEN, method: 'getUpdates', fetchImpl }).catch(
      (e: unknown) => e
    )) as TelegramError

    expect(error).toBeInstanceOf(TelegramError)
    expect(error.message).not.toContain(TOKEN)
    expect(error.message).toContain('<bot token>')
  })

  it('survives a rejection that was never an Error object', async () => {
    const fetchImpl = (async () => {
      throw 'undici exploded'
    }) as unknown as FetchLike
    await expect(callTelegram({ token: TOKEN, method: 'getMe', fetchImpl })).rejects.toThrow(
      'Telegram getMe failed: undici exploded'
    )
  })

  it('redacts the token out of a response body too', async () => {
    const { fetchImpl } = fakeFetch({ status: 404, text: `no method bot${TOKEN}/nope` })
    const error = (await callTelegram({ token: TOKEN, method: 'nope', fetchImpl }).catch(
      (e: unknown) => e
    )) as TelegramError
    expect(error.message).not.toContain(TOKEN)
  })

  it('rejects ok:true with no result rather than returning undefined', async () => {
    const { fetchImpl } = fakeFetch({ body: { ok: true } })
    await expect(callTelegram({ token: TOKEN, method: 'getMe', fetchImpl })).rejects.toThrow(
      'response carried no result'
    )
  })

  it('abandons an ordinary call at the default timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const { fetchImpl, sent } = fakeFetch({ body: { ok: true, result: {} } })

    await callTelegram({ token: TOKEN, method: 'getMe', fetchImpl })

    expect(timeout).toHaveBeenCalledWith(DEFAULT_TIMEOUT_MS)
    expect(sent[0].signal).toBeInstanceOf(AbortSignal)
    timeout.mockRestore()
  })
})

describe('withFloodRetry', () => {
  const floodError = (seconds: number) =>
    new TelegramError('sendMessage', 'Too Many Requests', { parameters: { retry_after: seconds } })

  it('returns the first success without sleeping', async () => {
    const sleep = vi.fn(async () => {})
    await expect(withFloodRetry(async () => 'ok', { sleep })).resolves.toBe('ok')
    expect(sleep).not.toHaveBeenCalled()
  })

  it('waits exactly as long as Telegram asked, then tries again', async () => {
    const sleep = vi.fn(async () => {})
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(floodError(3))
      .mockResolvedValueOnce('sent')

    await expect(withFloodRetry(run, { sleep })).resolves.toBe('sent')
    expect(sleep).toHaveBeenCalledWith(3000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not retry a failure Telegram gave no retry_after for', async () => {
    const sleep = vi.fn(async () => {})
    const run = vi.fn(async () => {
      throw new TelegramError('sendMessage', 'Bad Request: chat not found', { errorCode: 400 })
    })

    await expect(withFloodRetry(run, { sleep })).rejects.toThrow('chat not found')
    expect(run).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('does not retry an error that is not Telegram’s at all', async () => {
    const run = vi.fn(async () => {
      throw new Error('socket closed')
    })
    await expect(withFloodRetry(run, { sleep: async () => {} })).rejects.toThrow('socket closed')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('raises a flood wait longer than a poll should sit through', async () => {
    // Holding the poll for a quarter of an hour overruns the schedule that
    // would have retried anyway, and getUpdates confirmed nothing.
    const sleep = vi.fn(async () => {})
    const run = vi.fn(async () => {
      throw floodError(900)
    })

    await expect(withFloodRetry(run, { sleep, maxWaitSeconds: 60 })).rejects.toThrow(
      'Too Many Requests'
    )
    expect(sleep).not.toHaveBeenCalled()
  })

  it('really sleeps when no clock was injected', async () => {
    // The default is a real timer; only the tests replace it.
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(floodError(0.001))
      .mockResolvedValueOnce('sent')

    await expect(withFloodRetry(run)).resolves.toBe('sent')
  })

  it('gives up after the retry budget rather than looping', async () => {
    const sleep = vi.fn(async () => {})
    const run = vi.fn(async () => {
      throw floodError(1)
    })

    await expect(withFloodRetry(run, { sleep, retries: 2 })).rejects.toThrow('Too Many Requests')
    expect(run).toHaveBeenCalledTimes(3)
  })
})

describe('getUpdates', () => {
  const updates: TelegramUpdate[] = [{ update_id: 10 }]

  it('sends the offset, limit, timeout and allowed_updates it was given', async () => {
    const { fetchImpl, sent } = fakeFetch({ body: { ok: true, result: updates } })

    const result = await getUpdates({
      token: TOKEN,
      offset: 42,
      limit: 100,
      timeoutSeconds: 10,
      allowedUpdates: ['message', 'edited_message'],
      fetchImpl
    })

    expect(result).toEqual(updates)
    expect(sent[0].body).toEqual({
      offset: 42,
      limit: 100,
      timeout: 10,
      // Sent on every call because the setting is remembered per token and
      // outlives this process, so anything else holding it could have set it.
      allowed_updates: ['message', 'edited_message']
    })
  })

  it('omits the offset on the very first poll', async () => {
    const { fetchImpl, sent } = fakeFetch({ body: { ok: true, result: [] } })
    await getUpdates({ token: TOKEN, limit: 100, timeoutSeconds: 0, allowedUpdates: ['message'], fetchImpl })
    expect(sent[0].body).not.toHaveProperty('offset')
  })

  it('outlives its own long poll instead of aborting it', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const { fetchImpl } = fakeFetch({ body: { ok: true, result: [] } })

    await getUpdates({ token: TOKEN, limit: 1, timeoutSeconds: 30, allowedUpdates: [], fetchImpl })

    expect(timeout).toHaveBeenCalledWith(30_000 + LONG_POLL_SLACK_MS)
    timeout.mockRestore()
  })

  it('refuses a negative offset without reaching the network', async () => {
    // The one documented-destructive call in this API: a negative offset
    // forgets every previous update, and there is no way to fetch them back.
    const { fetchImpl, sent } = fakeFetch({ body: { ok: true, result: [] } })

    await expect(
      getUpdates({ token: TOKEN, offset: -1, limit: 1, timeoutSeconds: 0, allowedUpdates: [], fetchImpl })
    ).rejects.toThrow('Refusing to call getUpdates with offset -1')
    expect(sent).toHaveLength(0)
  })

  it('refuses an offset that is not a whole number', async () => {
    const { fetchImpl, sent } = fakeFetch({ body: { ok: true, result: [] } })
    await expect(
      getUpdates({ token: TOKEN, offset: 1.5, limit: 1, timeoutSeconds: 0, allowedUpdates: [], fetchImpl })
    ).rejects.toThrow('Refusing to call getUpdates')
    expect(sent).toHaveLength(0)
  })

  it('accepts offset 0, which is not the destructive case', async () => {
    const { fetchImpl, sent } = fakeFetch({ body: { ok: true, result: [] } })
    await getUpdates({ token: TOKEN, offset: 0, limit: 1, timeoutSeconds: 0, allowedUpdates: [], fetchImpl })
    expect(sent[0].body).toMatchObject({ offset: 0 })
  })
})

describe('the remaining methods', () => {
  it('getMe asks Telegram who the bot is', async () => {
    const { fetchImpl, sent } = fakeFetch({
      body: { ok: true, result: { id: 1, is_bot: true, first_name: 'Bot', can_read_all_group_messages: false } }
    })

    const me = await getMe(TOKEN, fetchImpl)

    expect(sent[0].url).toContain('/getMe')
    expect(me.can_read_all_group_messages).toBe(false)
  })

  it('sendMessage posts the chat id as a string, never a rounded number', async () => {
    const { fetchImpl, sent } = fakeFetch({
      body: { ok: true, result: { message_id: 5, date: 1, chat: { id: -1002147483649, type: 'supergroup' } } }
    })

    const message = await sendMessage({
      token: TOKEN,
      chatId: '-1002147483649',
      text: 'hello',
      fetchImpl
    })

    expect(sent[0].body).toEqual({ chat_id: '-1002147483649', text: 'hello' })
    expect(message.message_id).toBe(5)
  })

  it('sendMessage threads under a message when asked to', async () => {
    const { fetchImpl, sent } = fakeFetch({
      body: { ok: true, result: { message_id: 6, date: 1, chat: { id: 1, type: 'private' } } }
    })

    await sendMessage({ token: TOKEN, chatId: '1', text: 'hi', replyToMessageId: 4, fetchImpl })

    expect(sent[0].body).toEqual({
      chat_id: '1',
      text: 'hi',
      reply_parameters: { message_id: 4 }
    })
  })

  it('editMessageText returns the edited message', async () => {
    const { fetchImpl, sent } = fakeFetch({
      body: { ok: true, result: { message_id: 9, date: 1, chat: { id: 1, type: 'private' } } }
    })

    const edited = await editMessageText({
      token: TOKEN,
      chatId: '1',
      messageId: 9,
      text: 'new',
      fetchImpl
    })

    expect(sent[0].body).toEqual({ chat_id: '1', message_id: 9, text: 'new' })
    expect(edited).not.toBe(true)
    expect((edited as { message_id: number }).message_id).toBe(9)
  })

  it('editMessageText also returns plain true, which the type has to allow', async () => {
    // The reference is explicit: Message *or* true, `true` for an inline
    // message. A caller that read `.message_id` off that would crash.
    const { fetchImpl } = fakeFetch({ body: { ok: true, result: true } })
    await expect(
      editMessageText({ token: TOKEN, chatId: '1', messageId: 9, text: 'new', fetchImpl })
    ).resolves.toBe(true)
  })
})

describe('explainGetUpdatesFailure', () => {
  it('lists the causes the reference does not give a code for', async () => {
    const original = new TelegramError('getUpdates', 'Conflict: terminated by other getUpdates', {
      errorCode: 409
    })

    const explained = explainGetUpdatesFailure(original)

    expect(explained.message).toContain('Conflict: terminated by other getUpdates')
    expect(explained.message).toContain('outgoing webhook')
    expect(explained.message).toContain('already polling the same token')
    expect(explained.cause).toBe(original)
  })

  it('says the same thing whatever code came back, because none is promised', () => {
    // The 409 usually quoted for the webhook case is nowhere in the reference,
    // so nothing here branches on a status code.
    const explained = explainGetUpdatesFailure(
      new TelegramError('getUpdates', 'Unauthorized', { errorCode: 401 })
    )
    expect(explained.message).toContain('Unauthorized')
    expect(explained.message).toContain('outgoing webhook')
  })

  it('passes an ordinary error through untouched', () => {
    const original = new Error('socket hang up')
    expect(explainGetUpdatesFailure(original)).toBe(original)
  })

  it('wraps something that was never an error at all', () => {
    expect(explainGetUpdatesFailure('nope').message).toBe('nope')
  })
})
