import {
  defineConnector,
  type ActionContext,
  type ConnectorConfig,
  type ConnectorItem,
  type FetchContext
} from '@vornrun/connector-sdk'
import { slackGet, slackPages, slackPost, type SlackCallOptions, type SlackEnvelope } from './client'

const DEFAULT_LIMIT = 100
/** conversations.history refuses a larger page. */
const MAX_PAGE_SIZE = 999
/** A walk ends at the configured limit; this is the guard for a channel that is all noise. */
const MAX_HISTORY_PAGES = 10
const MEMBERS_PAGE_SIZE = 200
const MAX_MEMBER_PAGES = 50

export interface SlackMessage {
  type?: string
  subtype?: string
  user?: string
  bot_id?: string
  text?: string
  ts: string
  thread_ts?: string
  parent_user_id?: string
  team?: string
}

interface SlackChannel {
  id?: string
  name?: string
  is_private?: boolean
  is_archived?: boolean
  topic?: { value?: string }
  purpose?: { value?: string }
  num_members?: number
  created?: number
}

interface SlackUser {
  id?: string
  name?: string
  real_name?: string
  tz?: string
  is_bot?: boolean
  deleted?: boolean
  profile?: { display_name?: string; email?: string }
}

interface MessagesPage extends SlackEnvelope {
  messages?: SlackMessage[]
}

interface MembersPage extends SlackEnvelope {
  members?: string[]
}

interface ChannelsPage extends SlackEnvelope {
  channels?: SlackChannel[]
}

function required(config: ConnectorConfig, key: string, env: string): string {
  const value = String(config[key] ?? '').trim()
  if (!value) throw new Error(`${env} is required`)
  return value
}

function auth(context: { config: ConnectorConfig; fetch: typeof fetch }): SlackCallOptions {
  return { token: required(context.config, 'botToken', 'SLACK_BOT_TOKEN'), fetch: context.fetch }
}

function pageSize(config: ConnectorConfig): number {
  const parsed = Number(config.limit)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_PAGE_SIZE) : DEFAULT_LIMIT
}

/** A Slack `ts` is seconds with microseconds; ISO 8601 keeps the milliseconds. */
export function tsToIso(ts: string): string {
  return new Date(Math.round(Number(ts) * 1000)).toISOString()
}

/** Bot posts and system notices, which a channel watcher usually does not want. */
function isNoise(message: SlackMessage): boolean {
  return message.subtype !== undefined || message.bot_id !== undefined
}

/** The order the SDK's `lastItem` strategy expects. */
function newestFirst(messages: SlackMessage[]): SlackMessage[] {
  return [...messages].sort((left, right) => Number(right.ts) - Number(left.ts))
}

export function messageToItem(channel: string, message: SlackMessage): ConnectorItem {
  const text = message.text ?? ''
  return {
    externalId: message.ts,
    title: text.split('\n')[0]?.trim() || `Message ${message.ts}`,
    description: text,
    updatedAt: tsToIso(message.ts),
    data: {
      channel,
      ts: message.ts,
      text,
      ...(message.user !== undefined && { user: message.user }),
      ...(message.bot_id !== undefined && { botId: message.bot_id }),
      ...(message.subtype !== undefined && { subtype: message.subtype }),
      ...(message.thread_ts !== undefined && { threadTs: message.thread_ts }),
      ...(message.parent_user_id !== undefined && { parentUserId: message.parent_user_id }),
      ...(message.team !== undefined && { team: message.team })
    }
  }
}

function channelToOutput(channel: SlackChannel): Record<string, unknown> {
  return {
    id: channel.id,
    name: channel.name,
    isPrivate: channel.is_private === true,
    isArchived: channel.is_archived === true,
    topic: channel.topic?.value ?? '',
    purpose: channel.purpose?.value ?? '',
    numMembers: channel.num_members
  }
}

function userToOutput(user: SlackUser): Record<string, unknown> {
  return {
    id: user.id,
    name: user.name,
    realName: user.real_name,
    displayName: user.profile?.display_name,
    email: user.profile?.email,
    tz: user.tz,
    isBot: user.is_bot === true,
    deleted: user.deleted === true
  }
}

const CHANNEL_OUTPUTS = [
  { key: 'id', type: 'string' as const, description: 'Channel id' },
  { key: 'name', type: 'string' as const, description: 'Channel name without the #' },
  { key: 'isPrivate', type: 'boolean' as const },
  { key: 'isArchived', type: 'boolean' as const },
  { key: 'topic', type: 'string' as const },
  { key: 'purpose', type: 'string' as const },
  { key: 'numMembers', type: 'number' as const }
]

