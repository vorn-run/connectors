import { describe, expect, it } from 'vitest'
import { createConnectorHarness, runConformance } from '@vornrun/connector-sdk'
import { fixture, serve, type Handler } from '../fixtures/serve'
import { connector, dedupeByUrl, keywordFilter } from './connector'
import type { FeedItem } from './feed'
import { FEED_ACCEPT, PAGE_ACCEPT } from './http'
import { DEFAULT_USER_AGENT } from './settings'

const NOW = '2026-09-12T12:00:00.000Z'
const SAMPLE = 'https://www.rssboard.org/files/sample-rss-2.xml'
const ATOM = 'https://github.com/nodejs/node/releases.atom'
const MISSING = 'https://x.example/missing.xml'
const LOUISIANA = 'http://www.nasa.gov/press-release/louisiana-students-to-hear-from-nasa-astronauts-aboard-space-station'
const SUITS = 'http://www.nasa.gov/press-release/nasa-expands-options-for-spacewalking-moonwalking-suits-services'

const ROUTES: Record<string, Handler> = {
  [SAMPLE]: { body: fixture('rss2.xml'), headers: { 'content-type': 'text/xml' } },
  [ATOM]: { body: fixture('atom.xml'), headers: { 'content-type': 'application/atom+xml; charset=utf-8' } },
  [MISSING]: { status: 404 }
}

function harnessFor(routes: Record<string, Handler> = {}, config: Record<string, string> = {}, now = NOW) {
  const server = serve({ ...ROUTES, ...routes })
  const harness = createConnectorHarness(connector, {
    config,
    fetchImpl: server.fetchImpl,
    now: () => now,
    sleep: async () => {}
  })
  return { ...server, harness }
}

describe('the manifest', () => {
  it('needs no sign-in and describes every setting and input', () => {
    expect(connector.auth).toEqual({ rung: 'none' })
    expect(connector.config.map((field) => [field.key, field.env, field.secret ?? false])).toEqual([
      ['feeds', 'RSS_FEEDS', false],
      ['lookbackHours', 'RSS_LOOKBACK_HOURS', false],
      ['userAgent', 'RSS_USER_AGENT', false]
    ])
    expect(connector.icon?.paths).toHaveLength(3)
    for (const action of connector.actions) {
      expect(action.idempotent).toBe(true)
      expect(action.sample).toBeDefined()
      for (const input of action.inputs ?? []) expect(input.description).toBeTruthy()
    }
    expect(DEFAULT_USER_AGENT).toMatch(/^vorn-connector-rss\/\d+\.\d+\.\d+.* \(\+https:\/\/vorn\.run\)$/)
  })

  it('passes the mock conformance run, every action surviving a {} reply', async () => {
    const run = await runConformance(connector, { mock: true, now: () => NOW })
    expect(run.findings.map((finding) => finding.code)).toEqual(['sample-unusable'])
    expect(run.receipt?.checks).toEqual(['manifest', 'auth', 'secrets', 'actions', 'mock'])
  })
})

describe('readFeed', () => {
  it('reads a feed newest first with the feed Accept and User-Agent', async () => {
    const { harness, calls } = harnessFor()
    const out = await harness.execute('readFeed', { url: SAMPLE })
    expect(out.feed).toEqual({ title: 'NASA Space Station News', url: SAMPLE, siteUrl: 'http://www.nasa.gov/', format: 'rss2' })
    expect(out.count).toBe(7)
    const items = out.items as FeedItem[]
    expect(items[0]!.id).toBe('tag:rssboard.org,2006:weblog.221')
    expect(items.at(-1)!.publishedAt).toBe('2003-05-20T08:56:02.000Z')
    expect(calls[0]!.headers.get('accept')).toBe(FEED_ACCEPT)
    expect(calls[0]!.headers.get('user-agent')).toBe(DEFAULT_USER_AGENT)
  })

  it('keeps items within sinceHours and cuts to limit', async () => {
    const { harness } = harnessFor({}, { userAgent: 'my-reader/1.0' }, '2023-08-03T00:00:00.000Z')
    const out = await harness.execute('readFeed', { url: SAMPLE, limit: '3', sinceHours: String(24 * 14) })
    expect((out.items as FeedItem[]).map((item) => item.publishedAt)).toEqual([
      '2023-08-02T03:25:57.000Z',
      '2023-07-22T10:30:00.000Z',
      '2023-07-21T13:04:00.000Z'
    ])
  })

  it('sends the configured User-Agent', async () => {
    const { harness, calls } = harnessFor({}, { userAgent: 'my-reader/1.0' })
    await harness.execute('readFeed', { url: ATOM })
    expect(calls[0]!.headers.get('user-agent')).toBe('my-reader/1.0')
  })

  it('checks limit and sinceHours before fetching', async () => {
    const { harness, calls } = harnessFor()
    await expect(harness.execute('readFeed', { url: SAMPLE, limit: '0' })).rejects.toThrow(
      'limit must be a whole number from 1 to 100'
    )
    await expect(harness.execute('readFeed', { url: SAMPLE, limit: '2.5' })).rejects.toThrow('limit must be a whole number')
    await expect(harness.execute('readFeed', { url: SAMPLE, sinceHours: '-1' })).rejects.toThrow(
      'sinceHours must be a number of hours above 0'
    )
    expect(calls).toEqual([])
  })

  it('names the address and the reason when a feed cannot be read', async () => {
    const { harness, calls } = harnessFor({ 'https://x.example/page': { body: fixture('page.html') } })
    await expect(harness.execute('readFeed', { url: MISSING })).rejects.toThrow(`${MISSING}: HTTP 404`)
    await expect(harness.execute('readFeed', { url: 'https://x.example/page' })).rejects.toThrow(
      'https://x.example/page: not a feed (the body starts with "<!DOCTYPE"); try find feeds'
    )
    const before = calls.length
    await expect(harness.execute('readFeed', { url: 'file:///etc/passwd' })).rejects.toThrow(
      'file:///etc/passwd: refused, only http and https feeds are read'
    )
    expect(calls).toHaveLength(before)
  })

  it('requests nothing but the feed when its DOCTYPE declares external entities', async () => {
    const url = 'https://doctype.example/feed'
    const { harness, calls } = harnessFor({ [url]: { body: fixture('doctype.xml') } })
    const out = await harness.execute('readFeed', { url })
    expect(calls.map((call) => call.url)).toEqual([url])
    expect((out.items as FeedItem[])[0]!.title).toBe('Leak &xxe; and &remote;')
  })
})

