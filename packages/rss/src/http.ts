import { parseFeed, type ParsedFeed } from './feed'

export const FEED_ACCEPT =
  'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5'
export const PAGE_ACCEPT = `text/html, application/xhtml+xml, ${FEED_ACCEPT}`
export const TIMEOUT_MS = 20_000
export const MAX_BYTES = 5 * 1024 * 1024
export const MAX_IN_FLIGHT = 6

/** A feed that could not be read, and why. */
export class FeedError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string
  ) {
    super(`${url}: ${reason}`)
    this.name = 'FeedError'
  }
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const HOST_PORT = /^[^:/?#]+:\d+(?:[/?#]|$)/

/** The address to request: trimmed, `https://` assumed without a scheme, and only http or https. */
export function feedAddress(raw: string): string {
  const trimmed = raw.trim()
  const withScheme = SCHEME.test(trimmed) && !HOST_PORT.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new FeedError(trimmed, 'not a valid address')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FeedError(trimmed, 'refused, only http and https feeds are read')
  }
  return url.href
}

/** Addresses one per line or comma separated, blanks and repeats dropped. */
export function feedList(value: unknown): string[] {
  const parts = String(value ?? '')
    .split(/[\r\n,]+/)
    .map((part) => part.trim())
  return [...new Set(parts.filter((part) => part !== ''))]
}

/** Addresses to request, repeats dropped, and the ones that cannot be requested as failures. */
export function uniqueFeeds(raws: string[]): { urls: string[]; invalid: FeedError[] } {
  const urls = new Set<string>()
  const invalid: FeedError[] = []
  for (const raw of raws) {
    try {
      urls.add(feedAddress(raw))
    } catch (error) {
      invalid.push(error as FeedError)
    }
  }
  return { urls: [...urls], invalid }
}

export interface FetchOptions {
  userAgent: string
  accept?: string
  timeoutMs?: number
}

export interface Validators {
  /** Sent back as If-None-Match. */
  etag?: string | undefined
  /** Sent back as If-Modified-Since. */
  lastModified?: string | undefined
}

export interface Fetched {
  body: string
  /** The address after redirects. */
  url: string
  etag: string
  lastModified: string
}

function discard(res: Response): void {
  res.body?.cancel().catch(() => undefined)
}

async function readCapped(res: Response, url: string): Promise<Uint8Array> {
  if (Number(res.headers.get('content-length')) > MAX_BYTES) {
    discard(res)
    throw new FeedError(url, 'larger than 5 MB')
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body?.getReader()
  for (;;) {
    const next = await reader?.read()
    if (!next || next.done) break
    total += next.value.byteLength
    if (total > MAX_BYTES) {
      await reader!.cancel().catch(() => undefined)
      throw new FeedError(url, 'larger than 5 MB')
    }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}

/** A byte-order mark, else Content-Type's charset, else the XML declaration's encoding, else UTF-8. */
function charset(bytes: Uint8Array, contentType: string): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  const declared = /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType)?.[1]
  if (declared) return declared
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024))
  return /^\s*<\?xml[^>]*?\bencoding\s*=\s*["']([^"']+)["']/.exec(head)?.[1] ?? 'utf-8'
}

function decoderFor(label: string) {
  try {
    return new TextDecoder(label)
  } catch {
    return new TextDecoder('utf-8')
  }
}

export function decodeBody(bytes: Uint8Array, contentType: string): string {
  return decoderFor(charset(bytes, contentType))
    .decode(bytes)
    .replace(/^﻿/, '')
}

function reasonOf(error: unknown, timeoutMs: number): string {
  if (!(error instanceof Error)) return String(error)
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return `timed out after ${timeoutMs / 1000} s`
  const cause = error.cause instanceof Error ? error.cause.message : ''
  return cause && cause !== error.message ? `${error.message} (${cause})` : error.message
}

/** One GET within the time and size limits; undefined for a 304 to validators the caller sent. */
async function send(
  fetchImpl: typeof fetch,
  url: string,
  options: FetchOptions & Validators
): Promise<Fetched | undefined> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  const conditional = Boolean(options.etag || options.lastModified)
  const headers: Record<string, string> = {
    accept: options.accept ?? FEED_ACCEPT,
    'user-agent': options.userAgent,
    ...(options.etag && { 'if-none-match': options.etag }),
    ...(options.lastModified && { 'if-modified-since': options.lastModified })
  }
  try {
    const res = await fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
    if (res.status === 304 && conditional) {
      discard(res)
      return undefined
    }
    if (!res.ok) {
      discard(res)
      throw new FeedError(url, `HTTP ${res.status}`)
    }
    const bytes = await readCapped(res, url)
    return {
      body: decodeBody(bytes, res.headers.get('content-type') ?? ''),
      url: res.url || url,
      etag: res.headers.get('etag') ?? '',
      lastModified: res.headers.get('last-modified') ?? ''
    }
  } catch (error) {
    if (error instanceof FeedError) throw error
    throw new FeedError(url, reasonOf(error, timeoutMs))
  }
}

/** One unconditional GET; a 304 is a failure like any other status. */
export async function fetchBody(fetchImpl: typeof fetch, url: string, options: FetchOptions): Promise<Fetched> {
  return (await send(fetchImpl, url, options)) as Fetched
}

/** A GET carrying the validators, undefined when the server answers 304 Not Modified. */
export function fetchIfChanged(
  fetchImpl: typeof fetch,
  url: string,
  options: FetchOptions & Validators
): Promise<Fetched | undefined> {
  return send(fetchImpl, url, options)
}

/** A fetched body as a feed, or the reason it is not one against its address. */
export function parseFetched(url: string, got: Fetched): ParsedFeed {
  try {
    return parseFeed(got.body, { feedUrl: url, finalUrl: got.url })
  } catch (error) {
    throw new FeedError(url, (error as Error).message)
  }
}

/** Fetch and parse one feed, unconditionally. */
export async function readFeedAt(fetchImpl: typeof fetch, raw: string, options: FetchOptions): Promise<ParsedFeed> {
  const url = feedAddress(raw)
  return parseFetched(url, await fetchBody(fetchImpl, url, options))
}

/** `fn` over every value with at most `limit` running at once, results in input order. */
export async function mapLimit<T, R>(values: T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  const worker = async () => {
    while (next < values.length) {
      const index = next++
      results[index] = await fn(values[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker))
  return results
}
