import { createHash } from 'node:crypto'
import type { ConnectorItem, PollContext, PollOutcome } from '@vornrun/connector-sdk'
import { itemTime, type FeedItem } from './feed'
import { FeedError, MAX_IN_FLIGHT, feedList, fetchIfChanged, mapLimit, parseFetched, uniqueFeeds } from './http'
import { lookbackHours, userAgentOf } from './settings'

/** Ids remembered per feed; arXiv alone stamps hundreds of items with one date. */
export const SEEN_CAP = 1000
const HOUR_MS = 3_600_000

/** What the cursor keeps for one feed. */
export interface FeedState {
  /** The newest date seen, publishedAt else updatedAt. */
  t: string
  etag?: string
  lm?: string
  /** Hashed ids of the items at `t` and of every dateless item still in the feed. */
  seen: string[]
}

export function seenKey(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 12)
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/** Per-feed state from a cursor; anything unreadable starts afresh. */
export function readCursor(raw: string | undefined): Map<string, FeedState> {
  const states = new Map<string, FeedState>()
  let parsed: { v?: unknown; feeds?: Record<string, Record<string, unknown>> }
  try {
    parsed = JSON.parse(raw ?? '')
  } catch {
    return states
  }
  if (parsed?.v !== 1 || typeof parsed.feeds !== 'object' || parsed.feeds === null) return states
  for (const [url, state] of Object.entries(parsed.feeds)) {
    if (typeof state !== 'object' || state === null) continue
    states.set(url, {
      t: typeof state.t === 'string' ? state.t : '',
      ...(typeof state.etag === 'string' && { etag: state.etag }),
      ...(typeof state.lm === 'string' && { lm: state.lm }),
      seen: strings(state.seen)
    })
  }
  return states
}

export function writeCursor(states: Map<string, FeedState>): string {
  return JSON.stringify({ v: 1, feeds: Object.fromEntries(states) })
}

/**
 * The items of one feed worth firing, and the state to keep. A feed seen for
 * the first time fires only dated items from `floorMs` on; after that an item
 * fires when it is newer than the newest date seen, or on that date with an
 * id not yet seen, and a dateless item fires once.
 */
export function selectNew(
  items: FeedItem[],
  previous: FeedState | undefined,
  floorMs: number
): { fire: FeedItem[]; state: FeedState } {
  const seen = new Set(previous?.seen)
  const t = previous?.t ?? ''
  const fired = new Set<string>()
  const fire: FeedItem[] = []
  let newest = t
  for (const item of items) {
    const at = itemTime(item)
    const key = seenKey(item.id)
    if (at > newest) newest = at
    const fresh =
      previous === undefined
        ? at !== '' && Date.parse(at) >= floorMs
        : at === ''
          ? !seen.has(key)
          : at > t || (at === t && !seen.has(key))
    if (fresh && !fired.has(key)) {
      fired.add(key)
      fire.push(item)
    }
  }
  const keys = items
    .filter((item) => {
      const at = itemTime(item)
      return at === '' || at === newest
    })
    .map((item) => seenKey(item.id))
  const carried = newest === t ? (previous?.seen ?? []) : []
  return { fire, state: { t: newest, seen: [...new Set([...keys, ...carried])].slice(0, SEEN_CAP) } }
}

/** Oldest first, dateless last. */
function oldestFirst(items: FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => {
    const at = itemTime(a)
    const bt = itemTime(b)
    if (at === bt) return 0
    if (at === '') return 1
    if (bt === '') return -1
    return at < bt ? -1 : 1
  })
}

export function toConnectorItem(item: FeedItem): ConnectorItem {
  const at = itemTime(item)
  return {
    externalId: `${item.feedUrl} ${item.id}`,
    title: item.title || item.url || 'Untitled item',
    ...(item.url && { url: item.url }),
    ...(item.summary && { description: item.summary }),
    ...(item.author && { assignee: item.author }),
    labels: item.categories,
    ...(at && { updatedAt: at }),
    data: { ...item }
  }
}

type Polled = { url: string; state?: FeedState; fire: FeedItem[]; failure?: FeedError }

/** One poll of every configured feed, six at a time, each conditional on what the cursor holds for it. */
export async function pollFeeds(ctx: PollContext): Promise<PollOutcome> {
  const raws = feedList(ctx.config.feeds)
  if (raws.length === 0) throw new Error("Add feed URLs to the connection's feeds")
  const hours = lookbackHours(ctx.config)
  const userAgent = userAgentOf(ctx.config)
  const previous = readCursor(ctx.cursor)
  const sinceMs = ctx.since === undefined ? NaN : Date.parse(ctx.since)
  const floorMs = Number.isNaN(sinceMs) ? Date.parse(ctx.now()) - hours * HOUR_MS : sinceMs
  const { urls, invalid } = uniqueFeeds(raws)

  const polled = await mapLimit(urls, MAX_IN_FLIGHT, async (url): Promise<Polled> => {
    const before = previous.get(url)
    try {
      const got = await fetchIfChanged(ctx.fetch, url, { userAgent, etag: before?.etag, lastModified: before?.lm })
      if (got === undefined) return { url, state: before, fire: [] }
      const { fire, state } = selectNew(parseFetched(url, got).items, before, floorMs)
      return {
        url,
        state: { ...state, ...(got.etag && { etag: got.etag }), ...(got.lastModified && { lm: got.lastModified }) },
        fire
      }
    } catch (error) {
      return { url, state: before, fire: [], failure: error as FeedError }
    }
  })

  const failures = [...invalid, ...polled.flatMap((result) => (result.failure ? [result.failure] : []))]
  for (const failure of failures) process.stderr.write(`rss: ${failure.url}: ${failure.reason}\n`)
  if (failures.length === urls.length + invalid.length) {
    throw new Error(`Every feed failed: ${failures.map((failure) => failure.message).join('; ')}`)
  }
  const next = new Map<string, FeedState>()
  for (const result of polled) if (result.state) next.set(result.url, result.state)
  return {
    items: oldestFirst(polled.flatMap((result) => result.fire)).map(toConnectorItem),
    nextCursor: writeCursor(next),
    hasMore: false
  }
}
