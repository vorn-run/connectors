import {
  defineConnector,
  type ConnectorConfig,
  type ConnectorItem,
  type FetchContext
} from '@vornrun/connector-sdk'
import {
  DiscordApiError,
  compareSnowflakes,
  createDiscordClient,
  maxSnowflake,
  normalizeToken,
  snowflakeFrom,
  type DiscordClient,
  type FetchLike,
  type Sleep,
  type Warn
} from './client'
import {
  SAMPLE_MEMBER_ITEM,
  SAMPLE_MESSAGE_ITEM,
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
  userLabel,
  type DiscordChannel,
  type DiscordMember,
  type DiscordMessage,
  type DiscordUser
} from './items'

/** Discord's maximum `limit` for a page of messages. */
export const MESSAGE_PAGE_SIZE = 100

/** Discord's maximum `limit` for a page of guild members. */
export const MEMBER_PAGE_SIZE = 1000

export const MAX_CONTENT_LENGTH = 2000

export const MAX_EMBEDS = 10

export const MAX_THREAD_NAME_LENGTH = 100

export const AUTO_ARCHIVE_DURATIONS = [60, 1440, 4320, 10080] as const

const DEFAULT_AUTO_ARCHIVE = 1440

const DEFAULT_LOOKBACK_MINUTES = 60

const DEFAULT_MAX_PAGES = 5

// Discord's JSON error code for "A thread has already been created for this message".
const THREAD_EXISTS = 160004

const MEMBERS_INTENT_NOTE =
  'Listing guild members needs the Server Members intent: enable it under Privileged Gateway Intents on the Bot page at https://discord.com/developers/applications.'

export interface DiscordConnectorOptions {
  version?: string
  /** Injected in tests, so nothing reaches the network. */
  fetchImpl?: FetchLike
  /** Injected in tests, so no test spends real time asleep. */
  sleep?: Sleep
  /** Advisories go to stderr: stdout carries the MCP protocol. */
  warn?: Warn
  /** Where preflight and `$NAME` samples read from; defaults to the process environment. */
  env?: NodeJS.ProcessEnv
}

/* --------------------------------------------------------------- config -- */

function text(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim()
  return trimmed === '' ? undefined : trimmed
}

function flag(value: unknown): boolean {
  return /^(true|1|yes)$/i.test(String(value ?? '').trim())
}