describe('readFeeds', () => {
  const MIRROR = 'https://mirror.example/feed'
  const mirror = `<rss version="2.0"><channel><title>Mirror</title>
    <item><title>Mirrored newer</title><link>${LOUISIANA}</link><pubDate>Sat, 22 Jul 2023 00:00:00 GMT</pubDate></item>
    <item><title>Mirrored older</title><link>${SUITS}</link><pubDate>Sat, 01 Jan 2000 00:00:00 GMT</pubDate></item>
    <item><guid isPermaLink="false">no-address</guid><title>No address</title></item>
  </channel></rss>`

  it('merges feeds newest first, one copy per address, the newest copy kept', async () => {
    const { harness } = harnessFor({ [MIRROR]: { body: mirror } })
    const out = await harness.execute('readFeeds', { urls: `${SAMPLE}\n${ATOM}, ${MIRROR}` })
    const items = out.items as FeedItem[]
    expect(out).toMatchObject({ count: 11, feedsOk: 3, feedsFailed: [] })
    expect(items[0]!.id).toBe('tag:github.com,2008:Repository/27193779/v26.8.2')
    expect(items.at(-1)!.id).toBe('no-address')
    expect(items.find((entry) => entry.url === LOUISIANA)!.feedTitle).toBe('Mirror')
    expect(items.find((entry) => entry.url === SUITS)!.feedTitle).toBe('NASA Space Station News')
  })

  it("reads the connection's feeds when given none, keeping items whose title or summary has a keyword", async () => {
    const { harness } = harnessFor({}, { feeds: SAMPLE })
    const out = await harness.execute('readFeeds', { keywords: 'DRAGON, laundry facilities' })
    expect((out.items as FeedItem[]).map((entry) => entry.title)).toEqual([
      'NASA Plans Coverage of Roscosmos Spacewalk Outside Space Station',
      'NASA to Provide Coverage as Dragon Departs Station'
    ])
    expect((await harness.execute('readFeeds', { keywords: 'walk' })).count).toBe(0)
  })

  it('keeps the newest perFeed of each feed and those within sinceHours', async () => {
    const { harness } = harnessFor()
    const capped = await harness.execute('readFeeds', { urls: `${SAMPLE}\n${ATOM}`, perFeed: '2' })
    expect((capped.items as FeedItem[]).map((entry) => entry.publishedAt)).toEqual([
      '2026-09-09T16:07:48.000Z',
      '2026-09-08T21:51:09.000Z',
      '2023-08-02T03:25:57.000Z',
      '2023-07-22T10:30:00.000Z'
    ])
    expect((await harness.execute('readFeeds', { urls: `${SAMPLE}\n${ATOM}`, sinceHours: '72' })).count).toBe(1)
  })

  it('lists failed feeds, and fails naming each when fewer than minFeedsOk answer', async () => {
    const { harness } = harnessFor()
    await expect(harness.execute('readFeeds', { urls: `${SAMPLE}\n${MISSING}`, minFeedsOk: '2' })).rejects.toThrow(
      `1 of 2 feeds answered, fewer than minFeedsOk 2: ${MISSING}: HTTP 404`
    )
    await expect(harness.execute('readFeeds', { urls: MISSING })).rejects.toThrow(
      `0 of 1 feeds answered, fewer than minFeedsOk 1: ${MISSING}: HTTP 404`
    )
    const out = await harness.execute('readFeeds', { urls: `${MISSING}\nftp://x.example/feed`, minFeedsOk: '0' })
    expect(out).toEqual({
      items: [],
      count: 0,
      feedsOk: 0,
      feedsFailed: [
        { url: 'ftp://x.example/feed', error: 'refused, only http and https feeds are read' },
        { url: MISSING, error: 'HTTP 404' }
      ]
    })
  })

  it('asks for feeds when there are none, and checks its numbers', async () => {
    const { harness } = harnessFor()
    await expect(harness.execute('readFeeds', {})).rejects.toThrow(
      "Give feed URLs in urls, or add them to the connection's feeds"
    )
    await expect(harness.execute('readFeeds', { urls: SAMPLE, perFeed: '101' })).rejects.toThrow(
      'perFeed must be a whole number from 1 to 100'
    )
    await expect(harness.execute('readFeeds', { urls: SAMPLE, minFeedsOk: '-1' })).rejects.toThrow(
      'minFeedsOk must be a whole number from 0 up'
    )
  })
})

