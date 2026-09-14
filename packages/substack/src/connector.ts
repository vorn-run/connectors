import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ActionArgumentError,
  defineConnector,
  type ConnectorConfig,
  type ConnectorItem,
  type SessionContext
} from '@vornrun/connector-sdk'
import { parseFeed, plainText, type FeedPost } from './feed'
import { markdownToDoc } from './markdown'
import { postRef, publicationHost, substackHost } from './publication'
// Bundled at build time: a pack is one file, so a version read from disk is not there to read.
import pkg from '../package.json'

export const ORIGINS = ['https://substack.com', 'https://*.substack.com']
export const PROFILE_URL = 'https://substack.com/api/v1/user/profile/self'
export const SEARCH_URL = 'https://substack.com/api/v1/post/search'
export const NOTES_URL = 'https://substack.com/api/v1/comment/feed'

/** A publication's feed holds about its last twenty posts. */
export const MAX_FEED_POSTS = 20
export const DEFAULT_FEED_POSTS = 10
export const MAX_POSTS = 500
export const DEFAULT_POSTS = 50
export const MAX_NOTES = 100
export const DEFAULT_NOTES = 20

/** The archive answers at most this many posts a page. */
const ARCHIVE_PAGE = 25
/** A profile feed mixes Notes with posts and restacks, so a few pages may hold no Note at all. */
const NOTE_PAGES = 10

const REACTION = '❤'
const SLUG = /^[a-z0-9][a-z0-9-]*$/i
const HANDLE = /^[\w.-]+$/

/** The signed-in window carries at most 1 MiB a request; this leaves room for what wraps the body. */
export const MAX_UPLOAD_BODY = 1_000_000
const IMAGE_TYPES = [
  { type: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { type: 'image/jpeg', magic: [0xff, 0xd8, 0xff] }
]
/** What a draft Save draft makes starts as: a newsletter for everyone, in no section. */
const NEW_DRAFT = { type: 'newsletter', audience: 'everyone', section_chosen: false, draft_section_id: null }

/** Paths this connector must never reach: publishing or scheduling emails every subscriber. */
const NEVER = /publish|schedul/i
/** The dashboard's figures: the one such path, read-only, that a GET may reach. */
const DASHBOARD = /^\/api\/v1\/publish-dashboard\//

interface Profile {
  id?: unknown
  handle?: unknown
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

/** An answer outside 2xx, its status kept for the caller that reads a 404 as news. */
export class StatusError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
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
  if (!res.ok) throw new StatusError(`${method} ${pathname} answered ${res.status}${detail(body)}`, res.status)
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
    const request = input instanceof Request ? input : undefined
    const { pathname } = new URL(request ? request.url : String(input))
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    if (NEVER.test(pathname) && !(method === 'GET' && DASHBOARD.test(pathname))) {
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

/** How many a step asked for, the fallback when it asked nothing, never more than `max`. */
export function countLimit(value: unknown, fallback: number, max: number): number {
  const raw = text(value)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`limit must be a whole number from 1 to ${max}`)
  }
  return parsed
}

export function feedLimit(value: unknown): number {
  return countLimit(value, DEFAULT_FEED_POSTS, MAX_FEED_POSTS)
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

interface RawPost {
  id?: unknown
  title?: unknown
  subtitle?: unknown
  slug?: unknown
  canonical_url?: unknown
  post_date?: unknown
  audience?: unknown
  wordcount?: unknown
  body_html?: unknown
  reaction_count?: unknown
  reactions?: Record<string, unknown>
  restacks?: unknown
}

/** What the archive says of a post; Get post adds its body to the same fields. */
function listedPost(post: RawPost): Record<string, unknown> {
  return {
    id: Number(post.id ?? 0),
    title: String(post.title ?? ''),
    subtitle: String(post.subtitle ?? ''),
    slug: String(post.slug ?? ''),
    url: String(post.canonical_url ?? ''),
    publishedAt: String(post.post_date ?? ''),
    audience: String(post.audience ?? '')
  }
}

function likesOf(entry: { reaction_count?: unknown; reactions?: Record<string, unknown> }): number {
  return Number(entry.reaction_count ?? entry.reactions?.[REACTION] ?? 0)
}

interface RawNote {
  id?: unknown
  body?: unknown
  handle?: unknown
  date?: unknown
  reaction_count?: unknown
  reactions?: Record<string, unknown>
  restacks?: unknown
}

interface FeedEntry {
  type?: unknown
  context?: { type?: unknown }
  comment?: RawNote
}

export function noteUrl(handle: string, id: number): string {
  return `https://substack.com/@${handle}/note/c-${id}`
}

function noteRecord(note: RawNote, handle: string): Record<string, unknown> {
  const id = Number(note.id ?? 0)
  return {
    id,
    body: String(note.body ?? ''),
    url: noteUrl(text(note.handle) ?? handle, id),
    date: String(note.date ?? ''),
    likes: likesOf(note),
    restacks: Number(note.restacks ?? 0)
  }
}

/** Refuses a published post, so a draft action never reaches one. */
async function unpublishedDraft(session: SessionContext, host: string, id: number, verb: string): Promise<void> {
  const draft = await call<{ is_published?: unknown }>(session.fetch, `https://${host}/api/v1/drafts/${id}`)
  if (draft.is_published === true) {
    throw new Error(`${id} is a published post, not a draft; this action ${verb} only drafts`)
  }
}

/** Whether an id still names an unpublished draft; one deleted or published since gets a new draft instead. */
async function stillADraft(session: SessionContext, host: string, id: number): Promise<boolean> {
  try {
    const draft = await call<{ is_published?: unknown }>(session.fetch, `https://${host}/api/v1/drafts/${id}`)
    return draft.is_published !== true
  } catch (error) {
    if (error instanceof StatusError && error.status === 404) return false
    throw error
  }
}

/** A draft id, or nothing when a template left it empty, which the SDK reads as 0. */
function optionalDraftId(value: unknown): number | undefined {
  if (text(value) === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ActionArgumentError('draftId', 'draftId must be a Substack draft id, a whole number, or empty')
  }
  return parsed === 0 ? undefined : parsed
}

const editUrl = (host: string, id: number) => `https://${host}/publish/post/${id}`

/** A file on this computer: absolute, or starting `~/`; a connector runs from its pack's folder, so a relative path would land there. */
function localFile(value: unknown): string {
  const raw = text(value)
  if (raw === undefined) throw new ActionArgumentError('file', 'file is required')
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2))
  if (raw.startsWith('~') || !path.isAbsolute(raw)) {
    throw new ActionArgumentError('file', 'file must be an absolute path or start with ~/')
  }
  return path.resolve(raw)
}

