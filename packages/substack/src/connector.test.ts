import { describe, expect, it, vi } from 'vitest'
import { createConnectorHarness, runConformance, type ConnectorConfig } from '@vornrun/connector-sdk'
import { DEFAULT_FEED_POSTS, MAX_FEED_POSTS, connector, feedLimit, flattenComments, neverPublishing } from './connector'

const NOW = '2026-09-10T12:00:00.000Z'

interface Sent {
  method: string
  url: URL
  body?: unknown
  /** Whether the call went through the signed-in window rather than plain fetch. */
  window: boolean
}

type Route = (sent: Sent) => { status?: number; body?: unknown; text?: string } | undefined

/** The signed-in account, shaped like profile/self answered on 2026-09-10. */
const PROFILE = {
  id: 204810422,
  name: 'Javier Canizalez',
  handle: 'javiercanizalez',
  publicationUsers: [
    {
      role: 'admin',
      is_primary: true,
      publication: { id: 8174077, name: 'Example Letter', subdomain: 'exampleletter' }
    }
  ]
}

const FEED = `<rss version="2.0"><channel>
<item><title><![CDATA[Newer]]></title><link>https://exampleletter.substack.com/p/newer</link><guid isPermaLink="false">https://exampleletter.substack.com/p/newer</guid><dc:creator><![CDATA[Javier Canizalez]]></dc:creator><pubDate>Wed, 10 Sep 2026 09:00:00 GMT</pubDate><content:encoded><![CDATA[<p>Body two</p>]]></content:encoded></item>
<item><title><![CDATA[Older]]></title><link>https://exampleletter.substack.com/p/older</link><guid isPermaLink="false">https://exampleletter.substack.com/p/older</guid><pubDate>Fri, 29 May 2026 20:03:32 GMT</pubDate><content:encoded><![CDATA[<p>Body one</p>]]></content:encoded></item>
</channel></rss>`

function setup(route: Route, config: ConnectorConfig = { publication: 'exampleletter' }) {
  const sent: Sent[] = []
  const answer = (window: boolean) =>
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const record: Sent = {
        method: init?.method ?? 'GET',
        url: new URL(String(input)),
        window,
        ...(typeof init?.body === 'string' && { body: JSON.parse(init.body) })
      }
      sent.push(record)
      const reply = route(record)
      if (!reply) return new Response('{"error":"Not found"}', { status: 404 })
      return new Response(reply.text ?? JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200
      })
    }) as unknown as typeof fetch
  const harness = createConnectorHarness(connector, {
    config,
    now: () => NOW,
    fetchImpl: answer(false),
    sessionFetchImpl: answer(true),
    sleep: async () => {}
  })
  return { sent, harness }
}

const at = (sent: Sent) => `${sent.window ? 'window' : 'plain'} ${sent.method} ${sent.url.host}${sent.url.pathname}`

describe('the manifest', () => {
  it('signs in through a Vorn window on substack.com, and says who is signed in', () => {
    const manifest = createConnectorHarness(connector).manifest()
    expect(manifest.auth).toEqual({
      rung: 'browser',
      browser: {
        signInUrl: 'https://substack.com/sign-in',
        origins: ['https://substack.com', 'https://*.substack.com'],
        check: {
          url: 'https://substack.com/api/v1/user/profile/self',
          identity: ['name', 'handle']
        }
      }
    })
    expect(manifest.triggers.map((t) => t.type)).toEqual(['newPost'])
    expect(manifest.actions.map((a) => a.type)).toEqual([
      'readFeed',
      'searchPosts',
      'readComments',
      'listPosts',
      'getPost',
      'createDraft',
      'updateDraft',
      'deleteDraft',
      'commentOnPost',
      'setCommentLike',
      'deleteComment',
      'setPostLike',
      'setPostRestack',
      'postNote',
      'readNotes',
      'deleteNote',
      'readSubscriberCount'
    ])
  })

  it('passes its own conformance run, every action included', async () => {
    const run = await runConformance(connector, { mock: true })
    expect(run.findings.filter((item) => item.code.startsWith('mock'))).toEqual([])
    expect(run.passed).toEqual(expect.arrayContaining(['manifest', 'auth', 'secrets', 'actions', 'dedupe', 'mock']))
  })
})

