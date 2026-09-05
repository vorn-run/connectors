import { describe, expect, it, vi } from 'vitest'
import { createConnectorHarness, runConformance } from '@vornrun/connector-sdk'
import { API_ROOT, snowflakeFrom, snowflakeTime } from './client'
import {
  MEMBER_PAGE_SIZE,
  MESSAGE_PAGE_SIZE,
  autoArchiveDuration,
  createDiscordConnector,
  embedList,
  emojiSegment,
  readSettings,
  sendableContent,
  threadName
} from './connector'
import { SAMPLE_MEMBER, SAMPLE_MESSAGE, SAMPLE_THREAD } from './items'

const NOW = '2026-09-04T19:00:00.000Z'
const GUILD = '197038439483310086'
const CHANNEL = '41771983423143937'
const SELF = '99900000000000000'

interface Route {
  match: string | RegExp
  method?: string
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

interface Call {
  method: string
  url: string
  body?: unknown
}

/** Answers each request from the first matching route and records what was asked. */
function router(routes: Route[]) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ method, url, ...(typeof init?.body === 'string' && { body: JSON.parse(init.body) }) })
    const route = routes.find(
      (candidate) =>
        (candidate.method ?? method).toUpperCase() === method &&
        (typeof candidate.match === 'string' ? url.includes(candidate.match) : candidate.match.test(url))
    )
    if (!route) throw new Error(`unrouted ${method} ${url}`)
    const status = route.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(route.body ?? {}), {
      status,
      headers: { 'content-type': 'application/json', ...route.headers }
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const ME: Route = { match: '/users/@me', body: { id: SELF, username: 'vorn-bot', bot: true } }
const CHANNEL_INFO: Route = { match: new RegExp(`/channels/${CHANNEL}$`), body: { id: CHANNEL, guild_id: GUILD, type: 0 } }

function connectorWith(routes: Route[], extra: Record<string, unknown> = {}) {
  const { fetchImpl, calls } = router(routes)
  const warnings: string[] = []
  const connector = createDiscordConnector({
    version: '0.1.0',
    fetchImpl,
    sleep: async () => {},
    warn: (message) => {
      warnings.push(message)
    },
    env: {},
    ...extra
  })
  const harness = createConnectorHarness(connector, {
    config: { botToken: 'Bot tok', channel: CHANNEL, guild: GUILD },
    now: () => NOW,
    sleep: async () => {}
  })
  return { connector, harness, calls, warnings, fetchImpl }
}

function message(id: string, overrides: Record<string, unknown> = {}) {
  return {
    ...SAMPLE_MESSAGE,
    id,
    timestamp: new Date(snowflakeTime(id)).toISOString(),
    ...overrides
  }
}

function idAt(iso: string, low = 1n): string {
  return String(BigInt(snowflakeFrom(Date.parse(iso))) + low)
}

/* -------------------------------------------------------------- settings -- */

describe('readSettings', () => {
  it('applies the defaults and strips the token prefix', () => {
    expect(readSettings({ botToken: 'Bot abc' })).toEqual({
      token: 'abc',
      includeBots: false,
      includeSystem: false,
      lookbackMinutes: 60,
      maxPages: 5
    })
  })

  it('reads every field', () => {
    expect(
      readSettings({
        botToken: 'abc',
        channel: ' 1 ',
        guild: '2',
        includeBots: 'true',
        includeSystem: 'yes',
        lookbackMinutes: '0',
        maxPages: '2'
      })
    ).toEqual({
      token: 'abc',
      channel: '1',
      guild: '2',
      includeBots: true,
      includeSystem: true,
      lookbackMinutes: 0,
      maxPages: 2
    })
  })

  it('refuses numbers that are not whole or too small', () => {
    expect(() => readSettings({ botToken: 'a', lookbackMinutes: '-1' })).toThrow(/DISCORD_LOOKBACK_MINUTES/)
    expect(() => readSettings({ botToken: 'a', maxPages: '0' })).toThrow(/DISCORD_MAX_PAGES/)
    expect(() => readSettings({ botToken: 'a', maxPages: 'two' })).toThrow(/got "two"/)
    expect(() => readSettings({})).toThrow(/DISCORD_BOT_TOKEN/)
  })
})

describe('input helpers', () => {
  it('reads embeds as a list, one object or nothing', () => {
    expect(embedList(undefined)).toBeUndefined()
    expect(embedList('')).toBeUndefined()
    expect(embedList({ title: 't' })).toEqual([{ title: 't' }])
    expect(embedList([{ title: 't' }])).toEqual([{ title: 't' }])
    expect(() => embedList(Array.from({ length: 11 }, () => ({})))).toThrow(/at most 10/)
    expect(() => embedList(['text'])).toThrow(/array of embed objects/)
    expect(() => embedList([[]])).toThrow(/array of embed objects/)
  })

  it('bounds content and thread names', () => {
    expect(sendableContent(' hi ')).toBe('hi')
    expect(sendableContent('')).toBeUndefined()
    expect(() => sendableContent('x'.repeat(2001))).toThrow(/2001 characters/)
    expect(threadName('Build')).toBe('Build')
    expect(() => threadName('')).toThrow(/name is required/)
    expect(() => threadName('x'.repeat(101))).toThrow(/at most 100/)
  })

  it('accepts only the documented archive durations', () => {
    expect(autoArchiveDuration(undefined)).toBe(1440)
    expect(autoArchiveDuration('')).toBe(1440)
    expect(autoArchiveDuration('60')).toBe(60)
    expect(autoArchiveDuration(10080)).toBe(10080)
    expect(() => autoArchiveDuration('90')).toThrow(/one of 60, 1440, 4320, 10080/)
  })

  it('encodes emoji for the path', () => {
    expect(emojiSegment('👍')).toBe('%F0%9F%91%8D')
    expect(emojiSegment('party:123')).toBe('party%3A123')
    expect(emojiSegment('<:party:123>')).toBe('party%3A123')
    expect(emojiSegment('<a:dance:456>')).toBe('dance%3A456')
    expect(() => emojiSegment(' ')).toThrow(/emoji is required/)
  })
})

/* -------------------------------------------------------------- triggers -- */

describe('messageInChannel', () => {
  it('reads messages after the look-back, oldest first, without bots or itself', async () => {
    const fresh = idAt('2026-09-04T18:41:02.123Z')
    const older = idAt('2026-09-04T18:30:00.000Z')
    const { harness, calls } = connectorWith([
      ME,
      CHANNEL_INFO,
      {
        match: '/messages?',
        body: [
          message(fresh),
          message(older, { author: { id: SELF, username: 'vorn-bot', bot: true } }),
          message(idAt('2026-09-04T18:20:00.000Z'), { type: 7 }),
          message(idAt('2026-09-04T18:10:00.000Z'), { author: { id: '2', username: 'other-bot', bot: true } }),
          message(idAt('2026-09-04T18:05:00.000Z'), { content: 'first' })
        ]
      }
    ])

    const page = await harness.poll('messageInChannel')

    expect(page.items.map((item) => item.title)).toEqual(['wumpus: first', 'wumpus: Deploy finished for build 418'])
    expect(page.items[1]!.url).toBe(`https://discord.com/channels/${GUILD}/${CHANNEL}/${fresh}`)
    expect(page.items[1]!.updatedAt).toBe('2026-09-04T18:41:02.123Z')

    const list = calls.find((call) => call.url.includes('/messages?'))!
    const url = new URL(list.url)
    expect(url.pathname).toBe(`/api/v10/channels/${CHANNEL}/messages`)
    expect(url.searchParams.get('after')).toBe(snowflakeFrom(Date.parse('2026-09-04T18:00:00.000Z')))
    expect(url.searchParams.get('limit')).toBe(String(MESSAGE_PAGE_SIZE))
    expect(calls.filter((call) => call.url.endsWith('/users/@me'))).toHaveLength(1)
  })

  it('continues from the watermark and delivers nothing twice', async () => {
    const { harness, calls } = connectorWith([
      ME,
      CHANNEL_INFO,
      { match: '/messages?', body: [message(idAt('2026-09-04T18:50:00.000Z'))] }
    ])

    expect(await harness.pollTwice('messageInChannel')).toEqual([])
    const afters = calls
      .filter((call) => call.url.includes('/messages?'))
      .map((call) => new URL(call.url).searchParams.get('after'))
    expect(afters[1]).toBe(snowflakeFrom(Date.parse('2026-09-04T18:50:00.000Z')))
    expect(calls.filter((call) => call.url.endsWith('/users/@me'))).toHaveLength(1)
    expect(calls.filter((call) => /\/channels\/\d+$/.test(call.url))).toHaveLength(1)
  })

  it('walks a full page onward from its newest id, up to maxPages', async () => {
    const base = BigInt(snowflakeFrom(Date.parse('2026-09-04T18:30:00.000Z')))
    const full = Array.from({ length: MESSAGE_PAGE_SIZE }, (_, index) => message(String(base + BigInt(index) + 1n)))
    const { harness, calls } = connectorWith([ME, CHANNEL_INFO, { match: '/messages?', body: full }])

    const page = await harness.poll('messageInChannel', {
      config: { botToken: 'tok', channel: CHANNEL, maxPages: '2', includeBots: 'true' }
    })

    expect(page.items).toHaveLength(MESSAGE_PAGE_SIZE)
    const afters = calls
      .filter((call) => call.url.includes('/messages?'))
      .map((call) => new URL(call.url).searchParams.get('after'))
    expect(afters).toHaveLength(2)
    expect(afters[1]).toBe(String(base + BigInt(MESSAGE_PAGE_SIZE)))
  })

  it('keeps its own messages when bots are included and skips the self lookup', async () => {
    const { harness, calls } = connectorWith([
      CHANNEL_INFO,
      { match: '/messages?', body: [message(idAt('2026-09-04T18:50:00.000Z'), { author: { id: SELF, bot: true } })] }
    ])
    const page = await harness.poll('messageInChannel', {
      config: { botToken: 'tok', channel: CHANNEL, includeBots: 'true' }
    })
    expect(page.items).toHaveLength(1)
    expect(calls.some((call) => call.url.endsWith('/users/@me'))).toBe(false)
  })

  it('links a DM through @me and tolerates a non-list answer', async () => {
    const { harness } = connectorWith([
      ME,
      { match: new RegExp(`/channels/${CHANNEL}$`), body: { id: CHANNEL, type: 1 } },
      { match: '/messages?', body: [message(idAt('2026-09-04T18:50:00.000Z'))] }
    ])
    const page = await harness.poll('messageInChannel')
    expect(page.items[0]!.url).toMatch(/^https:\/\/discord\.com\/channels\/@me\//)

    const { harness: odd } = connectorWith([ME, CHANNEL_INFO, { match: '/messages?', body: { message: 'nope' } }])
    expect((await odd.poll('messageInChannel')).items).toEqual([])
  })

  it('requires a channel', async () => {
    const { harness } = connectorWith([])
    await expect(harness.poll('messageInChannel', { config: { botToken: 'tok' } })).rejects.toThrow(
      /channel is required.*DISCORD_CHANNEL_ID/
    )
  })

  it('forgets a failed self lookup so the next poll asks again', async () => {
    let attempts = 0
    const stub = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      // Two failures in a row, since the client retries a 5xx once on its own.
      if (url.endsWith('/users/@me') && attempts++ < 2) {
        return new Response('{"message":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/users/@me')) return Response.json({ id: SELF })
      if (/\/channels\/\d+$/.test(url)) return Response.json({ id: CHANNEL, guild_id: GUILD })
      return Response.json([])
    })
    const fetchImpl = stub as unknown as typeof fetch
    const connector = createDiscordConnector({ fetchImpl, sleep: async () => {}, warn: () => {} })
    const harness = createConnectorHarness(connector, {
      config: { botToken: 'tok', channel: CHANNEL },
      now: () => NOW,
      sleep: async () => {}
    })

    await expect(harness.poll('messageInChannel')).rejects.toThrow('500: boom')
    expect((await harness.poll('messageInChannel')).items).toEqual([])
    expect(stub.mock.calls.filter(([input]) => String(input).endsWith('/users/@me'))).toHaveLength(3)
  })
})

