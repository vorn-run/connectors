import type { ConnectorItem } from '@vornrun/connector-sdk'
import { snowflakeTime } from './client'

/** How much of a message's first line becomes the item title. */
const TITLE_LIMIT = 120

// Message types a person wrote: `0` DEFAULT and `19` REPLY. Everything else in the table is a system or app message.
export const DEFAULT_MESSAGE_TYPE = 0
export const REPLY_MESSAGE_TYPE = 19

export interface DiscordUser {
  id: string
  username?: string
  global_name?: string | null
  bot?: boolean
}

export interface DiscordMessage {
  id: string
  channel_id: string
  type?: number
  content?: string
  timestamp: string
  edited_timestamp?: string | null
  author?: DiscordUser
  attachments?: unknown[]
  embeds?: unknown[]
  mention_everyone?: boolean
  pinned?: boolean
  message_reference?: { message_id?: string; channel_id?: string; guild_id?: string } | null
  thread?: { id?: string } | null
}

export interface DiscordMember {
  user?: DiscordUser
  nick?: string | null
  roles?: string[]
  joined_at: string
  premium_since?: string | null
  pending?: boolean
  communication_disabled_until?: string | null
}

export interface ThreadMetadata {
  archived?: boolean
  auto_archive_duration?: number
  archive_timestamp?: string
  locked?: boolean
  create_timestamp?: string | null
}

export interface DiscordChannel {
  id: string
  type?: number
  guild_id?: string
  name?: string | null
  parent_id?: string | null
  owner_id?: string
  position?: number
  topic?: string | null
  nsfw?: boolean
  last_message_id?: string | null
  rate_limit_per_user?: number
  thread_metadata?: ThreadMetadata | null
  message_count?: number
  member_count?: number
}

function truncate(text: string): string {
  return text.length > TITLE_LIMIT ? `${text.slice(0, TITLE_LIMIT - 1)}…` : text
}

export function userLabel(user: DiscordUser | undefined): string {
  return user?.username || user?.global_name || user?.id || 'unknown'
}

/* --------------------------------------------------------- messages -- */

export interface MessageFilter {
  includeBots: boolean
  includeSystem: boolean
  /** The bot's own user id, dropped unless bots are included. */
  selfId?: string
}

export function keepsMessage(message: DiscordMessage, filter: MessageFilter): boolean {
  const type = message.type ?? DEFAULT_MESSAGE_TYPE
  const human = type === DEFAULT_MESSAGE_TYPE || type === REPLY_MESSAGE_TYPE
  if (!human && !filter.includeSystem) return false
  if (filter.includeBots) return true
  if (message.author?.bot === true) return false
  return filter.selfId === undefined || message.author?.id !== filter.selfId
}

export function messageUrl(guildId: string | undefined, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId ?? '@me'}/${channelId}/${messageId}`
}

export function messageToItem(message: DiscordMessage, guildId: string | undefined): ConnectorItem {
  const content = (message.content ?? '').trim()
  const firstLine = content.split('\n')[0]?.trim() ?? ''
  const author = userLabel(message.author)
  return {
    externalId: message.id,
    title: truncate(firstLine ? `${author}: ${firstLine}` : `${author}: message ${message.id}`),
    url: messageUrl(guildId, message.channel_id, message.id),
    description: content,
    ...(message.author?.username && { assignee: message.author.username }),
    updatedAt: message.timestamp,
    data: {
      id: message.id,
      channel_id: message.channel_id,
      guild_id: guildId ?? null,
      type: message.type ?? DEFAULT_MESSAGE_TYPE,
      content: message.content ?? '',
      timestamp: message.timestamp,
      edited_timestamp: message.edited_timestamp ?? null,
      author: message.author
        ? {
            id: message.author.id,
            username: message.author.username ?? '',
            global_name: message.author.global_name ?? null,
            bot: message.author.bot === true
          }
        : null,
      attachments: message.attachments ?? [],
      embeds: message.embeds ?? [],
      mention_everyone: message.mention_everyone === true,
      pinned: message.pinned === true,
      message_reference: message.message_reference ?? null,
      thread: message.thread ?? null
    }
  }
}

/* ---------------------------------------------------------- members -- */

export function memberToItem(member: DiscordMember, guildId: string): ConnectorItem {
  const user = member.user
  const id = user?.id ?? ''
  return {
    externalId: id,
    title: `${userLabel(user)} joined`,
    url: `https://discord.com/users/${id}`,
    ...(member.nick && { description: member.nick }),
    updatedAt: member.joined_at,
    data: {
      user: user
        ? {
            id: user.id,
            username: user.username ?? '',
            global_name: user.global_name ?? null,
            bot: user.bot === true
          }
        : null,
      nick: member.nick ?? null,
      roles: member.roles ?? [],
      joined_at: member.joined_at,
      premium_since: member.premium_since ?? null,
      pending: member.pending === true,
      guild_id: guildId
    }
  }
}

