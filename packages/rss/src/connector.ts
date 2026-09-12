import { defineConnector } from '@vornrun/connector-sdk'
import { TYPE_OF_FORMAT, discoverFeeds } from './discover'
import { isJsonFeed, itemTime, newestFirst, withinHours, type FeedItem, type ParsedFeed } from './feed'
import {
  FeedError,
  MAX_IN_FLIGHT,
  PAGE_ACCEPT,
  feedAddress,
  feedList,
  fetchBody,
  mapLimit,
  parseFetched,
  readFeedAt,
  uniqueFeeds,
  type Fetched
} from './http'
import { pollFeeds, toConnectorItem } from './poll'
import { DEFAULT_LOOKBACK_HOURS, DEFAULT_USER_AGENT, optionalHours, userAgentOf, wholeNumber } from './settings'
// Bundled at build time: a pack is one file, so a version read from disk is not there to read.
import pkg from '../package.json'

export const MAX_ITEMS = 100
export const DEFAULT_ITEMS = 20

/** An item passes when any keyword matches its title or summary as a whole word or phrase, ignoring case. */
export function keywordFilter(value: unknown): (item: FeedItem) => boolean {
  const words = String(value ?? '')
    .split(',')
    .map((word) => word.trim())
    .filter((word) => word !== '')
  if (words.length === 0) return () => true
  const patterns = words.map(
    (word) => new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu')
  )
  return (item) => patterns.some((pattern) => pattern.test(item.title) || pattern.test(item.summary))
}

/** One copy per address, the newest; an item with no address is keyed by its feed and id. */
export function dedupeByUrl(items: FeedItem[]): FeedItem[] {
  const kept = new Map<string, FeedItem>()
  for (const item of items) {
    const key = item.url || `${item.feedUrl} ${item.id}`
    const held = kept.get(key)
    if (!held || itemTime(item) > itemTime(held)) kept.set(key, item)
  }
  return [...kept.values()]
}

/** The body as a feed when it is one; a JSON body has to say so with a version or an items list. */
function asFeed(url: string, got: Fetched): ParsedFeed | undefined {
  if (got.body.trimStart().startsWith('{') && !isJsonFeed(got.body.trim())) return undefined
  try {
    return parseFetched(url, got)
  } catch {
    return undefined
  }
}

const SAMPLE_ITEM: FeedItem = {
  id: 'tag:rssboard.org,2006:weblog.221',
  title: 'How to Read an RSS Feed with Java Using XOM',
  url: 'https://www.rssboard.org/news/221/read-rss-feed-java-using-xom',
  author: 'Rogers Cadenhead',
  publishedAt: '2023-08-02T03:25:57.000Z',
  updatedAt: '',
  summary:
    'There are a lot of libraries for processing XML data with Java that can be used to read RSS feeds. One of the best is the open source library XOM created by the computer book author Elliotte Rusty Harold.',
  html: '<p>There are a lot of libraries for processing XML data with Java that can be used to read RSS feeds.</p>',
  categories: ['announcements,'],
  feedTitle: 'RSS Advisory Board',
  feedUrl: 'http://feeds.rssboard.org/rssboard'
}

const SINCE_HOURS_INPUT = {
  key: 'sinceHours',
  label: 'Within hours',
  type: 'number' as const,
  description: 'Only items published within this many hours; items with no date are left out when set.',
  builderHint: 'Match it to how often the workflow runs, such as 24 for a daily digest.'
}

const ITEM_OUTPUT = {
  key: 'items',
  description:
    'Items as { id, title, url, author, publishedAt, updatedAt, summary, html, categories, feedTitle, feedUrl }'
}