function integer(value: unknown, env: string, fallback: number, min: number): number {
  const raw = text(value)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${env} must be a whole number of at least ${min}, got "${raw}"`)
  }
  return parsed
}

export interface Settings {
  token: string
  channel?: string
  guild?: string
  includeBots: boolean
  includeSystem: boolean
  lookbackMinutes: number
  maxPages: number
}

export function readSettings(config: ConnectorConfig): Settings {
  const channel = text(config.channel)
  const guild = text(config.guild)
  return {
    token: normalizeToken(config.botToken),
    ...(channel && { channel }),
    ...(guild && { guild }),
    includeBots: flag(config.includeBots),
    includeSystem: flag(config.includeSystem),
    lookbackMinutes: integer(config.lookbackMinutes, 'DISCORD_LOOKBACK_MINUTES', DEFAULT_LOOKBACK_MINUTES, 0),
    maxPages: integer(config.maxPages, 'DISCORD_MAX_PAGES', DEFAULT_MAX_PAGES, 1)
  }
}

function required(value: unknown, key: string, env: string): string {
  const found = text(value)
  if (!found) throw new Error(`${key} is required: set ${env} on the connection`)
  return found
}

// The look-back window on a first poll, so an old channel is not replayed.
function boundaryOf(context: FetchContext, lookbackMinutes: number): number {
  if (context.since) return Date.parse(context.since)
  return Date.parse(context.now()) - lookbackMinutes * 60_000
}

/* ---------------------------------------------------------------- input -- */

// Embeds arrive as parsed JSON: an array of embed objects, or one object for a single embed.
export function embedList(value: unknown): Record<string, unknown>[] | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const list = Array.isArray(value) ? value : [value]
  if (list.length > MAX_EMBEDS) {
    throw new Error(`embeds may hold at most ${MAX_EMBEDS} embeds, got ${list.length}`)
  }
  for (const embed of list) {
    if (typeof embed !== 'object' || embed === null || Array.isArray(embed)) {
      throw new Error('embeds must be a JSON array of embed objects')
    }
  }
  return list as Record<string, unknown>[]
}

export function sendableContent(value: unknown, key = 'content'): string | undefined {
  const body = text(value)
  if (body === undefined) return undefined
  if (body.length > MAX_CONTENT_LENGTH) {
    throw new Error(
      `${key} is ${body.length} characters; Discord refuses more than ${MAX_CONTENT_LENGTH}. Shorten it or split it across steps.`
    )
  }
  return body
}

export function threadName(value: unknown): string {
  const name = text(value)
  if (!name) throw new Error('name is required')
  if (name.length > MAX_THREAD_NAME_LENGTH) {
    throw new Error(`name is ${name.length} characters; a thread name holds at most ${MAX_THREAD_NAME_LENGTH}`)
  }
  return name
}

export function autoArchiveDuration(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_AUTO_ARCHIVE
  const minutes = Number(value)
  if (!(AUTO_ARCHIVE_DURATIONS as readonly number[]).includes(minutes)) {
    throw new Error(`autoArchiveDuration must be one of ${AUTO_ARCHIVE_DURATIONS.join(', ')}, got "${String(value)}"`)
  }
  return minutes
}

// `<:name:id>` and `<a:name:id>` are how a custom emoji is pasted from a message; the API wants `name:id`.
export function emojiSegment(value: unknown): string {
  const emoji = text(value)
  if (!emoji) throw new Error('emoji is required')
  const custom = /^<a?:([^:>]+):(\d+)>$/.exec(emoji)
  return encodeURIComponent(custom ? `${custom[1]}:${custom[2]}` : emoji)
}

/* ------------------------------------------------------------ connector -- */

export function createDiscordConnector(options: DiscordConnectorOptions = {}) {
  const version = options.version ?? '0.0.0'
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const env = options.env ?? process.env

  // A `$NAME` argument reads the environment: the live samples name ids that only the machine running them knows.
  function fromEnv(value: unknown): string | undefined {
    const raw = text(value)
    if (raw === undefined) return undefined
    const match = /^\$([A-Z][A-Z0-9_]*)$/.exec(raw)
    return match ? text(env[match[1]!]) : raw
  }

  function clientFor(config: ConnectorConfig, fetchImpl?: typeof fetch): DiscordClient {
    return createDiscordClient({
      token: normalizeToken(config.botToken),
      version,
      fetchImpl: options.fetchImpl ?? (fetchImpl as FetchLike | undefined),
      ...(options.sleep && { sleep: options.sleep }),
      warn
    })
  }

  // Cached for the process: the answer only changes when the bot is replaced, and a connector process is per connection.
  const selfIds = new Map<string, Promise<string>>()

  function selfId(token: string, client: DiscordClient): Promise<string> {
    let pending = selfIds.get(token)
    if (!pending) {
      pending = client.get<DiscordUser>('users/@me').then((me) => String(me?.id ?? ''))
      pending.catch(() => selfIds.delete(token))
      selfIds.set(token, pending)
    }
    return pending
  }

  // A message fetched over HTTP carries no `guild_id`, and the URL needs it; the channel is read once per process.
  const guildIds = new Map<string, Promise<string | undefined>>()

  function guildIdOf(channel: string, client: DiscordClient): Promise<string | undefined> {
    let pending = guildIds.get(channel)
    if (!pending) {
      pending = client.get<DiscordChannel>(`channels/${encodeURIComponent(channel)}`).then((found) => {
        const id = found?.guild_id
        return typeof id === 'string' && id !== '' ? id : undefined
      })
      pending.catch(() => guildIds.delete(channel))
      guildIds.set(channel, pending)
    }
    return pending
  }

  /* ---------------------------------------------------------- triggers -- */

  async function fetchMessages(context: FetchContext): Promise<ConnectorItem[]> {
    const settings = readSettings(context.config)
    const channel = required(settings.channel, 'channel', 'DISCORD_CHANNEL_ID')
    const client = clientFor(context.config, context.fetch)
    const path = `channels/${encodeURIComponent(channel)}/messages`

    const filter = {
      includeBots: settings.includeBots,
      includeSystem: settings.includeSystem,
      ...(!settings.includeBots && { selfId: await selfId(settings.token, client) })
    }
    const guildId = await guildIdOf(channel, client)

    // Keyed by id: the SDK refuses a page carrying the same item twice, and pages can overlap while people post.
    const collected = new Map<string, DiscordMessage>()
    let after = snowflakeFrom(boundaryOf(context, settings.lookbackMinutes))
    for (let page = 0; page < settings.maxPages; page += 1) {
      const messages = await client.get<DiscordMessage[]>(path, { after, limit: MESSAGE_PAGE_SIZE })
      const batch = Array.isArray(messages) ? messages : []
      for (const message of batch) if (message?.id) collected.set(message.id, message)
      const newest = maxSnowflake(batch.map((message) => message.id))
      if (batch.length < MESSAGE_PAGE_SIZE || newest === undefined) break
      after = newest
    }

    return [...collected.values()]
      .filter((message) => keepsMessage(message, filter))
      .sort((left, right) => compareSnowflakes(left.id, right.id))
      .map((message) => messageToItem(message, guildId))
  }

  async function fetchMembers(context: FetchContext): Promise<ConnectorItem[]> {
    const settings = readSettings(context.config)
    const guild = required(settings.guild, 'guild', 'DISCORD_GUILD_ID')
    const client = clientFor(context.config, context.fetch)
    const path = `guilds/${encodeURIComponent(guild)}/members`
    const boundary = boundaryOf(context, settings.lookbackMinutes)

    const joined = new Map<string, DiscordMember>()
    let after: string | undefined
    let page = 0
    for (;;) {
      let members: DiscordMember[]
      try {
        members = await client.get<DiscordMember[]>(path, { limit: MEMBER_PAGE_SIZE, after })
      } catch (error) {
        if (error instanceof DiscordApiError && error.status === 403) {
          throw new Error(`${error.message}. ${MEMBERS_INTENT_NOTE}`, { cause: error })
        }
        throw error
      }
      const batch = Array.isArray(members) ? members : []
      for (const member of batch) {
        if (member.user?.id && Date.parse(member.joined_at) >= boundary) joined.set(member.user.id, member)
      }
      page += 1
      const last = maxSnowflake(batch.map((member) => member.user?.id ?? '').filter(Boolean))
      if (batch.length < MEMBER_PAGE_SIZE || last === undefined) break
      if (page >= settings.maxPages) {
        warn(
          `Discord: guild ${guild} has more than ${settings.maxPages * MEMBER_PAGE_SIZE} members; raise DISCORD_MAX_PAGES to walk them all.`
        )
        break
      }
      after = last
    }

    return [...joined.values()]
      .sort((left, right) => left.joined_at.localeCompare(right.joined_at))
      .map((member) => memberToItem(member, guild))
  }

  async function fetchThreads(context: FetchContext): Promise<ConnectorItem[]> {
    const settings = readSettings(context.config)
    const guild = required(settings.guild, 'guild', 'DISCORD_GUILD_ID')
    const client = clientFor(context.config, context.fetch)
    const boundary = boundaryOf(context, settings.lookbackMinutes)

    const body = await client.get<{ threads?: DiscordChannel[] }>(
      `guilds/${encodeURIComponent(guild)}/threads/active`
    )
    const threads = Array.isArray(body?.threads) ? body.threads : []
    return threads
      .filter((thread) => typeof thread?.id === 'string')
      .filter((thread) => settings.channel === undefined || thread.parent_id === settings.channel)
      .filter((thread) => Date.parse(threadCreatedAt(thread)) >= boundary)
      .sort((left, right) => threadCreatedAt(left).localeCompare(threadCreatedAt(right)))
      .map((thread) => threadToItem(thread, guild))
  }

  /* ----------------------------------------------------------- actions -- */

  function channelArg(args: Record<string, unknown>): string {
    const channel = fromEnv(args.channel)
    if (!channel) throw new Error('channel is required')
    return channel
  }

  function idArg(args: Record<string, unknown>, key: string): string {
    const id = fromEnv(args[key])
    if (!id) throw new Error(`${key} is required`)
    return id
  }

  return defineConnector({
    id: 'discord',
    name: 'Discord',
    version,
    description:
      'Trigger workflows from new Discord messages, members and threads, and send messages, reply in threads, react, pin or read channels and members from a step.',
    auth: { rung: 'key', keys: ['botToken'] },
    // Clyde, Discord's controller-shaped face, with the eyes punched through by the evenodd rule.
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.35-.76-.54-1.09-.01-.02-.04-.03-.07-.03-1.5.26-2.93.71-4.27 1.33-.01 0-.02.01-.03.02-2.72 4.07-3.47 8.03-3.1 11.95 0 .02.01.04.03.05 1.8 1.32 3.53 2.12 5.24 2.65.03.01.06 0 .07-.02.4-.55.76-1.13 1.07-1.74.02-.04 0-.08-.04-.09-.57-.22-1.11-.48-1.64-.78-.04-.02-.04-.08-.01-.11.11-.08.22-.17.33-.25.02-.02.05-.02.07-.01 3.44 1.57 7.15 1.57 10.55 0 .02-.01.05-.01.07.01.11.09.22.17.33.26.04.03.04.09-.01.11-.52.31-1.07.56-1.64.78-.04.01-.05.06-.04.09.32.61.68 1.19 1.07 1.74.03.01.06.02.09.01 1.72-.53 3.45-1.33 5.25-2.65.02-.01.03-.03.03-.05.44-4.53-.73-8.46-3.1-11.95-.01-.01-.02-.02-.04-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.83 2.12-1.89 2.12z'
      ]
    },
    config: [
      {
        key: 'botToken',
        env: 'DISCORD_BOT_TOKEN',
        label: 'Bot token',
        secret: true,
        required: true,
        description:
          'From https://discord.com/developers/applications: open the application, Bot tab, Reset Token, and paste the token it shows once. Sent as `Authorization: Bot <token>`.',
        builderHint:
          'A bot token, not an OAuth2 Bearer token. Reading message text needs the Message Content intent and listing members the Server Members intent, both under Privileged Gateway Intents on the same Bot page. A pasted "Bot " prefix is stripped.'
      },
      {
        key: 'channel',
        env: 'DISCORD_CHANNEL_ID',
        label: 'Channel',
        description:
          'Channel or thread id (Developer Mode → right-click → Copy Channel ID). Required by the message trigger; narrows the thread trigger to one parent channel.',
        builderHint:
          'A snowflake, so keep it a string. A thread is a channel: point a second connection at the thread id to watch its replies.'
      },
      {
        key: 'guild',
        env: 'DISCORD_GUILD_ID',
        label: 'Server',
        description: 'Guild (server) id. Required by the member and thread triggers.',
        builderHint: 'Also a snowflake. Right-click the server name with Developer Mode on to copy it.'
      },
      {
        key: 'includeBots',
        env: 'DISCORD_INCLUDE_BOTS',
        label: 'Include bot messages',
        default: 'false',
        description:
          'Deliver messages whose author is a bot, including this one’s. Off by default so a workflow that posts into the channel it watches does not loop.'
      },
      {
        key: 'includeSystem',
        env: 'DISCORD_INCLUDE_SYSTEM',
        label: 'Include system messages',
        default: 'false',
        description: 'Deliver joins, pins, boosts, thread notices and other messages nobody typed.'
      },
      {
        key: 'lookbackMinutes',
        env: 'DISCORD_LOOKBACK_MINUTES',
        label: 'First poll look-back (minutes)',
        default: String(DEFAULT_LOOKBACK_MINUTES),
        description: 'How far back the very first poll looks. Later polls continue from where the last one stopped.'
      },
      {
        key: 'maxPages',
        env: 'DISCORD_MAX_PAGES',
        label: 'Pages per poll',
        default: String(DEFAULT_MAX_PAGES),
        description: 'Pages of 100 messages or 1000 members one poll walks before leaving the rest for the next.'
      }
    ],
    async preflight() {
      const token = text(env.DISCORD_BOT_TOKEN)
      if (!token) {
        return {
          ok: false,
          message:
            'Set DISCORD_BOT_TOKEN: create one at https://discord.com/developers/applications under the Bot tab with Reset Token.'
        }
      }
      const client = createDiscordClient({ token: normalizeToken(token), version, ...(options.fetchImpl && { fetchImpl: options.fetchImpl }), warn })
      const me = await client.get<DiscordUser>('users/@me')
      return { ok: true, message: `Signed in as ${userLabel(me)} (${me?.id ?? 'unknown id'})` }
    },
    triggers: [
      {
        type: 'messageInChannel',
        label: 'A message is posted in a channel',
        description:
          'Fires once per new message in the channel or thread. Bot and system messages are skipped unless the connection includes them. Reading the text needs the Message Content intent.',
        defaultWorkflow: { name: 'Discord: messages', defaultCronFromMinutes: 1 },
        dedupe: 'timestamp',
        sample: [SAMPLE_MESSAGE_ITEM],
        fetch: fetchMessages
      },
      {
        type: 'memberJoined',
        label: 'A member joins the server',
        description:
          'Fires once per member who joined the guild since the last poll. Needs the Server Members intent.',
        defaultWorkflow: { name: 'Discord: new members', defaultCronFromMinutes: 5 },
        dedupe: 'timestamp',
        sample: [SAMPLE_MEMBER_ITEM],
        fetch: fetchMembers
      },
      {
        type: 'threadCreated',
        label: 'A thread is created',
        description:
          'Fires once per active thread created since the last poll, in every channel of the guild or only under the configured channel.',
        defaultWorkflow: { name: 'Discord: new threads', defaultCronFromMinutes: 5 },
        dedupe: 'timestamp',
        sample: [SAMPLE_THREAD_ITEM],
        fetch: fetchThreads
      }
    ],
    actions: [
      {
        type: 'sendMessage',
        label: 'Send a message',
        description: 'Post a message to a channel or thread, optionally as a reply and with embeds.',
        idempotent: false,
        inputs: [
          {
            key: 'channel',
            label: 'Channel',
            required: true,
            description: 'Channel or thread id.',
            builderHint: 'Defaults to nothing: a step names the channel it posts to, which is often {{trigger.item.channel_id}}.'
          },
          {
            key: 'content',
            label: 'Message',
            description: 'Text, up to 2000 characters. Required unless embeds are given.',
            builderHint: 'Markdown as Discord renders it; mentions are <@userId>.'
          },
          {
            key: 'embeds',
            label: 'Embeds',
            type: 'json',
            description:
              'A JSON array of up to 10 embed objects (title, description, url, color, fields, footer, image, thumbnail, author, timestamp).',
            builderHint: 'Needs the Embed Links permission to render. One object is taken as a single embed.'
          },
          {
            key: 'replyTo',
            label: 'Reply to',
            description: 'Message id to reply to, from {{trigger.item.id}}.',
            builderHint: 'Sent as message_reference with fail_if_not_exists false, so a deleted target posts a plain message rather than failing.'
          }
        ],
        outputs: [
          { key: 'id', description: 'Id of the message' },
          { key: 'channelId', description: 'The channel it landed in' },
          { key: 'content', description: 'The text as stored' },
          { key: 'timestamp', description: 'When Discord received it' },
          { key: 'url', description: 'Link to the message' }
        ],
        async run(args, context) {
          const channel = channelArg(args)
          const content = sendableContent(args.content)
          const embeds = embedList(args.embeds)
          if (content === undefined && embeds === undefined) {
            throw new Error('content or embeds is required: Discord cannot send an empty message')
          }
          const replyTo = text(args.replyTo)
          const client = clientFor(context.config, context.fetch)
          const sent = await client.request<DiscordMessage>('POST', `channels/${encodeURIComponent(channel)}/messages`, {
            body: {
              ...(content !== undefined && { content }),
              ...(embeds !== undefined && { embeds }),
              ...(replyTo && { message_reference: { message_id: replyTo, fail_if_not_exists: false } })
            }
          })
          const id = sent?.id ?? null
          const channelId = sent?.channel_id ?? channel
          return {
            id,
            channelId,
            content: sent?.content ?? content ?? '',
            timestamp: sent?.timestamp ?? null,
            url: id ? messageUrl(await guildIdOf(channelId, client), channelId, id) : null
          }
        }
      },
      {
        type: 'createThread',
        label: 'Reply in a thread',
        description:
          'Start a thread from a message, or use the one it already has, and post a reply in it.',
        idempotent: false,
        inputs: [
          { key: 'channel', label: 'Channel', required: true, description: 'The parent channel id.' },
          {
            key: 'message',
            label: 'Message',
            required: true,
            description: 'The message to thread from, from {{trigger.item.id}}.',
            builderHint: 'A thread shares its id with the source message, so a thread that already exists is found by this id.'
          },
          {
            key: 'name',
            label: 'Thread name',
            required: true,
            description: 'Thread name, 1 to 100 characters. Ignored when the thread already exists.'
          },
          {
            key: 'content',
            label: 'Reply',
            required: true,
            description: 'The reply to post in the thread, up to 2000 characters.'
          },
          {
            key: 'autoArchiveDuration',
            label: 'Auto-archive after',
            type: 'select',
            options: [
              { value: '60', label: '1 hour' },
              { value: '1440', label: '1 day' },
              { value: '4320', label: '3 days' },
              { value: '10080', label: '1 week' }
            ],
            description: 'Minutes of inactivity before the thread archives: 60, 1440, 4320 or 10080. Defaults to 1440.',
            builderHint: 'Discord accepts only these four values; anything else is refused before the call.'
          }
        ],
        outputs: [
          { key: 'threadId', description: 'Id of the thread, the same as the source message' },
          { key: 'threadName', description: 'Name of the thread' },
          { key: 'created', type: 'boolean', description: 'Whether this call made the thread' },
          { key: 'messageId', description: 'Id of the reply posted in the thread' },
          { key: 'url', description: 'Link to the reply' }
        ],
        async run(args, context) {
          const channel = channelArg(args)
          const message = idArg(args, 'message')
          const name = threadName(args.name)
          const content = sendableContent(args.content)
          if (content === undefined) throw new Error('content is required')
          const minutes = autoArchiveDuration(args.autoArchiveDuration)
          const client = clientFor(context.config, context.fetch)

          let threadId = message
          let threadLabel = name
          let created = false
          try {
            const thread = await client.request<DiscordChannel>(
              'POST',
              `channels/${encodeURIComponent(channel)}/messages/${encodeURIComponent(message)}/threads`,
              { body: { name, auto_archive_duration: minutes } }
            )
            threadId = thread?.id ?? message
            threadLabel = thread?.name ?? name
            created = true
          } catch (error) {
            if (!(error instanceof DiscordApiError) || error.code !== THREAD_EXISTS) throw error
          }

          const posted = await client.request<DiscordMessage>('POST', `channels/${encodeURIComponent(threadId)}/messages`, {
            body: { content }
          })
          const messageId = posted?.id ?? null
          return {
            threadId,
            threadName: threadLabel,
            created,
            messageId,
            url: messageId ? messageUrl(await guildIdOf(channel, client), threadId, messageId) : null
          }
        }
      },
      {
        type: 'addReaction',
        label: 'Add a reaction',
        description: 'React to a message with a Unicode or custom emoji.',
        idempotent: false,
        inputs: [
          { key: 'channel', label: 'Channel', required: true, description: 'Channel or thread id.' },
          { key: 'message', label: 'Message', required: true, description: 'Message id.' },
          {
            key: 'emoji',
            label: 'Emoji',
            required: true,
            description: 'A Unicode emoji such as 👍, or name:id for a custom one.',
            builderHint: 'URL-encoded into the path; a pasted <:name:id> is reduced to name:id. Needs Read Message History and Add Reactions.'
          }
        ],
        outputs: [{ key: 'ok', type: 'boolean', description: 'True once Discord answered 204' }],
        async run(args, context) {
          const channel = channelArg(args)
          const message = idArg(args, 'message')
          const emoji = emojiSegment(args.emoji)
          await clientFor(context.config, context.fetch).request(
            'PUT',
            `channels/${encodeURIComponent(channel)}/messages/${encodeURIComponent(message)}/reactions/${emoji}/@me`
          )
          return { ok: true }
        }
      },
      {
        type: 'pinMessage',
        label: 'Pin a message',
        description: 'Pin a message in its channel. Pinning one already pinned is a no-op.',
        idempotent: true,
        inputs: [
          { key: 'channel', label: 'Channel', required: true, description: 'Channel or thread id.' },
          {
            key: 'message',
            label: 'Message',
            required: true,
            description: 'Message id.',
            builderHint: 'Needs the Pin Messages permission; a channel holds at most 250 pins and Discord answers 30003 past that.'
          }
        ],
        outputs: [{ key: 'ok', type: 'boolean', description: 'True once Discord answered 204' }],
        async run(args, context) {
          const channel = channelArg(args)
          const message = idArg(args, 'message')
          await clientFor(context.config, context.fetch).request(
            'PUT',
            `channels/${encodeURIComponent(channel)}/messages/pins/${encodeURIComponent(message)}`
          )
          return { ok: true }
        }
      },
      {
        type: 'listChannels',
        label: 'List channels',
        description: 'The channels of a guild, sorted by position. Threads are not included.',
        idempotent: true,
        inputs: [
          { key: 'guild', label: 'Server', required: true, description: 'Guild (server) id.' },
          {
            key: 'type',
            label: 'Channel type',
            type: 'number',
            description: 'Keep only this type: 0 text, 2 voice, 4 category, 5 announcement, 13 stage, 15 forum, 16 media.',
            builderHint: 'Discord’s channel type numbers; blank keeps every type.'
          }
        ],
        outputs: [
          {
            key: 'channels',
            description: 'One entry per channel: id, name, type, parentId, position, topic, nsfw'
          }
        ],
        sample: { guild: '$DISCORD_GUILD_ID' },
        async run(args, context) {
          const guild = idArg(args, 'guild')
          const wanted = typeof args.type === 'number' ? args.type : undefined
          const channels = await clientFor(context.config, context.fetch).get<DiscordChannel[]>(
            `guilds/${encodeURIComponent(guild)}/channels`
          )
          const list = Array.isArray(channels) ? channels : []
          return {
            channels: list
              .filter((channel) => wanted === undefined || channel.type === wanted)
              .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
              .map(channelSummary)
          }
        }
      },
      {
        type: 'getChannel',
        label: 'Get a channel',
        description: 'Read one channel or thread by id.',
        idempotent: true,
        inputs: [{ key: 'channel', label: 'Channel', required: true, description: 'Channel or thread id.' }],
        outputs: [
          { key: 'id', description: 'Channel id' },
          { key: 'name', description: 'Channel name' },
          { key: 'type', type: 'number', description: 'Channel type number' },
          { key: 'guildId', description: 'Guild the channel belongs to, or null for a DM' },
          { key: 'parentId', description: 'Category or parent channel id, or null' },
          { key: 'topic', description: 'Channel topic, or null' },
          { key: 'nsfw', type: 'boolean', description: 'Whether the channel is age-restricted' },
          { key: 'lastMessageId', description: 'Id of the newest message, or null' },
          { key: 'rateLimitPerUser', type: 'number', description: 'Slowmode seconds, or null' },
          { key: 'threadMetadata', description: 'Thread metadata for a thread, or null' },
          { key: 'messageCount', type: 'number', description: 'Messages in a thread, or null' },
          { key: 'memberCount', type: 'number', description: 'Members of a thread, or null' }
        ],
        sample: { channel: '$DISCORD_CHANNEL_ID' },
        async run(args, context) {
          const channel = channelArg(args)
          const found = await clientFor(context.config, context.fetch).get<DiscordChannel>(
            `channels/${encodeURIComponent(channel)}`
          )
          return channelOutput({ ...(found ?? {}), id: found?.id ?? channel })
        }
      },
      {
        type: 'getGuildMember',
        label: 'Get a server member',
        description: 'Read one member of a guild, with their nickname, roles and join date.',
        idempotent: true,
        inputs: [
          { key: 'guild', label: 'Server', required: true, description: 'Guild (server) id.' },
          {
            key: 'user',
            label: 'User',
            required: true,
            description: 'User id, from {{trigger.item.author.id}}.',
            builderHint: 'Needs no privileged intent, unlike listing members. 10007 Unknown Member when the user is not in the guild.'
          }
        ],
        outputs: [
          { key: 'userId', description: 'User id' },
          { key: 'username', description: 'Account username' },
          { key: 'globalName', description: 'Display name, or null' },
          { key: 'nick', description: 'Nickname in this guild, or null' },
          { key: 'roles', description: 'Role ids' },
          { key: 'joinedAt', description: 'When they joined the guild' },
          { key: 'premiumSince', description: 'When they started boosting, or null' },
          { key: 'pending', type: 'boolean', description: 'Whether membership screening is still pending' },
          { key: 'communicationDisabledUntil', description: 'End of a timeout, or null' },
          { key: 'isBot', type: 'boolean', description: 'Whether the user is a bot' }
        ],
        sample: { guild: '$DISCORD_GUILD_ID', user: '$DISCORD_USER_ID' },
        async run(args, context) {
          const guild = idArg(args, 'guild')
          const client = clientFor(context.config, context.fetch)
          // The bot is a member of every guild it can read, so its own id is the sample when none is named.
          const user = fromEnv(args.user) ?? (await selfId(normalizeToken(context.config.botToken), client))
          if (!user) throw new Error('user is required')
          const member = await client.get<DiscordMember>(
            `guilds/${encodeURIComponent(guild)}/members/${encodeURIComponent(user)}`
          )
          return memberOutput({ ...(member ?? {}), user: member?.user ?? { id: user } } as DiscordMember)
        }
      }
    ]
  })
}