describe('newPost', () => {
  it("reads the publication's feed without signing in, and delivers each post once", async () => {
    const { sent, harness } = setup((r) => (r.url.pathname === '/feed' ? { text: FEED } : undefined))
    const items = await harness.drain('newPost')
    expect(items.map((item) => [item.externalId, item.title, item.updatedAt])).toEqual(
      expect.arrayContaining([
        ['https://exampleletter.substack.com/p/newer', 'Newer', '2026-09-10T09:00:00.000Z'],
        ['https://exampleletter.substack.com/p/older', 'Older', '2026-05-29T20:03:32.000Z']
      ])
    )
    expect(items.find((item) => item.title === 'Newer')).toMatchObject({
      author: 'Javier Canizalez',
      text: 'Body two'
    })
    expect(sent.map(at)).toEqual(['plain GET exampleletter.substack.com/feed'])
    expect(await harness.pollTwice('newPost')).toEqual([])
  })

  it('asks for a publication when the connection names none', async () => {
    const { harness } = setup(() => ({ text: FEED }), {})
    await expect(harness.drain('newPost')).rejects.toThrow(/publication is required/)
  })
})

describe('readFeed', () => {
  it('reads any publication, a custom domain included, up to the limit', async () => {
    const { sent, harness } = setup((r) => (r.url.pathname === '/feed' ? { text: FEED } : undefined))
    const out = await harness.execute('readFeed', {
      publication: 'www.lennysnewsletter.com',
      limit: '1'
    })
    expect(out).toMatchObject({
      publication: 'www.lennysnewsletter.com',
      count: 1,
      posts: [{ title: 'Newer', text: 'Body two' }]
    })
    expect(sent.map(at)).toEqual(['plain GET www.lennysnewsletter.com/feed'])
    await expect(harness.execute('readFeed', {})).resolves.toMatchObject({
      publication: 'exampleletter.substack.com',
      count: 2
    })
  })

  it('keeps the limit within what a feed holds', () => {
    expect(feedLimit(undefined)).toBe(DEFAULT_FEED_POSTS)
    expect(feedLimit('20')).toBe(MAX_FEED_POSTS)
    expect(() => feedLimit('21')).toThrow(/1 to 20/)
    expect(() => feedLimit('0')).toThrow(/1 to 20/)
  })
})

describe('searchPosts', () => {
  it('asks Substack search without signing in, and keeps what a step needs of each post', async () => {
    const { sent, harness } = setup(() => ({
      body: {
        more: true,
        results: [
          {
            id: 213983679,
            title: 'Forget the Demo. Can Your AI Agent Make Money?',
            subtitle: 's',
            canonical_url: 'https://aiagentssimplified.substack.com/p/forget-the-demo-can-your-ai-agent',
            post_date: '2026-09-03T19:30:48.958Z',
            reaction_count: 21,
            comment_count: 4,
            publication_id: 4259035,
            publishedBylines: [{ name: 'Ada', handle: 'ada' }]
          }
        ]
      }
    }))
    const out = await harness.execute('searchPosts', { query: 'ai agents' })
    expect(out).toMatchObject({
      query: 'ai agents',
      page: 0,
      count: 1,
      more: true,
      posts: [
        {
          id: 213983679,
          author: 'Ada',
          authorHandle: 'ada',
          likes: 21,
          comments: 4,
          url: expect.stringContaining('/p/forget')
        }
      ]
    })
    expect(sent[0]?.window).toBe(false)
    expect(Object.fromEntries(sent[0]!.url.searchParams)).toEqual({
      query: 'ai agents',
      page: '0',
      includePlatformResults: 'true',
      filter: 'all'
    })
  })
})

