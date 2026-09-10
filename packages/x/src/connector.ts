import {
  defineConnector,
  type ConnectorConfig,
  type ConnectorItem,
  type FetchContext
} from '@vornrun/connector-sdk'
import { USER_FIELDS, createXClient, type Params, type XClient, type XEnvelope, type XPost } from './client'
import { SAMPLE_ITEM, joinAuthor, postToItem, postUrl } from './items'
// Bundled at build time: a pack is one file, so a version read from disk is not there to read.
import pkg from '../package.json'

export interface XConnectorOptions {
  version?: string
  /** Replaced in tests so a rate-limit wait costs no real time. */
  sleep?: (ms: number) => Promise<void>
  /** Milliseconds since the epoch, for the OAuth timestamp and the rate-limit wait. */
  now?: () => number
}

/** The limit for accounts without Premium; the pages read publish no weighted rule, so this is the plain count. */
export const MAX_POST_LENGTH = 280

// The endpoints' own bounds for `max_results`.
export const MENTIONS_MIN_RESULTS = 5
export const SEARCH_MIN_RESULTS = 10
export const MAX_RESULTS = 100
export const DEFAULT_SEARCH_RESULTS = 10

export const MAX_QUERY_LENGTH = 512

const USERNAME = /^[A-Za-z0-9_]{1,15}$/

const CONSOLE_URL = 'https://developer.x.com/en/portal/dashboard'

const ACCESS_NOTE =
  'Metered per request and per post read; see the README for the price and the rate limit of each call.'

function text(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim()
  return trimmed || undefined
}

function required(config: ConnectorConfig, key: string, env: string): string {
  const value = text(config[key])
  if (value === undefined) throw new Error(`${env} is required`)
  return value
}

export function postText(value: unknown): string {
  const body = String(value ?? '')
  const length = Array.from(body).length
  if (body.trim() === '') throw new Error('Post text is required')
  if (length > MAX_POST_LENGTH) {
    throw new Error(`Post text is ${length} characters; the limit is ${MAX_POST_LENGTH} for non-Premium accounts`)
  }
  return body
}

/** Within the endpoint's window: a value under the floor is raised to it, one over the ceiling or not a number is refused. */
export function pageSize(value: unknown, floor: number, fallback: number): number {
  const raw = text(value)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed)) throw new Error(`maxResults must be a whole number between ${floor} and ${MAX_RESULTS}`)
  if (parsed > MAX_RESULTS) throw new Error(`maxResults must be at most ${MAX_RESULTS}`)
  return Math.max(floor, parsed)
}

export function searchQuery(value: unknown): string {
  const query = text(value)
  if (query === undefined) throw new Error('query is required')
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`query is ${query.length} characters; recent search accepts at most ${MAX_QUERY_LENGTH}`)
  }
  return query
}

export function handle(value: unknown): string {
  const username = text(value)?.replace(/^@/, '')
  if (username === undefined || !USERNAME.test(username)) {
    throw new Error('username must be 1 to 15 letters, digits or underscores, without the @')
  }
  return username
}

function postId(value: unknown, key: string): string {
  const id = text(value)
  if (id === undefined) throw new Error(`${key} is required`)
  return id
}

export function postsOf(envelope: XEnvelope<XPost[]>) {
  const posts = Array.isArray(envelope.data) ? envelope.data : []
  return posts.map((post) => joinAuthor(post, envelope.includes?.users))
}

function createdOutput(envelope: XEnvelope<XPost>) {
  const id = envelope.data?.id ?? ''
  return { id, url: id ? postUrl(id) : '', text: envelope.data?.text ?? '' }
}