describe('memberJoined', () => {
  it('delivers members who joined after the boundary, oldest first', async () => {
    const { harness, calls } = connectorWith([
      {
        match: '/members?',
        body: [
          { ...SAMPLE_MEMBER, user: { id: '3', username: 'late' }, joined_at: '2026-09-04T18:59:00.000Z' },
          { ...SAMPLE_MEMBER, user: { id: '1', username: 'old' }, joined_at: '2026-09-01T00:00:00.000Z' },
          { ...SAMPLE_MEMBER, user: { id: '2', username: 'recent' }, joined_at: '2026-09-04T18:30:00.000Z' },
          { ...SAMPLE_MEMBER, user: undefined, joined_at: '2026-09-04T18:45:00.000Z' }
        ]
      }
    ])

    const page = await harness.poll('memberJoined')

    expect(page.items.map((item) => item.title)).toEqual(['recent joined', 'late joined'])
    expect(page.items[0]!.externalId).toBe('2')
    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe(`/api/v10/guilds/${GUILD}/members`)
    expect(url.searchParams.get('limit')).toBe(String(MEMBER_PAGE_SIZE))
    expect(url.searchParams.has('after')).toBe(false)
    expect(await harness.pollTwice('memberJoined')).toEqual([])
  })

  it('pages with after set to the highest user id, and warns when truncated', async () => {
    const full = Array.from({ length: MEMBER_PAGE_SIZE }, (_, index) => ({
      user: { id: String(1000 + index) },
      joined_at: '2026-09-04T18:30:00.000Z'
    }))
    const { harness, calls, warnings } = connectorWith([{ match: '/members?', body: full }])

    const page = await harness.poll('memberJoined', { config: { botToken: 'tok', guild: GUILD, maxPages: '2' } })

    expect(page.items).toHaveLength(MEMBER_PAGE_SIZE)
    expect(calls).toHaveLength(2)
    expect(new URL(calls[1]!.url).searchParams.get('after')).toBe('1999')
    expect(warnings[0]).toMatch(/more than 2000 members; raise DISCORD_MAX_PAGES/)
  })

  it('explains a 403 as the missing Server Members intent', async () => {
    const { harness } = connectorWith([
      { match: '/members?', status: 403, body: { code: 50001, message: 'Missing Access' } }
    ])
    await expect(harness.poll('memberJoined')).rejects.toThrow(
      /403 50001: Missing Access\. Listing guild members needs the Server Members intent/
    )
  })

  it('passes other failures through and requires a guild', async () => {
    const { harness } = connectorWith([{ match: '/members?', status: 404, body: { code: 10004, message: 'Unknown Guild' } }])
    await expect(harness.poll('memberJoined')).rejects.toThrow('404 10004: Unknown Guild')
    await expect(harness.poll('memberJoined', { config: { botToken: 'tok' } })).rejects.toThrow(/guild is required/)

    const { harness: odd } = connectorWith([{ match: '/members?', body: { message: 'nope' } }])
    expect((await odd.poll('memberJoined')).items).toEqual([])
  })
})