export const connector = defineConnector({
  id: 'rss',
  name: 'RSS',
  version: pkg.version,
  description:
    'Trigger workflows from new items in RSS, Atom and JSON Feed feeds, and read feeds or find the feeds a web page declares from a step.',
  icon: {
    viewBox: '0 0 24 24',
    paths: [
      'M5.5 16a2.5 2.5 0 1 1 0 5a2.5 2.5 0 1 1 0-5z',
      'M3 13a8 8 0 0 1 8 8h3A11 11 0 0 0 3 10z',
      'M3 6a15 15 0 0 1 15 15h3A18 18 0 0 0 3 3z'
    ]
  },
  auth: { rung: 'none' },
  config: [
    {
      key: 'feeds',
      label: 'Feeds',
      env: 'RSS_FEEDS',
      description:
        'Feed addresses, one per line or comma separated. The new-item trigger polls them, and Read feeds uses them when it is given none.',
      builderHint:
        "RSS, Atom or JSON Feed addresses rather than the site's page; Find feeds turns a page into its feed addresses. https:// is assumed when there is no scheme."
    },
    {
      key: 'lookbackHours',
      label: 'First poll looks back (hours)',
      env: 'RSS_LOOKBACK_HOURS',
      default: String(DEFAULT_LOOKBACK_HOURS),
      description:
        'How far back the first poll of a feed reaches, a whole number of hours from 1 to 8760, so a new connection does not fire for the whole backlog.',
      builderHint: 'Only the first poll of each feed reads it; later polls fire on whatever is newer than the last one.'
    },
    {
      key: 'userAgent',
      label: 'User-Agent',
      env: 'RSS_USER_AGENT',
      default: DEFAULT_USER_AGENT,
      description: 'Sent with every request; some hosts refuse requests without one.',
      builderHint: 'Leave the default unless a host asks for a contact address in it.'
    }
  ],
  triggers: [
    {
      type: 'newItem',
      label: 'New item',
      description:
        "An item appears in any of the connection's feeds. The first poll of a feed fires only for items inside the look-back, an item with no date fires once, and an item dated before the newest one already seen never fires.",
      poll: pollFeeds,
      sample: [toConnectorItem(SAMPLE_ITEM)]
    }
  ],
  actions: [
    {
      type: 'readFeed',
      label: 'Read a feed',
      description: `The newest items of one RSS, Atom or JSON Feed feed, up to ${MAX_ITEMS}, newest first with dateless items last.`,
      idempotent: true,
      inputs: [
        {
          key: 'url',
          label: 'Feed URL',
          required: true,
          description: "The feed's address; https:// is assumed when there is no scheme.",
          builderHint: 'A feed, not a web page; run Find feeds on a page to get its feed.'
        },
        {
          key: 'limit',
          label: 'Items',
          type: 'number',
          description: `How many of the newest items, a whole number from 1 to ${MAX_ITEMS}; ${DEFAULT_ITEMS} when empty.`
        },
        SINCE_HOURS_INPUT
      ],
      outputs: [
        { key: 'feed', description: 'The feed as { title, url, siteUrl, format }, format one of rss2, rss1, atom, json' },
        ITEM_OUTPUT,
        { key: 'count', type: 'number', description: 'How many items came back, in `items`' }
      ],
      sample: { url: 'https://www.rssboard.org/files/sample-rss-2.xml' },
      run: async (args, ctx) => {
        const limit = wholeNumber(args.limit, 'limit', 1, MAX_ITEMS, DEFAULT_ITEMS)
        const hours = optionalHours(args.sinceHours, 'sinceHours')
        const { feed, items } = await readFeedAt(ctx.fetch, String(args.url ?? ''), {
          userAgent: userAgentOf(ctx.config)
        })
        const recent = hours === undefined ? items : withinHours(items, hours, Date.parse(ctx.now()))
        const kept = newestFirst(recent).slice(0, limit)
        return { feed, items: kept, count: kept.length }
      }
    },
    {
      type: 'readFeeds',
      label: 'Read feeds',
      description:
        "Items from several feeds at once, filtered by age and keywords, one copy per address, newest first. A feed that fails is listed with its reason and never loses the others' items.",
      idempotent: true,
      inputs: [
        {
          key: 'urls',
          label: 'Feed URLs',
          description: "Feed addresses, one per line or comma separated; the connection's feeds when empty.",
          builderHint: 'Leave it empty to read the feeds the connection already polls.'
        },
        SINCE_HOURS_INPUT,
        {
          key: 'perFeed',
          label: 'Items per feed',
          type: 'number',
          description: `The newest items kept from each feed, a whole number from 1 to ${MAX_ITEMS}; ${DEFAULT_ITEMS} when empty.`
        },
        {
          key: 'keywords',
          label: 'Keywords',
          description:
            'Comma separated; an item passes when any one matches its title or summary as a whole word or phrase, ignoring case. Empty keeps everything.',
          builderHint: 'Whole words only: "AI" matches "AI agents" but not "said".'
        },
        {
          key: 'minFeedsOk',
          label: 'Feeds that must answer',
          type: 'number',
          description: 'The action fails, naming every failed feed, when fewer feeds than this answer; 1 when empty.',
          builderHint: 'Set it to the number of feeds when every one of them has to be read.'
        }
      ],
      outputs: [
        ITEM_OUTPUT,
        { key: 'count', type: 'number', description: 'How many items came back, in `items`' },
        { key: 'feedsOk', type: 'number', description: 'How many feeds answered' },
        { key: 'feedsFailed', description: 'The feeds that did not answer, as [{ url, error }]' }
      ],
      sample: {
        urls: 'https://www.rssboard.org/files/sample-rss-2.xml\nhttps://github.com/nodejs/node/releases.atom'
      },
      run: async (args, ctx) => {
        const perFeed = wholeNumber(args.perFeed, 'perFeed', 1, MAX_ITEMS, DEFAULT_ITEMS)
        const minFeedsOk = wholeNumber(args.minFeedsOk, 'minFeedsOk', 0, Infinity, 1)
        const hours = optionalHours(args.sinceHours, 'sinceHours')
        const matches = keywordFilter(args.keywords)
        const given = feedList(args.urls)
        const raws = given.length > 0 ? given : feedList(ctx.config.feeds)
        if (raws.length === 0) throw new Error("Give feed URLs in urls, or add them to the connection's feeds")
        const userAgent = userAgentOf(ctx.config)
        const nowMs = Date.parse(ctx.now())
        const { urls, invalid } = uniqueFeeds(raws)
        const read = await mapLimit(urls, MAX_IN_FLIGHT, async (url) => {
          try {
            return { items: (await readFeedAt(ctx.fetch, url, { userAgent })).items }
          } catch (error) {
            return { failure: error as FeedError }
          }
        })
        const failures = [...invalid, ...read.flatMap((result) => (result.failure ? [result.failure] : []))]
        const feedsFailed = failures.map((failure) => ({ url: failure.url, error: failure.reason }))
        const total = urls.length + invalid.length
        const feedsOk = total - failures.length
        if (feedsOk < minFeedsOk) {
          throw new Error(
            `${feedsOk} of ${total} feeds answered, fewer than minFeedsOk ${minFeedsOk}: ${failures.map((f) => f.message).join('; ')}`
          )
        }
        const picked = read.flatMap(({ items = [] }) => {
          const recent = hours === undefined ? items : withinHours(items, hours, nowMs)
          return newestFirst(recent.filter(matches)).slice(0, perFeed)
        })
        const items = newestFirst(dedupeByUrl(picked))
        return { items, count: items.length, feedsOk, feedsFailed }
      }
    },
    {
      type: 'findFeeds',
      label: 'Find feeds',
      description:
        'The RSS, Atom and JSON Feed feeds a web page declares in its link rel="alternate" tags, as absolute addresses with their titles; the address itself when it already is a feed.',
      idempotent: true,
      inputs: [
        {
          key: 'url',
          label: 'Page URL',
          required: true,
          description: "A web page's address, or a feed's; https:// is assumed when there is no scheme.",
          builderHint: "A site's home page usually declares its feeds; a page that declares none returns an empty list."
        }
      ],
      outputs: [
        { key: 'feeds', description: 'The feeds found, as [{ url, title, type, format }]' },
        { key: 'count', type: 'number', description: 'How many feeds were found' },
        { key: 'isFeed', type: 'boolean', description: 'Whether the address given is itself a feed' }
      ],
      sample: { url: 'https://www.rssboard.org/' },
      run: async (args, ctx) => {
        const url = feedAddress(String(args.url ?? ''))
        const got = await fetchBody(ctx.fetch, url, { userAgent: userAgentOf(ctx.config), accept: PAGE_ACCEPT })
        const parsed = asFeed(url, got)
        if (parsed) {
          const { title, format } = parsed.feed
          return { feeds: [{ url, title, type: TYPE_OF_FORMAT[format], format }], count: 1, isFeed: true }
        }
        const feeds = discoverFeeds(got.body, got.url)
        return { feeds, count: feeds.length, isFeed: false }
      }
    }
  ]
})