describe('readComments', () => {
  const THREAD = {
    comments: [
      {
        id: 1,
        body: 'Great post',
        name: 'Todd',
        handle: 'todd',
        date: '2026-09-04T23:33:16.664Z',
        reaction_count: 1,
        ancestor_path: '',
        children_count: 1,
        children: [
          {
            id: 2,
            body: 'Thanks',
            name: 'Javier',
            handle: 'javiercanizalez',
            ancestor_path: '1',
            children: []
          }
        ]
      }
    ]
  }

  it('looks a post up by its address, then reads the thread with replies after what they answer', async () => {
    const { sent, harness } = setup((r) =>
      r.url.pathname === '/api/v1/posts/forget-the-demo' ? { body: { id: 213983679 } } : { body: THREAD }
    )
    const out = await harness.execute('readComments', {
      post: 'https://aiagentssimplified.substack.com/p/forget-the-demo'
    })
    expect(out).toMatchObject({
      postId: 213983679,
      count: 2,
      comments: [
        { id: 1, author: 'Todd', parentId: null, replies: 1, likes: 1 },
        { id: 2, author: 'Javier', parentId: 1, replies: 0, likes: 0 }
      ]
    })
    expect(sent.map(at)).toEqual([
      'plain GET aiagentssimplified.substack.com/api/v1/posts/forget-the-demo',
      'plain GET aiagentssimplified.substack.com/api/v1/post/213983679/comments'
    ])
  })

  it('skips the lookup when given the id', async () => {
    const { sent, harness } = setup(() => ({ body: { comments: [] } }))
    await harness.execute('readComments', { postId: '7' })
    expect(sent.map(at)).toEqual(['plain GET exampleletter.substack.com/api/v1/post/7/comments'])
  })

  it('says so when no post has that slug', async () => {
    const { harness } = setup(() => undefined)
    await expect(harness.execute('readComments', { post: 'nothing-here' })).rejects.toThrow(/answered 404/)
  })

  it('blanks a deleted comment', () => {
    expect(flattenComments([{ id: 3, body: 'gone', deleted: true }])[0]?.body).toBe('')
  })
})

describe('createDraft', () => {
  it('saves a draft through the window with the author as its byline, and never publishes', async () => {
    const { sent, harness } = setup((r) => {
      if (r.url.pathname === '/api/v1/user/profile/self') return { body: PROFILE }
      if (r.method === 'POST' && r.url.pathname === '/api/v1/drafts') return { body: { id: 215138440 } }
      return undefined
    })
    const out = await harness.execute('createDraft', {
      title: 'Hello',
      subtitle: 'World',
      body: '## Why\n\n**Now**.'
    })
    expect(out).toEqual({
      title: 'Hello',
      id: 215138440,
      editUrl: 'https://exampleletter.substack.com/publish/post/215138440'
    })
    expect(sent.map(at)).toEqual([
      'window GET substack.com/api/v1/user/profile/self',
      'window POST exampleletter.substack.com/api/v1/drafts'
    ])
    const draft = sent[1]!.body as Record<string, unknown>
    expect(draft).toMatchObject({
      draft_title: 'Hello',
      draft_subtitle: 'World',
      draft_bylines: [{ id: 204810422, is_guest: false }],
      type: 'newsletter',
      audience: 'everyone'
    })
    expect(JSON.parse(draft.draft_body as string)).toEqual({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Why' }]
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Now', marks: [{ type: 'strong' }] },
            { type: 'text', text: '.' }
          ]
        }
      ]
    })
  })

  it("uses the account's primary publication when neither the step nor the connection names one", async () => {
    const { sent, harness } = setup(
      (r) => (r.url.pathname.endsWith('/profile/self') ? { body: PROFILE } : { body: { id: 1 } }),
      {}
    )
    await harness.execute('createDraft', { title: 't', body: 'b' })
    expect(sent.map(at)[1]).toBe('window POST exampleletter.substack.com/api/v1/drafts')
  })

  it('refuses a custom domain, which the window never signed in to', async () => {
    const { sent, harness } = setup(() => ({ body: PROFILE }))
    await expect(
      harness.execute('createDraft', {
        title: 't',
        body: 'b',
        publication: 'www.lennysnewsletter.com'
      })
    ).rejects.toThrow(/custom domain/)
    expect(sent.filter((s) => s.method === 'POST')).toEqual([])
  })

  it('reports a signed-out window as the answer it got', async () => {
    const { harness } = setup(() => ({
      status: 401,
      body: { error: 'Not authorized' }
    }))
    await expect(harness.execute('createDraft', { title: 't', body: 'b' })).rejects.toThrow(
      /answered 401: Not authorized/
    )
  })
})