describe('threadCreated', () => {
  const threads = [
    { ...SAMPLE_THREAD, id: '3', thread_metadata: { ...SAMPLE_THREAD.thread_metadata, create_timestamp: '2026-09-04T18:50:00.000Z' } },
    { ...SAMPLE_THREAD, id: '2', parent_id: 'elsewhere', thread_metadata: { create_timestamp: '2026-09-04T18:40:00.000Z' } },
    { ...SAMPLE_THREAD, id: '1', thread_metadata: { create_timestamp: '2026-09-01T00:00:00.000Z' } },
    { name: 'no id' }
  ]

  it('delivers new threads under the configured channel, oldest first', async () => {
    const { harness, calls } = connectorWith([{ match: '/threads/active', body: { threads } }])
    const page = await harness.poll('threadCreated')
    expect(page.items.map((item) => item.externalId)).toEqual(['3'])
    expect(new URL(calls[0]!.url).pathname).toBe(`/api/v10/guilds/${GUILD}/threads/active`)
    expect(await harness.pollTwice('threadCreated')).toEqual([])
  })

  it('watches every channel when none is configured', async () => {
    const { harness } = connectorWith([{ match: '/threads/active', body: { threads } }])
    const page = await harness.poll('threadCreated', { config: { botToken: 'tok', guild: GUILD } })
    expect(page.items.map((item) => item.externalId)).toEqual(['2', '3'])
  })

  it('requires a guild and tolerates an empty answer', async () => {
    const { harness } = connectorWith([{ match: '/threads/active', body: {} }])
    expect((await harness.poll('threadCreated')).items).toEqual([])
    await expect(harness.poll('threadCreated', { config: { botToken: 'tok' } })).rejects.toThrow(/guild is required/)
  })
})

