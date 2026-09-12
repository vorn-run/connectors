import { createHash } from 'node:crypto'
import { parseDate } from './dates'
import { cut, escapeHtml, inlineText, oneLine, plainText, tidy } from './text'
import { NS, attr, child, elements, innerXml, isElement, parseXml, resolveUrl, textOf, type XmlElement } from './xml'

export type FeedFormat = 'rss2' | 'rss1' | 'atom' | 'json'

interface ItemFields {
  id: string
  title: string
  url: string
  author: string
  /** ISO 8601 in UTC, or "" when the feed gives none. */
  publishedAt: string
  updatedAt: string
  /** Plain text, at most 2000 characters. */
  summary: string
  html: string
  categories: string[]
  feedTitle: string
  feedUrl: string
}

/** One item, whichever format it came from. */
export interface FeedItem extends ItemFields, Record<string, unknown> {}

export interface FeedInfo extends Record<string, unknown> {
  title: string
  /** Where the feed was read from, after redirects. */
  url: string
  siteUrl: string
  format: FeedFormat
}

export interface ParsedFeed {
  feed: FeedInfo
  items: FeedItem[]
}

export interface FeedSource {
  /** The address as configured, which every item carries. */
  feedUrl: string
  /** The address after redirects, which relative links resolve against. */
  finalUrl: string
}

type Draft = Omit<ItemFields, 'feedTitle' | 'feedUrl'>

/** A stable id for an item that has no id and no link. */
export function hashId(title: string, publishedAt: string): string {
  return `sha256:${createHash('sha256').update(`${title}\n${publishedAt}`).digest('hex').slice(0, 16)}`
}

/** The name in `lawyer@boyer.net (Lawyer Boyer)`, else the value as written. */
export function authorName(value: string): string {
  const text = inlineText(value)
  return /^\S+@\S+\s*\((.+)\)$/.exec(text)?.[1]?.trim() ?? text
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(oneLine).filter((value) => value !== ''))]
}

function finish(draft: Draft, feedTitle: string, feedUrl: string): FeedItem {
  return {
    ...draft,
    id: draft.id || draft.url || hashId(draft.title, draft.publishedAt),
    summary: cut(draft.summary),
    categories: unique(draft.categories),
    feedTitle,
    feedUrl
  }
}

function texts(el: XmlElement, local: string, ns: string): string[] {
  return elements(el, local, ns).map(textOf)
}

/** An Atom `link rel="alternate"` (no rel counts), `text/html` first, resolved. */
function alternate(el: XmlElement, ns: string): string {
  const links = elements(el, 'link', ns).filter((link) => {
    const rel = attr(link, 'rel').trim().toLowerCase() || 'alternate'
    return rel === 'alternate' || rel === 'http://www.iana.org/assignments/relation/alternate'
  })
  const best = links.find((link) => attr(link, 'type').toLowerCase().startsWith('text/html')) ?? links[0]
  return best ? resolveUrl(attr(best, 'href'), best.base) : ''
}

function linkText(el: XmlElement | undefined): string {
  return el ? resolveUrl(oneLine(textOf(el)), el.base) : ''
}

function rssItem(item: XmlElement, core: string): Draft {
  const guid = child(item, 'guid', core)
  const guidText = oneLine(textOf(guid))
  const permalink =
    attr(guid, 'isPermaLink').trim().toLowerCase() !== 'false' && /^https?:\/\//i.test(guidText)
      ? resolveUrl(guidText, guid!.base)
      : ''
  const description = textOf(child(item, 'description', core))
  const group = child(item, 'group', NS.media)
  const media = textOf(child(item, 'description', NS.media) ?? child(group, 'description', NS.media))
  const encoded = textOf(child(item, 'encoded', NS.content))
  return {
    id: guidText,
    title:
      inlineText(textOf(child(item, 'title', core))) ||
      inlineText(textOf(child(item, 'title', NS.media) ?? child(group, 'title', NS.media))),
    url: linkText(child(item, 'link', core)) || permalink || alternate(item, NS.atom),
    author: authorName(textOf(child(item, 'author', core))) || inlineText(textOf(child(item, 'creator', NS.dc))),
    publishedAt: parseDate(textOf(child(item, 'pubDate', core))) || parseDate(textOf(child(item, 'date', NS.dc))),
    updatedAt: parseDate(textOf(child(item, 'updated', NS.atom))),
    summary: plainText(description || media || encoded),
    html: encoded || description,
    categories: [...texts(item, 'category', core), ...texts(item, 'subject', NS.dc)].map(inlineText)
  }
}