describe('keywords and duplicates', () => {
  const entry = (title: string, summary = '') => ({ title, summary }) as FeedItem

  it('match whole words and phrases ignoring case, escaping what a pattern would read', () => {
    expect(keywordFilter('c++')(entry('Why C++ matters'))).toBe(true)
    expect(keywordFilter('AI')(entry('New AI agents'))).toBe(true)
    expect(keywordFilter('AI')(entry('He said so', 'Maintained'))).toBe(false)
    expect(keywordFilter('café')(entry('', 'Le Café ouvre'))).toBe(true)
    expect(keywordFilter(' , ')(entry('anything'))).toBe(true)
    expect(keywordFilter(undefined)(entry('anything'))).toBe(true)
  })

  it('key an item with no address by its feed and id', () => {
    const a = { id: '1', url: '', feedUrl: 'https://a.example/', publishedAt: '', updatedAt: '' } as FeedItem
    const b = { ...a, feedUrl: 'https://b.example/' }
    expect(dedupeByUrl([a, b, a])).toEqual([a, b])
  })
})

describe('findFeeds', () => {
  it('lists the feeds a page declares, asking for HTML first', async () => {
    const { harness, calls } = harnessFor({ 'https://blog.example/': { body: fixture('page.html') } })
    const out = await harness.execute('findFeeds', { url: 'blog.example' })
    expect(out).toMatchObject({ count: 3, isFeed: false })
    expect((out.feeds as Array<{ url: string }>).map((feed) => feed.url)).toEqual([
      'https://blog.example/base/feed.xml',
      'https://blog.example/atom.xml',
      'https://blog.example/base/feed.json'
    ])
    expect(calls[0]!.headers.get('accept')).toBe(PAGE_ACCEPT)
  })

  it('resolves links against the page it was redirected to', async () => {
    const page = '<link rel="alternate" type="application/rss+xml" href="feed.xml">'
    const { harness } = harnessFor({ 'https://old.example/': { body: page, url: 'https://moved.example/blog/' } })
    expect(await harness.execute('findFeeds', { url: 'https://old.example/' })).toEqual({
      feeds: [{ url: 'https://moved.example/blog/feed.xml', title: '', type: 'application/rss+xml', format: 'rss2' }],
      count: 1,
      isFeed: false
    })
  })

  it('returns the address itself when it already is a feed', async () => {
    const JSON_FEED = 'https://www.jsonfeed.org/feed.json'
    const { harness } = harnessFor({ [JSON_FEED]: { body: fixture('feed.json') } })
    expect(await harness.execute('findFeeds', { url: ATOM })).toEqual({
      feeds: [{ url: ATOM, title: 'Release notes from node', type: 'application/atom+xml', format: 'atom' }],
      count: 1,
      isFeed: true
    })
    expect(await harness.execute('findFeeds', { url: JSON_FEED })).toMatchObject({ isFeed: true, count: 1 })
  })

  it('finds nothing in JSON that is not a feed or text that is neither page nor feed', async () => {
    const { harness } = harnessFor({
      'https://api.example/': { body: '{"ok":true}' },
      'https://txt.example/': { body: 'plain words' }
    })
    expect(await harness.execute('findFeeds', { url: 'https://api.example/' })).toEqual({ feeds: [], count: 0, isFeed: false })
    expect(await harness.execute('findFeeds', { url: 'https://txt.example/' })).toEqual({ feeds: [], count: 0, isFeed: false })
  })

  it('names the address when the page cannot be read', async () => {
    await expect(harnessFor().harness.execute('findFeeds', { url: MISSING })).rejects.toThrow(`${MISSING}: HTTP 404`)
  })
})
