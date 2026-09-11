import { describe, expect, it, vi } from 'vitest'
import { createConnectorHarness, type ConnectorConfig } from '@vornrun/connector-sdk'
import { call, connector, resolvePost } from './connector'
import { markdownToDoc } from './markdown'

const answering = (status: number, body: string) =>
  vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch

function harness(
  route: (url: URL, method: string) => { status?: number; text?: string },
  config: ConnectorConfig = { publication: 'novumai' }
) {
  const serve = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const reply = route(new URL(String(input)), init?.method ?? 'GET')
    return new Response(reply.text ?? '{}', { status: reply.status ?? 200 })
  }) as unknown as typeof fetch
  return createConnectorHarness(connector, { config, fetchImpl: serve, sessionFetchImpl: serve, sleep: async () => {} })
}

describe('what a failed call says', () => {
  it('quotes the first validation error, or the plain error, or only the status', async () => {
    const url = 'https://novumai.substack.com/api/v1/drafts'
    await expect(
      call(answering(400, '{"errors":[{"param":"draft_bylines","msg":"Invalid value"}]}'), url)
    ).rejects.toThrow('GET /api/v1/drafts answered 400: draft_bylines Invalid value')
    await expect(call(answering(403, '{"error":"Forbidden"}'), url)).rejects.toThrow('answered 403: Forbidden')
    await expect(call(answering(502, '<html>bad gateway</html>'), url)).rejects.toThrow(/answered 502$/)
    await expect(call(answering(500, '{"other":1}'), url)).rejects.toThrow(/answered 500$/)
  })

  it('reads an empty answer as nothing and refuses one that is not JSON', async () => {
    const url = 'https://novumai.substack.com/api/v1/comment/1'
    await expect(call(answering(200, ''), url, { method: 'DELETE' })).resolves.toEqual({})
    await expect(call(answering(200, '<html></html>'), url)).rejects.toThrow(/not JSON/)
  })

  it('says so when a feed cannot be read', async () => {
    const h = harness(() => ({ status: 404, text: 'gone' }))
    await expect(h.execute('readFeed', {})).rejects.toThrow('GET /feed on novumai.substack.com answered 404')
  })
})

