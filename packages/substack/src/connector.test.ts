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
      publication: { id: 8174077, name: 'Novum AI', subdomain: 'novumai' }
    }
  ]
}

const FEED = `<rss version="2.0"><channel>
<item><title><![CDATA[Newer]]></title><link>https://novumai.substack.com/p/newer</link><guid isPermaLink="false">https://novumai.substack.com/p/newer</guid><dc:creator><![CDATA[Javier Canizalez]]></dc:creator><pubDate>Wed, 10 Sep 2026 09:00:00 GMT</pubDate><content:encoded><![CDATA[<p>Body two</p>]]></content:encoded></item>
<item><title><![CDATA[Older]]></title><link>https://novumai.substack.com/p/older</link><guid isPermaLink="false">https://novumai.substack.com/p/older</guid><pubDate>Fri, 29 May 2026 20:03:32 GMT</pubDate><content:encoded><![CDATA[<p>Body one</p>]]></content:encoded></item>
</channel></rss>`

function setup(route: Route, config: ConnectorConfig = { publication: 'novumai' }) {
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
      'createDraft',
      'deleteDraft',
      'commentOnPost',
      'setCommentLike',
      'deleteComment'
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
        ['https://novumai.substack.com/p/newer', 'Newer', '2026-09-10T09:00:00.000Z'],
        ['https://novumai.substack.com/p/older', 'Older', '2026-05-29T20:03:32.000Z']
      ])
    )
    expect(items.find((item) => item.title === 'Newer')).toMatchObject({
      author: 'Javier Canizalez',
      text: 'Body two'
    })
    expect(sent.map(at)).toEqual(['plain GET novumai.substack.com/feed'])
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
      publication: 'novumai.substack.com',
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
    expect(sent.map(at)).toEqual(['plain GET novumai.substack.com/api/v1/post/7/comments'])
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
      editUrl: 'https://novumai.substack.com/publish/post/215138440'
    })
    expect(sent.map(at)).toEqual([
      'window GET substack.com/api/v1/user/profile/self',
      'window POST novumai.substack.com/api/v1/drafts'
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
    expect(sent.map(at)[1]).toBe('window POST novumai.substack.com/api/v1/drafts')
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
      'window GET novumai.substack.com/api/v1/drafts/9',
      'window DELETE novumai.substack.com/api/v1/drafts/9'
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
        post: 'https://novumai.substack.com/p/a-post',
        body: 'Nice'
      })
    ).resolves.toEqual({ postId: 5, id: 77 })
    expect(sent.map(at)).toEqual([
      'plain GET novumai.substack.com/api/v1/posts/a-post',
      'window POST novumai.substack.com/api/v1/post/5/comment'
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
      'window POST novumai.substack.com/api/v1/comment/77/reaction',
      'window DELETE novumai.substack.com/api/v1/comment/77/reaction'
    ])
    expect(sent[0]?.body).toEqual({ reaction: '❤' })
  })

  it('deletes a comment', async () => {
    const { sent, harness } = setup(() => ({ body: {} }))
    await expect(harness.execute('deleteComment', { commentId: '77' })).resolves.toEqual({
      deleted: true,
      commentId: 77
    })
    expect(sent.map(at)).toEqual(['window DELETE novumai.substack.com/api/v1/comment/77'])
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
    await harness.execute('createDraft', { title: 't', body: 'b' })
    await harness.execute('deleteDraft', { draftId: '1' })
    await harness.execute('commentOnPost', { postId: '1', body: 'c' })
    await harness.execute('setCommentLike', { commentId: '1', liked: 'true' })
    await harness.execute('deleteComment', { commentId: '1' })
    expect(sent.length).toBeGreaterThan(8)
    expect(sent.filter((s) => /publish|schedule/i.test(s.url.pathname))).toEqual([])
  })

  it('is refused before a signed-in request leaves', async () => {
    const fetchImpl = vi.fn()
    const guarded = neverPublishing(fetchImpl as unknown as typeof fetch)
    await expect(guarded('https://novumai.substack.com/api/v1/drafts/1/publish', { method: 'POST' })).rejects.toThrow(
      /never publishes/
    )
    await expect(
      guarded(new Request('https://novumai.substack.com/api/v1/drafts/1/scheduled_release'))
    ).rejects.toThrow(/never publishes/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
