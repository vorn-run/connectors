import type { FeedFormat } from './feed'
import { decodeEntities } from './text'
import { resolveUrl } from './xml'

export interface DiscoveredFeed extends Record<string, unknown> {
  url: string
  title: string
  type: string
  format: FeedFormat
}

/** Autodiscovery types and the format each one names; RSS 1.0 and 2.0 share one. */
export const FEED_TYPES: Record<string, FeedFormat> = {
  'application/rss+xml': 'rss2',
  'application/atom+xml': 'atom',
  'application/feed+json': 'json',
  'application/json': 'json'
}

export const TYPE_OF_FORMAT: Record<FeedFormat, string> = {
  rss2: 'application/rss+xml',
  rss1: 'application/rss+xml',
  atom: 'application/atom+xml',
  json: 'application/feed+json'
}

const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

function attributesOf(tag: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const m of tag.matchAll(ATTRIBUTE)) {
    const name = m[1]!.toLowerCase()
    if (!found.has(name)) found.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? '').trim())
  }
  return found
}

/** The feeds a page's `<link rel="alternate">` tags declare, absolute and in document order; plain JSON only without a feed+json link. */
export function discoverFeeds(html: string, pageUrl: string): DiscoveredFeed[] {
  const page = html.replace(/<!--[\s\S]*?-->/g, '')
  const baseHref = attributesOf(/<base\b([^>]*)>/i.exec(page)?.[1] ?? '').get('href') ?? ''
  const base = resolveUrl(baseHref, pageUrl) || pageUrl
  const links: DiscoveredFeed[] = []
  for (const m of page.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = attributesOf(m[1]!)
    const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/)
    const type = (attrs.get('type') ?? '').split(';')[0]!.trim().toLowerCase()
    const href = attrs.get('href') ?? ''
    const format = FEED_TYPES[type]
    if (!rel.includes('alternate') || format === undefined || href === '') continue
    links.push({ url: resolveUrl(href, base), title: attrs.get('title') ?? '', type, format })
  }
  const preferred = links.some((link) => link.type === 'application/feed+json')
  const seen = new Set<string>()
  return links.filter((link) => {
    if (preferred && link.type === 'application/json') return false
    if (seen.has(link.url)) return false
    seen.add(link.url)
    return true
  })
}
