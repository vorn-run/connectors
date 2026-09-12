import { describe, expect, it } from 'vitest'
import { fixture, serve } from '../fixtures/serve'
import {
  FEED_ACCEPT,
  FeedError,
  MAX_BYTES,
  TIMEOUT_MS,
  decodeBody,
  feedAddress,
  feedList,
  fetchBody,
  fetchIfChanged,
  mapLimit,
  parseFetched,
  readFeedAt,
  uniqueFeeds
} from './http'

function failure(run: () => unknown): FeedError {
  try {
    run()
  } catch (error) {
    return error as FeedError
  }
  throw new Error('did not throw')
}

const reply = (body: ConstructorParameters<typeof Response>[0], init?: ResponseInit) =>
  (async () => new Response(body, init)) as typeof fetch

describe('addresses', () => {
  it('assumes https without a scheme and keeps a port', () => {
    expect(feedAddress('example.com/feed.xml')).toBe('https://example.com/feed.xml')
    expect(feedAddress(' http://x.example/a ')).toBe('http://x.example/a')
    expect(feedAddress('localhost:8080/feed')).toBe('https://localhost:8080/feed')
    expect(feedAddress('check')).toBe('https://check/')
  })

  it('refuses every scheme but http and https before a request is made', () => {
    for (const raw of ['file:///etc/passwd', 'javascript:alert(1)', 'feed://x.example/rss']) {
      expect(failure(() => feedAddress(raw))).toMatchObject({
        url: raw,
        reason: 'refused, only http and https feeds are read',
        message: `${raw}: refused, only http and https feeds are read`
      })
    }
    expect(failure(() => feedAddress('http://[bad')).reason).toBe('not a valid address')
  })

  it('splits a list on lines and commas, dropping blanks and repeats', () => {
    expect(feedList('a\nb, c\r\n\n a ,')).toEqual(['a', 'b', 'c'])
    expect(feedList(undefined)).toEqual([])
    const { urls, invalid } = uniqueFeeds(['example.com/a', 'https://example.com/a', 'ftp://x.example/'])
    expect(urls).toEqual(['https://example.com/a'])
    expect(invalid.map((error) => error.url)).toEqual(['ftp://x.example/'])
  })
})

describe('fetching', () => {
  it('asks for feeds with the User-Agent, following redirects within the timeout', async () => {
    const { fetchImpl, calls } = serve({
      'https://f.example/feed': {
        body: '<rss/>',
        url: 'https://moved.example/feed',
        headers: { etag: 'W/"1"', 'last-modified': 'Sat, 12 Sep 2026 10:00:00 GMT' }
      }
    })
    const seen: RequestInit[] = []
    const spy = ((url: string, init: RequestInit) => {
      seen.push(init)
      return fetchImpl(url, init)
    }) as typeof fetch
    expect(await fetchBody(spy, 'https://f.example/feed', { userAgent: 'ua' })).toEqual({
      body: '<rss/>',
      url: 'https://moved.example/feed',
      etag: 'W/"1"',
      lastModified: 'Sat, 12 Sep 2026 10:00:00 GMT'
    })
    expect(calls[0]!.headers.get('accept')).toBe(FEED_ACCEPT)
    expect(calls[0]!.headers.get('user-agent')).toBe('ua')
    expect(calls[0]!.headers.has('if-none-match')).toBe(false)
    expect(seen[0]).toMatchObject({ redirect: 'follow' })
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(TIMEOUT_MS).toBe(20_000)
  })

  it('sends validators back and reads a 304 as nothing changed', async () => {
    const { fetchImpl, calls } = serve({ 'https://f.example/feed': { status: 304 } })
    const options = { userAgent: 'ua', etag: 'W/"1"', lastModified: 'Sat, 12 Sep 2026 10:00:00 GMT' }
    expect(await fetchIfChanged(fetchImpl, 'https://f.example/feed', options)).toBeUndefined()
    expect(calls[0]!.headers.get('if-none-match')).toBe('W/"1"')
    expect(calls[0]!.headers.get('if-modified-since')).toBe('Sat, 12 Sep 2026 10:00:00 GMT')
  })

  it('reads a 304 to an unconditional request, and any other failing status, as a failure', async () => {
    await expect(fetchBody(reply(null, { status: 304 }), 'https://f.example/', { userAgent: 'ua' })).rejects.toMatchObject(
      { url: 'https://f.example/', reason: 'HTTP 304' }
    )
    await expect(fetchBody(reply('no', { status: 500 }), 'https://f.example/', { userAgent: 'ua' })).rejects.toThrow(
      'https://f.example/: HTTP 500'
    )
  })

  it('refuses a body over 5 MB, whether declared up front or found while reading', async () => {
    const declared = reply('small', { headers: { 'content-length': String(MAX_BYTES + 1) } })
    await expect(fetchBody(declared, 'https://f.example/', { userAgent: 'ua' })).rejects.toMatchObject({
      reason: 'larger than 5 MB'
    })
    const chunk = new Uint8Array(3 * 1024 * 1024)
    const streamed = reply(
      new ReadableStream({
        start(controller) {
          controller.enqueue(chunk)
          controller.enqueue(chunk)
          controller.close()
        }
      })
    )
    await expect(fetchBody(streamed, 'https://f.example/', { userAgent: 'ua' })).rejects.toMatchObject({
      reason: 'larger than 5 MB'
    })
  })

  it('reads an empty body as empty', async () => {
    expect((await fetchBody(reply(null), 'https://f.example/', { userAgent: 'ua' })).body).toBe('')
  })

  it('gives up after the timeout', async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
      })) as typeof fetch
    await expect(fetchBody(hang, 'https://slow.example/', { userAgent: 'ua', timeoutMs: 10 })).rejects.toMatchObject({
      reason: 'timed out after 0.01 s'
    })
    const aborted = (async () => {
      throw new DOMException('aborted', 'AbortError')
    }) as typeof fetch
    await expect(fetchBody(aborted, 'https://slow.example/', { userAgent: 'ua' })).rejects.toMatchObject({
      reason: 'timed out after 20 s'
    })
  })

  it("reports a network failure by its message and cause", async () => {
    const offline = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND nowhere.example') })
    }) as typeof fetch
    await expect(fetchBody(offline, 'https://nowhere.example/', { userAgent: 'ua' })).rejects.toMatchObject({
      reason: 'fetch failed (getaddrinfo ENOTFOUND nowhere.example)'
    })
    const plain = (async () => {
      throw new Error('socket hang up')
    }) as typeof fetch
    await expect(fetchBody(plain, 'https://x.example/', { userAgent: 'ua' })).rejects.toMatchObject({
      reason: 'socket hang up'
    })
    const odd = (async () => {
      throw 'boom'
    }) as typeof fetch
    await expect(fetchBody(odd, 'https://x.example/', { userAgent: 'ua' })).rejects.toMatchObject({ reason: 'boom' })
  })
})