/* --------------------------------------------------------------- actions -- */

describe('sendMessage', () => {
  it('posts content, embeds and a reply reference', async () => {
    const { harness, calls } = connectorWith([
      CHANNEL_INFO,
      { match: '/messages', method: 'POST', body: { id: '10', channel_id: CHANNEL, content: 'hi', timestamp: NOW } }
    ])

    const result = await harness.execute('sendMessage', {
      channel: CHANNEL,
      content: 'hi',
      embeds: '[{"title":"Build"}]',
      replyTo: '9'
    })

    expect(result).toEqual({
      id: '10',
      channelId: CHANNEL,
      content: 'hi',
      timestamp: NOW,
      url: `https://discord.com/channels/${GUILD}/${CHANNEL}/10`
    })
    expect(calls[0]).toEqual({
      method: 'POST',
      url: `${API_ROOT}/channels/${CHANNEL}/messages`,
      body: {
        content: 'hi',
        embeds: [{ title: 'Build' }],
        message_reference: { message_id: '9', fail_if_not_exists: false }
      }
    })
  })

  it('refuses an empty message before calling', async () => {
    const { harness, calls } = connectorWith([])
    await expect(harness.execute('sendMessage', { channel: CHANNEL })).rejects.toThrow(/content or embeds is required/)
    await expect(harness.execute('sendMessage', { channel: ' ', content: 'x' })).rejects.toThrow(/channel is required/)
    expect(calls).toEqual([])
  })

  it('survives an answer with nothing in it', async () => {
    const { harness } = connectorWith([{ match: '/messages', method: 'POST', body: {} }])
    expect(await harness.execute('sendMessage', { channel: CHANNEL, content: 'hi' })).toEqual({
      id: null,
      channelId: CHANNEL,
      content: 'hi',
      timestamp: null,
      url: null
    })
  })
})

