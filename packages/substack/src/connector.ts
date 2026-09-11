import { defineConnector, type ConnectorConfig, type ConnectorItem, type SessionContext } from '@vornrun/connector-sdk'
import { parseFeed, type FeedPost } from './feed'
import { markdownToDoc } from './markdown'
import { postRef, publicationHost, substackHost } from './publication'
// Bundled at build time: a pack is one file, so a version read from disk is not there to read.
import pkg from '../package.json'

export const ORIGINS = ['https://substack.com', 'https://*.substack.com']
export const PROFILE_URL = 'https://substack.com/api/v1/user/profile/self'
export const SEARCH_URL = 'https://substack.com/api/v1/post/search'

/** A publication's feed holds about its last twenty posts. */
export const MAX_FEED_POSTS = 20
export const DEFAULT_FEED_POSTS = 10

const REACTION = '❤'
const SLUG = /^[a-z0-9][a-z0-9-]*$/i

/** Paths this connector must never reach: publishing or scheduling emails every subscriber. */
const NEVER = /publish|schedul/i

interface Profile {
  id?: unknown
  publicationUsers?: Array<{ is_primary?: unknown; publication?: { name?: unknown; subdomain?: unknown } }>
}

function text(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim()
  return trimmed || undefined
}

function detail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; errors?: Array<{ msg?: unknown; param?: unknown }> }
    if (typeof parsed.error === 'string') return `: ${parsed.error}`
    const first = parsed.errors?.[0]
    if (first) return `: ${String(first.param ?? '')} ${String(first.msg ?? '')}`.trimEnd()
  } catch {
    // Not JSON: the status says enough.
  }
  return ''
}

/** JSON from a Substack endpoint, or an error naming the call and how it was answered. */
export async function call<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const method = init.method ?? 'GET'
  const { pathname } = new URL(url)
  const res = await fetchImpl(url, {
    method,
    headers: {
      accept: 'application/json',
      ...(init.body !== undefined && { 'content-type': 'application/json' })
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) })
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`${method} ${pathname} answered ${res.status}${detail(body)}`)
  if (body.trim() === '') return {} as T
  try {
    return JSON.parse(body) as T
  } catch {
    throw new Error(`${method} ${pathname} answered something that is not JSON`)
  }
}

/** A signed-in fetch that refuses any publishing or scheduling address before the request leaves. */
export function neverPublishing(fetchImpl: typeof fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const { pathname } = new URL(input instanceof Request ? input.url : String(input))
    if (NEVER.test(pathname)) {
      return Promise.reject(new Error(`Refused ${pathname}: this connector never publishes or schedules`))
    }
    return fetchImpl(input, init)
  }) as typeof fetch
}

function signedIn(session: SessionContext | undefined): SessionContext {
  if (!session)
    throw new Error('This action acts as you on Substack, so it runs from Vorn once the connection is signed in')
  return { fetch: neverPublishing(session.fetch) }
}

function publicationsOf(me: Profile): Array<{ subdomain: string; name: string; primary: boolean }> {
  return (me.publicationUsers ?? []).flatMap((user) => {
    const subdomain = text(user.publication?.subdomain)
    if (subdomain === undefined) return []
    return [{ subdomain, name: text(user.publication?.name) ?? subdomain, primary: user.is_primary === true }]
  })
}

/** What a step names, else the connection's publication. */
function stepPublication(value: unknown, config: ConnectorConfig): unknown {
  return text(value) ?? config.publication
}

async function readPosts(fetchImpl: typeof fetch, host: string): Promise<FeedPost[]> {
  const res = await fetchImpl(`https://${host}/feed`, {
    headers: { accept: 'application/rss+xml, application/xml, text/xml' }
  })
  if (!res.ok) throw new Error(`GET /feed on ${host} answered ${res.status}`)
  return parseFeed(await res.text())
}

export function feedLimit(value: unknown): number {
  const raw = text(value)
  if (raw === undefined) return DEFAULT_FEED_POSTS
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_FEED_POSTS) {
    throw new Error(`limit must be a whole number from 1 to ${MAX_FEED_POSTS}`)
  }
  return parsed
}

