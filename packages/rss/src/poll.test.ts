import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createConnectorHarness } from '@vornrun/connector-sdk'
import { fixture, serve, type Handler, type Reply } from '../fixtures/serve'
import { connector } from './connector'
import type { FeedItem } from './feed'
import { SEEN_CAP, readCursor, seenKey, selectNew, toConnectorItem, writeCursor } from './poll'

const NOW = '2026-09-12T12:00:00.000Z'
const ATOM = 'https://github.com/nodejs/node/releases.atom'
const HAND = 'https://hand.example/feed'
const DAY = 'Sat, 12 Sep 2026 00:00:00 -0400'
const sleep = async () => {}

const rss = (...items: string[]) => `<rss version="2.0"><channel><title>Hand</title>${items.join('')}</channel></rss>`
const item = (id: string, date?: string) =>
  `<item><guid isPermaLink="false">${id}</guid><title>${id}</title>${date ? `<pubDate>${date}</pubDate>` : ''}</item>`

function harnessFor(routes: Record<string, Handler>, config: Record<string, string>) {
  const server = serve(routes)
  return { ...server, harness: createConnectorHarness(connector, { config, fetchImpl: server.fetchImpl, now: () => NOW, sleep }) }
}

let stderr: MockInstance
beforeEach(() => {
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(() => {
  stderr.mockRestore()
})

describe('the first poll of a feed', () => {
  it('fires only for items inside the look-back and remembers where the feed stands', async () => {
    const headers = { etag: 'W/"abc"', 'last-modified': 'Wed, 09 Sep 2026 16:07:48 GMT' }
    const { harness, calls } = harnessFor({ [ATOM]: { body: fixture('atom.xml'), headers } }, { feeds: ATOM, lookbackHours: '72' })
    const page = await harness.poll('newItem')
    expect(page.hasMore).toBe(false)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      externalId: `${ATOM} tag:github.com,2008:Repository/27193779/v26.8.2`,
      title: '2026-09-09, Version 26.8.2 (Current), @aduh95',
      url: 'https://github.com/nodejs/node/releases/tag/v26.8.2',
      assignee: 'aduh95',
      labels: [],
      updatedAt: '2026-09-09T16:07:48.000Z',
      publishedAt: '2026-09-09T16:07:48.000Z',
      feedTitle: 'Release notes from node',
      feedUrl: ATOM
    })
    expect(page.items[0]!.description).toMatch(/^Notable Changes\n/)
    expect(JSON.parse(page.nextCursor!)).toEqual({
      v: 1,
      feeds: {
        [ATOM]: {
          t: '2026-09-09T16:07:48.000Z',
          etag: 'W/"abc"',
          lm: 'Wed, 09 Sep 2026 16:07:48 GMT',
          seen: [seenKey('tag:github.com,2008:Repository/27193779/v26.8.2')]
        }
      }
    })
    expect(calls[0]!.headers.has('if-none-match')).toBe(false)
  })

  it('fires nothing older than the default 24 hours', async () => {
    const { harness } = harnessFor({ [ATOM]: { body: fixture('atom.xml') } }, { feeds: ATOM })
    expect((await harness.poll('newItem')).items).toEqual([])
  })

  it("starts from the host's since when it gives one, oldest first", async () => {
    const { harness } = harnessFor({ [ATOM]: { body: fixture('atom.xml') } }, { feeds: ATOM })
    const page = await harness.poll('newItem', { since: '2026-09-08T00:00:00.000Z' })
    expect(page.items.map((entry) => entry.updatedAt)).toEqual([
      '2026-09-08T07:30:00.000Z',
      '2026-09-08T21:51:09.000Z',
      '2026-09-09T16:07:48.000Z'
    ])
  })
})