function rss2(root: XmlElement, source: FeedSource): ParsedFeed {
  const core = root.ns
  const channel = child(root, 'channel', core)
  const title = inlineText(textOf(child(channel, 'title', core)))
  // RSS 0.9x put items beside the channel rather than inside it.
  const items = [...elements(channel, 'item', core), ...elements(root, 'item', core)]
  return {
    feed: {
      title,
      url: source.finalUrl,
      siteUrl: linkText(child(channel, 'link', core)) || (channel ? alternate(channel, NS.atom) : ''),
      format: 'rss2'
    },
    items: items.filter((item) => !item.truncated).map((item) => finish(rssItem(item, core), title, source.feedUrl))
  }
}

function rss1(root: XmlElement, source: FeedSource): ParsedFeed {
  const channel = root.children.find((node): node is XmlElement => isElement(node) && node.local === 'channel')
  const core = channel?.ns ?? NS.rss1
  const title = inlineText(textOf(child(channel, 'title', core)))
  const items = elements(root, 'item', core).filter((item) => !item.truncated)
  return {
    feed: { title, url: source.finalUrl, siteUrl: linkText(child(channel, 'link', core)), format: 'rss1' },
    items: items.map((item) => {
      const description = textOf(child(item, 'description', core) ?? child(item, 'description', NS.dc))
      const encoded = textOf(child(item, 'encoded', NS.content))
      const draft: Draft = {
        id: attr(item, 'about', NS.rdf).trim(),
        title: inlineText(textOf(child(item, 'title', core))),
        url: linkText(child(item, 'link', core)),
        author: inlineText(textOf(child(item, 'creator', NS.dc))),
        publishedAt: parseDate(textOf(child(item, 'date', NS.dc))),
        updatedAt: '',
        summary: plainText(description || encoded),
        html: encoded || description,
        categories: texts(item, 'subject', NS.dc).map(inlineText)
      }
      return finish(draft, title, source.feedUrl)
    })
  }
}

/** An Atom text construct as text and as HTML, by its `type`. */
function atomText(el: XmlElement | undefined): { text: string; html: string } {
  if (!el || attr(el, 'src') !== '') return { text: '', html: '' }
  const type = attr(el, 'type').trim().toLowerCase() || 'text'
  if (type === 'xhtml' || type === 'application/xhtml+xml') {
    const div = el.children.find(isElement)
    const markup = div ? innerXml(div) : textOf(el)
    return { text: plainText(markup), html: markup }
  }
  const value = textOf(el)
  if (type === 'html' || type === 'text/html') return { text: plainText(value), html: value }
  return { text: tidy(value), html: escapeHtml(value) }
}

function atomAuthors(el: XmlElement | undefined, core: string): string {
  return elements(el, 'author', core)
    .map((author) => oneLine(textOf(child(author, 'name', core))))
    .filter((name) => name !== '')
    .join(', ')
}