describe('deleteDraft', () => {
  it('deletes a draft', async () => {
    const { sent, harness } = setup((r) =>
      r.method === 'GET' ? { body: { id: 9, is_published: false } } : { body: {} }
    )
    await expect(harness.execute('deleteDraft', { draftId: '9' })).resolves.toEqual({ deleted: true, id: 9 })
    expect(sent.map(at)).toEqual([
      'window GET exampleletter.substack.com/api/v1/drafts/9',
      'window DELETE exampleletter.substack.com/api/v1/drafts/9'
    ])
  })

  it('refuses a published post, and sends no delete', async () => {
    const { sent, harness } = setup(() => ({
      body: { id: 9, is_published: true }
    }))
    await expect(harness.execute('deleteDraft', { draftId: '9' })).rejects.toThrow(/published post/)
    expect(sent.filter((s) => s.method === 'DELETE')).toEqual([])
  })
})

describe('comments as the signed-in account', () => {
  it('comments through the window after looking the post up without it', async () => {
    const { sent, harness } = setup((r) =>
      r.url.pathname === '/api/v1/posts/a-post' ? { body: { id: 5 } } : { body: { id: 77, body: 'Nice' } }
    )
    await expect(
      harness.execute('commentOnPost', {
        post: 'https://exampleletter.substack.com/p/a-post',
        body: 'Nice'
      })
    ).resolves.toEqual({ postId: 5, id: 77 })
    expect(sent.map(at)).toEqual([
      'plain GET exampleletter.substack.com/api/v1/posts/a-post',
      'window POST exampleletter.substack.com/api/v1/post/5/comment'
    ])
    expect(sent[1]?.body).toEqual({ body: 'Nice' })
  })

  it('refuses to comment on a custom domain, which the window never signed in to', async () => {
    const { harness } = setup(() => ({ body: { id: 5 } }))
    await expect(
      harness.execute('commentOnPost', {
        post: 'https://www.lennysnewsletter.com/p/a-post',
        body: 'x'
      })
    ).rejects.toThrow(/custom domain/)
  })

  it('likes and unlikes a comment', async () => {
    const { sent, harness } = setup(() => ({ body: {} }))
    await harness.execute('setCommentLike', { commentId: '77', liked: 'true' })
    await harness.execute('setCommentLike', {
      commentId: '77',
      liked: 'false'
    })
    expect(sent.map(at)).toEqual([
      'window POST exampleletter.substack.com/api/v1/comment/77/reaction',
      'window DELETE exampleletter.substack.com/api/v1/comment/77/reaction'
    ])
    expect(sent[0]?.body).toEqual({ reaction: '❤' })
  })

  it('deletes a comment', async () => {
    const { sent, harness } = setup(() => ({ body: {} }))
    await expect(harness.execute('deleteComment', { commentId: '77' })).resolves.toEqual({
      deleted: true,
      commentId: 77
    })
    expect(sent.map(at)).toEqual(['window DELETE exampleletter.substack.com/api/v1/comment/77'])
  })
})

