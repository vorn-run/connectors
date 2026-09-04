import { describe, expect, it, vi } from 'vitest'
import { createConnectorHarness, runConformance } from '@vornrun/connector-sdk'
import { connector, messageToItem, tsToIso } from './connector'

type Answer = (url: URL, init?: RequestInit) => unknown

interface Call {
  url: URL
  method: string
  headers: Headers
  body?: unknown
}

/** Answers every Slack call from `answer`, recording what the connector asked. */
function slackFetch(answer: Answer) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      ...(typeof init?.body === 'string' && { body: JSON.parse(init.body) })
    })
    const reply = answer(url, init)
    if (reply instanceof Response) return reply
    return new Response(JSON.stringify(reply), {
      headers: { 'content-type': 'application/json' }
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const method = (url: URL): string => url.pathname.replace('/api/', '')
const query = (call: Call): Record<string, string> => Object.fromEntries(call.url.searchParams)

const config = { botToken: 'xoxb-test', channel: 'C0123456789', limit: '100', includeBots: 'false' }

const CHANNEL_MESSAGES = [
  { type: 'message', user: 'U2', text: 'Third\nwith a second line', ts: '1700000003.000300' },
  { type: 'message', subtype: 'channel_join', user: 'U9', text: 'joined', ts: '1700000002.500000' },
  { type: 'message', bot_id: 'B1', text: 'Build passed', ts: '1700000002.000200' },
  { type: 'message', user: 'U1', text: 'First', ts: '1700000001.000100', team: 'T1' }
]

function harness(answer: Answer, overrides: Record<string, string> = {}) {
  const { fetchImpl, calls } = slackFetch(answer)
  const h = createConnectorHarness(connector, {
    config: { ...config, ...overrides },
    fetchImpl,
    now: () => '2026-09-04T12:00:00.000Z',
    sleep: async () => {}
  })
  return { ...h, calls }
}

describe('tsToIso', () => {
  it('turns a Slack ts into an ISO instant, keeping the milliseconds', () => {
    expect(tsToIso('1512085950.000216')).toBe('2017-11-30T23:52:30.000Z')
    expect(tsToIso('1512085950.750')).toBe('2017-11-30T23:52:30.750Z')
  })
})

describe('messageToItem', () => {
  it('titles a message by its first line and keeps the rest as data', () => {
    const item = messageToItem('C1', {
      user: 'U1',
      bot_id: 'B1',
      subtype: 'bot_message',
      text: 'Hello\nworld',
      ts: '1.5',
      thread_ts: '1.0',
      parent_user_id: 'U0',
      team: 'T1'
    })

    expect(item).toEqual({
      externalId: '1.5',
      title: 'Hello',
      description: 'Hello\nworld',
      updatedAt: '1970-01-01T00:00:01.500Z',
      data: {
        channel: 'C1',
        ts: '1.5',
        text: 'Hello\nworld',
        user: 'U1',
        botId: 'B1',
        subtype: 'bot_message',
        threadTs: '1.0',
        parentUserId: 'U0',
        team: 'T1'
      }
    })
  })

  it('names a message with no text by its ts', () => {
    const item = messageToItem('C1', { ts: '2.0' })

    expect(item.title).toBe('Message 2.0')
    expect(item.data).toEqual({ channel: 'C1', ts: '2.0', text: '' })
  })
})

describe('messageInChannel', () => {
  it('reads the newest page once on the first poll and delivers people in order', async () => {
    const h = harness(() => ({ ok: true, messages: CHANNEL_MESSAGES }))

    const page = await h.poll('messageInChannel')

    expect(h.calls).toHaveLength(1)
    expect(method(h.calls[0]!.url)).toBe('conversations.history')
    expect(query(h.calls[0]!)).toEqual({ channel: 'C0123456789', limit: '100' })
    expect(h.calls[0]!.headers.get('authorization')).toBe('Bearer xoxb-test')
    expect(page.items.map((item) => item.externalId)).toEqual([
      '1700000001.000100',
      '1700000003.000300'
    ])
    expect(page.items[0]).toMatchObject({
      title: 'First',
      description: 'First',
      updatedAt: '2023-11-14T22:13:21.000Z',
      user: 'U1',
      team: 'T1',
      channel: 'C0123456789'
    })
    expect(page.items[1]!.title).toBe('Third')
    expect(page.nextCursor).toBeDefined()
  })

  it('includes bot and system messages when asked', async () => {
    const h = harness(() => ({ ok: true, messages: CHANNEL_MESSAGES }), { includeBots: 'true' })

    const page = await h.poll('messageInChannel')

    expect(page.items.map((item) => item.externalId)).toEqual([
      '1700000001.000100',
      '1700000002.000200',
      '1700000002.500000',
      '1700000003.000300'
    ])
    expect(page.items[1]).toMatchObject({ title: 'Build passed', botId: 'B1' })
    expect(page.items[2]).toMatchObject({ subtype: 'channel_join' })
  })

  it('passes the newest delivered ts back as oldest and walks every page after it', async () => {
    const newer = [
      { type: 'message', user: 'U3', text: 'Fifth', ts: '1700000005.000000' },
      { type: 'message', user: 'U3', text: 'Fourth', ts: '1700000004.000000' }
    ]
    const h = harness((url) => {
      if (url.searchParams.get('oldest') === null) return { ok: true, messages: CHANNEL_MESSAGES }
      if (url.searchParams.get('cursor') === 'page2') return { ok: true, messages: [newer[1]] }
      return { ok: true, messages: [newer[0]], response_metadata: { next_cursor: 'page2' } }
    })

    const first = await h.poll('messageInChannel')
    const second = await h.poll('messageInChannel', { cursor: first.nextCursor })

    expect(query(h.calls[1]!)).toEqual({
      channel: 'C0123456789',
      limit: '100',
      oldest: '1700000003.000300'
    })
    expect(query(h.calls[2]!).cursor).toBe('page2')
    expect(second.items.map((item) => item.title)).toEqual(['Fourth', 'Fifth'])
    expect(second.nextCursor).not.toBe(first.nextCursor)
  })

  it('does not deliver the same message twice', async () => {
    const h = harness(() => ({ ok: true, messages: CHANNEL_MESSAGES }))

    expect(await h.pollTwice('messageInChannel')).toEqual([])
  })

  it('reports nothing new when the newest message is one to skip', async () => {
    const h = harness((url) =>
      url.searchParams.has('oldest')
        ? { ok: true, messages: [CHANNEL_MESSAGES[2]] }
        : { ok: true, messages: CHANNEL_MESSAGES }
    )

    const first = await h.poll('messageInChannel')
    const second = await h.poll('messageInChannel', { cursor: first.nextCursor })

    expect(second.items).toEqual([])
    expect(second.nextCursor).toBe(first.nextCursor)
  })

  it('stops a catch-up walk after ten pages', async () => {
    const h = harness((url) => ({
      ok: true,
      messages: [
        { type: 'message', user: 'U1', text: 'x', ts: `170000001${url.searchParams.get('cursor') ?? '0'}.000000` }
      ],
      response_metadata: { next_cursor: String(h.calls.length) }
    }))

    const first = await h.poll('messageInChannel')
    await h.poll('messageInChannel', { cursor: first.nextCursor })

    expect(h.calls).toHaveLength(11)
  })

  it('honours the configured page size within Slack’s bounds', async () => {
    for (const [limit, sent] of [
      ['15', '15'],
      ['5000', '999'],
      ['lots', '100'],
      ['0', '100'],
      ['', '100']
    ]) {
      const h = harness(() => ({ ok: true, messages: [] }), { limit: limit! })
      await h.poll('messageInChannel')
      expect(query(h.calls[0]!).limit).toBe(sent)
    }
  })

  it('names the missing setting rather than calling Slack without it', async () => {
    const noChannel = harness(() => ({ ok: true }), { channel: '' })
    await expect(noChannel.poll('messageInChannel')).rejects.toThrow('SLACK_CHANNEL is required')

    const noToken = harness(() => ({ ok: true }), { botToken: ' ' })
    await expect(noToken.poll('messageInChannel')).rejects.toThrow('SLACK_BOT_TOKEN is required')
    expect(noToken.calls).toHaveLength(0)
  })

  it('surfaces Slack’s error code', async () => {
    const h = harness(() => ({ ok: false, error: 'not_in_channel' }))

    await expect(h.poll('messageInChannel')).rejects.toThrow(
      'Slack conversations.history answered not_in_channel'
    )
  })

  it('waits out a rate limit and reads the page that follows', async () => {
    let asked = 0
    const h = harness(() => {
      asked += 1
      if (asked === 1) {
        return new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '1' }
        })
      }
      return { ok: true, messages: [CHANNEL_MESSAGES[3]] }
    })

    const page = await h.poll('messageInChannel')

    expect(page.items).toHaveLength(1)
    expect(h.calls).toHaveLength(2)
  })
})