/** A picture as the data address Substack's upload takes, refused before it is read when the body would not fit the window. */
export async function imageBody(file: string): Promise<{ image: string }> {
  const found = await stat(file).catch(() => undefined)
  if (!found?.isFile()) throw new ActionArgumentError('file', `No file at ${file}`)
  const wrapper = JSON.stringify({ image: 'data:image/jpeg;base64,' }).length
  const largest = Math.floor((MAX_UPLOAD_BODY - wrapper) / 4) * 3
  if (found.size > largest) {
    throw new ActionArgumentError(
      'file',
      `${path.basename(file)} is ${found.size} bytes; the upload takes at most ${largest}, so make it smaller first`
    )
  }
  const bytes = await readFile(file)
  const type = IMAGE_TYPES.find(({ magic }) => magic.every((byte, i) => bytes[i] === byte))?.type
  if (type === undefined) throw new ActionArgumentError('file', `${path.basename(file)} is not a JPEG or PNG`)
  return { image: `data:${type};base64,${bytes.toString('base64')}` }
}

/** A draft's title, subtitle, body and byline, as Save draft and Update draft both send them. */
function draftFields(me: Profile, title: string, subtitle: unknown, body: string): Record<string, unknown> {
  return {
    draft_title: title,
    draft_subtitle: text(subtitle) ?? '',
    draft_body: JSON.stringify(markdownToDoc(body)),
    // Substack refuses a draft without a byline and says so; only a profile with no id leaves it out.
    ...(typeof me.id === 'number' && { draft_bylines: [{ id: me.id, is_guest: false }] })
  }
}

