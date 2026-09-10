import { describe, expect, it, vi } from 'vitest'
import { createConnectorHarness, runConformance, type ConnectorConfig } from '@vornrun/connector-sdk'
import {
  DEFAULT_SEARCH_RESULTS,
  MAX_POST_LENGTH,
  SEARCH_MIN_RESULTS,
  connector as packaged,
  createXConnector,
  handle,
  pageSize,
  postText,
  searchQuery
} from './connector'
import { SAMPLE_ITEM } from './items'

const NOW = '2026-09-10T12:00:00.000Z'
const CONFIG: ConnectorConfig = {
  apiKey: 'consumer-key',
  apiSecret: 'consumer-secret',
  accessToken: '123-token',
  accessTokenSecret: 'token-secret',
  query: 'from:xdevelopers -is:retweet'
}

interface Sent {
  method: string
  url: URL
  auth: string
  body?: unknown
}

type Route = (sent: Sent) => { status?: number; body?: unknown } | undefined

const ME = { data: { id: '2244994945', username: 'xdevelopers', name: 'X Developers' } }

function post(id: string, text = `post ${id}`) {
  return { id, text, author_id: '2244994945', created_at: `2026-09-10T11:${id.padStart(2, '0')}:00.000Z`, conversation_id: id }
}

const USERS = [{ id: '2244994945', username: 'xdevelopers', name: 'X Developers' }]

function setup(route: Route = () => undefined) {
  const sent: Sent[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const record: Sent = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      auth: ((init?.headers as Record<string, string>) ?? {}).Authorization ?? '',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    }
    sent.push(record)
    const reply = route(record) ?? (record.url.pathname === '/2/users/me' ? { body: ME } : { body: {} })
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 })
  }) as unknown as typeof fetch
  const sleep = vi.fn(async () => {})
  const connector = createXConnector({ version: '0.0.0-test', sleep, now: () => Date.parse(NOW) })
  const harness = createConnectorHarness(connector, { config: CONFIG, fetchImpl, now: () => NOW })
  return { sent, harness, connector, sleep }
}

describe('the manifest', () => {
  it('declares the key rung over the four OAuth 1.0a fields and describes every input', () => {
    expect(packaged.id).toBe('x')
    expect(packaged.auth).toEqual({
      rung: 'key',
      keys: ['apiKey', 'apiSecret', 'accessToken', 'accessTokenSecret']
    })
    // Every auth key is stored encrypted: the SDK refuses a credential field left in the clear.
    expect(packaged.config.filter((field) => field.secret).map((field) => field.key)).toEqual(packaged.auth?.keys)
    expect(packaged.config.map((field) => field.env)).toEqual([
      'X_API_KEY',
      'X_API_SECRET',
      'X_ACCESS_TOKEN',
      'X_ACCESS_TOKEN_SECRET',
      'X_SEARCH_QUERY'
    ])
    for (const action of packaged.actions) {
      for (const input of action.inputs ?? []) expect(input.description, `${action.type}.${input.key}`).toBeTruthy()
      if (action.idempotent) expect(action.sample, action.type).toBeDefined()
      else expect(action.sample, action.type).toBeUndefined()
    }
    expect(packaged.triggers.map((trigger) => trigger.type)).toEqual(['newMention', 'newSearchResult'])
    expect(packaged.icon?.paths[0]).toMatch(/^M0 1\.2H7\.6/)
    expect(packaged.version).toBe(JSON.parse(JSON.stringify(packaged.version)))
  })

  it('passes the SDK mock conformance run', async () => {
    const run = await runConformance(packaged, { mock: true })
    expect(run.findings.filter((item) => item.code.startsWith('mock'))).toEqual([])
    expect(run.passed).toEqual(expect.arrayContaining(['manifest', 'auth', 'secrets', 'actions', 'dedupe', 'mock']))
  })
})