describe('later polls', () => {
  it('send the validators back, and a 304 costs nothing and keeps the cursor', async () => {
    const headers = { etag: 'W/"abc"', 'last-modified': 'Wed, 09 Sep 2026 16:07:48 GMT' }
    const route: Handler = (request) =>
      request.headers.get('if-none-match') === 'W/"abc"' ? { status: 304 } : { body: fixture('atom.xml'), headers }
    const { harness, calls } = harnessFor({ [ATOM]: route }, { feeds: ATOM, lookbackHours: '72' })
    const first = await harness.poll('newItem')
    const second = await harness.poll('newItem', { cursor: first.nextCursor })
    expect(second.items).toEqual([])
    expect(second.nextCursor).toBe(first.nextCursor)
    expect(calls[1]!.headers.get('if-modified-since')).toBe('Wed, 09 Sep 2026 16:07:48 GMT')
  })

  it('fire a new item once, and drop validators the feed no longer sends', async () => {
    let body = fixture('atom.xml')
    const { harness } = harnessFor(
      { [ATOM]: (): Reply => ({ body, headers: body.includes('v26.9.0') ? {} : { etag: '"1"' } }) },
      { feeds: ATOM, lookbackHours: '72' }
    )
    const first = await harness.poll('newItem')
    body = body.replace(
      '<entry>',
      '<entry><id>v26.9.0</id><title>26.9.0</title><link href="https://github.com/nodejs/node/releases/tag/v26.9.0"/><updated>2026-09-12T09:00:00Z</updated></entry>\n  <entry>'
    )
    const second = await harness.poll('newItem', { cursor: first.nextCursor })
    expect(second.items.map((entry) => entry.externalId)).toEqual([`${ATOM} v26.9.0`])
    expect(JSON.parse(second.nextCursor!).feeds[ATOM]).toEqual({ t: '2026-09-12T09:00:00.000Z', seen: [seenKey('v26.9.0')] })
    const third = await harness.poll('newItem', { cursor: second.nextCursor })
    expect(third.items).toEqual([])
  })

  it('fire an item sharing the newest date only when its id is new, as arXiv stamps a whole day with one time', async () => {
    let body = rss(item('a', DAY), item('b', DAY))
    const { harness } = harnessFor({ [HAND]: () => ({ body }) }, { feeds: HAND })
    const first = await harness.poll('newItem')
    expect(first.items.map((entry) => entry.title)).toEqual(['a', 'b'])
    body = rss(item('a', DAY), item('b', DAY), item('c', DAY))
    const second = await harness.poll('newItem', { cursor: first.nextCursor })
    expect(second.items.map((entry) => entry.title)).toEqual(['c'])
    expect((await harness.poll('newItem', { cursor: second.nextCursor })).items).toEqual([])
  })

  it('fire an item with no date once, by its id', async () => {
    let body = rss(item('x'), item('y', DAY))
    const { harness } = harnessFor({ [HAND]: () => ({ body }) }, { feeds: HAND })
    const first = await harness.poll('newItem')
    expect(first.items.map((entry) => entry.title)).toEqual(['y'])
    body = rss(item('x'), item('y', DAY), item('z'))
    const second = await harness.poll('newItem', { cursor: first.nextCursor })
    expect(second.items).toMatchObject([{ title: 'z', updatedAt: NOW }])
    expect((await harness.poll('newItem', { cursor: second.nextCursor })).items).toEqual([])
  })

  it('never fire an item dated before the newest one seen', async () => {
    let body = rss(item('y', DAY))
    const { harness } = harnessFor({ [HAND]: () => ({ body }) }, { feeds: HAND })
    const first = await harness.poll('newItem')
    body = rss(item('y', DAY), item('old', 'Tue, 01 Sep 2026 00:00:00 GMT'))
    expect((await harness.poll('newItem', { cursor: first.nextCursor })).items).toEqual([])
  })

  it('fire an item a feed lists twice only once', async () => {
    const { harness } = harnessFor({ [HAND]: { body: rss(item('a', DAY), item('a', DAY)) } }, { feeds: HAND })
    expect((await harness.poll('newItem')).items).toHaveLength(1)
  })

  it('drop feeds the connection no longer lists from the cursor', async () => {
    const cursor = writeCursor(new Map([['https://old.example/feed', { t: '2026-09-01T00:00:00.000Z', seen: [] }]]))
    const { harness } = harnessFor({ [HAND]: { body: rss(item('a', DAY)) } }, { feeds: HAND })
    const page = await harness.poll('newItem', { cursor })
    expect(Object.keys(JSON.parse(page.nextCursor!).feeds)).toEqual([HAND])
  })
})