describe('listPosts', () => {
  const page = (from: number, size: number) =>
    Array.from({ length: size }, (_, i) => ({
      id: from + i,
      title: `Post ${from + i}`,
      subtitle: 'Why it matters',
      slug: `post-${from + i}`,
      canonical_url: `https://exampleletter.substack.com/p/post-${from + i}`,
      post_date: '2026-05-29T20:03:32.000Z',
      audience: 'everyone'
    }))

  it('pages through the archive without signing in, until a page comes back short', async () => {
    const { sent, harness } = setup((r) =>
      r.url.pathname === '/api/v1/archive'
        ? { body: r.url.searchParams.get('offset') === '0' ? page(1, 25) : page(26, 3) }
        : undefined
    )
    const out = await harness.execute('listPosts', {})
    expect(out).toMatchObject({ publication: 'exampleletter.substack.com', count: 28 })
    expect((out as { posts: unknown[] }).posts[0]).toEqual({
      id: 1,
      title: 'Post 1',
      subtitle: 'Why it matters',
      slug: 'post-1',
      url: 'https://exampleletter.substack.com/p/post-1',
      publishedAt: '2026-05-29T20:03:32.000Z',
      audience: 'everyone'
    })
    expect(sent.map((s) => `${at(s)}${s.url.search}`)).toEqual([
      'plain GET exampleletter.substack.com/api/v1/archive?sort=new&limit=25&offset=0',
      'plain GET exampleletter.substack.com/api/v1/archive?sort=new&limit=25&offset=25'
    ])
  })

  it('stops at the limit, and reads an answer that is not a list as no posts', async () => {
    const full = setup(() => ({ body: page(1, 25) }))
    await expect(full.harness.execute('listPosts', { limit: '2' })).resolves.toMatchObject({ count: 2 })
    expect(full.sent).toHaveLength(1)
    const odd = setup(() => ({ body: { posts: [] } }))
    await expect(odd.harness.execute('listPosts', { publication: 'www.lennysnewsletter.com' })).resolves.toEqual({
      publication: 'www.lennysnewsletter.com',
      count: 0,
      posts: []
    })
  })
})

describe('getPost', () => {
  it('reads one post by its address without signing in, its body as HTML and as text', async () => {
    const { sent, harness } = setup(() => ({
      body: {
        id: 199708472,
        title: 'A weekly letter.',
        subtitle: 'Who can pay for compute.',
        slug: 'the-weekly-letter',
        canonical_url: 'https://exampleletter.substack.com/p/the-weekly-letter',
        post_date: '2026-05-29T20:03:32.000Z',
        audience: 'everyone',
        wordcount: 1241,
        body_html: '<p>One move.</p><p>Two &amp; three.</p>',
        reactions: { '❤': 4 },
        restacks: 1
      }
    }))
    const out = await harness.execute('getPost', {
      post: 'https://exampleletter.substack.com/p/the-weekly-letter'
    })
    expect(out).toMatchObject({
      id: 199708472,
      slug: 'the-weekly-letter',
      wordcount: 1241,
      html: '<p>One move.</p><p>Two &amp; three.</p>',
      likes: 4,
      restacks: 1
    })
    expect((out as { text: string }).text).toContain('Two & three.')
    expect((out as { text: string }).text).not.toContain('<p>')
    expect(sent.map(at)).toEqual(['plain GET exampleletter.substack.com/api/v1/posts/the-weekly-letter'])
  })

  it("reads a slug on the connection's publication, and fills in what an empty answer leaves out", async () => {
    const { sent, harness } = setup(() => ({ body: {} }))
    await expect(harness.execute('getPost', { post: 'a-post' })).resolves.toEqual({
      id: 0,
      title: '',
      subtitle: '',
      slug: '',
      url: '',
      publishedAt: '',
      audience: '',
      wordcount: 0,
      html: '',
      text: '',
      likes: 0,
      restacks: 0
    })
    expect(sent.map(at)).toEqual(['plain GET exampleletter.substack.com/api/v1/posts/a-post'])
  })
})

describe('updateDraft', () => {
  it('replaces a draft through the window with the byline, once it has checked the draft is not published', async () => {
    const { sent, harness } = setup((r) => {
      if (r.url.pathname === '/api/v1/user/profile/self') return { body: PROFILE }
      if (r.method === 'GET') return { body: { id: 9, is_published: false } }
      return { body: {} }
    })
    await expect(harness.execute('updateDraft', { draftId: '9', title: 'New', body: 'Words' })).resolves.toEqual({
      updated: true,
      id: 9,
      title: 'New',
      editUrl: 'https://exampleletter.substack.com/publish/post/9'
    })
    expect(sent.map(at)).toEqual([
      'window GET substack.com/api/v1/user/profile/self',
      'window GET exampleletter.substack.com/api/v1/drafts/9',
      'window PUT exampleletter.substack.com/api/v1/drafts/9'
    ])
    const draft = sent[2]!.body as Record<string, unknown>
    expect(draft).toMatchObject({
      draft_title: 'New',
      draft_subtitle: '',
      draft_bylines: [{ id: 204810422, is_guest: false }]
    })
    expect(JSON.parse(draft.draft_body as string)).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Words' }] }]
    })
  })

  it('refuses a published post, and sends no PUT', async () => {
    const { sent, harness } = setup((r) =>
      r.url.pathname.endsWith('/profile/self') ? { body: PROFILE } : { body: { id: 9, is_published: true } }
    )
    await expect(harness.execute('updateDraft', { draftId: '9', title: 't', body: 'b' })).rejects.toThrow(
      /published post, not a draft; this action updates only drafts/
    )
    expect(sent.filter((s) => s.method === 'PUT')).toEqual([])
  })
})