const USER_OUTPUTS = [
  { key: 'id', type: 'string' as const, description: 'User id' },
  { key: 'name', type: 'string' as const, description: 'Handle' },
  { key: 'realName', type: 'string' as const },
  { key: 'displayName', type: 'string' as const },
  { key: 'email', type: 'string' as const, description: 'Needs users:read.email' },
  { key: 'tz', type: 'string' as const, description: 'IANA time zone' },
  { key: 'isBot', type: 'boolean' as const },
  { key: 'deleted', type: 'boolean' as const }
]

const CHANNEL_INPUT = {
  key: 'channel',
  label: 'Channel',
  required: true,
  description: 'Channel id such as C0123456789',
  builderHint: 'An id, not a name: names are not unique and Slack renames them. The bot must be a member.'
}

const SAMPLE_CHANNEL = 'C0123456789'

async function fetchMessages(context: FetchContext): Promise<ConnectorItem[]> {
  const { config } = context
  const channel = required(config, 'channel', 'SLACK_CHANNEL')
  const includeBots = config.includeBots === 'true'
  const limit = pageSize(config)
  // Skipped messages do not count towards the limit, or a run of bot posts would hide the person after it.
  const messages = await slackPages<MessagesPage, SlackMessage>(
    'conversations.history',
    { channel, oldest: context.lastItemId, limit },
    auth(context),
    (page) => (page.messages ?? []).filter((message) => includeBots || !isNoise(message)),
    { items: limit, pages: MAX_HISTORY_PAGES }
  )
  return newestFirst(messages).map((message) => messageToItem(channel, message))
}

async function fetchReplies(context: FetchContext): Promise<ConnectorItem[]> {
  const { config } = context
  const channel = required(config, 'channel', 'SLACK_CHANNEL')
  const threadTs = required(config, 'threadTs', 'SLACK_THREAD_TS')
  const limit = pageSize(config)
  // The parent rides along in every page; its ts is the thread's.
  const messages = await slackPages<MessagesPage, SlackMessage>(
    'conversations.replies',
    { channel, ts: threadTs, oldest: context.lastItemId, limit },
    auth(context),
    (page) => (page.messages ?? []).filter((message) => message.ts !== threadTs),
    { items: limit, pages: MAX_HISTORY_PAGES }
  )
  return newestFirst(messages).map((message) => messageToItem(channel, message))
}

async function fetchMembers(context: FetchContext): Promise<ConnectorItem[]> {
  const channel = required(context.config, 'channel', 'SLACK_CHANNEL')
  const members = await slackPages<MembersPage, string>(
    'conversations.members',
    { channel, limit: MEMBERS_PAGE_SIZE },
    auth(context),
    (page) => page.members ?? [],
    { items: Number.POSITIVE_INFINITY, pages: MAX_MEMBER_PAGES }
  )
  // No updatedAt on purpose: Slack gives no join time, and stamping poll time would redeliver everyone every poll.
  return members.map((user) => ({
    externalId: user,
    title: `${user} joined ${channel}`,
    data: { user, channel }
  }))
}