describe('failures', () => {
  const BROKEN = 'https://broken.example/feed'
  const brokenState = { t: '2026-09-01T00:00:00.000Z', etag: '"b"', seen: [] }

  it("write a failed feed to stderr, keep its state, and never lose the other feeds' items", async () => {
    const { harness, calls } = harnessFor(
      { [HAND]: { body: rss(item('a', DAY)) }, [BROKEN]: { status: 500 } },
      { feeds: `${HAND}\n${BROKEN}` }
    )
    const page = await harness.poll('newItem', { cursor: writeCursor(new Map([[BROKEN, brokenState]])) })
    expect(page.items.map((entry) => entry.title)).toEqual(['a'])
    expect(JSON.parse(page.nextCursor!).feeds[BROKEN]).toEqual(brokenState)
    expect(stderr).toHaveBeenCalledWith(`rss: ${BROKEN}: HTTP 500\n`)
    expect(calls.find((call) => call.url === BROKEN)!.headers.get('if-none-match')).toBe('"b"')
  })

  it('throw only when every feed failed, a refused address included', async () => {
    const { harness } = harnessFor({ [BROKEN]: { status: 500 } }, { feeds: `${BROKEN}, ftp://x.example/feed` })
    await expect(harness.poll('newItem')).rejects.toThrow(
      'Every feed failed: ftp://x.example/feed: refused, only http and https feeds are read; https://broken.example/feed: HTTP 500'
    )
  })

  it('ask for feeds when there are none, and for a sensible look-back', async () => {
    await expect(harnessFor({}, {}).harness.poll('newItem')).rejects.toThrow("Add feed URLs to the connection's feeds")
    await expect(harnessFor({}, { feeds: HAND, lookbackHours: '0' }).harness.poll('newItem')).rejects.toThrow(
      'lookbackHours must be a whole number from 1 to 8760'
    )
  })
})

describe('the pool', () => {
  it('keeps at most six feeds in flight', async () => {
    let active = 0
    let peak = 0
    const feeds = Array.from({ length: 8 }, (_, i) => `https://f${i}.example/feed`)
    const fetchImpl = (async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return new Response(rss(item('a', DAY)))
    }) as typeof fetch
    const harness = createConnectorHarness(connector, { config: { feeds: feeds.join('\n') }, fetchImpl, now: () => NOW, sleep })
    expect((await harness.poll('newItem')).items).toHaveLength(8)
    expect(peak).toBe(6)
  })
})

describe('the cursor', () => {
  it('starts afresh from anything it cannot read', () => {
    for (const raw of [undefined, 'not json', 'null', '{"v":2,"feeds":{}}', '{"v":1,"feeds":null}']) {
      expect(readCursor(raw).size).toBe(0)
    }
  })

  it('keeps what it can read of each feed', () => {
    const states = readCursor(
      '{"v":1,"feeds":{"a":null,"b":{"t":5,"etag":1,"seen":[1,"x"]},"c":{"t":"T","etag":"e","lm":"l","seen":"no"}}}'
    )
    expect(Object.fromEntries(states)).toEqual({ b: { t: '', seen: ['x'] }, c: { t: 'T', etag: 'e', lm: 'l', seen: [] } })
    expect(readCursor(writeCursor(states))).toEqual(states)
  })

  it(`remembers at most ${SEEN_CAP} ids per feed`, () => {
    const items = Array.from({ length: 1500 }, (_, i) => ({ id: `id-${i}`, publishedAt: NOW, updatedAt: '' }) as FeedItem)
    const { fire, state } = selectNew(items, undefined, 0)
    expect(fire).toHaveLength(1500)
    expect(state.seen).toHaveLength(SEEN_CAP)
  })
})

describe('items', () => {
  it('fall back to the address, then to a placeholder, for a title', () => {
    const base = {
      id: 'i',
      feedUrl: 'https://f.example/',
      feedTitle: '',
      publishedAt: '',
      updatedAt: '',
      summary: '',
      html: '',
      author: '',
      categories: []
    }
    expect(toConnectorItem({ ...base, title: '', url: 'https://f.example/1' } as FeedItem).title).toBe('https://f.example/1')
    const bare = toConnectorItem({ ...base, title: '', url: '' } as FeedItem)
    expect(bare).toMatchObject({ externalId: 'https://f.example/ i', title: 'Untitled item' })
    expect(bare).not.toHaveProperty('updatedAt')
    expect(bare).not.toHaveProperty('description')
  })

  it('carry the sample from the RSS Advisory Board feed', () => {
    expect(connector.triggers[0]!.sample![0]).toMatchObject({
      externalId: 'http://feeds.rssboard.org/rssboard tag:rssboard.org,2006:weblog.221',
      title: 'How to Read an RSS Feed with Java Using XOM',
      assignee: 'Rogers Cadenhead',
      updatedAt: '2023-08-02T03:25:57.000Z'
    })
  })
})