describe('likes and restacks on a post', () => {
  it('likes and unlikes a post through the window, after looking it up without it', async () => {
    const { sent, harness } = setup((r) =>
      r.url.pathname === '/api/v1/posts/a-post' ? { body: { id: 5 } } : { body: {} }
    )
    await expect(
      harness.execute('setPostLike', { post: 'https://exampleletter.substack.com/p/a-post', liked: 'true' })
    ).resolves.toEqual({ postId: 5, liked: true })
    await harness.execute('setPostLike', { postId: '5', liked: 'false' })
    expect(sent.map(at)).toEqual([
      'plain GET exampleletter.substack.com/api/v1/posts/a-post',
      'window POST exampleletter.substack.com/api/v1/post/5/reaction',
      'window DELETE exampleletter.substack.com/api/v1/post/5/reaction'
    ])
    expect(sent[1]?.body).toEqual({ reaction: '❤' })
  })

  it('restacks a post and takes the restack back', async () => {
    const { sent, harness } = setup(() => ({ body: {} }))
    await expect(harness.execute('setPostRestack', { postId: '5', restacked: 'true' })).resolves.toEqual({
      postId: 5,
      restacked: true
    })
    await harness.execute('setPostRestack', { postId: '5', restacked: 'false' })
    expect(sent.map(at)).toEqual([
      'window POST exampleletter.substack.com/api/v1/restack/feed',
      'window DELETE exampleletter.substack.com/api/v1/restack/feed'
    ])
    expect(sent[0]?.body).toEqual({ postId: 5, commentId: null })
  })

  it('refuses a custom domain, which the window never signed in to', async () => {
    const { sent, harness } = setup(() => ({ body: { id: 5 } }))
    const post = 'https://www.lennysnewsletter.com/p/a-post'
    await expect(harness.execute('setPostLike', { post, liked: 'true' })).rejects.toThrow(/custom domain/)
    await expect(harness.execute('setPostRestack', { post, restacked: 'true' })).rejects.toThrow(/custom domain/)
    expect(sent).toEqual([])
  })
})