describe('replyInThread', () => {
  const THREAD = [
    { type: 'message', user: 'U1', text: 'Parent', ts: '1700000001.000100', thread_ts: '1700000001.000100' },
    { type: 'message', user: 'U2', text: 'Reply one', ts: '1700000002.000200', thread_ts: '1700000001.000100', parent_user_id: 'U1' },
    { type: 'message', bot_id: 'B1', text: 'Reply two', ts: '1700000003.000300', thread_ts: '1700000001.000100' }
  ]

  it('asks for the thread, drops the parent and delivers replies in order', async () => {
    const h = harness(() => ({ ok: true, messages: THREAD }), { threadTs: '1700000001.000100' })

    const page = await h.poll('replyInThread')

    expect(method(h.calls[0]!.url)).toBe('conversations.replies')
    expect(query(h.calls[0]!)).toEqual({
      channel: 'C0123456789',
      ts: '1700000001.000100',
      limit: '100'
    })
    expect(page.items.map((item) => item.title)).toEqual(['Reply one', 'Reply two'])
    expect(page.items[0]).toMatchObject({ threadTs: '1700000001.000100', parentUserId: 'U1' })
  })

  it('passes the newest delivered reply back as oldest', async () => {
    const h = harness(() => ({ ok: true, messages: THREAD }), { threadTs: '1700000001.000100' })

    const first = await h.poll('replyInThread')
    await h.poll('replyInThread', { cursor: first.nextCursor })

    expect(query(h.calls[1]!).oldest).toBe('1700000003.000300')
  })

  it('does not deliver the same reply twice', async () => {
    const h = harness(() => ({ ok: true, messages: THREAD }), { threadTs: '1700000001.000100' })

    expect(await h.pollTwice('replyInThread')).toEqual([])
  })

  it('needs the parent ts', async () => {
    const h = harness(() => ({ ok: true }))

    await expect(h.poll('replyInThread')).rejects.toThrow('SLACK_THREAD_TS is required')
  })
})