const SAMPLE_POST: FeedPost = {
  id: 'https://exampleletter.substack.com/p/the-weekly-letter',
  title: 'A weekly letter about the week in software.',
  subtitle: 'Both moves are really about one question: who can pay for compute.',
  url: 'https://exampleletter.substack.com/p/the-weekly-letter',
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
    'Trigger workflows from new posts on a Substack publication, and read, search, like, restack and comment on posts, post and read Notes, or save and update a draft with pictures from a step.',
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
        "Your publication's substack.com subdomain, such as exampleletter. The new-post trigger reads its feed, and a step that names no publication uses it.",
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
      type: 'listPosts',
      label: 'List posts',
      description: `A publication's archive, newest first, up to ${MAX_POSTS} posts, where the feed holds only the last twenty. Needs no sign-in.`,
      idempotent: true,
      inputs: [
        PUBLICATION_INPUT,
        {
          key: 'limit',
          label: 'Posts',
          type: 'number',
          description: `How many of the newest posts, from 1 to ${MAX_POSTS}; ${DEFAULT_POSTS} when empty.`
        }
      ],
      outputs: [
        { key: 'publication', type: 'string', description: 'The host the archive was read from' },
        { key: 'count', type: 'number', description: 'How many posts came back, in `posts`' }
      ],
      run: async (args, ctx) => {
        const host = publicationHost(stepPublication(args.publication, ctx.config))
        const limit = countLimit(args.limit, DEFAULT_POSTS, MAX_POSTS)
        const posts: RawPost[] = []
        for (let offset = 0; posts.length < limit; offset += ARCHIVE_PAGE) {
          const page = await call<unknown>(
            ctx.fetch,
            `https://${host}/api/v1/archive?sort=new&limit=${ARCHIVE_PAGE}&offset=${offset}`
          )
          const rows = Array.isArray(page) ? (page as RawPost[]) : []
          posts.push(...rows)
          if (rows.length < ARCHIVE_PAGE) break
        }
        const listed = posts.slice(0, limit).map(listedPost)
        return { publication: host, count: listed.length, posts: listed }
      }
    },
    {
      type: 'getPost',
      label: 'Get post',
      description: 'One post with its whole body as HTML and as text, and its likes and restacks. Needs no sign-in for a public post.',
      idempotent: true,
      inputs: [
        {
          key: 'post',
          label: 'Post',
          required: true,
          description: "The post's address, or its slug on the publication."
        },
        PUBLICATION_INPUT
      ],
      outputs: [
        { key: 'id', type: 'number', description: "The post's id" },
        { key: 'title', type: 'string', description: "The post's title" },
        { key: 'url', type: 'string', description: "The post's address" },
        { key: 'text', type: 'string', description: 'The body as plain text' }
      ],
      run: async (args, ctx) => {
        const raw = text(args.post)
        if (raw === undefined) throw new Error('post is required')
        const host = postHost(raw, stepPublication(args.publication, ctx.config))
        const slug = raw.includes('/') ? postRef(raw).slug : raw
        if (!SLUG.test(slug)) throw new Error(`"${slug}" is not a post slug`)
        const post = await call<RawPost>(ctx.fetch, `https://${host}/api/v1/posts/${slug}`)
        const html = String(post.body_html ?? '')
        return {
          ...listedPost(post),
          wordcount: Number(post.wordcount ?? 0),
          html,
          text: plainText(html),
          likes: likesOf(post),
          restacks: Number(post.restacks ?? 0)
        }
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
          body: { ...draftFields(me, title, args.subtitle, body), ...NEW_DRAFT }
        })
        const id = typeof draft.id === 'number' ? draft.id : undefined
        return { title, ...(id !== undefined && { id, editUrl: editUrl(host, id) }) }
      }
    },
    {
      type: 'updateDraft',
      label: 'Update draft',
      description:
        "Replace a draft's title, subtitle and body with new markdown. A published post is refused, and it never publishes.",
      idempotent: false,
      inputs: [
        {
          key: 'draftId',
          label: 'Draft id',
          type: 'number',
          required: true,
          description: 'The id Save draft returned.'
        },
        { key: 'title', label: 'Title', required: true, description: "The draft's title." },
        { key: 'subtitle', label: 'Subtitle', description: 'The line under the title; empty leaves the draft without one.' },
        {
          key: 'body',
          label: 'Body',
          required: true,
          description: 'The whole post in markdown, replacing what the draft held.'
        },
        { ...OWN_PUBLICATION_INPUT, type: 'select', loadOptions: 'publications' }
      ],
      outputs: [
        { key: 'updated', type: 'boolean', description: 'Whether the draft was saved' },
        { key: 'id', type: 'number', description: "The draft's id" },
        { key: 'editUrl', type: 'string', description: 'Where to open the draft in the Substack editor' }
      ],
      run: async (args, ctx) => {
        const session = signedIn(ctx.session)
        const id = wholeId(args.draftId, 'draftId')
        const title = text(args.title)
        const body = text(args.body)
        if (title === undefined) throw new Error('title is required')
        if (body === undefined) throw new Error('body is required')
        const me = await call<Profile>(session.fetch, PROFILE_URL)
        const host = namedPublication(args.publication, ctx.config) ?? primaryPublication(me)
        await unpublishedDraft(session, host, id, 'updates')
        await call(session.fetch, `https://${host}/api/v1/drafts/${id}`, {
          method: 'PUT',
          body: draftFields(me, title, args.subtitle, body)
        })
        return { updated: true, id, title, editUrl: editUrl(host, id) }
      }
    },
    {
      type: 'saveDraft',
      label: 'Save or update draft',
      description:
        'Update the draft a step names, or save a new one when it names none or that draft has since been deleted or published, from a title and markdown with an optional cover picture. Run again with the id it returned, it updates the same draft. It never publishes.',
      idempotent: false,
      inputs: [
        {
          key: 'draftId',
          label: 'Draft id',
          type: 'number',
          description: 'The id this action returned before; empty or 0 saves a new draft.',
          builderHint: 'Keep the id from the first run somewhere a later run can read it, so reruns update one draft.'
        },
        { key: 'title', label: 'Title', required: true, description: "The draft's title." },
        { key: 'subtitle', label: 'Subtitle', description: 'The line under the title; empty leaves the draft without one.' },
        {
          key: 'body',
          label: 'Body',
          required: true,
          description:
            'The whole post in markdown. A line holding only a picture Upload image returned, as ![alt](address), becomes a picture in the post.'
        },
        {
          key: 'coverImage',
          label: 'Cover picture',
          description:
            "A picture's address, as Upload image returns it: the post's cover, shown in previews and on social sites. Empty leaves the cover as it is."
        },
        { ...OWN_PUBLICATION_INPUT, type: 'select', loadOptions: 'publications' }
      ],
      outputs: [
        { key: 'id', type: 'number', description: "The draft's id, to hand the next run" },
        { key: 'title', type: 'string', description: "The draft's title" },
        { key: 'editUrl', type: 'string', description: 'Where to open the draft in the Substack editor' },
        { key: 'created', type: 'boolean', description: 'Whether a new draft was saved rather than one updated' }
      ],
      run: async (args, ctx) => {
        const session = signedIn(ctx.session)
        const draftId = optionalDraftId(args.draftId)
        const title = text(args.title)
        const body = text(args.body)
        if (title === undefined) throw new Error('title is required')
        if (body === undefined) throw new Error('body is required')
        const cover = text(args.coverImage)
        const me = await call<Profile>(session.fetch, PROFILE_URL)
        const host = namedPublication(args.publication, ctx.config) ?? primaryPublication(me)
        const fields = { ...draftFields(me, title, args.subtitle, body), ...(cover !== undefined && { cover_image: cover }) }
        if (draftId !== undefined && (await stillADraft(session, host, draftId))) {
          await call(session.fetch, `https://${host}/api/v1/drafts/${draftId}`, { method: 'PUT', body: fields })
          return { id: draftId, title, editUrl: editUrl(host, draftId), created: false }
        }
        const draft = await call<{ id?: unknown }>(session.fetch, `https://${host}/api/v1/drafts`, {
          method: 'POST',
          body: { ...fields, ...NEW_DRAFT }
        })
        if (typeof draft.id !== 'number') throw new Error("POST /api/v1/drafts answered without the new draft's id")
        return { id: draft.id, title, editUrl: editUrl(host, draft.id), created: true }
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
        await unpublishedDraft(session, host, id, 'deletes')
        await call(session.fetch, `https://${host}/api/v1/drafts/${id}`, { method: 'DELETE' })
        return { deleted: true, id }
      }
    },
    {
      type: 'uploadImage',
      label: 'Upload image',
      description:
        "Upload a JPEG or PNG from this computer to Substack's picture storage, for a draft's body or cover. It appears nowhere until a draft uses it.",
      idempotent: false,
      inputs: [
        {
          key: 'file',
          label: 'Picture file',
          required: true,
          description: 'A JPEG or PNG, as an absolute path or one starting with ~/, of at most about 730 KB.',
          builderHint: 'Shrink a larger picture first, for example with sips on macOS; a relative path is refused.'
        },
        { ...OWN_PUBLICATION_INPUT, type: 'select', loadOptions: 'publications' }
      ],
      outputs: [
        { key: 'url', type: 'string', description: "The picture's address, for Save or update draft" },
        { key: 'width', type: 'number', description: 'Its width in pixels' },
        { key: 'height', type: 'number', description: 'Its height in pixels' },
        { key: 'bytes', type: 'number', description: 'Its size as stored' },
        { key: 'contentType', type: 'string', description: 'Its type, image/jpeg or image/png' }
      ],
      run: async (args, ctx) => {
        const body = await imageBody(localFile(args.file))
        const session = signedIn(ctx.session)
        const host = await ownPublication(args.publication, ctx.config, session)
        const uploaded = await call<{
          url?: unknown
          imageWidth?: unknown
          imageHeight?: unknown
          bytes?: unknown
          contentType?: unknown
        }>(session.fetch, `https://${host}/api/v1/image`, { method: 'POST', body })
        const url = text(uploaded.url)
        if (url === undefined) throw new Error('POST /api/v1/image answered without an address for the picture')
        return {
          url,
          width: Number(uploaded.imageWidth ?? 0),
          height: Number(uploaded.imageHeight ?? 0),
          bytes: Number(uploaded.bytes ?? 0),
          contentType: String(uploaded.contentType ?? '')
        }
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
    },
    {
      type: 'setPostLike',
      label: 'Like or unlike post',
      description: 'Like a post as the signed-in account, or take the like back.',
      idempotent: false,
      inputs: [
        ...POST_INPUTS,
        {
          key: 'liked',
          label: 'Liked',
          type: 'boolean',
          required: true,
          description: 'true to like it, false to take the like back.'
        },
        PUBLICATION_INPUT
      ],
      outputs: [{ key: 'liked', type: 'boolean', description: 'The state now set' }],
      run: async (args, ctx) => {
        const session = signedIn(ctx.session)
        const liked = args.liked === true
        const publication = stepPublication(args.publication, ctx.config)
        // Checked before the lookup: a custom domain is outside the window, whatever the post.
        const host = substackHost(postHost(args.post, publication))
        const { id } = await resolvePost(ctx.fetch, args.post, args.postId, publication)
        await call(session.fetch, `https://${host}/api/v1/post/${id}/reaction`, {
          method: liked ? 'POST' : 'DELETE',
          body: { reaction: REACTION }
        })
        return { postId: id, liked }
      }
    },
    {
      type: 'setPostRestack',
      label: 'Restack or undo restack post',
      description:
        "Restack a post to the signed-in account's followers, or take the restack back. Posts only, not Notes.",
      idempotent: false,
      inputs: [
        ...POST_INPUTS,
        {
          key: 'restacked',
          label: 'Restacked',
          type: 'boolean',
          required: true,
          description: 'true to restack it, false to take the restack back.'
        },
        PUBLICATION_INPUT
      ],
      outputs: [{ key: 'restacked', type: 'boolean', description: 'The state now set' }],
      run: async (args, ctx) => {
        const session = signedIn(ctx.session)
        const restacked = args.restacked === true
        const publication = stepPublication(args.publication, ctx.config)
        const host = substackHost(postHost(args.post, publication))
        const { id } = await resolvePost(ctx.fetch, args.post, args.postId, publication)
        await call(session.fetch, `https://${host}/api/v1/restack/feed`, {
          method: restacked ? 'POST' : 'DELETE',
          body: { postId: id, commentId: null }
        })
        return { postId: id, restacked }
      }
    },
    {
      type: 'postNote',
      label: 'Post a note',
      description:
        'Post a Note as the signed-in account. Followers see it in their feeds as soon as it posts; Delete note takes it down.',
      idempotent: false,
      inputs: [
        {
          key: 'body',
          label: 'Note',
          required: true,
          description: "The Note in markdown, converted the way a draft's body is."
        }
      ],
      outputs: [
        { key: 'id', type: 'number', description: "The Note's id" },
        { key: 'url', type: 'string', description: "The Note's address" }
      ],
      run: async (args, ctx) => {
        const session = signedIn(ctx.session)
        const body = text(args.body)
        if (body === undefined) throw new Error('body is required')
        const me = await call<Profile>(session.fetch, PROFILE_URL)
        const note = await call<{ id?: unknown }>(session.fetch, NOTES_URL, {
          method: 'POST',
          body: {
            bodyJson: { ...markdownToDoc(body), attrs: { schemaVersion: 'v1' } },
            tabId: 'for-you',
            surface: 'feed',
            replyMinimumRole: 'everyone'
          }
        })
        if (typeof note.id !== 'number') return {}
        const handle = text(me.handle)
        return { id: note.id, ...(handle !== undefined && { url: noteUrl(handle, note.id) }) }
      }
    },
    {
      type: 'readNotes',
      label: 'Read notes',
      description: `A profile's Notes, newest first, up to ${MAX_NOTES}, from its activity feed as the signed-in account sees it.`,
      idempotent: true,
      inputs: [
        {
          key: 'profile',
          label: 'Profile',
          description: 'A Substack handle, with or without @; the signed-in account when empty.'
        },
        {
          key: 'limit',
          label: 'Notes',
          type: 'number',
          description: `How many of the newest Notes, from 1 to ${MAX_NOTES}; ${DEFAULT_NOTES} when empty.`
        }
      ],
      outputs: [
        { key: 'profile', type: 'string', description: 'The handle the Notes are from' },
        { key: 'count', type: 'number', description: 'How many Notes came back, in `notes`' }
      ],
      run: async (args, ctx) => {
        const session = signedIn(ctx.session)
        const limit = countLimit(args.limit, DEFAULT_NOTES, MAX_NOTES)
        const named = text(args.profile)?.replace(/^@/, '')
        if (named !== undefined && !HANDLE.test(named)) throw new Error(`"${named}" is not a Substack handle`)
        const who = await call<Profile>(
          session.fetch,
          named === undefined ? PROFILE_URL : `https://substack.com/api/v1/user/${named}/public_profile`
        )
        const handle = text(who.handle) ?? named ?? ''
        const notes: Array<Record<string, unknown>> = []
        let cursor: string | undefined
        for (let page = 0; typeof who.id === 'number' && page < NOTE_PAGES && notes.length < limit; page++) {
          const url = new URL(`https://substack.com/api/v1/reader/feed/profile/${who.id}`)
          if (cursor !== undefined) url.searchParams.set('cursor', cursor)
          const feed = await call<{ items?: FeedEntry[]; nextCursor?: unknown }>(session.fetch, url.href)
          for (const entry of feed.items ?? []) {
            if (entry.type === 'comment' && entry.context?.type === 'note' && entry.comment) {
              notes.push(noteRecord(entry.comment, handle))
            }
          }
          cursor = text(feed.nextCursor)
          if (cursor === undefined) break
        }
        const kept = notes.slice(0, limit)
        return { profile: handle, count: kept.length, notes: kept }
      }
    },
    {
      type: 'deleteNote',
      label: 'Delete note',
      description: "Delete one of the signed-in account's Notes.",
      idempotent: false,
      inputs: [
        {
          key: 'noteId',
          label: 'Note id',
          type: 'number',
          required: true,
          description: 'The id Post a note or Read notes returned.'
        }
      ],
      outputs: [{ key: 'deleted', type: 'boolean', description: 'Whether the Note was deleted' }],
      run: async (args, ctx) => {
        const session = signedIn(ctx.session)
        const id = wholeId(args.noteId, 'noteId')
        await call(session.fetch, `https://substack.com/api/v1/comment/${id}`, { method: 'DELETE' })
        return { deleted: true, noteId: id }
      }
    },
    {
      type: 'readSubscriberCount',
      label: 'Read subscriber count',
      description:
        "Your publication's subscriber, email and view figures, as its dashboard shows them. Needs the signed-in account to run the publication.",
      idempotent: true,
      inputs: [{ ...OWN_PUBLICATION_INPUT, type: 'select', loadOptions: 'publications' }],
      outputs: [
        {
          key: 'subscribers',
          type: 'number',
          description: "Every subscriber, free and paid: the count the dashboard's subscribers page shows"
        },
        { key: 'paidSubscribers', type: 'number', description: 'Paid subscribers only' },
        { key: 'appSubscribers', type: 'number', description: 'The dashboard summary’s app subscriber figure' },
        { key: 'views', type: 'number', description: 'The dashboard summary’s view count' },
        { key: 'openRate', type: 'number', description: 'Email open rate, as the dashboard summary reports it' }
      ],
      run: async (args, ctx) => {
        const session = signedIn(ctx.session)
        const host = await ownPublication(args.publication, ctx.config, session)
        const summary = await call<Record<string, unknown>>(
          session.fetch,
          `https://${host}/api/v1/publish-dashboard/summary`
        )
        // The summary's `subscribers` counts paid ones; its `totalEmail` is the dashboard's total.
        return {
          publication: host,
          subscribers: Number(summary.totalEmail ?? 0),
          paidSubscribers: Number(summary.subscribers ?? 0),
          appSubscribers: Number(summary.appSubscribers ?? 0),
          views: Number(summary.views ?? 0),
          openRate: Number(summary.openRate ?? 0)
        }
      }
    }
  ]
})