describe('createThread', () => {
  it('starts a thread from the message and posts the reply into it', async () => {
    const { harness, calls } = connectorWith([
      CHANNEL_INFO,
      { match: /\/messages\/9\/threads$/, method: 'POST', body: { id: '9', name: 'Build 418' } },
      { match: /\/channels\/9\/messages$/, method: 'POST', body: { id: '11' } }
    ])

    const result = await harness.execute('createThread', {
      channel: CHANNEL,
      message: '9',
      name: 'Build 418',
      content: 'Looking',
      autoArchiveDuration: '60'
    })

    expect(result).toEqual({
      threadId: '9',
      threadName: 'Build 418',
      created: true,
      messageId: '11',
      url: `https://discord.com/channels/${GUILD}/9/11`
    })
    expect(calls[0]!.body).toEqual({ name: 'Build 418', auto_archive_duration: 60 })
    expect(calls[1]!.body).toEqual({ content: 'Looking' })
  })

  it('posts into the existing thread when Discord says one exists', async () => {
    const { harness } = connectorWith([
      CHANNEL_INFO,
      {
        match: /\/threads$/,
        method: 'POST',
        status: 400,
        body: { code: 160004, message: 'A thread has already been created for this message' }
      },
      { match: /\/channels\/9\/messages$/, method: 'POST', body: { id: '12' } }
    ])
    expect(
      await harness.execute('createThread', { channel: CHANNEL, message: '9', name: 'Again', content: 'More' })
    ).toMatchObject({ threadId: '9', threadName: 'Again', created: false, messageId: '12' })
  })

  it('passes any other failure through, and validates before calling', async () => {
    const { harness, calls } = connectorWith([
      { match: /\/threads$/, method: 'POST', status: 403, body: { code: 50013, message: 'Missing Permissions' } }
    ])
    await expect(
      harness.execute('createThread', { channel: CHANNEL, message: '9', name: 'x', content: 'y' })
    ).rejects.toThrow('403 50013: Missing Permissions')
    await expect(
      harness.execute('createThread', { channel: CHANNEL, message: '9', name: 'x', content: ' ' })
    ).rejects.toThrow(/content is required/)
    await expect(
      harness.execute('createThread', { channel: CHANNEL, message: ' ', name: 'x', content: 'y' })
    ).rejects.toThrow(/message is required/)
    expect(calls).toHaveLength(1)
  })

  it('falls back to the message id when the thread answer carries none', async () => {
    const { harness } = connectorWith([
      CHANNEL_INFO,
      { match: /\/threads$/, method: 'POST', body: {} },
      { match: /\/messages$/, method: 'POST', body: {} }
    ])
    expect(
      await harness.execute('createThread', { channel: CHANNEL, message: '9', name: 'x', content: 'y' })
    ).toEqual({ threadId: '9', threadName: 'x', created: true, messageId: null, url: null })
  })
})