/* ---------------------------------------------------------- threads -- */

// `create_timestamp` is null for threads made before 2022-01-09; the id's snowflake time stands in.
export function threadCreatedAt(thread: DiscordChannel): string {
  const stamped = thread.thread_metadata?.create_timestamp
  if (stamped) return stamped
  return new Date(snowflakeTime(thread.id)).toISOString()
}

export function threadToItem(thread: DiscordChannel, guildId: string): ConnectorItem {
  const name = thread.name || thread.id
  const metadata = thread.thread_metadata ?? {}
  return {
    externalId: thread.id,
    title: truncate(`Thread: ${name}`),
    url: `https://discord.com/channels/${thread.guild_id ?? guildId}/${thread.id}`,
    updatedAt: threadCreatedAt(thread),
    data: {
      id: thread.id,
      type: thread.type ?? null,
      guild_id: thread.guild_id ?? guildId,
      parent_id: thread.parent_id ?? null,
      owner_id: thread.owner_id ?? null,
      name,
      message_count: thread.message_count ?? null,
      member_count: thread.member_count ?? null,
      thread_metadata: {
        archived: metadata.archived === true,
        auto_archive_duration: metadata.auto_archive_duration ?? null,
        archive_timestamp: metadata.archive_timestamp ?? null,
        locked: metadata.locked === true,
        create_timestamp: metadata.create_timestamp ?? null
      }
    }
  }
}

/* ---------------------------------------------------------- outputs -- */

export function channelOutput(channel: DiscordChannel): Record<string, unknown> {
  return {
    id: channel.id,
    name: channel.name ?? null,
    type: channel.type ?? null,
    guildId: channel.guild_id ?? null,
    parentId: channel.parent_id ?? null,
    topic: channel.topic ?? null,
    nsfw: channel.nsfw === true,
    lastMessageId: channel.last_message_id ?? null,
    rateLimitPerUser: channel.rate_limit_per_user ?? null,
    threadMetadata: channel.thread_metadata ?? null,
    messageCount: channel.message_count ?? null,
    memberCount: channel.member_count ?? null
  }
}

export function channelSummary(channel: DiscordChannel): Record<string, unknown> {
  return {
    id: channel.id,
    name: channel.name ?? null,
    type: channel.type ?? null,
    parentId: channel.parent_id ?? null,
    position: channel.position ?? null,
    topic: channel.topic ?? null,
    nsfw: channel.nsfw === true
  }
}

export function memberOutput(member: DiscordMember): Record<string, unknown> {
  return {
    userId: member.user?.id ?? null,
    username: member.user?.username ?? null,
    globalName: member.user?.global_name ?? null,
    nick: member.nick ?? null,
    roles: member.roles ?? [],
    joinedAt: member.joined_at ?? null,
    premiumSince: member.premium_since ?? null,
    pending: member.pending === true,
    communicationDisabledUntil: member.communication_disabled_until ?? null,
    isBot: member.user?.bot === true
  }
}

/* ---------------------------------------------------------- samples -- */

const SAMPLE_GUILD = '197038439483310086'
const SAMPLE_CHANNEL = '41771983423143937'
const SAMPLE_USER: DiscordUser = {
  id: '80351110224678912',
  username: 'wumpus',
  global_name: 'Wumpus',
  bot: false
}

export const SAMPLE_MESSAGE: DiscordMessage = {
  id: '1412345678901234567',
  channel_id: SAMPLE_CHANNEL,
  type: 0,
  content: 'Deploy finished for build 418',
  timestamp: '2026-09-04T18:41:02.123000+00:00',
  edited_timestamp: null,
  author: SAMPLE_USER,
  attachments: [],
  embeds: [],
  mention_everyone: false,
  pinned: false,
  message_reference: null,
  thread: null
}

export const SAMPLE_MEMBER: DiscordMember = {
  user: SAMPLE_USER,
  nick: null,
  roles: [],
  joined_at: '2026-09-04T18:30:00.000000+00:00',
  premium_since: null,
  pending: false
}

export const SAMPLE_THREAD: DiscordChannel = {
  id: '1412345678901234567',
  type: 11,
  guild_id: SAMPLE_GUILD,
  parent_id: SAMPLE_CHANNEL,
  owner_id: SAMPLE_USER.id,
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

export const SAMPLE_MESSAGE_ITEM = messageToItem(SAMPLE_MESSAGE, SAMPLE_GUILD)
export const SAMPLE_MEMBER_ITEM = memberToItem(SAMPLE_MEMBER, SAMPLE_GUILD)
export const SAMPLE_THREAD_ITEM = threadToItem(SAMPLE_THREAD, SAMPLE_GUILD)
