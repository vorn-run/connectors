import { describe, expect, it } from 'vitest'
import { snowflakeTime } from './client'
import {
  SAMPLE_MEMBER,
  SAMPLE_MEMBER_ITEM,
  SAMPLE_MESSAGE,
  SAMPLE_MESSAGE_ITEM,
  SAMPLE_THREAD,
  SAMPLE_THREAD_ITEM,
  channelOutput,
  channelSummary,
  keepsMessage,
  memberOutput,
  memberToItem,
  messageToItem,
  messageUrl,
  threadCreatedAt,
  threadToItem,
  userLabel
} from './items'

const GUILD = '197038439483310086'

describe('keepsMessage', () => {
  const human = { ...SAMPLE_MESSAGE }
  const bot = { ...SAMPLE_MESSAGE, author: { id: '2', username: 'robot', bot: true } }
  const system = { ...SAMPLE_MESSAGE, type: 7 }
  const self = { ...SAMPLE_MESSAGE, author: { id: 'me', username: 'this-bot', bot: true } }
  const defaults = { includeBots: false, includeSystem: false, selfId: 'me' }

  it('keeps default and reply messages from people by default', () => {
    expect(keepsMessage(human, defaults)).toBe(true)
    expect(keepsMessage({ ...human, type: 19 }, defaults)).toBe(true)
    expect(keepsMessage({ ...human, type: undefined }, defaults)).toBe(true)
  })

  it('drops bots, itself and system messages by default', () => {
    expect(keepsMessage(bot, defaults)).toBe(false)
    expect(keepsMessage(self, defaults)).toBe(false)
    expect(keepsMessage(system, defaults)).toBe(false)
    expect(keepsMessage({ ...human, author: { id: 'me' } }, defaults)).toBe(false)
  })

  it('keeps bots and its own messages when asked', () => {
    const bots = { ...defaults, includeBots: true }
    expect(keepsMessage(bot, bots)).toBe(true)
    expect(keepsMessage(self, bots)).toBe(true)
    expect(keepsMessage(system, bots)).toBe(false)
  })

  it('keeps system messages when asked, still without bots', () => {
    const systems = { ...defaults, includeSystem: true }
    expect(keepsMessage(system, systems)).toBe(true)
    expect(keepsMessage({ ...system, author: bot.author }, systems)).toBe(false)
  })

  it('keeps every author when no self id is known', () => {
    expect(keepsMessage({ ...human, author: { id: 'me' } }, { includeBots: false, includeSystem: false })).toBe(true)
  })
})

describe('messageToItem', () => {
  it('matches the documented sample', () => {
    expect(SAMPLE_MESSAGE_ITEM).toEqual({
      externalId: '1412345678901234567',
      title: 'wumpus: Deploy finished for build 418',
      url: 'https://discord.com/channels/197038439483310086/41771983423143937/1412345678901234567',
      description: 'Deploy finished for build 418',
      assignee: 'wumpus',
      updatedAt: '2026-09-04T18:41:02.123000+00:00',
      data: {
        id: '1412345678901234567',
        channel_id: '41771983423143937',
        guild_id: '197038439483310086',
        type: 0,
        content: 'Deploy finished for build 418',
        timestamp: '2026-09-04T18:41:02.123000+00:00',
        edited_timestamp: null,
        author: { id: '80351110224678912', username: 'wumpus', global_name: 'Wumpus', bot: false },
        attachments: [],
        embeds: [],
        mention_everyone: false,
        pinned: false,
        message_reference: null,
        thread: null
      }
    })
  })

  it('titles a message without text, and uses @me for a DM', () => {
    const item = messageToItem({ id: '5', channel_id: '7', timestamp: '2026-01-01T00:00:00Z' }, undefined)
    expect(item.title).toBe('unknown: message 5')
    expect(item.url).toBe('https://discord.com/channels/@me/7/5')
    expect(item.assignee).toBeUndefined()
    expect(item.data?.author).toBeNull()
    expect(item.data?.guild_id).toBeNull()
    expect(item.data?.type).toBe(0)
  })

  it('takes the first line and truncates a long one', () => {
    const long = `${'a'.repeat(200)}\nsecond line`
    const item = messageToItem({ ...SAMPLE_MESSAGE, content: long }, GUILD)
    expect(item.title).toHaveLength(120)
    expect(item.title.endsWith('…')).toBe(true)
    expect(item.description).toBe(long)
  })

  it('falls back through the author names', () => {
    expect(userLabel({ id: '1', global_name: 'Global' })).toBe('Global')
    expect(userLabel({ id: '1' })).toBe('1')
    expect(userLabel(undefined)).toBe('unknown')
  })

  it('builds a message url', () => {
    expect(messageUrl('g', 'c', 'm')).toBe('https://discord.com/channels/g/c/m')
  })
})