describe('reactions and pins', () => {
  it('puts the encoded emoji under @me', async () => {
    const { harness, calls } = connectorWith([{ match: '/reactions/', method: 'PUT', status: 204 }])
    expect(await harness.execute('addReaction', { channel: CHANNEL, message: '9', emoji: '👍' })).toEqual({ ok: true })
    expect(calls[0]!.url).toBe(`${API_ROOT}/channels/${CHANNEL}/messages/9/reactions/%F0%9F%91%8D/@me`)
  })

  it('pins through the current pins route', async () => {
    const { harness, calls } = connectorWith([{ match: '/messages/pins/', method: 'PUT', status: 204 }])
    expect(await harness.execute('pinMessage', { channel: CHANNEL, message: '9' })).toEqual({ ok: true })
    expect(calls[0]!.url).toBe(`${API_ROOT}/channels/${CHANNEL}/messages/pins/9`)
  })
})

describe('reads', () => {
  it('lists channels sorted by position, optionally of one type', async () => {
    const channels = [
      { id: '2', name: 'voice', type: 2, position: 1 },
      { id: '1', name: 'general', type: 0, position: 2, parent_id: '5', topic: 'talk' },
      { id: '3', name: 'rules', type: 0, position: 0 }
    ]
    const { harness, calls } = connectorWith([{ match: '/channels', body: channels }])

    const all = await harness.execute('listChannels', { guild: GUILD })
    expect((all.channels as Array<{ id: string }>).map((channel) => channel.id)).toEqual(['3', '2', '1'])
    expect(calls[0]!.url).toBe(`${API_ROOT}/guilds/${GUILD}/channels`)

    const text = await harness.execute('listChannels', { guild: GUILD, type: '0' })
    expect(text.channels).toEqual([
      { id: '3', name: 'rules', type: 0, parentId: null, position: 0, topic: null, nsfw: false },
      { id: '1', name: 'general', type: 0, parentId: '5', position: 2, topic: 'talk', nsfw: false }
    ])

    const { harness: odd } = connectorWith([{ match: '/channels', body: {} }])
    expect(await odd.execute('listChannels', { guild: GUILD })).toEqual({ channels: [] })
  })

  it('gets a channel', async () => {
    const { harness } = connectorWith([CHANNEL_INFO])
    expect(await harness.execute('getChannel', { channel: CHANNEL })).toMatchObject({
      id: CHANNEL,
      guildId: GUILD,
      type: 0
    })
    const { harness: odd } = connectorWith([{ match: '/channels/', body: {} }])
    expect(await odd.execute('getChannel', { channel: CHANNEL })).toMatchObject({ id: CHANNEL, guildId: null })
  })

  it('gets a guild member', async () => {
    const { harness, calls } = connectorWith([{ match: '/members/', body: SAMPLE_MEMBER }])
    expect(await harness.execute('getGuildMember', { guild: GUILD, user: '80351110224678912' })).toMatchObject({
      userId: '80351110224678912',
      username: 'wumpus',
      joinedAt: SAMPLE_MEMBER.joined_at
    })
    expect(calls[0]!.url).toBe(`${API_ROOT}/guilds/${GUILD}/members/80351110224678912`)

    const { harness: odd } = connectorWith([{ match: '/members/', body: {} }])
    expect(await odd.execute('getGuildMember', { guild: GUILD, user: '7' })).toMatchObject({ userId: '7', username: null })
  })

  it('fills $NAME samples from the environment, defaulting the user to the bot itself', async () => {
    const { harness, calls } = connectorWith([ME, { match: '/members/', body: SAMPLE_MEMBER }], {
      env: { DISCORD_GUILD_ID: GUILD }
    })
    await harness.execute('getGuildMember', { guild: '$DISCORD_GUILD_ID', user: '$DISCORD_USER_ID' })
    expect(calls.at(-1)!.url).toBe(`${API_ROOT}/guilds/${GUILD}/members/${SELF}`)

    const { harness: unset } = connectorWith([{ match: '/members/', body: SAMPLE_MEMBER }], { env: {} })
    await expect(unset.execute('getGuildMember', { guild: '$DISCORD_GUILD_ID', user: '1' })).rejects.toThrow(
      /guild is required/
    )

    const { harness: noSelf } = connectorWith([{ match: '/users/@me', body: {} }], { env: { DISCORD_GUILD_ID: GUILD } })
    await expect(noSelf.execute('getGuildMember', { guild: '$DISCORD_GUILD_ID', user: '$DISCORD_USER_ID' })).rejects.toThrow(
      /user is required/
    )
  })
})