describe('newMention', () => {
  it('looks the account up once, signs each call and delivers oldest first', async () => {
    const { sent, harness } = setup((request) =>
      request.url.pathname.endsWith('/mentions')
        ? { body: { data: [post('3'), post('2'), post('1')], includes: { users: USERS }, meta: { newest_id: '3', oldest_id: '1', result_count: 3 } } }
        : undefined
    )
    const page = await harness.poll('newMention')
    expect(page.items.map((item) => item.externalId)).toEqual(['1', '2', '3'])
    expect(page.items[2]).toMatchObject({
      title: '@xdevelopers: post 3',
      url: 'https://x.com/xdevelopers/status/3',
      updatedAt: '2026-09-10T11:03:00.000Z'
    })
    expect(sent.map((request) => request.url.pathname)).toEqual(['/2/users/me', '/2/users/2244994945/mentions'])
    const mentions = sent[1].url.searchParams
    expect(mentions.get('tweet.fields')).toBe('created_at,author_id,conversation_id,in_reply_to_user_id')
    expect(mentions.get('expansions')).toBe('author_id')
    expect(mentions.get('max_results')).toBe('100')
    expect(mentions.has('since_id')).toBe(false)
    expect(sent[1].auth).toMatch(/^OAuth oauth_consumer_key="consumer-key", /)

    const again = await harness.poll('newMention', { cursor: page.nextCursor })
    expect(again.items).toEqual([])
    expect(sent).toHaveLength(3)
    expect(sent[2].url.searchParams.get('since_id')).toBe('3')
  })

  it('delivers nothing twice and honours the page limit', async () => {
    const { sent, harness } = setup((request) =>
      request.url.pathname.endsWith('/mentions') ? { body: { data: [post('2'), post('1')], includes: { users: USERS } } } : undefined
    )
    expect(await harness.pollTwice('newMention')).toEqual([])
    await harness.poll('newMention', { limit: 2 })
    expect(sent.at(-1)?.url.searchParams.get('max_results')).toBe('5')
  })

  it('links a mention without its author through /i/status', async () => {
    const { harness } = setup((request) =>
      request.url.pathname.endsWith('/mentions') ? { body: { data: [post('4')], errors: [{ title: 'partial' }] } } : undefined
    )
    const page = await harness.poll('newMention')
    expect(page.items[0].url).toBe('https://x.com/i/status/4')
    expect(page.items[0].title).toBe('@: post 4')
  })

  it('fails plainly when the account lookup has no id or the credentials are missing', async () => {
    const { harness } = setup((request) => (request.url.pathname === '/2/users/me' ? { body: {} } : undefined))
    await expect(harness.poll('newMention')).rejects.toThrow('GET /2/users/me returned no id')
    const bare = createConnectorHarness(createXConnector(), { config: { apiKey: 'k' }, now: () => NOW })
    await expect(bare.poll('newMention')).rejects.toThrow('X_API_SECRET is required')
  })

  it('reports a plan refusal with the problem name', async () => {
    const { harness } = setup((request) =>
      request.url.pathname.endsWith('/mentions')
        ? { status: 403, body: { title: 'Forbidden', detail: 'App not enrolled', type: 'https://api.x.com/2/problems/client-forbidden' } }
        : undefined
    )
    await expect(harness.poll('newMention')).rejects.toThrow("[client-forbidden]. The app's plan or credits do not cover this endpoint.")
  })
})

describe('newSearchResult', () => {
  it('searches with the query, since_id and recency order', async () => {
    const { sent, harness } = setup((request) =>
      request.url.pathname === '/2/tweets/search/recent'
        ? { body: { data: [post('8'), post('7')], includes: { users: USERS }, meta: { newest_id: '8' } } }
        : undefined
    )
    const page = await harness.poll('newSearchResult')
    expect(page.items.map((item) => item.externalId)).toEqual(['7', '8'])
    expect(sent).toHaveLength(1)
    const params = sent[0].url.searchParams
    expect(params.get('query')).toBe('from:xdevelopers -is:retweet')
    expect(params.get('sort_order')).toBe('recency')
    expect(params.has('start_time')).toBe(false)
    await harness.poll('newSearchResult', { cursor: page.nextCursor, limit: 3 })
    expect(sent[1].url.searchParams.get('since_id')).toBe('8')
    expect(sent[1].url.searchParams.get('max_results')).toBe(String(SEARCH_MIN_RESULTS))
  })

  it('needs the query setting', async () => {
    const harness = createConnectorHarness(createXConnector(), { config: { ...CONFIG, query: ' ' }, now: () => NOW })
    await expect(harness.poll('newSearchResult')).rejects.toThrow('query is required')
  })

  it('replays the sample through dedupe', () => {
    for (const trigger of packaged.triggers) expect(trigger.sample).toEqual([SAMPLE_ITEM])
  })
})