describe('charsets', () => {
  it("uses Content-Type's charset, else the XML declaration's encoding, else UTF-8", () => {
    expect(decodeBody(Buffer.from('<r>café</r>', 'latin1'), 'text/xml; charset="ISO-8859-1"')).toBe('<r>café</r>')
    const declared = Buffer.concat([
      Buffer.from('<?xml version="1.0" encoding="windows-1252"?><r>'),
      Buffer.from([0x93, 0x68, 0x69, 0x94]),
      Buffer.from('</r>')
    ])
    expect(decodeBody(declared, 'text/xml')).toBe('<?xml version="1.0" encoding="windows-1252"?><r>“hi”</r>')
    expect(decodeBody(Buffer.from('<r>é</r>'), '')).toBe('<r>é</r>')
    expect(decodeBody(Buffer.from('<r>é</r>'), 'text/xml; charset=x-unknown')).toBe('<r>é</r>')
  })

  it('follows a byte-order mark and drops it', () => {
    expect(decodeBody(Buffer.from('﻿<r>é</r>'), 'text/xml; charset=iso-8859-1')).toBe('<r>é</r>')
    expect(decodeBody(Buffer.from('﻿<r>é</r>', 'utf16le'), '')).toBe('<r>é</r>')
    expect(decodeBody(Buffer.from('﻿<r>é</r>', 'utf16le').swap16(), '')).toBe('<r>é</r>')
  })
})

describe('reading one feed', () => {
  it('fetches the address with https assumed and parses what came back', async () => {
    const { fetchImpl, calls } = serve({ 'https://f.example/feed.json': { body: fixture('feed.json') } })
    const { feed, items } = await readFeedAt(fetchImpl, 'f.example/feed.json', { userAgent: 'ua' })
    expect(calls.map((call) => call.url)).toEqual(['https://f.example/feed.json'])
    expect(feed.format).toBe('json')
    expect(items[0]!.feedUrl).toBe('https://f.example/feed.json')
  })

  it("names the address with the parser's reason", () => {
    expect(
      failure(() => parseFetched('https://f.example/', { body: '', url: 'https://f.example/', etag: '', lastModified: '' }))
    ).toMatchObject({ url: 'https://f.example/', reason: 'unparseable: no root element' })
  })
})

describe('the pool', () => {
  it('runs at most the limit at once and keeps results in order', async () => {
    let active = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20])
    expect(peak).toBe(3)
    expect(await mapLimit([], 3, async () => 1)).toEqual([])
  })
})