function wholeId(value: unknown, name: string): number {
  const parsed = Number(text(value))
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a Substack id, a whole number`)
  return parsed
}

function namedPublication(value: unknown, config: ConnectorConfig): string | undefined {
  const named = text(value) ?? text(config.publication)
  return named === undefined ? undefined : substackHost(named)
}

function primaryPublication(me: Profile): string {
  const publications = publicationsOf(me)
  const primary = publications.find((publication) => publication.primary) ?? publications[0]
  if (primary === undefined) throw new Error('This account has no publication; name one in the step or the connection')
  return substackHost(primary.subdomain)
}

/** The publication a step names, the connection's, or else the signed-in account's primary one. */
async function ownPublication(value: unknown, config: ConnectorConfig, session: SessionContext): Promise<string> {
  return namedPublication(value, config) ?? primaryPublication(await call<Profile>(session.fetch, PROFILE_URL))
}

/** Where a post lives: its address's host, else the publication's. */
export function postHost(post: unknown, publication: unknown): string {
  const raw = text(post)
  return raw?.includes('/') ? postRef(raw).host : publicationHost(publication)
}

/** A post by its id, its address, or its slug on the publication; an id saves looking the post up. */
export async function resolvePost(
  fetchImpl: typeof fetch,
  post: unknown,
  postId: unknown,
  publication: unknown
): Promise<{ host: string; id: number }> {
  const raw = text(post)
  const ref = raw?.includes('/') ? postRef(raw) : undefined
  const host = postHost(post, publication)
  if (text(postId) !== undefined) return { host, id: wholeId(postId, 'postId') }
  if (raw === undefined) throw new Error("Give the post's address, its slug, or its id")
  if (/^\d+$/.test(raw)) return { host, id: Number(raw) }
  const slug = ref?.slug ?? raw
  if (!SLUG.test(slug)) throw new Error(`"${slug}" is not a post slug`)
  const found = await call<{ id?: unknown }>(fetchImpl, `https://${host}/api/v1/posts/${slug}`)
  if (typeof found.id !== 'number') throw new Error(`No post "${slug}" on ${host}`)
  return { host, id: found.id }
}

export function postItem(post: FeedPost): ConnectorItem {
  return {
    externalId: post.id,
    title: post.title || post.url,
    url: post.url,
    ...(post.subtitle && { description: post.subtitle }),
    ...(post.author && { assignee: post.author }),
    ...(post.publishedAt && { updatedAt: post.publishedAt }),
    data: { subtitle: post.subtitle, author: post.author, publishedAt: post.publishedAt, text: post.text }
  }
}

interface SearchResult {
  id?: unknown
  title?: unknown
  subtitle?: unknown
  canonical_url?: unknown
  post_date?: unknown
  reaction_count?: unknown
  comment_count?: unknown
  publication_id?: unknown
  publishedBylines?: Array<{ name?: unknown; handle?: unknown }>
}

interface RawComment {
  id?: unknown
  body?: unknown
  name?: unknown
  handle?: unknown
  date?: unknown
  reaction_count?: unknown
  ancestor_path?: unknown
  children_count?: unknown
  deleted?: unknown
  children?: RawComment[]
}

export interface CommentRecord extends Record<string, unknown> {
  id: number
  body: string
  author: string
  handle: string
  date: string
  likes: number
  parentId: number | null
  replies: number
}

/** Every comment of a thread in reading order, replies after the comment they answer. */
export function flattenComments(comments: RawComment[] | undefined): CommentRecord[] {
  return (comments ?? []).flatMap((comment) => {
    const parent = String(comment.ancestor_path ?? '')
      .split('.')
      .filter(Boolean)
      .at(-1)
    const record: CommentRecord = {
      id: Number(comment.id),
      body: comment.deleted === true ? '' : String(comment.body ?? ''),
      author: String(comment.name ?? ''),
      handle: String(comment.handle ?? ''),
      date: String(comment.date ?? ''),
      likes: Number(comment.reaction_count ?? 0),
      parentId: parent === undefined ? null : Number(parent),
      replies: Number(comment.children_count ?? comment.children?.length ?? 0)
    }
    return [record, ...flattenComments(comment.children)]
  })
}

const SAMPLE_POST: FeedPost = {
  id: 'https://novumai.substack.com/p/anthropic-passed-openai-this-week',
  title: 'Anthropic passed OpenAI this week. The $65 billion shows what the lead costs.',
  subtitle: 'Both moves are really about one question: who can pay for compute.',
  url: 'https://novumai.substack.com/p/anthropic-passed-openai-this-week',
  author: 'Javier Canizalez',
  publishedAt: '2026-05-29T20:03:32.000Z',
  html: '<p>Both moves are really about one question.</p>',
  text: 'Both moves are really about one question.'
}