/* ------------------------------------------------------------- preflight -- */

describe('preflight', () => {
  it('says what to set when the token is missing', async () => {
    const { connector } = connectorWith([])
    expect(await connector.preflight!()).toEqual({
      ok: false,
      message: expect.stringMatching(/Set DISCORD_BOT_TOKEN.*Reset Token/)
    })
  })

  it('reports who the bot is', async () => {
    const { connector } = connectorWith([ME], { env: { DISCORD_BOT_TOKEN: 'Bot tok' } })
    expect(await connector.preflight!()).toEqual({ ok: true, message: `Signed in as vorn-bot (${SELF})` })

    const { connector: bare } = connectorWith([{ match: '/users/@me', body: {} }], { env: { DISCORD_BOT_TOKEN: 'tok' } })
    expect(await bare.preflight!()).toEqual({ ok: true, message: 'Signed in as unknown (unknown id)' })
  })
})

/* ---------------------------------------------------------------- shape -- */

describe('the connector definition', () => {
  it('declares its auth, icon, samples and version', () => {
    const { connector } = connectorWith([])
    expect(connector.auth).toEqual({ rung: 'key', keys: ['botToken'] })
    expect(connector.icon?.paths[0]).toMatch(/^M/)
    expect(connector.version).toBe('0.1.0')
    expect(createDiscordConnector().version).toBe('0.0.0')
    for (const trigger of connector.triggers) expect(trigger.sample).toHaveLength(1)
    for (const action of connector.actions) {
      expect(typeof action.idempotent).toBe('boolean')
      for (const input of action.inputs ?? []) expect(input.description).toBeTruthy()
    }
  })

  it('passes the SDK conformance run on its samples', async () => {
    const { connector } = connectorWith([])
    const run = await runConformance(connector, { now: () => NOW })
    expect(run.findings.filter((finding) => finding.level === 'error')).toEqual([])
    expect(run.passed).toEqual(expect.arrayContaining(['manifest', 'auth', 'secrets', 'actions', 'dedupe']))
  })

  it('warns through console by default', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const full = Array.from({ length: MEMBER_PAGE_SIZE }, (_, index) => ({
      user: { id: String(1000 + index) },
      joined_at: '2026-09-04T18:30:00.000Z'
    }))
    const { fetchImpl } = router([{ match: '/members?', body: full }])
    const harness = createConnectorHarness(createDiscordConnector({ fetchImpl }), {
      config: { botToken: 'tok', guild: GUILD, maxPages: '1' },
      now: () => NOW
    })
    await harness.poll('memberJoined')
    expect(warned).toHaveBeenCalledWith(expect.stringMatching(/DISCORD_MAX_PAGES/))
    warned.mockRestore()
  })
})