describe('memberJoinedChannel', () => {
  it('walks every page of members and delivers each id once', async () => {
    const h = harness((url) =>
      url.searchParams.get('cursor') === 'more'
        ? { ok: true, members: ['U3'] }
        : { ok: true, members: ['U1', 'U2'], response_metadata: { next_cursor: 'more' } }
    )

    const page = await h.poll('memberJoinedChannel')

    expect(method(h.calls[0]!.url)).toBe('conversations.members')
    expect(query(h.calls[0]!)).toEqual({ channel: 'C0123456789', limit: '200' })
    expect(h.calls).toHaveLength(2)
    expect(page.items.map((item) => item.externalId)).toEqual(['U1', 'U2', 'U3'])
    expect(page.items[0]).toMatchObject({ title: 'U1 joined C0123456789', user: 'U1', channel: 'C0123456789' })
  })

  it('delivers only members it has not seen before', async () => {
    let members = ['U1', 'U2']
    const h = harness(() => ({ ok: true, members }))

    const first = await h.poll('memberJoinedChannel')
    members = ['U1', 'U2', 'U3']
    const second = await h.poll('memberJoinedChannel', { cursor: first.nextCursor })
    const third = await h.poll('memberJoinedChannel', { cursor: second.nextCursor })

    expect(first.items.map((item) => item.externalId)).toEqual(['U1', 'U2'])
    expect(second.items.map((item) => item.externalId)).toEqual(['U3'])
    expect(third.items).toEqual([])
  })

  it('does not deliver the same member twice', async () => {
    const h = harness(() => ({ ok: true, members: ['U1'] }))

    expect(await h.pollTwice('memberJoinedChannel')).toEqual([])
  })
})

