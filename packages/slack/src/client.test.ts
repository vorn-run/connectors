import { describe, expect, it, vi } from 'vitest'
import { SLACK_API, slackGet, slackPages, slackPost } from './client'

interface Reply {
  status?: number
  body?: unknown
  text?: string
}

/** Answers each call in turn from `replies`, recording what was asked. */
function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? {}
    const text = reply.text ?? JSON.stringify(reply.body ?? { ok: true })
    return new Response(text, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const token = 'xoxb-test'

describe('slackGet', () => {
  it('sends the token as a Bearer header and the arguments as a query string', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: { ok: true, channel: { id: 'C1' } } }])

    const result = await slackGet<{ channel: { id: string } }>(
      'conversations.info',
      { channel: 'C1', include_num_members: true, cursor: undefined, blank: '' },
      { token, fetch: fetchImpl }
    )

    expect(result.channel.id).toBe('C1')
    const url = new URL(calls[0]!.url)
    expect(url.origin + url.pathname).toBe(`${SLACK_API}/conversations.info`)
    expect([...url.searchParams.entries()]).toEqual([
      ['channel', 'C1'],
      ['include_num_members', 'true']
    ])
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer xoxb-test')
    expect(calls[0]!.init?.method).toBeUndefined()
  })

  it('surfaces the error code when Slack answers ok: false', async () => {
    const { fetchImpl } = fakeFetch([{ body: { ok: false, error: 'channel_not_found' } }])

    await expect(slackGet('conversations.info', {}, { token, fetch: fetchImpl })).rejects.toThrow(
      'Slack conversations.info answered channel_not_found'
    )
  })

  it('names the refusal even when Slack gives no error code', async () => {
    const { fetchImpl } = fakeFetch([{ body: { ok: false } }])

    await expect(slackGet('auth.test', {}, { token, fetch: fetchImpl })).rejects.toThrow(
      'Slack auth.test answered an unnamed error'
    )
  })

  it('reports the status when the reply is not JSON', async () => {
    const { fetchImpl } = fakeFetch([{ status: 502, text: '<html>bad gateway</html>' }])

    await expect(slackGet('auth.test', {}, { token, fetch: fetchImpl })).rejects.toThrow(
      'Slack auth.test answered HTTP 502'
    )
  })

  it('reads a 429 by its envelope rather than its status', async () => {
    const { fetchImpl } = fakeFetch([{ status: 429, body: { ok: false, error: 'ratelimited' } }])

    await expect(slackGet('auth.test', {}, { token, fetch: fetchImpl })).rejects.toThrow(
      'Slack auth.test answered ratelimited'
    )
  })

  it('treats an empty 200 as an empty envelope', async () => {
    const { fetchImpl } = fakeFetch([{ text: '' }])

    expect(await slackGet('auth.test', {}, { token, fetch: fetchImpl })).toEqual({})
  })
})

describe('slackPost', () => {
  it('sends a JSON body with the token as a Bearer header', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: { ok: true, ts: '1.2' } }])

    const result = await slackPost<{ ts: string }>(
      'chat.postMessage',
      { channel: 'C1', text: 'hi', thread_ts: undefined },
      { token, fetch: fetchImpl }
    )

    expect(result.ts).toBe('1.2')
    expect(calls[0]!.url).toBe(`${SLACK_API}/chat.postMessage`)
    expect(calls[0]!.init?.method).toBe('POST')
    const headers = new Headers(calls[0]!.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer xoxb-test')
    expect(headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ channel: 'C1', text: 'hi' })
  })

  it('surfaces the error code when Slack answers ok: false', async () => {
    const { fetchImpl } = fakeFetch([{ body: { ok: false, error: 'already_reacted' } }])

    await expect(slackPost('reactions.add', {}, { token, fetch: fetchImpl })).rejects.toThrow(
      'Slack reactions.add answered already_reacted'
    )
  })
})

describe('slackPages', () => {
  it('follows next_cursor until Slack has no more', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { ok: true, members: ['U1', 'U2'], response_metadata: { next_cursor: 'p2' } } },
      { body: { ok: true, members: ['U3'], response_metadata: { next_cursor: '' } } }
    ])

    const members = await slackPages<{ members: string[] }, string>(
      'conversations.members',
      { channel: 'C1', limit: 2 },
      { token, fetch: fetchImpl },
      (page) => page.members,
      { items: Number.POSITIVE_INFINITY, pages: 10 }
    )

    expect(members).toEqual(['U1', 'U2', 'U3'])
    expect(calls).toHaveLength(2)
    expect(new URL(calls[0]!.url).searchParams.get('cursor')).toBeNull()
    expect(new URL(calls[1]!.url).searchParams.get('cursor')).toBe('p2')
  })

  it('stops when a page carries no metadata at all', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: { ok: true, members: ['U1'] } }])

    const members = await slackPages<{ members?: string[] }, string>(
      'conversations.members',
      { channel: 'C1' },
      { token, fetch: fetchImpl },
      (page) => page.members ?? [],
      { items: Number.POSITIVE_INFINITY, pages: 10 }
    )

    expect(members).toEqual(['U1'])
    expect(calls).toHaveLength(1)
  })

  it('stops at the page bound rather than following a cursor forever', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { ok: true, members: ['U1'], response_metadata: { next_cursor: 'again' } } }
    ])

    const members = await slackPages<{ members: string[] }, string>(
      'conversations.members',
      { channel: 'C1' },
      { token, fetch: fetchImpl },
      (page) => page.members,
      { items: Number.POSITIVE_INFINITY, pages: 3 }
    )

    expect(members).toEqual(['U1', 'U1', 'U1'])
    expect(calls).toHaveLength(3)
  })

  it('stops once it holds as many entries as asked for', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { ok: true, members: ['U1'], response_metadata: { next_cursor: 'p2' } } },
      { body: { ok: true, members: ['U2', 'U3'], response_metadata: { next_cursor: 'p3' } } },
      { body: { ok: true, members: ['U4'] } }
    ])

    const members = await slackPages<{ members: string[] }, string>(
      'conversations.members',
      { channel: 'C1' },
      { token, fetch: fetchImpl },
      (page) => page.members,
      { items: 2, pages: 10 }
    )

    expect(members).toEqual(['U1', 'U2', 'U3'])
    expect(calls).toHaveLength(2)
  })
})