const PUBLICATION_INPUT = {
  key: 'publication',
  label: 'Publication',
  description: "Its substack.com subdomain or address; the connection's publication when empty."
}

/** For a write, which falls back to the account's own publication when nothing names one. */
const OWN_PUBLICATION_INPUT = {
  ...PUBLICATION_INPUT,
  description: "Its substack.com subdomain; the connection's publication when empty, else the account's primary one."
}

const POST_INPUTS = [
  {
    key: 'post',
    label: 'Post',
    description: "The post's address, or its slug on the publication; not needed when its id is given."
  },
  {
    key: 'postId',
    label: 'Post id',
    type: 'number' as const,
    description: "The post's id, as Search posts returns it; saves looking the post up by address."
  }
]

const COMMENT_PUBLICATION_INPUT = {
  ...PUBLICATION_INPUT,
  description: "The publication the comment's post is on; the connection's when empty, else the account's primary one."
}

export const connector = defineConnector({
  id: 'substack',
  name: 'Substack',
  version: pkg.version,
  description:
    'Trigger workflows from new posts on a Substack publication, and read, search and comment on posts or save a draft from a step.',
  icon: {
    viewBox: '0 0 24 24',
    paths: [
      'M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z'
    ]
  },
  auth: {
    rung: 'browser',
    browser: {
      signInUrl: 'https://substack.com/sign-in',
      origins: ORIGINS,
      check: { url: PROFILE_URL, identity: ['name', 'handle'] }
    }
  },
  config: [
    {
      key: 'publication',
      label: 'Publication',
      env: 'SUBSTACK_PUBLICATION',
      description:
        "Your publication's substack.com subdomain, such as novumai. The new-post trigger reads its feed, and a step that names no publication uses it.",
      builderHint: 'The part before .substack.com in the publication address; a custom domain works for reading only.'
    }
  ],
  options: {
    publications: async (ctx) => {
      if (!ctx.session) return []
      const me = await call<Profile>(signedIn(ctx.session).fetch, PROFILE_URL)
      return publicationsOf(me).map(({ subdomain, name }) => ({ value: subdomain, label: name }))
    }
  },
  triggers: [
    {
      type: 'newPost',
      label: 'New post',
      description:
        "A post appears in the publication's RSS feed. Reading the feed needs no sign-in; it holds about the last twenty posts, so a burst larger than that between polls loses the oldest.",
      dedupe: 'timestamp',
      fetch: async (ctx) => (await readPosts(ctx.fetch, publicationHost(ctx.config.publication))).map(postItem),
      sample: [postItem(SAMPLE_POST)]
    }
  ],
  actions: [
    {
      type: 'readFeed',
      label: 'Read feed',
      description: `The newest posts of any publication from its RSS feed, up to ${MAX_FEED_POSTS}, with each body as text and HTML. Needs no sign-in.`,
      idempotent: true,
      inputs: [
        PUBLICATION_INPUT,
        {
          key: 'limit',
          label: 'Posts',
          type: 'number',
          description: `How many of the newest posts, from 1 to ${MAX_FEED_POSTS}; ${DEFAULT_FEED_POSTS} when empty.`
        }
      ],
      outputs: [
        { key: 'publication', type: 'string', description: 'The host the feed was read from' },
        { key: 'count', type: 'number', description: 'How many posts came back, in `posts`' }
      ],
      run: async (args, ctx) => {
        const host = publicationHost(stepPublication(args.publication, ctx.config))
        const posts = (await readPosts(ctx.fetch, host)).slice(0, feedLimit(args.limit))
        return { publication: host, count: posts.length, posts }
      }
    },
    {
      type: 'searchPosts',
      label: 'Search posts',
      description:
        'Posts across Substack matching a query, a page at a time, as Substack search ranks them. Needs no sign-in.',
      idempotent: true,
      inputs: [
        { key: 'query', label: 'Query', required: true, description: 'Words to search posts for.' },
        { key: 'page', label: 'Page', type: 'number', description: 'Which page of results, from 0; 0 when empty.' }
      ],
      outputs: [
        { key: 'count', type: 'number', description: 'How many posts are on this page, in `posts`' },
        { key: 'more', type: 'boolean', description: 'Whether a next page exists' }
      ],
      run: async (args, ctx) => {
        const query = text(args.query)
        if (query === undefined) throw new Error('query is required')
        const page = text(args.page) === undefined ? 0 : Number(args.page)
        if (!Number.isInteger(page) || page < 0) throw new Error('page must be a whole number from 0')
        const url = new URL(SEARCH_URL)
        url.search = new URLSearchParams({
          query,
          page: String(page),
          includePlatformResults: 'true',
          filter: 'all'
        }).toString()
        const found = await call<{ results?: SearchResult[]; more?: unknown }>(ctx.fetch, url.href)
        const posts = (found.results ?? []).map((post) => ({
          id: Number(post.id),
          title: String(post.title ?? ''),
          subtitle: String(post.subtitle ?? ''),
          url: String(post.canonical_url ?? ''),
          publishedAt: String(post.post_date ?? ''),
          author: String(post.publishedBylines?.[0]?.name ?? ''),
          authorHandle: String(post.publishedBylines?.[0]?.handle ?? ''),
          likes: Number(post.reaction_count ?? 0),
          comments: Number(post.comment_count ?? 0),
          publicationId: Number(post.publication_id ?? 0)
        }))
        return { query, page, count: posts.length, more: found.more === true, posts }
      }
    },
    {
      type: 'readComments',
      label: 'Read comments',
      description:
        'Every comment on a post, newest first, with replies after the comment they answer. Needs no sign-in for a public post.',
      idempotent: true,
      inputs: [...POST_INPUTS, PUBLICATION_INPUT],
      outputs: [
        { key: 'postId', type: 'number', description: "The post's id" },
        { key: 'count', type: 'number', description: 'How many comments came back, in `comments`' }
      ],
      run: async (args, ctx) => {
        const publication = stepPublication(args.publication, ctx.config)
        const { host, id } = await resolvePost(ctx.fetch, args.post, args.postId, publication)
        const found = await call<{ comments?: RawComment[] }>(
          ctx.fetch,
          `https://${host}/api/v1/post/${id}/comments?all_comments=true&sort=newest_first`
        )
        const comments = flattenComments(found.comments)
        return { postId: id, count: comments.length, comments }
      }
    },
    {
      type: 'createDraft',
      label: 'Save draft',
      description:
        'Save a new draft on your publication from a title and markdown, for you to review and publish in Substack. It never publishes, since publishing emails every subscriber.',
      idempotent: false,
      inputs: [
        { key: 'title', label: 'Title', required: true, description: "The draft's title." },
        { key: 'subtitle', label: 'Subtitle', description: 'The line under the title.' },
        {
          key: 'body',
          label: 'Body',
          required: true,
          description: 'The post in markdown: headings, lists, quotes, code, links and emphasis carry over.'
        },
        { ...OWN_PUBLICATION_INPUT, type: 'select', loadOptions: 'publications' }
      ],
      outputs: [
        { key: 'id', type: 'number', description: "The draft's id" },
        { key: 'editUrl', type: 'string', description: 'Where to open the draft in the Substack editor' }
      ],
      run: async (args, ctx) => {
        const session = signedIn(ctx.session)
        const title = text(args.title)
        const body = text(args.body)
        if (title === undefined) throw new Error('title is required')
        if (body === undefined) throw new Error('body is required')
        const me = await call<Profile>(session.fetch, PROFILE_URL)
        const host = namedPublication(args.publication, ctx.config) ?? primaryPublication(me)
        const draft = await call<{ id?: unknown }>(session.fetch, `https://${host}/api/v1/drafts`, {
          method: 'POST',
          body: {
            draft_title: title,
            draft_subtitle: text(args.subtitle) ?? '',
            draft_body: JSON.stringify(markdownToDoc(body)),
            // Substack refuses a draft without a byline and says so; only a profile with no id leaves it out.
            ...(typeof me.id === 'number' && { draft_bylines: [{ id: me.id, is_guest: false }] }),
            type: 'newsletter',
            audience: 'everyone',
            section_chosen: false,
            draft_section_id: null
          }
        })
        const id = typeof draft.id === 'number' ? draft.id : undefined
        return { title, ...(id !== undefined && { id, editUrl: `https://${host}/publish/post/${id}` }) }
      }
    },
    {
      type: 'deleteDraft',
      label: 'Delete draft',
      description: 'Delete a draft on your publication. A published post is refused, so this never removes one.',
      idempotent: false,
      inputs: [
        {
          key: 'draftId',
          label: 'Draft id',
          type: 'number',
          required: true,
          description: 'The id Save draft returned.'
        },
        OWN_PUBLICATION_INPUT
      ],
      outputs: [{ key: 'deleted', type: 'boolean', description: 'Whether the draft was deleted' }],
      run: async (args, ctx) => {
        const session = signedIn(ctx.session)
        const id = wholeId(args.draftId, 'draftId')
        const host = await ownPublication(args.publication, ctx.config, session)
        const draft = await call<{ is_published?: unknown }>(session.fetch, `https://${host}/api/v1/drafts/${id}`)
        if (draft.is_published === true) {
          throw new Error(`${id} is a published post, not a draft; this action deletes only drafts`)
        }
        await call(session.fetch, `https://${host}/api/v1/drafts/${id}`, { method: 'DELETE' })
        return { deleted: true, id }
      }
    },
    {
      type: 'commentOnPost',
      label: 'Comment on post',
      description: 'Post a comment on a post as the signed-in account.',
      idempotent: false,
      inputs: [
        ...POST_INPUTS,
        { key: 'body', label: 'Comment', required: true, description: 'The comment, as plain text.' },
        PUBLICATION_INPUT
      ],
      outputs: [
        { key: 'id', type: 'number', description: "The new comment's id" },
        { key: 'postId', type: 'number', description: "The post's id" }
      ],
      run: async (args, ctx) => {
        const session = signedIn(ctx.session)
        const body = text(args.body)
        if (body === undefined) throw new Error('body is required')
        const publication = stepPublication(args.publication, ctx.config)
        // Checked before the lookup: a custom domain is outside the window, whatever the post.
        const host = substackHost(postHost(args.post, publication))
        const { id } = await resolvePost(ctx.fetch, args.post, args.postId, publication)
        const comment = await call<{ id?: unknown }>(session.fetch, `https://${host}/api/v1/post/${id}/comment`, {
          method: 'POST',
          body: { body }
        })
        return { postId: id, ...(typeof comment.id === 'number' && { id: comment.id }) }
      }
    },
    {
      type: 'setCommentLike',
      label: 'Like or unlike comment',
      description:
        'Like a comment as the signed-in account, or take the like back. Setting the same state twice changes nothing.',
      idempotent: true,
      inputs: [
        {
          key: 'commentId',
          label: 'Comment id',
          type: 'number',
          required: true,
          description: 'The id Read comments returned.'
        },
        {
          key: 'liked',
          label: 'Liked',
          type: 'boolean',
          required: true,
          description: 'true to like it, false to take the like back.'
        },
        COMMENT_PUBLICATION_INPUT
      ],
      outputs: [{ key: 'liked', type: 'boolean', description: 'The state now set' }],
      run: async (args, ctx) => {
        const session = signedIn(ctx.session)
        const id = wholeId(args.commentId, 'commentId')
        const liked = args.liked === true
        const host = await ownPublication(args.publication, ctx.config, session)
        await call(session.fetch, `https://${host}/api/v1/comment/${id}/reaction`, {
          method: liked ? 'POST' : 'DELETE',
          body: { reaction: REACTION }
        })
        return { commentId: id, liked }
      }
    },
    {
      type: 'deleteComment',
      label: 'Delete comment',
      description: "Delete one of the signed-in account's comments, or one on its own publication.",
      idempotent: false,
      inputs: [
        {
          key: 'commentId',
          label: 'Comment id',
          type: 'number',
          required: true,
          description: 'The id Read comments or Comment on post returned.'
        },
        COMMENT_PUBLICATION_INPUT
      ],
      outputs: [{ key: 'deleted', type: 'boolean', description: 'Whether the comment was deleted' }],
      run: async (args, ctx) => {
        const session = signedIn(ctx.session)
        const id = wholeId(args.commentId, 'commentId')
        const host = await ownPublication(args.publication, ctx.config, session)
        await call(session.fetch, `https://${host}/api/v1/comment/${id}`, { method: 'DELETE' })
        return { deleted: true, commentId: id }
      }
    }
  ]
})