export const connector = defineConnector({
  id: 'slack',
  name: 'Slack',
  description:
    'Trigger workflows from Slack messages, thread replies and channel members, and post, reply or react from a step.',
  version: '0.1.0',
  // Slack's own mark.
  icon: {
    viewBox: '0 0 24 24',
    paths: [
      'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z'
    ]
  },
  auth: { rung: 'key', keys: ['botToken'] },
  config: [
    {
      key: 'botToken',
      env: 'SLACK_BOT_TOKEN',
      label: 'Bot token',
      required: true,
      secret: true,
      description:
        'Bot User OAuth Token (xoxb-…) of a Slack app installed to the workspace, from api.slack.com/apps under OAuth & Permissions.',
      builderHint:
        'Sent as Authorization: Bearer. Bot scopes: channels:read, groups:read, channels:history, groups:history, chat:write, reactions:write, users:read, users:read.email. Never put it in the query string; Slack refuses it there.'
    },
    {
      key: 'channel',
      env: 'SLACK_CHANNEL',
      label: 'Channel',
      description: 'Channel id such as C0123456789 the triggers watch. The bot must be a member.',
      builderHint:
        'An id (C… or G…), not a name. Reading history or members of a channel the bot is not in answers not_in_channel.'
    },
    {
      key: 'threadTs',
      env: 'SLACK_THREAD_TS',
      label: 'Thread',
      description: 'The parent message ts, such as 1512085950.000216, for the reply trigger.',
      builderHint: 'Only the reply trigger reads it. A ts is a string; do not round it.'
    },
    {
      key: 'includeBots',
      env: 'SLACK_INCLUDE_BOTS',
      label: 'Include bot and system messages',
      default: 'false',
      description: 'true delivers messages with a subtype or a bot_id too; joins, topic changes, app posts.',
      builderHint: 'Applies to the channel trigger only; thread replies are delivered whoever wrote them.'
    },
    {
      key: 'limit',
      env: 'SLACK_LIMIT',
      label: 'Messages per page',
      default: String(DEFAULT_LIMIT),
      description: 'Messages read per request, 1 to 999.',
      builderHint:
        'Some non-Marketplace apps get conversations.history at 1 request a minute with limit capped at 15; keep polls minutes apart.'
    }
  ],
  triggers: [
    {
      type: 'messageInChannel',
      label: 'A message is posted in a channel',
      description:
        'Fires for each new message in the configured channel. Bot and system messages are skipped unless includeBots is true.',
      dedupe: 'lastItem',
      defaultWorkflow: { name: 'Slack: channel messages', defaultCronFromMinutes: 2 },
      fetch: fetchMessages,
      sample: [
        messageToItem(SAMPLE_CHANNEL, {
          type: 'message',
          user: 'U061F7AUR',
          text: 'Rolling back, the error rate doubled',
          ts: '1512104434.000490',
          team: 'T012AB3CD'
        }),
        messageToItem(SAMPLE_CHANNEL, {
          type: 'message',
          user: 'U123ABC456',
          text: 'Deploy finished for build 418',
          ts: '1512085950.000216',
          team: 'T012AB3CD'
        })
      ]
    },
    {
      type: 'replyInThread',
      label: 'A reply is posted in a thread',
      description: 'Fires for each new reply under the configured parent message.',
      dedupe: 'lastItem',
      defaultWorkflow: { name: 'Slack: thread replies', defaultCronFromMinutes: 2 },
      fetch: fetchReplies,
      sample: [
        messageToItem(SAMPLE_CHANNEL, {
          type: 'message',
          user: 'U061F7AUR',
          text: 'Looks good, shipping it',
          ts: '1512104434.000490',
          thread_ts: '1512085950.000216',
          parent_user_id: 'U123ABC456'
        })
      ]
    },
    {
      type: 'memberJoinedChannel',
      label: 'A member joins a channel',
      description: 'Fires once for each user id in the channel that has not been seen before.',
      dedupe: 'timestamp',
      defaultWorkflow: { name: 'Slack: channel members', defaultCronFromMinutes: 5 },
      fetch: fetchMembers,
      sample: [
        { externalId: 'U023BECGF', title: 'U023BECGF joined C0123456789', data: { user: 'U023BECGF', channel: SAMPLE_CHANNEL } },
        { externalId: 'U061F7AUR', title: 'U061F7AUR joined C0123456789', data: { user: 'U061F7AUR', channel: SAMPLE_CHANNEL } }
      ]
    }
  ],
  actions: [
    {
      type: 'postMessage',
      label: 'Post a message',
      description: 'Post a message to a channel, optionally under a thread or with Block Kit blocks.',
      // Two calls post twice.
      idempotent: false,
      inputs: [
        { ...CHANNEL_INPUT, description: 'Channel id, or a name the bot can resolve' },
        {
          key: 'text',
          label: 'Text',
          required: true,
          description: 'Message text; with blocks it is the notification fallback'
        },
        {
          key: 'threadTs',
          label: 'Thread',
          description: 'Parent message ts to reply under',
          builderHint: 'Leave empty to post at the top level.'
        },
        {
          key: 'blocks',
          label: 'Blocks',
          type: 'json',
          description: 'Block Kit layout as a JSON array',
          builderHint: 'Sent as the blocks array; Slack answers invalid_blocks when it is malformed.'
        }
      ],
      outputs: [
        { key: 'ts', type: 'string', description: 'The new message ts' },
        { key: 'channel', type: 'string', description: 'The channel id it landed in' }
      ],
      async run(args, context: ActionContext) {
        const posted = await slackPost<{ ts?: string; channel?: string }>(
          'chat.postMessage',
          { channel: args.channel, text: args.text, thread_ts: args.threadTs, blocks: args.blocks },
          auth(context)
        )
        return { ts: posted.ts, channel: posted.channel }
      }
    },
    {
      type: 'replyInThread',
      label: 'Reply in a thread',
      description: 'Post a reply under a parent message.',
      idempotent: false,
      inputs: [
        CHANNEL_INPUT,
        { key: 'threadTs', label: 'Thread', required: true, description: 'The parent message ts' },
        { key: 'text', label: 'Text', required: true, description: 'Reply text' }
      ],
      outputs: [
        { key: 'ts', type: 'string', description: 'The reply ts' },
        { key: 'channel', type: 'string', description: 'The channel id' }
      ],
      async run(args, context: ActionContext) {
        const posted = await slackPost<{ ts?: string; channel?: string }>(
          'chat.postMessage',
          { channel: args.channel, thread_ts: args.threadTs, text: args.text },
          auth(context)
        )
        return { ts: posted.ts, channel: posted.channel }
      }
    },
    {
      type: 'addReaction',
      label: 'Add a reaction',
      description: 'React to a message with an emoji.',
      // A second call answers already_reacted.
      idempotent: false,
      inputs: [
        CHANNEL_INPUT,
        { key: 'ts', label: 'Message', required: true, description: 'The message ts' },
        {
          key: 'emoji',
          label: 'Emoji',
          required: true,
          description: 'Emoji name without colons, e.g. thumbsup',
          builderHint: 'Slack answers invalid_name for a name it does not know.'
        }
      ],
      outputs: [{ key: 'ok', type: 'boolean', description: 'true once the reaction is on' }],
      async run(args, context: ActionContext) {
        await slackPost(
          'reactions.add',
          { channel: args.channel, timestamp: args.ts, name: args.emoji },
          auth(context)
        )
        return { ok: true }
      }
    },
    {
      type: 'listChannels',
      label: 'List channels',
      description: 'List the public and private channels the bot can see, unarchived only.',
      idempotent: true,
      inputs: [
        {
          key: 'limit',
          label: 'Limit',
          type: 'number',
          description: 'Channels per page, default 100, max 1000'
        },
        {
          key: 'cursor',
          label: 'Cursor',
          description: 'nextCursor from an earlier call, for the next page'
        }
      ],
      outputs: [
        { key: 'channels', description: 'Array of { id, name, isPrivate, isArchived, topic, purpose, numMembers }' },
        { key: 'nextCursor', type: 'string', description: 'Empty on the last page' }
      ],
      sample: { limit: '20' },
      async run(args, context: ActionContext) {
        const page = await slackGet<ChannelsPage>(
          'conversations.list',
          {
            types: 'public_channel,private_channel',
            exclude_archived: true,
            limit: (args.limit as number | undefined) ?? DEFAULT_LIMIT,
            cursor: args.cursor as string | undefined
          },
          auth(context)
        )
        return {
          channels: (page.channels ?? []).map(channelToOutput),
          nextCursor: page.response_metadata?.next_cursor ?? ''
        }
      }
    },
    {
      type: 'getChannel',
      label: 'Get a channel',
      description: 'Read one channel by id.',
      idempotent: true,
      inputs: [CHANNEL_INPUT],
      outputs: [...CHANNEL_OUTPUTS, { key: 'created', type: 'number', description: 'Unix seconds' }],
      sample: { channel: '$SLACK_CHANNEL_ID' },
      async run(args, context: ActionContext) {
        const info = await slackGet<{ channel?: SlackChannel }>(
          'conversations.info',
          { channel: args.channel as string, include_num_members: true },
          auth(context)
        )
        const channel = info.channel ?? {}
        return { ...channelToOutput(channel), created: channel.created }
      }
    },
    {
      type: 'findUserByEmail',
      label: 'Find a user by email',
      description: 'Look a user up by the address registered on the workspace.',
      idempotent: true,
      inputs: [
        {
          key: 'email',
          label: 'Email',
          required: true,
          description: 'The address registered on the workspace',
          builderHint: 'Needs users:read.email; an unknown or deactivated address answers users_not_found.'
        }
      ],
      outputs: USER_OUTPUTS,
      sample: { email: '$SLACK_USER_EMAIL' },
      async run(args, context: ActionContext) {
        const found = await slackGet<{ user?: SlackUser }>(
          'users.lookupByEmail',
          { email: args.email as string },
          auth(context)
        )
        return userToOutput(found.user ?? {})
      }
    },
    {
      type: 'getUser',
      label: 'Get a user',
      description: 'Read one user by id.',
      idempotent: true,
      inputs: [
        { key: 'user', label: 'User', required: true, description: 'User id such as U123ABC456' }
      ],
      outputs: USER_OUTPUTS,
      sample: { user: '$SLACK_USER_ID' },
      async run(args, context: ActionContext) {
        const found = await slackGet<{ user?: SlackUser }>(
          'users.info',
          { user: args.user as string },
          auth(context)
        )
        return userToOutput(found.user ?? {})
      }
    }
  ]
})