describe('Notes', () => {
  const note = (id: number, extra: Record<string, unknown> = {}) => ({
    type: 'comment',
    context: { type: 'note' },
    comment: { id, body: `Note ${id}`, date: '2026-09-12T23:00:00.000Z', ...extra }
  })

  it('posts a Note through the window as an editor document, and says where it lives', async () => {
    const { sent, harness } = setup((r) =>
      r.url.pathname.endsWith('/profile/self') ? { body: PROFILE } : { body: { id: 335788094, body: 'Hello there' } }
    )
    await expect(harness.execute('postNote', { body: 'Hello **there**' })).resolves.toEqual({
      id: 335788094,
      url: 'https://substack.com/@javiercanizalez/note/c-335788094'
    })
    expect(sent.map(at)).toEqual([
      'window GET substack.com/api/v1/user/profile/self',
      'window POST substack.com/api/v1/comment/feed'
    ])
    expect(sent[1]?.body).toEqual({
      bodyJson: {
        type: 'doc',
        attrs: { schemaVersion: 'v1' },
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Hello ' },
              { type: 'text', text: 'there', marks: [{ type: 'strong' }] }
            ]
          }
        ]
      },
      tabId: 'for-you',
      surface: 'feed',
      replyMinimumRole: 'everyone'
    })
  })

  it('gives the id without an address when the profile has no handle, and nothing when no id comes back', async () => {
    const noHandle = setup((r) => (r.url.pathname.endsWith('/profile/self') ? { body: { id: 1 } } : { body: { id: 7 } }))
    await expect(noHandle.harness.execute('postNote', { body: 'x' })).resolves.toEqual({ id: 7 })
    const noId = setup(() => ({ body: {} }))
    await expect(noId.harness.execute('postNote', { body: 'x' })).resolves.toEqual({})
  })

  it("reads the signed-in account's Notes across pages, and leaves its posts and replies out", async () => {
    const { sent, harness } = setup((r) => {
      if (r.url.pathname.endsWith('/profile/self')) return { body: PROFILE }
      if (!r.url.searchParams.has('cursor')) {
        return {
          body: {
            items: [
              note(3, { reaction_count: 2, restacks: 1 }),
              { type: 'post', context: { type: 'post' } },
              { type: 'comment', context: { type: 'comment' }, comment: { id: 9 } }
            ],
            nextCursor: 'c2'
          }
        }
      }
      return { body: { items: [note(2, { reactions: { '❤': 5 }, handle: 'other' }), note(1)] } }
    })
    await expect(harness.execute('readNotes', {})).resolves.toEqual({
      profile: 'javiercanizalez',
      count: 3,
      notes: [
        {
          id: 3,
          body: 'Note 3',
          url: 'https://substack.com/@javiercanizalez/note/c-3',
          date: '2026-09-12T23:00:00.000Z',
          likes: 2,
          restacks: 1
        },
        {
          id: 2,
          body: 'Note 2',
          url: 'https://substack.com/@other/note/c-2',
          date: '2026-09-12T23:00:00.000Z',
          likes: 5,
          restacks: 0
        },
        {
          id: 1,
          body: 'Note 1',
          url: 'https://substack.com/@javiercanizalez/note/c-1',
          date: '2026-09-12T23:00:00.000Z',
          likes: 0,
          restacks: 0
        }
      ]
    })
    expect(sent.map((s) => `${at(s)}${s.url.search}`)).toEqual([
      'window GET substack.com/api/v1/user/profile/self',
      'window GET substack.com/api/v1/reader/feed/profile/204810422',
      'window GET substack.com/api/v1/reader/feed/profile/204810422?cursor=c2'
    ])
  })

  it('reads another profile by its handle, and stops at the limit', async () => {
    const { sent, harness } = setup((r) =>
      r.url.pathname.endsWith('/public_profile')
        ? { body: { id: 81309935, handle: 'substack' } }
        : { body: { items: [note(1), note(2)], nextCursor: 'more' } }
    )
    await expect(harness.execute('readNotes', { profile: '@substack', limit: '1' })).resolves.toMatchObject({
      profile: 'substack',
      count: 1
    })
    expect(sent.map(at)).toEqual([
      'window GET substack.com/api/v1/user/substack/public_profile',
      'window GET substack.com/api/v1/reader/feed/profile/81309935'
    ])
  })

  it('reads nothing when the profile answers without an id', async () => {
    const named = setup(() => ({ body: {} }))
    await expect(named.harness.execute('readNotes', { profile: 'nobody' })).resolves.toEqual({
      profile: 'nobody',
      count: 0,
      notes: []
    })
    expect(named.sent).toHaveLength(1)
    const self = setup(() => ({ body: {} }))
    await expect(self.harness.execute('readNotes', {})).resolves.toEqual({ profile: '', count: 0, notes: [] })
  })

  it('stops after ten pages of a feed that holds no Notes', async () => {
    const { sent, harness } = setup((r) =>
      r.url.pathname.endsWith('/profile/self') ? { body: PROFILE } : { body: { items: [{ type: 'post' }], nextCursor: 'again' } }
    )
    await expect(harness.execute('readNotes', {})).resolves.toMatchObject({ count: 0 })
    expect(sent).toHaveLength(11)
  })

  it('deletes a Note on substack.com', async () => {
    const { sent, harness } = setup(() => ({ body: {} }))
    await expect(harness.execute('deleteNote', { noteId: '335788094' })).resolves.toEqual({
      deleted: true,
      noteId: 335788094
    })
    expect(sent.map(at)).toEqual(['window DELETE substack.com/api/v1/comment/335788094'])
  })
})