describe('memberToItem', () => {
  it('matches the documented sample', () => {
    expect(SAMPLE_MEMBER_ITEM).toEqual({
      externalId: '80351110224678912',
      title: 'wumpus joined',
      url: 'https://discord.com/users/80351110224678912',
      updatedAt: '2026-09-04T18:30:00.000000+00:00',
      data: {
        user: { id: '80351110224678912', username: 'wumpus', global_name: 'Wumpus', bot: false },
        nick: null,
        roles: [],
        joined_at: '2026-09-04T18:30:00.000000+00:00',
        premium_since: null,
        pending: false,
        guild_id: '197038439483310086'
      }
    })
  })

  it('carries the nickname and survives a member without a user', () => {
    const named = memberToItem({ ...SAMPLE_MEMBER, nick: 'Wump', roles: ['1'] }, GUILD)
    expect(named.description).toBe('Wump')
    expect(named.data?.roles).toEqual(['1'])

    const bare = memberToItem({ joined_at: '2026-01-01T00:00:00Z' }, GUILD)
    expect(bare.externalId).toBe('')
    expect(bare.title).toBe('unknown joined')
    expect(bare.data?.user).toBeNull()
  })
})

describe('threads', () => {
  it('matches the documented sample', () => {
    expect(SAMPLE_THREAD_ITEM).toEqual({
      externalId: '1412345678901234567',
      title: 'Thread: Build 418 rollout',
      url: 'https://discord.com/channels/197038439483310086/1412345678901234567',
      updatedAt: '2026-09-04T18:45:10.000000+00:00',
      data: {
        id: '1412345678901234567',
        type: 11,
        guild_id: '197038439483310086',
        parent_id: '41771983423143937',
        owner_id: '80351110224678912',
        name: 'Build 418 rollout',
        message_count: 1,
        member_count: 2,
        thread_metadata: {
          archived: false,
          auto_archive_duration: 1440,
          archive_timestamp: '2026-09-04T18:45:10.000000+00:00',
          locked: false,
          create_timestamp: '2026-09-04T18:45:10.000000+00:00'
        }
      }
    })
  })

  it('falls back to the snowflake time when create_timestamp is null', () => {
    const old = { id: '175928847299117063', thread_metadata: { create_timestamp: null } }
    expect(threadCreatedAt(old)).toBe(new Date(snowflakeTime(old.id)).toISOString())
    expect(threadCreatedAt({ id: old.id })).toBe(new Date(1462015105796).toISOString())
    expect(threadCreatedAt(SAMPLE_THREAD)).toBe('2026-09-04T18:45:10.000000+00:00')
  })

  it('names a nameless thread by id and fills missing metadata', () => {
    const item = threadToItem({ id: '175928847299117063' }, GUILD)
    expect(item.title).toBe('Thread: 175928847299117063')
    expect(item.url).toBe(`https://discord.com/channels/${GUILD}/175928847299117063`)
    expect(item.data?.guild_id).toBe(GUILD)
    expect(item.data?.thread_metadata).toEqual({
      archived: false,
      auto_archive_duration: null,
      archive_timestamp: null,
      locked: false,
      create_timestamp: null
    })
  })
})

describe('outputs', () => {
  it('shapes a channel for getChannel and listChannels', () => {
    expect(channelOutput({ id: '1', name: 'general', type: 0, guild_id: GUILD, nsfw: true })).toEqual({
      id: '1',
      name: 'general',
      type: 0,
      guildId: GUILD,
      parentId: null,
      topic: null,
      nsfw: true,
      lastMessageId: null,
      rateLimitPerUser: null,
      threadMetadata: null,
      messageCount: null,
      memberCount: null
    })
    expect(channelOutput(SAMPLE_THREAD).threadMetadata).toEqual(SAMPLE_THREAD.thread_metadata)
    expect(channelSummary({ id: '1', position: 3 })).toEqual({
      id: '1',
      name: null,
      type: null,
      parentId: null,
      position: 3,
      topic: null,
      nsfw: false
    })
  })

  it('shapes a member for getGuildMember', () => {
    expect(memberOutput({ ...SAMPLE_MEMBER, communication_disabled_until: '2026-09-05T00:00:00Z' })).toEqual({
      userId: '80351110224678912',
      username: 'wumpus',
      globalName: 'Wumpus',
      nick: null,
      roles: [],
      joinedAt: '2026-09-04T18:30:00.000000+00:00',
      premiumSince: null,
      pending: false,
      communicationDisabledUntil: '2026-09-05T00:00:00Z',
      isBot: false
    })
    expect(memberOutput({} as never)).toMatchObject({ userId: null, username: null, joinedAt: null, isBot: false })
  })
})