describe('postMessage', () => {
  it('posts JSON to chat.postMessage and returns where it landed', async () => {
    const h = harness(() => ({ ok: true, ts: '1700000009.000900', channel: 'C0123456789' }))

    const result = await h.execute('postMessage', { channel: 'C0123456789', text: 'Hello' })

    expect(result).toEqual({ ts: '1700000009.000900', channel: 'C0123456789' })
    expect(h.calls[0]!.method).toBe('POST')
    expect(method(h.calls[0]!.url)).toBe('chat.postMessage')
    expect(h.calls[0]!.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(h.calls[0]!.body).toEqual({ channel: 'C0123456789', text: 'Hello' })
  })

  it('sends the thread and the parsed blocks when given', async () => {
    const h = harness(() => ({ ok: true, ts: '1.0', channel: 'C1' }))

    await h.execute('postMessage', {
      channel: 'C1',
      text: 'Fallback',
      threadTs: '1700000001.000100',
      blocks: '[{"type":"section","text":{"type":"mrkdwn","text":"*Hi*"}}]'
    })

    expect(h.calls[0]!.body).toEqual({
      channel: 'C1',
      text: 'Fallback',
      thread_ts: '1700000001.000100',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Hi*' } }]
    })
  })

  it('refuses blocks that are not JSON before calling Slack', async () => {
    const h = harness(() => ({ ok: true }))

    await expect(h.execute('postMessage', { channel: 'C1', text: 'x', blocks: 'nope' })).rejects.toThrow(
      'Expected JSON'
    )
    expect(h.calls).toHaveLength(0)
  })

  it('surfaces Slack’s refusal', async () => {
    const h = harness(() => ({ ok: false, error: 'channel_not_found' }))

    await expect(h.execute('postMessage', { channel: 'C1', text: 'x' })).rejects.toThrow(
      'Slack chat.postMessage answered channel_not_found'
    )
  })

  it('needs a channel and text', async () => {
    const h = harness(() => ({ ok: true }))

    await expect(h.execute('postMessage', { text: 'x' })).rejects.toThrow('requires "channel"')
    await expect(h.execute('postMessage', { channel: 'C1' })).rejects.toThrow('requires "text"')
  })
})

describe('replyInThread action', () => {
  it('posts under the parent', async () => {
    const h = harness(() => ({ ok: true, ts: '2.0', channel: 'C1' }))

    const result = await h.execute('replyInThread', {
      channel: 'C1',
      threadTs: '1700000001.000100',
      text: 'On it'
    })

    expect(result).toEqual({ ts: '2.0', channel: 'C1' })
    expect(method(h.calls[0]!.url)).toBe('chat.postMessage')
    expect(h.calls[0]!.body).toEqual({ channel: 'C1', thread_ts: '1700000001.000100', text: 'On it' })
  })

  it('needs the parent ts', async () => {
    const h = harness(() => ({ ok: true }))

    await expect(h.execute('replyInThread', { channel: 'C1', text: 'x' })).rejects.toThrow(
      'requires "threadTs"'
    )
  })
})

describe('addReaction', () => {
  it('adds the named emoji to the message', async () => {
    const h = harness(() => ({ ok: true }))

    const result = await h.execute('addReaction', { channel: 'C1', ts: '1.0', emoji: 'thumbsup' })

    expect(result).toEqual({ ok: true })
    expect(method(h.calls[0]!.url)).toBe('reactions.add')
    expect(h.calls[0]!.body).toEqual({ channel: 'C1', timestamp: '1.0', name: 'thumbsup' })
  })

  it('surfaces already_reacted rather than pretending', async () => {
    const h = harness(() => ({ ok: false, error: 'already_reacted' }))

    await expect(h.execute('addReaction', { channel: 'C1', ts: '1.0', emoji: 'eyes' })).rejects.toThrow(
      'already_reacted'
    )
  })
})

const CHANNEL = {
  id: 'C1',
  name: 'general',
  is_private: false,
  is_archived: false,
  topic: { value: 'Company wide' },
  purpose: { value: 'Everyone' },
  num_members: 42,
  created: 1449252889
}

describe('listChannels', () => {
  it('lists public and private channels, unarchived, and reshapes them', async () => {
    const h = harness(() => ({
      ok: true,
      channels: [CHANNEL, { id: 'C2', name: 'secret', is_private: true }],
      response_metadata: { next_cursor: 'dGVhbTpD' }
    }))

    const result = await h.execute('listChannels', { limit: '20', cursor: 'prev' })

    expect(method(h.calls[0]!.url)).toBe('conversations.list')
    expect(query(h.calls[0]!)).toEqual({
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '20',
      cursor: 'prev'
    })
    expect(result).toEqual({
      channels: [
        {
          id: 'C1',
          name: 'general',
          isPrivate: false,
          isArchived: false,
          topic: 'Company wide',
          purpose: 'Everyone',
          numMembers: 42
        },
        {
          id: 'C2',
          name: 'secret',
          isPrivate: true,
          isArchived: false,
          topic: '',
          purpose: '',
          numMembers: undefined
        }
      ],
      nextCursor: 'dGVhbTpD'
    })
  })

  it('defaults to 100 per page and an empty cursor at the end', async () => {
    const h = harness(() => ({ ok: true, channels: [] }))

    const result = await h.execute('listChannels')

    expect(query(h.calls[0]!).limit).toBe('100')
    expect(result).toEqual({ channels: [], nextCursor: '' })
  })
})

describe('getChannel', () => {
  it('reads one channel with its member count', async () => {
    const h = harness(() => ({ ok: true, channel: CHANNEL }))

    const result = await h.execute('getChannel', { channel: 'C1' })

    expect(method(h.calls[0]!.url)).toBe('conversations.info')
    expect(query(h.calls[0]!)).toEqual({ channel: 'C1', include_num_members: 'true' })
    expect(result).toMatchObject({ id: 'C1', name: 'general', numMembers: 42, created: 1449252889 })
  })

  it('surfaces channel_not_found', async () => {
    const h = harness(() => ({ ok: false, error: 'channel_not_found' }))

    await expect(h.execute('getChannel', { channel: 'C9' })).rejects.toThrow('channel_not_found')
  })
})

const USER = {
  id: 'U1',
  name: 'ada',
  real_name: 'Ada Lovelace',
  tz: 'Europe/London',
  is_bot: false,
  deleted: false,
  profile: { display_name: 'ada', email: 'ada@example.com' }
}

describe('findUserByEmail', () => {
  it('looks the address up and reshapes the user', async () => {
    const h = harness(() => ({ ok: true, user: USER }))

    const result = await h.execute('findUserByEmail', { email: 'ada@example.com' })

    expect(method(h.calls[0]!.url)).toBe('users.lookupByEmail')
    expect(query(h.calls[0]!)).toEqual({ email: 'ada@example.com' })
    expect(result).toEqual({
      id: 'U1',
      name: 'ada',
      realName: 'Ada Lovelace',
      displayName: 'ada',
      email: 'ada@example.com',
      tz: 'Europe/London',
      isBot: false,
      deleted: false
    })
  })

  it('surfaces users_not_found', async () => {
    const h = harness(() => ({ ok: false, error: 'users_not_found' }))

    await expect(h.execute('findUserByEmail', { email: 'nobody@example.com' })).rejects.toThrow(
      'users_not_found'
    )
  })
})

describe('getUser', () => {
  it('reads one user by id', async () => {
    const h = harness(() => ({ ok: true, user: { ...USER, is_bot: true, deleted: true, profile: {} } }))

    const result = await h.execute('getUser', { user: 'U1' })

    expect(method(h.calls[0]!.url)).toBe('users.info')
    expect(query(h.calls[0]!)).toEqual({ user: 'U1' })
    expect(result).toMatchObject({ id: 'U1', isBot: true, deleted: true, displayName: undefined, email: undefined })
  })

  it('retries a read that met a server error', async () => {
    let asked = 0
    const h = harness(() => {
      asked += 1
      return asked === 1 ? new Response('oops', { status: 503 }) : { ok: true, user: USER }
    })

    const result = await h.execute('getUser', { user: 'U1' })

    expect(result).toMatchObject({ id: 'U1' })
    expect(h.calls).toHaveLength(2)
  })
})

describe('the definition', () => {
  it('signs in with the bot token and keeps it secret', () => {
    expect(connector.auth).toEqual({ rung: 'key', keys: ['botToken'] })
    expect(connector.config.find((field) => field.key === 'botToken')).toMatchObject({
      env: 'SLACK_BOT_TOKEN',
      secret: true,
      required: true
    })
  })

  it('says which actions are safe to repeat', () => {
    const byType = Object.fromEntries(connector.actions.map((action) => [action.type, action.idempotent]))
    expect(byType).toEqual({
      postMessage: false,
      replyInThread: false,
      addReaction: false,
      listChannels: true,
      getChannel: true,
      findUserByEmail: true,
      getUser: true
    })
  })

  it('passes the SDK’s conformance checks against served HTTP', async () => {
    const run = await runConformance(connector, { mock: true })

    expect(run.findings.filter((item) => item.level === 'error')).toEqual([])
    expect(run.passed).toEqual(expect.arrayContaining(['manifest', 'auth', 'secrets', 'actions', 'dedupe', 'mock']))
  })
})