describe('the write actions', () => {
  it('creates a post, as a reply or a quote when asked', async () => {
    const { sent, harness } = setup((request) =>
      request.method === 'POST' ? { status: 201, body: { data: { id: '55', text: request.body ? (request.body as { text: string }).text : '' } } } : undefined
    )
    expect(await harness.execute('createPost', { text: 'Hello' })).toEqual({ id: '55', url: 'https://x.com/i/status/55', text: 'Hello' })
    expect(sent[0].body).toEqual({ text: 'Hello' })
    await harness.execute('createPost', { text: 'Hi', inReplyToPostId: '1', quotePostId: '2' })
    expect(sent[1].body).toEqual({ text: 'Hi', reply: { in_reply_to_tweet_id: '1' }, quote_tweet_id: '2' })
    expect(sent[1].auth).toContain('oauth_signature="')
  })

  it('replies to a post', async () => {
    const { sent, harness } = setup(() => ({ status: 201, body: { data: { id: '56', text: 'Yes' } } }))
    expect(await harness.execute('replyToPost', { postId: '20', text: 'Yes' })).toEqual({ id: '56', url: 'https://x.com/i/status/56', text: 'Yes' })
    expect(sent[0].body).toEqual({ text: 'Yes', reply: { in_reply_to_tweet_id: '20' } })
    await expect(harness.execute('replyToPost', { postId: ' ', text: 'Yes' })).rejects.toThrow('postId is required')
  })

  it('refuses empty or over-long text before sending', async () => {
    const { sent, harness } = setup()
    await expect(harness.execute('createPost', { text: 'x'.repeat(MAX_POST_LENGTH + 1) })).rejects.toThrow(
      `Post text is ${MAX_POST_LENGTH + 1} characters; the limit is ${MAX_POST_LENGTH} for non-Premium accounts`
    )
    await expect(harness.execute('createPost', { text: '  ' })).rejects.toThrow('Post text is required')
    expect(sent).toHaveLength(0)
    expect(postText('☃'.repeat(MAX_POST_LENGTH))).toHaveLength(MAX_POST_LENGTH)
  })

  it('deletes a post and survives an empty reply', async () => {
    const { sent, harness } = setup((request) => (request.method === 'DELETE' && request.url.pathname === '/2/tweets/55' ? { body: { data: { deleted: true } } } : undefined))
    expect(await harness.execute('deletePost', { postId: '55' })).toEqual({ deleted: true })
    expect(await harness.execute('deletePost', { postId: '56' })).toEqual({ deleted: false })
    expect(sent[0].method).toBe('DELETE')
  })

  it('reports a 403 with its detail and reason', async () => {
    const { harness } = setup(() => ({ status: 403, body: { title: 'Forbidden', detail: 'You are not allowed to delete a Tweet.', reason: 'not-owner' } }))
    await expect(harness.execute('deletePost', { postId: '1' })).rejects.toThrow('403 Forbidden: You are not allowed to delete a Tweet. reason: not-owner')
  })
})