describe('arguments a step can get wrong', () => {
  const h = harness(() => ({ text: '{}' }))

  it('refuses a page, a draft id or a comment id that is not a whole number', async () => {
    await expect(h.execute('searchPosts', { query: 'q', page: '-1' })).rejects.toThrow(/page must be/)
    await expect(h.execute('searchPosts', { query: ' ' })).rejects.toThrow(/query is required/)
    await expect(h.execute('deleteDraft', { draftId: '0' })).rejects.toThrow(/draftId must be/)
    await expect(h.execute('deleteComment', { commentId: '-4' })).rejects.toThrow(/commentId must be/)
    await expect(h.execute('readFeed', { limit: '2.5' })).rejects.toThrow(/limit must be/)
  })

  it('asks for a title, a body and a comment that are more than spaces', async () => {
    await expect(h.execute('createDraft', { title: ' ', body: 'b' })).rejects.toThrow(/title is required/)
    await expect(h.execute('createDraft', { title: 't', body: ' ' })).rejects.toThrow(/body is required/)
    await expect(h.execute('commentOnPost', { postId: '1', body: ' ' })).rejects.toThrow(/body is required/)
  })

  it('finds a post by id, by number, by slug or by address, and refuses anything else', async () => {
    const lookup = answering(200, '{"id":42}')
    await expect(resolvePost(lookup, undefined, '9', 'novumai')).resolves.toEqual({
      host: 'novumai.substack.com',
      id: 9
    })
    await expect(resolvePost(lookup, '12', undefined, 'novumai')).resolves.toEqual({
      host: 'novumai.substack.com',
      id: 12
    })
    await expect(resolvePost(lookup, 'a-post', undefined, 'novumai')).resolves.toEqual({
      host: 'novumai.substack.com',
      id: 42
    })
    await expect(resolvePost(lookup, 'https://x.substack.com/p/a-post', '5', 'novumai')).resolves.toEqual({
      host: 'x.substack.com',
      id: 5
    })
    await expect(resolvePost(lookup, undefined, undefined, 'novumai')).rejects.toThrow(/Give the post's address/)
    await expect(resolvePost(lookup, 'not a slug!', undefined, 'novumai')).rejects.toThrow(/not a post slug/)
    await expect(resolvePost(answering(200, '{}'), 'a-post', undefined, 'novumai')).rejects.toThrow(
      'No post "a-post" on novumai.substack.com'
    )
  })

  it('says so when the account has no publication to fall back on', async () => {
    const none = harness(() => ({ text: '{"id":1,"publicationUsers":[]}' }), {})
    await expect(none.execute('deleteDraft', { draftId: '1' })).rejects.toThrow(/has no publication/)
  })

  it('falls back to the first publication when none is marked primary', async () => {
    const seen: string[] = []
    const first = harness((url) => {
      seen.push(url.host + url.pathname)
      return {
        text: url.pathname.endsWith('/profile/self')
          ? '{"publicationUsers":[{"publication":{"subdomain":"second"}}]}'
          : '{}'
      }
    }, {})
    await first.execute('setCommentLike', { commentId: '3', liked: 'true' })
    expect(seen).toContain('second.substack.com/api/v1/comment/3/reaction')
  })

  it('saves a draft without an id and says nothing about where to edit it', async () => {
    const h2 = harness((url) => ({ text: url.pathname.endsWith('/profile/self') ? '{"id":1}' : '{}' }))
    await expect(h2.execute('createDraft', { title: 't', body: 'b' })).resolves.toEqual({ title: 't' })
  })
})

describe('the signed-in window', () => {
  const run = (type: string) => connector.actions.find((action) => action.type === type)!

  it('is what a signed-in action needs; without one it says where to run it', async () => {
    const action = run('createDraft')
    if (!('run' in action) || typeof action.run !== 'function') throw new Error('createDraft is hand-written')
    await expect(action.run({ title: 't', body: 'b' }, { config: {}, now: () => '', fetch })).rejects.toThrow(
      /runs from Vorn/
    )
  })

  it('lists the account’s publications for the draft picker, and nothing without a window', async () => {
    const load = connector.options!.publications!
    const signed = answering(
      200,
      '{"publicationUsers":[{"publication":{"name":"Novum AI","subdomain":"novumai"}},{"publication":{"subdomain":"notes"}},{"publication":{}}]}'
    )
    await expect(load({ config: {}, now: () => '', fetch, session: { fetch: signed } })).resolves.toEqual([
      { value: 'novumai', label: 'Novum AI' },
      { value: 'notes', label: 'notes' }
    ])
    await expect(load({ config: {}, now: () => '', fetch })).resolves.toEqual([])
  })
})

describe('markdown the editor has no node for', () => {
  it('leaves an empty code block empty, and a link definition out', () => {
    expect(markdownToDoc('```\n```').content).toEqual([{ type: 'code_block', attrs: { language: null } }])
    expect(markdownToDoc('[a]: https://vorn.run\n\ntext').content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'text' }] }
    ])
    expect(markdownToDoc('0. zero').content?.[0]?.attrs).toEqual({ start: 0 })
  })

  const kinds = (markdown: string) => markdownToDoc(markdown).content?.map((n) => n.type)

  it('keeps a heading within the editor’s levels, an empty list item, and a code block without a language', () => {
    expect(markdownToDoc('###### six').content?.[0]?.attrs).toEqual({ level: 6 })
    expect(markdownToDoc('- \n- b').content?.[0]?.content?.[0]).toEqual({
      type: 'list_item',
      content: [{ type: 'paragraph' }]
    })
    expect(markdownToDoc('```\nx\n```').content?.[0]?.attrs).toEqual({ language: null })
    expect(kinds('1) one')).toEqual(['ordered_list'])
  })

  it('writes raw HTML out as text, and does not stack a mark twice', () => {
    expect(markdownToDoc('<div>raw</div>').content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: '<div>raw</div>' }] }
    ])
    const inline = markdownToDoc('**a __b__** \\* <span>x</span>').content?.[0]?.content
    expect(inline?.find((n) => n.text === 'b')?.marks).toEqual([{ type: 'strong' }])
    expect(inline?.map((n) => n.text).join('')).toContain('* <span>x</span>')
  })

  it('names a picture with no words by its address, and drops a link mark on an unsafe one', () => {
    expect(markdownToDoc('![](https://e.io/p.png)').content?.[0]?.content?.[0]?.text).toBe('https://e.io/p.png')
    expect(markdownToDoc('![x](javascript:1)').content?.[0]?.content?.[0]).toEqual({ type: 'text', text: 'x' })
  })
})