export function createXConnector(options: XConnectorOptions = {}) {
  const clock = options.now ?? Date.now
  // One client per credential set, so the connected account's id is looked up once per process.
  const clients = new Map<string, XClient>()

  function client(context: { config: ConnectorConfig; fetch: typeof fetch }): XClient {
    const credentials = {
      consumerKey: required(context.config, 'apiKey', 'X_API_KEY'),
      consumerSecret: required(context.config, 'apiSecret', 'X_API_SECRET'),
      token: required(context.config, 'accessToken', 'X_ACCESS_TOKEN'),
      tokenSecret: required(context.config, 'accessTokenSecret', 'X_ACCESS_TOKEN_SECRET')
    }
    const key = Object.values(credentials).join('\n')
    const cached = clients.get(key)
    if (cached) {
      cached.setFetch(context.fetch)
      return cached
    }
    const created = createXClient({
      credentials,
      fetch: context.fetch,
      now: clock,
      ...(options.sleep && { sleep: options.sleep })
    })
    clients.set(key, created)
    return created
  }

  function pageQuery(context: FetchContext, floor: number): Params {
    return {
      since_id: context.lastItemId,
      max_results: Math.min(MAX_RESULTS, Math.max(floor, context.limit ?? MAX_RESULTS))
    }
  }

  async function fetchMentions(context: FetchContext): Promise<ConnectorItem[]> {
    const api = client(context)
    const me = await api.myId()
    if (!me.id) throw new Error('GET /2/users/me returned no id for the connected account')
    const page = await api.mentions(me.id, pageQuery(context, MENTIONS_MIN_RESULTS))
    return postsOf(page).map(postToItem)
  }

  async function fetchSearch(context: FetchContext): Promise<ConnectorItem[]> {
    const query = searchQuery(context.config.query)
    const page = await client(context).searchRecent({ query, ...pageQuery(context, SEARCH_MIN_RESULTS) })
    return postsOf(page).map(postToItem)
  }

  return defineConnector({
    id: 'x',
    name: 'X',
    version: options.version ?? pkg.version,
    description:
      'Trigger workflows from new mentions or posts matching a search on X, and create, reply to, delete, read and search posts from a step.',
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M0 1.2H7.6L24 22.8H16.6Z M4.3 3.4H6.6L19.7 20.6H17.4Z M18.9 1.2H22.7L14.72 10.57L12.93 8.22Z M10.77 15.21L8.97 12.87L0.5 22.8H4.3Z'
      ]
    },
    auth: { rung: 'key', keys: ['apiKey', 'apiSecret', 'accessToken', 'accessTokenSecret'] },
    config: [
      {
        key: 'apiKey',
        label: 'API key',
        env: 'X_API_KEY',
        required: true,
        secret: true,
        description: "The app's API Key (OAuth 1.0a consumer key).",
        builderHint: `${CONSOLE_URL}: Projects & Apps, the app, Keys and tokens. Shown once at creation; regenerate from the same tab.`
      },
      {
        key: 'apiSecret',
        label: 'API key secret',
        env: 'X_API_SECRET',
        required: true,
        secret: true,
        description: "The app's API Key Secret (consumer secret).",
        builderHint: 'Same tab as the API key; half of the HMAC-SHA1 signing key.'
      },
      {
        key: 'accessToken',
        label: 'Access token',
        env: 'X_ACCESS_TOKEN',
        required: true,
        secret: true,
        description: 'The Access Token generated for your own account under Keys and tokens.',
        builderHint:
          'Set the app permission to Read and Write before generating it: a token made earlier stays read-only.'
      },
      {
        key: 'accessTokenSecret',
        label: 'Access token secret',
        env: 'X_ACCESS_TOKEN_SECRET',
        required: true,
        secret: true,
        description: 'The Access Token Secret shown with the access token.',
        builderHint: 'Regenerated together with the access token; the other half of the signing key.'
      },
      {
        key: 'query',
        label: 'Search query',
        env: 'X_SEARCH_QUERY',
        description: 'Recent-search query the "new search result" trigger polls, such as `from:xdevelopers -is:retweet`.',
        builderHint: 'Only needed by newSearchResult; 1 to 512 characters of recent-search syntax, last 7 days only.'
      }
    ],
    triggers: [
      {
        type: 'newMention',
        label: 'New mention',
        description:
          `A post mentions the connected account. Polls the mentions timeline with since_id; a burst above ${MAX_RESULTS} mentions between polls loses the oldest. ` +
          `Access: 300 requests per 15 minutes per user, billed per post read (an Owned Read when the account owns the app). ${ACCESS_NOTE}`,
        dedupe: 'lastItem',
        fetch: fetchMentions,
        sample: [SAMPLE_ITEM],
        defaultWorkflow: { name: 'X: new mentions', defaultCronFromMinutes: 5 }
      },
      {
        type: 'newSearchResult',
        label: 'New search result',
        description:
          `A post from the last 7 days matches the search query with since_id; a burst above ${MAX_RESULTS} matches between polls loses the oldest. ` +
          `Access: 300 requests per 15 minutes per user, billed per post returned; recent search is the read that used to need a paid tier. ${ACCESS_NOTE}`,
        dedupe: 'lastItem',
        fetch: fetchSearch,
        sample: [SAMPLE_ITEM],
        defaultWorkflow: { name: 'X: search results', defaultCronFromMinutes: 5 }
      }
    ],
    actions: [
      {
        type: 'createPost',
        label: 'Create post',
        description: `Publish a post of up to ${MAX_POST_LENGTH} characters, optionally as a reply or a quote. Needs Read and Write permission.`,
        idempotent: false,
        inputs: [
          {
            key: 'text',
            label: 'Text',
            required: true,
            description: `The post, up to ${MAX_POST_LENGTH} characters for non-Premium accounts.`,
            builderHint: 'Counted in code points before sending; the API may still weigh a text longer and answer 403.'
          },
          {
            key: 'inReplyToPostId',
            label: 'In reply to post id',
            description: 'Id of the post to reply to, sent as reply.in_reply_to_tweet_id.'
          },
          {
            key: 'quotePostId',
            label: 'Quote post id',
            description: 'Id of the post to quote, sent as quote_tweet_id; the docs say quoting needs an Enterprise plan.'
          }
        ],
        outputs: [
          { key: 'id', type: 'string', description: 'The new post id' },
          { key: 'url', type: 'string', description: 'https://x.com/i/status/{id}' },
          { key: 'text', type: 'string', description: 'The text as X stored it' }
        ],
        async run(args, context) {
          const body: Record<string, unknown> = { text: postText(args.text) }
          const replyTo = text(args.inReplyToPostId)
          const quote = text(args.quotePostId)
          if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo }
          if (quote) body.quote_tweet_id = quote
          return createdOutput(await client(context).createPost(body))
        }
      },
      {
        type: 'replyToPost',
        label: 'Reply to post',
        description: `Reply to a post with up to ${MAX_POST_LENGTH} characters. Needs Read and Write permission.`,
        idempotent: false,
        inputs: [
          { key: 'postId', label: 'Post id', required: true, description: 'The post being replied to.' },
          {
            key: 'text',
            label: 'Text',
            required: true,
            description: `The reply, up to ${MAX_POST_LENGTH} characters for non-Premium accounts.`
          }
        ],
        outputs: [
          { key: 'id', type: 'string', description: 'The new post id' },
          { key: 'url', type: 'string', description: 'https://x.com/i/status/{id}' },
          { key: 'text', type: 'string', description: 'The text as X stored it' }
        ],
        async run(args, context) {
          const body = { text: postText(args.text), reply: { in_reply_to_tweet_id: postId(args.postId, 'postId') } }
          return createdOutput(await client(context).createPost(body))
        }
      },
      {
        type: 'deletePost',
        label: 'Delete post',
        description: "Delete one of the connected account's own posts. Needs Read and Write permission.",
        idempotent: false,
        inputs: [{ key: 'postId', label: 'Post id', required: true, description: 'The post to delete.' }],
        outputs: [{ key: 'deleted', type: 'boolean', description: 'Whether X reports the post deleted' }],
        async run(args, context) {
          const answer = await client(context).deletePost(postId(args.postId, 'postId'))
          return { deleted: answer.data?.deleted === true }
        }
      },
      {
        type: 'getMe',
        label: 'Get me',
        description: `The connected account. Access: 75 requests per 15 minutes per user, one user read. ${ACCESS_NOTE}`,
        idempotent: true,
        inputs: [],
        outputs: [
          { key: 'id', type: 'string', description: 'The account id' },
          { key: 'username', type: 'string', description: 'The handle without @' },
          { key: 'name', type: 'string', description: 'The display name' },
          { key: 'url', type: 'string', description: 'https://x.com/{username}' }
        ],
        sample: {},
        async run(_args, context) {
          const user = (await client(context).getMe()).data ?? {}
          const username = user.username ?? ''
          return { id: user.id ?? '', username, name: user.name ?? '', url: username ? `https://x.com/${username}` : '' }
        }
      },
      {
        type: 'getPost',
        label: 'Get post',
        description: `A post by id with its author and public metrics. Access: 900 requests per 15 minutes per user, one post read plus one user read. ${ACCESS_NOTE}`,
        idempotent: true,
        inputs: [{ key: 'postId', label: 'Post id', required: true, description: 'The post to read.' }],
        outputs: [
          { key: 'id', type: 'string', description: 'The post id' },
          { key: 'text', type: 'string', description: 'The post text' },
          { key: 'createdAt', type: 'string', description: 'ISO 8601 creation instant' },
          { key: 'authorId', type: 'string', description: 'The author id' },
          { key: 'authorUsername', type: 'string', description: 'The author handle, when included' },
          { key: 'conversationId', type: 'string', description: 'The conversation (thread root) id' },
          { key: 'url', type: 'string', description: 'The post page' },
          { key: 'metrics', description: 'public_metrics as JSON: like, reply, repost, quote, bookmark and impression counts' },
          { key: 'raw', description: 'The full answer as JSON' }
        ],
        sample: { postId: '20' },
        async run(args, context) {
          const answer = await client(context).getPost(postId(args.postId, 'postId'), {
            'tweet.fields': 'created_at,author_id,conversation_id,public_metrics',
            expansions: 'author_id',
            'user.fields': 'username,name'
          })
          const post = answer.data ?? {}
          const record = joinAuthor(post, answer.includes?.users)
          return {
            id: record.id,
            text: record.text,
            createdAt: record.createdAt,
            authorId: record.author.id,
            authorUsername: record.author.username,
            conversationId: record.conversationId,
            url: record.url,
            metrics: post.public_metrics ?? {},
            raw: answer
          }
        }
      },
      {
        type: 'getUserByUsername',
        label: 'Get user by username',
        description: `A user by handle. Access: 900 requests per 15 minutes per user, one user read. ${ACCESS_NOTE}`,
        idempotent: true,
        inputs: [
          {
            key: 'username',
            label: 'Username',
            required: true,
            description: 'The handle without @ (1 to 15 letters, digits or underscores); a leading @ is stripped.'
          }
        ],
        outputs: [
          { key: 'id', type: 'string', description: 'The user id' },
          { key: 'username', type: 'string', description: 'The handle' },
          { key: 'name', type: 'string', description: 'The display name' },
          { key: 'description', type: 'string', description: 'The profile bio' },
          { key: 'createdAt', type: 'string', description: 'ISO 8601 account creation instant' },
          { key: 'followers', type: 'number', description: 'public_metrics.followers_count' },
          { key: 'following', type: 'number', description: 'public_metrics.following_count' },
          { key: 'posts', type: 'number', description: 'public_metrics.tweet_count' },
          { key: 'url', type: 'string', description: 'https://x.com/{username}' },
          { key: 'raw', description: 'The full answer as JSON' }
        ],
        sample: { username: 'x' },
        async run(args, context) {
          const answer = await client(context).getUserByUsername(handle(args.username), {
            'user.fields': `${USER_FIELDS},description,public_metrics,created_at`
          })
          const user = answer.data ?? {}
          const metrics = user.public_metrics ?? {}
          const username = user.username ?? ''
          return {
            id: user.id ?? '',
            username,
            name: user.name ?? '',
            description: user.description ?? '',
            createdAt: user.created_at ?? '',
            followers: metrics.followers_count ?? 0,
            following: metrics.following_count ?? 0,
            posts: metrics.tweet_count ?? 0,
            url: username ? `https://x.com/${username}` : '',
            raw: answer
          }
        }
      },
      {
        type: 'searchRecentPosts',
        label: 'Search recent posts',
        description: `Posts from the last 7 days matching a query, newest first. Access: 300 requests per 15 minutes per user, billed per post returned; this is the read that used to need a paid tier. ${ACCESS_NOTE}`,
        idempotent: true,
        inputs: [
          {
            key: 'query',
            label: 'Query',
            required: true,
            description: `Recent-search query, 1 to ${MAX_QUERY_LENGTH} characters, such as from:xdevelopers -is:retweet.`
          },
          {
            key: 'maxResults',
            label: 'Max results',
            type: 'number',
            description: `${SEARCH_MIN_RESULTS} to ${MAX_RESULTS}, default ${DEFAULT_SEARCH_RESULTS}; a smaller value is raised to ${SEARCH_MIN_RESULTS}.`
          },
          { key: 'sinceId', label: 'Since id', description: 'Only posts with an id greater than this one.' }
        ],
        outputs: [
          { key: 'posts', description: 'JSON array of posts: id, text, createdAt, conversationId, inReplyToUserId, author, url' },
          { key: 'count', type: 'number', description: 'meta.result_count' },
          { key: 'newestId', type: 'string', description: 'meta.newest_id' },
          { key: 'nextToken', type: 'string', description: 'meta.next_token, for the page after this one' }
        ],
        sample: { query: 'from:xdevelopers -is:retweet', maxResults: '10' },
        async run(args, context) {
          const answer = await client(context).searchRecent({
            query: searchQuery(args.query),
            max_results: pageSize(args.maxResults, SEARCH_MIN_RESULTS, DEFAULT_SEARCH_RESULTS),
            since_id: text(args.sinceId)
          })
          return {
            posts: postsOf(answer),
            count: answer.meta?.result_count ?? 0,
            newestId: answer.meta?.newest_id ?? '',
            nextToken: answer.meta?.next_token ?? ''
          }
        }
      }
    ]
  })
}

export const connector = createXConnector()