describe('the read actions', () => {
  it('gets the connected account', async () => {
    const { harness } = setup()
    expect(await harness.execute('getMe', {})).toEqual({ id: '2244994945', username: 'xdevelopers', name: 'X Developers', url: 'https://x.com/xdevelopers' })
    const empty = setup(() => ({ body: {} }))
    expect(await empty.harness.execute('getMe', {})).toEqual({ id: '', username: '', name: '', url: '' })
  })

  it('gets a post with its author and metrics', async () => {
    const metrics = { like_count: 1, reply_count: 2, repost_count: 3, quote_count: 4, bookmark_count: 5, impression_count: 6 }
    const body = { data: { ...post('20', 'just setting up my twttr'), public_metrics: metrics }, includes: { users: USERS } }
    const { sent, harness } = setup((request) => (request.url.pathname === '/2/tweets/20' ? { body } : undefined))
    expect(await harness.execute('getPost', { postId: '20' })).toEqual({
      id: '20',
      text: 'just setting up my twttr',
      createdAt: '2026-09-10T11:20:00.000Z',
      authorId: '2244994945',
      authorUsername: 'xdevelopers',
      conversationId: '20',
      url: 'https://x.com/xdevelopers/status/20',
      metrics,
      raw: body
    })
    expect(sent[0].url.searchParams.get('tweet.fields')).toBe('created_at,author_id,conversation_id,public_metrics')
    expect(await harness.execute('getPost', { postId: '21' })).toMatchObject({ id: '', url: 'https://x.com/i/status/', metrics: {}, raw: {} })
  })

  it('gets a user by username, stripping the @', async () => {
    const body = {
      data: { id: '783214', username: 'X', name: 'X', description: 'the everything app', created_at: '2007-02-20T14:35:54.000Z', public_metrics: { followers_count: 10, following_count: 2, tweet_count: 3 } }
    }
    const { sent, harness } = setup((request) => (request.url.pathname === '/2/users/by/username/x' ? { body } : undefined))
    expect(await harness.execute('getUserByUsername', { username: '@x' })).toEqual({
      id: '783214',
      username: 'X',
      name: 'X',
      description: 'the everything app',
      createdAt: '2007-02-20T14:35:54.000Z',
      followers: 10,
      following: 2,
      posts: 3,
      url: 'https://x.com/X',
      raw: body
    })
    expect(sent[0].url.searchParams.get('user.fields')).toBe('id,username,name,description,public_metrics,created_at')
    expect(await harness.execute('getUserByUsername', { username: 'nobody' })).toMatchObject({ id: '', followers: 0, url: '' })
    await expect(harness.execute('getUserByUsername', { username: 'far too long a handle' })).rejects.toThrow('username must be 1 to 15')
  })

  it('searches recent posts and lifts the meta out', async () => {
    const body = { data: [post('8'), post('7')], includes: { users: USERS }, meta: { result_count: 2, newest_id: '8', oldest_id: '7', next_token: 'n1' } }
    const { sent, harness } = setup((request) => (request.url.pathname === '/2/tweets/search/recent' ? { body } : undefined))
    const result = await harness.execute('searchRecentPosts', { query: 'from:x', maxResults: '50', sinceId: '5' })
    expect(result).toMatchObject({ count: 2, newestId: '8', nextToken: 'n1' })
    expect((result.posts as unknown[]).length).toBe(2)
    expect((result.posts as Array<{ url: string }>)[0].url).toBe('https://x.com/xdevelopers/status/8')
    const params = sent[0].url.searchParams
    expect(params.get('max_results')).toBe('50')
    expect(params.get('since_id')).toBe('5')
    expect(params.get('sort_order')).toBe('recency')
    const empty = setup(() => ({ body: {} }))
    expect(await empty.harness.execute('searchRecentPosts', { query: 'from:x' })).toEqual({ posts: [], count: 0, newestId: '', nextToken: '' })
    expect(empty.sent[0].url.searchParams.get('max_results')).toBe(String(DEFAULT_SEARCH_RESULTS))
  })
})

describe('the argument parsers', () => {
  it('bounds maxResults', () => {
    expect(pageSize(undefined, 10, 10)).toBe(10)
    expect(pageSize('1', 10, 10)).toBe(10)
    expect(pageSize('100', 10, 10)).toBe(100)
    expect(() => pageSize('101', 10, 10)).toThrow('maxResults must be at most 100')
    expect(() => pageSize('ten', 10, 10)).toThrow('whole number')
    expect(() => pageSize('1.5', 10, 10)).toThrow('whole number')
  })

  it('bounds the query and the handle', () => {
    expect(() => searchQuery('x'.repeat(513))).toThrow('recent search accepts at most 512')
    expect(searchQuery(' from:x ')).toBe('from:x')
    expect(handle('@Some_User')).toBe('Some_User')
    expect(() => handle('')).toThrow('username must be')
  })
})