function atom(root: XmlElement, source: FeedSource): ParsedFeed {
  const core = root.ns
  const title = atomText(child(root, 'title', core)).text.replace(/\n/g, ' ')
  const feedAuthor = atomAuthors(root, core)
  const entries = elements(root, 'entry', core).filter((entry) => !entry.truncated)
  return {
    feed: { title, url: source.finalUrl, siteUrl: alternate(root, core), format: 'atom' },
    items: entries.map((entry) => {
      const summary = atomText(child(entry, 'summary', core))
      const content = atomText(child(entry, 'content', core))
      const updated = parseDate(textOf(child(entry, 'updated', core)))
      const draft: Draft = {
        id: oneLine(textOf(child(entry, 'id', core))),
        title: atomText(child(entry, 'title', core)).text.replace(/\n/g, ' '),
        url: alternate(entry, core),
        author: atomAuthors(entry, core) || feedAuthor,
        publishedAt: parseDate(textOf(child(entry, 'published', core))) || updated,
        updatedAt: updated,
        summary: summary.text || content.text,
        html: content.html || summary.html,
        categories: elements(entry, 'category', core).map((category) => attr(category, 'term'))
      }
      return finish(draft, title, source.feedUrl)
    })
  }
}

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 1.1's `authors`, else 1.0's singular `author`. */
function jsonAuthors(value: Json): string {
  const list = Array.isArray(value.authors) ? value.authors : [value.author]
  return list
    .filter(isRecord)
    .map((author) => oneLine(str(author.name)))
    .filter((name) => name !== '')
    .join(', ')
}

function jsonFeed(body: string, source: FeedSource): ParsedFeed {
  let data: Json
  try {
    data = JSON.parse(body) as Json
  } catch (error) {
    throw new Error(`unparseable: ${(error as Error).message}`)
  }
  const title = oneLine(str(data.title))
  const feedAuthor = jsonAuthors(data)
  const items = (Array.isArray(data.items) ? data.items : []).filter(isRecord)
  return {
    feed: {
      title,
      url: source.finalUrl,
      siteUrl: resolveUrl(str(data.home_page_url), source.finalUrl),
      format: 'json'
    },
    items: items.map((item) => {
      const html = str(item.content_html)
      const contentText = str(item.content_text)
      const draft: Draft = {
        id: typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id).trim() : '',
        title: oneLine(str(item.title)),
        url: resolveUrl(str(item.url) || str(item.external_url), source.finalUrl),
        author: jsonAuthors(item) || feedAuthor,
        publishedAt: parseDate(str(item.date_published)),
        updatedAt: parseDate(str(item.date_modified)),
        summary: tidy(str(item.summary)) || tidy(contentText) || plainText(html),
        html: html || (contentText && escapeHtml(contentText)),
        categories: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : []
      }
      return finish(draft, title, source.feedUrl)
    })
  }
}

/** Whether a JSON body declares itself a JSON Feed, by a `version` or an `items` list. */
export function isJsonFeed(body: string): boolean {
  try {
    const data: unknown = JSON.parse(body)
    return isRecord(data) && (typeof data.version === 'string' || Array.isArray(data.items))
  } catch {
    return false
  }
}

/** Any of the four formats as one shape; throws the reason when the body is not a feed. */
export function parseFeed(body: string, source: FeedSource): ParsedFeed {
  const text = body.replace(/^﻿/, '').trimStart()
  if (text.startsWith('{')) return jsonFeed(text, source)
  const root = parseXml(text, source.finalUrl)
  if (!root) throw new Error('unparseable: no root element')
  const local = root.local.toLowerCase()
  if (local === 'rss') return rss2(root, source)
  if (local === 'rdf') return rss1(root, source)
  if (local === 'feed') return atom(root, source)
  if (local === 'html') {
    throw new Error(`not a feed (the body starts with "${/^[^\s>]{1,15}/.exec(text)![0]}"); try find feeds`)
  }
  throw new Error(`unparseable: root <${root.name}> is not rss, RDF or feed`)
}

/** When an item happened: published, else updated. */
export function itemTime(item: FeedItem): string {
  return item.publishedAt || item.updatedAt
}

/** Newest first, dateless last, otherwise in feed order. */
export function newestFirst(items: FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => {
    const at = itemTime(a)
    const bt = itemTime(b)
    if (at === bt) return 0
    if (at === '') return 1
    if (bt === '') return -1
    return at < bt ? 1 : -1
  })
}

/** Items dated within the last `hours`; dateless ones are left out. */
export function withinHours(items: FeedItem[], hours: number, nowMs: number): FeedItem[] {
  const floor = nowMs - hours * 3_600_000
  return items.filter((item) => itemTime(item) !== '' && Date.parse(itemTime(item)) >= floor)
}