describe('readSubscriberCount', () => {
  it("reads the dashboard's figures through the window, the total from totalEmail and the paid count from subscribers", async () => {
    const { sent, harness } = setup(() => ({
      body: { subscribers: 0, totalEmail: 29, appSubscribers: 3, views: 1200, openRate: 0.41 }
    }))
    await expect(harness.execute('readSubscriberCount', {})).resolves.toEqual({
      publication: 'exampleletter.substack.com',
      subscribers: 29,
      paidSubscribers: 0,
      appSubscribers: 3,
      views: 1200,
      openRate: 0.41
    })
    expect(sent.map(at)).toEqual(['window GET exampleletter.substack.com/api/v1/publish-dashboard/summary'])
  })

  it('reads a figure the dashboard leaves out as zero', async () => {
    const { harness } = setup(() => ({ body: {} }))
    await expect(harness.execute('readSubscriberCount', {})).resolves.toEqual({
      publication: 'exampleletter.substack.com',
      subscribers: 0,
      paidSubscribers: 0,
      appSubscribers: 0,
      views: 0,
      openRate: 0
    })
  })
})

describe('publishing', () => {
  it('is never reached by any action', async () => {
    const { sent, harness } = setup((r) => {
      if (r.url.pathname === '/feed') return { text: FEED }
      if (r.url.pathname.endsWith('/profile/self')) return { body: PROFILE }
      return { body: { id: 1, comments: [], results: [] } }
    })
    await harness.execute('readFeed', {})
    await harness.execute('searchPosts', { query: 'q' })
    await harness.execute('readComments', { postId: '1' })
    await harness.execute('listPosts', {})
    await harness.execute('getPost', { post: 'a-post' })
    await harness.execute('createDraft', { title: 't', body: 'b' })
    await harness.execute('updateDraft', { draftId: '1', title: 't', body: 'b' })
    await harness.execute('deleteDraft', { draftId: '1' })
    await harness.execute('commentOnPost', { postId: '1', body: 'c' })
    await harness.execute('setCommentLike', { commentId: '1', liked: 'true' })
    await harness.execute('deleteComment', { commentId: '1' })
    await harness.execute('setPostLike', { postId: '1', liked: 'true' })
    await harness.execute('setPostRestack', { postId: '1', restacked: 'true' })
    await harness.execute('postNote', { body: 'n' })
    await harness.execute('readNotes', {})
    await harness.execute('deleteNote', { noteId: '1' })
    await harness.execute('readSubscriberCount', {})
    expect(sent.length).toBeGreaterThan(17)
    expect(
      sent.filter(
        (s) => /publish|schedule/i.test(s.url.pathname) && !s.url.pathname.startsWith('/api/v1/publish-dashboard/')
      )
    ).toEqual([])
  })

  it("lets a GET read the dashboard's figures, and refuses any other method there", async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'))
    const guarded = neverPublishing(fetchImpl as unknown as typeof fetch)
    const summary = 'https://exampleletter.substack.com/api/v1/publish-dashboard/summary'
    await guarded(summary)
    await guarded(new Request(summary))
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await expect(guarded(summary, { method: 'POST' })).rejects.toThrow(/never publishes/)
    await expect(guarded(new Request(summary, { method: 'PUT' }))).rejects.toThrow(/never publishes/)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('is refused before a signed-in request leaves', async () => {
    const fetchImpl = vi.fn()
    const guarded = neverPublishing(fetchImpl as unknown as typeof fetch)
    await expect(guarded('https://exampleletter.substack.com/api/v1/drafts/1/publish', { method: 'POST' })).rejects.toThrow(
      /never publishes/
    )
    await expect(
      guarded(new Request('https://exampleletter.substack.com/api/v1/drafts/1/scheduled_release'))
    ).rejects.toThrow(/never publishes/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
