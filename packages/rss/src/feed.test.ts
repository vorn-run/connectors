import { describe, expect, it } from 'vitest'
import { fixture } from '../fixtures/serve'
import { authorName, hashId, isJsonFeed, itemTime, newestFirst, parseFeed, withinHours, type FeedItem } from './feed'

const at = (url: string) => ({ feedUrl: url, finalUrl: url })

describe('RSS 2.0', () => {
  const url = 'https://www.rssboard.org/files/sample-rss-2.xml'
  const { feed, items } = parseFeed(fixture('rss2.xml'), at(url))

  it('reads the channel', () => {
    expect(feed).toEqual({ title: 'NASA Space Station News', url, siteUrl: 'http://www.nasa.gov/', format: 'rss2' })
    expect(items).toHaveLength(7)
  })

  it('reads an item of the sample file, a date without seconds and with a zone name included', () => {
    const link =
      'http://www.nasa.gov/press-release/louisiana-students-to-hear-from-nasa-astronauts-aboard-space-station'
    const summary =
      "As part of the state's first Earth-to-space call, students from Louisiana will have an opportunity soon to hear from NASA astronauts aboard the International Space Station."
    expect(items[0]).toEqual({
      id: link,
      title: 'Louisiana Students to Hear from NASA Astronauts Aboard Space Station',
      url: link,
      author: '',
      publishedAt: '2023-07-21T13:04:00.000Z',
      updatedAt: '',
      summary,
      html: summary,
      categories: [],
      feedTitle: 'NASA Space Station News',
      feedUrl: url
    })
  })

  it('keeps an item with no title, and prefers the link to a guid that differs from it', () => {
    expect(items[1]!.title).toBe('')
    expect(items[4]).toMatchObject({
      id: 'http://liftoff.msfc.nasa.gov/2003/05/20.html#item570',
      url: 'http://liftoff.msfc.nasa.gov/news/2003/news-laundry.asp',
      summary:
        'Compared to earlier spacecraft, the International Space Station has many luxuries, but laundry facilities are not one of them. Instead, astronauts have other options.'
    })
  })

  it('reads the namespaced item: content:encoded, dc:creator, dc:date, media:title and a relative link', () => {
    expect(items[5]).toMatchObject({
      id: 'sample-relative-item',
      title: 'Relative links & namespaced bodies',
      url: 'https://www.rssboard.org/news/relative-item',
      author: 'Sally Ride',
      publishedAt: '2023-07-22T10:30:00.000Z',
      summary: 'A short escaped summary & more.',
      html: '<p>The <strong>full</strong> body &amp; more.</p>',
      categories: ['Tests', 'Namespaces']
    })
  })

  it('decodes the entity-escaped HTML rssboard.org wraps in CDATA', () => {
    const item = items[6]!
    expect(item).toMatchObject({
      id: 'tag:rssboard.org,2006:weblog.221',
      title: 'How to Read an RSS Feed with Java Using XOM',
      url: 'https://www.rssboard.org/news/221/read-rss-feed-java-using-xom',
      author: 'Rogers Cadenhead',
      publishedAt: '2023-08-02T03:25:57.000Z',
      categories: ['announcements,']
    })
    expect(item.html).toMatch(/^<figure class="text-center"><img src="https:\/\/www\.rssboard\.org\/images\//)
    expect(item.summary).toMatch(
      /^There are a lot of libraries for processing XML data with Java that can be used to read RSS feeds\./
    )
  })

  it('takes a permalink guid, else an atom:link, for the address', () => {
    const { items: found } = parseFeed(
      `<rss><channel>
        <item><guid>https://x.example/p/1</guid></item>
        <item><guid isPermaLink="false">https://x.example/p/2</guid></item>
        <item><guid>tag:not-a-url</guid><atom:link rel="alternate" href="/alt"/></item>
      </channel></rss>`,
      at('https://x.example/feed')
    )
    expect(found.map((item) => [item.id, item.url])).toEqual([
      ['https://x.example/p/1', 'https://x.example/p/1'],
      ['https://x.example/p/2', ''],
      ['tag:not-a-url', 'https://x.example/alt']
    ])
  })

  it('reads an author address, media groups, atom:updated and items beside the channel', () => {
    const { feed: old, items: found } = parseFeed(
      `<rss version="0.91" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom">
        <channel><title>Old</title><atom:link href="https://old.example/"/>
          <item><link>https://v.example/1</link><author>lawyer@boyer.net (Lawyer Boyer)</author>
            <media:group><media:title>Video</media:title><media:description>About the video</media:description></media:group>
            <atom:updated>2026-09-12T11:00:00Z</atom:updated></item>
        </channel>
        <item><title>Beside</title><link>https://old.example/2</link></item>
      </rss>`,
      at('https://old.example/rss')
    )
    expect(old.siteUrl).toBe('https://old.example/')
    expect(found.map((item) => item.title)).toEqual(['Video', 'Beside'])
    expect(found[0]).toMatchObject({
      author: 'Lawyer Boyer',
      summary: 'About the video',
      html: '',
      updatedAt: '2026-09-12T11:00:00.000Z'
    })
  })

  it('hashes the title and date into an id when there is neither guid nor link', () => {
    const { items: found } = parseFeed(
      '<rss><channel><item><title>Only a title</title><pubDate>Sat, 12 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>',
      at('https://x.example/feed')
    )
    expect(found[0]!.id).toBe(hashId('Only a title', '2026-09-12T10:00:00.000Z'))
    expect(found[0]!.id).toMatch(/^sha256:[0-9a-f]{16}$/)
  })

  it('cuts a long summary to 2000 characters', () => {
    const { items: found } = parseFeed(
      `<rss><channel><item><link>https://x.example/1</link><description>${'word '.repeat(1000)}</description></item></channel></rss>`,
      at('https://x.example/feed')
    )
    expect(found[0]!.summary).toHaveLength(2000)
    expect(found[0]!.summary.endsWith('…')).toBe(true)
  })

  it('reads an rss element with no channel as an empty feed', () => {
    expect(parseFeed('<rss/>', at('https://x.example/feed'))).toEqual({
      feed: { title: '', url: 'https://x.example/feed', siteUrl: '', format: 'rss2' },
      items: []
    })
  })
})

describe('RSS 1.0', () => {
  const url = 'https://f.example/rss1.rdf'
  const { feed, items } = parseFeed(fixture('rss1.rdf'), at(url))

  it('reads the specification example with its Dublin Core and content modules', () => {
    expect(feed).toEqual({ title: 'XML.com', url, siteUrl: 'http://xml.com/pub', format: 'rss1' })
    expect(items.map((item) => item.id)).toEqual([
      'http://xml.com/pub/2000/08/09/xslt/xslt.html',
      'http://xml.com/pub/2000/08/09/rdfdb/index.html',
      'http://c.moreover.com/click/here.pl?r123'
    ])
    expect(items[0]).toMatchObject({
      title: 'Processing Inclusions with XSLT',
      url: 'http://xml.com/pub/2000/08/09/xslt/xslt.html',
      publishedAt: '2000-08-09T12:00:00.000Z',
      updatedAt: '',
      summary:
        'Processing document inclusions with general XML tools can be problematic. This article proposes a way of preserving inclusion information through SAX-based processing.',
      html: '<p>Processing document inclusions with <em>general XML tools</em> can be problematic.</p>'
    })
    expect(items[1]).toMatchObject({ author: 'Edd Dumbill', publishedAt: '2000-08-09T14:30:00.000Z' })
    expect(items[2]).toMatchObject({
      author: 'Simon St.Laurent (mailto:simonstl@simonstl.com)',
      summary: 'XML is placing increasingly heavy loads on the existing technical infrastructure of the Internet.',
      publishedAt: '',
      categories: ['XML']
    })
  })

  it('reads an RSS 0.90 document by the namespace of its channel, and one with no channel', () => {
    const { items: old } = parseFeed(
      `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://my.netscape.com/rdf/simple/0.9/">
        <channel><title>Old</title><link>https://n.example/</link></channel>
        <item><title>One</title><link>https://n.example/1</link></item></rdf:RDF>`,
      at('https://n.example/rdf')
    )
    expect(old.map((item) => item.title)).toEqual(['One'])
    const { feed: bare, items: lone } = parseFeed(
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><item rdf:about="x"><title>T</title></item></rdf:RDF>',
      at('https://n.example/rdf')
    )
    expect(bare.title).toBe('')
    expect(lone[0]).toMatchObject({ id: 'x', title: 'T' })
  })
})

describe('Atom', () => {
  const url = 'https://github.com/nodejs/node/releases.atom'
  const { feed, items } = parseFeed(fixture('atom.xml'), at(url))

  it('reads the feed and its release entries', () => {
    expect(feed).toEqual({
      title: 'Release notes from node',
      url,
      siteUrl: 'https://github.com/nodejs/node/releases',
      format: 'atom'
    })
    expect(items[0]).toMatchObject({
      id: 'tag:github.com,2008:Repository/27193779/v26.8.2',
      title: '2026-09-09, Version 26.8.2 (Current), @aduh95',
      url: 'https://github.com/nodejs/node/releases/tag/v26.8.2',
      author: 'aduh95',
      publishedAt: '2026-09-09T16:07:48.000Z',
      updatedAt: '2026-09-09T16:07:48.000Z'
    })
    expect(items[0]!.html).toMatch(/^<h3>Notable Changes<\/h3>/)
    expect(items[0]!.summary).toMatch(
      /^Notable Changes\n\[616bd3fa26\] - doc: deprecate Server\.prototype\._listen2 in node:net/
    )
    expect(items[1]!.title).toBe("2026-09-08, Version 24.21.0 'Krypton' (LTS), @aduh95")
  })

  it('resolves against xml:base, prefers the text/html alternate and reads xhtml content', () => {
    expect(items[2]).toEqual({
      id: 'urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a',
      title: 'Bases <and> links',
      url: 'https://example.org/blog/entries/1.html',
      author: 'Ada Example',
      publishedAt: '2026-09-08T07:30:00.000Z',
      updatedAt: '2026-09-10T12:00:00.000Z',
      summary: 'An entry written by hand for the tests.',
      html: '<p>An <em>xhtml</em> body &amp; a <a href="more.html">link</a>.</p>',
      categories: ['notes', 'atom'],
      feedTitle: 'Release notes from node',
      feedUrl: url
    })
  })

  it('falls back to the feed author, reads text constructs as text and skips out-of-line content', () => {
    const { items: found } = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom"><author><name>Feed Author</name></author>
        <entry><id>e1</id><title type="text">A &lt;b&gt; title</title><content type="text">1 &lt; 2</content>
          <link rel="self" href="https://x.example/e1.atom"/></entry>
        <entry><id>e2</id><summary type="html">&lt;p&gt;Short&lt;/p&gt;</summary><content src="https://x.example/v.mp4" type="video/mp4"/>
          <link rel="http://www.iana.org/assignments/relation/alternate" href="https://x.example/e2"/></entry>
        <entry><id>e3</id><content type="xhtml">plain</content><published>2026-09-01T00:00:00Z</published></entry>
      </feed>`,
      at('https://x.example/atom')
    )
    expect(found[0]).toMatchObject({ author: 'Feed Author', title: 'A <b> title', summary: '1 < 2', html: '1 &lt; 2', url: '' })
    expect(found[1]).toMatchObject({ summary: 'Short', html: '<p>Short</p>', url: 'https://x.example/e2' })
    expect(found[2]).toMatchObject({ html: 'plain', publishedAt: '2026-09-01T00:00:00.000Z', updatedAt: '' })
  })
})

describe('JSON Feed', () => {
  const url = 'https://www.jsonfeed.org/feed.json'
  const { feed, items } = parseFeed(fixture('feed.json'), at(url))

  it("reads jsonfeed.org's version 1 feed", () => {
    expect(feed).toEqual({ title: 'JSON Feed', url, siteUrl: 'https://www.jsonfeed.org/', format: 'json' })
    expect(items[0]).toMatchObject({
      id: 'http://jsonfeed.micro.blog/2020/08/07/json-feed-version.html',
      title: 'JSON Feed version 1.1',
      url: 'https://www.jsonfeed.org/2020/08/07/json-feed-version.html',
      author: '',
      publishedAt: '2020-08-07T16:44:36.000Z',
      summary:
        'We’ve updated the spec to version 1.1. It’s a minor update to JSON Feed, clarifying a few things in the spec and adding a couple new fields such as authors and language.'
    })
    expect(items[0]!.html).toMatch(/^<p>We&rsquo;ve updated/)
  })

  it('reads a version 1.1 item: a numeric id, authors, tags, a modified date and text content', () => {
    expect(items[2]).toMatchObject({
      id: '42',
      title: 'A version 1.1 item',
      url: 'https://www.jsonfeed.org/2026/09/12/version-1-1.html',
      author: 'Manton Reece, Brent Simmons',
      publishedAt: '2026-09-12T08:00:00.000Z',
      updatedAt: '2026-09-12T09:15:30.250Z',
      summary: 'A short summary.',
      html: 'Plain text with &lt;angle&gt; &amp; ampersand.',
      categories: ['jsonfeed', 'spec']
    })
  })

  it("falls back to 1.0's singular author, external_url and html content, and drops what is not an item", () => {
    const { items: found } = parseFeed(
      JSON.stringify({
        version: 'https://jsonfeed.org/version/1',
        author: { name: 'Feed Person' },
        items: [
          { id: 'a', content_text: 'Only text', external_url: 'https://ext.example/a' },
          { id: 'b', author: { name: 'Item Person' }, content_html: '<p>Html only</p>' },
          'not an item',
          { title: 'No id', date_published: '2026-01-01T00:00:00Z' }
        ]
      }),
      at('https://j.example/feed.json')
    )
    expect(found).toHaveLength(3)
    expect(found[0]).toMatchObject({ author: 'Feed Person', url: 'https://ext.example/a', summary: 'Only text', html: 'Only text' })
    expect(found[1]).toMatchObject({ author: 'Item Person', summary: 'Html only', html: '<p>Html only</p>' })
    expect(found[2]!.id).toBe(hashId('No id', '2026-01-01T00:00:00.000Z'))
  })

  it('reads an empty object as a feed with no items, and says why broken JSON is not one', () => {
    expect(parseFeed('{}', at('https://j.example/'))).toEqual({
      feed: { title: '', url: 'https://j.example/', siteUrl: '', format: 'json' },
      items: []
    })
    expect(() => parseFeed('{"items": [}', at('https://j.example/'))).toThrow(/^unparseable: /)
  })

  it('tells a JSON Feed from other JSON', () => {
    expect(isJsonFeed('{"version":"https://jsonfeed.org/version/1.1"}')).toBe(true)
    expect(isJsonFeed('{"items":[]}')).toBe(true)
    expect(isJsonFeed('{"ok":true}')).toBe(false)
    expect(isJsonFeed('[1]')).toBe(false)
    expect(isJsonFeed('{')).toBe(false)
  })
})

describe('what is not a feed', () => {
  it('says why', () => {
    const source = at('https://x.example/')
    expect(() => parseFeed('', source)).toThrow('unparseable: no root element')
    expect(() => parseFeed('just text', source)).toThrow('unparseable: no root element')
    expect(() => parseFeed('<html lang="en"><body>x</body></html>', source)).toThrow(
      'not a feed (the body starts with "<html"); try find feeds'
    )
    expect(() => parseFeed('<svg xmlns="http://www.w3.org/2000/svg"/>', source)).toThrow(
      'unparseable: root <svg> is not rss, RDF or feed'
    )
  })

  it('reads past a byte-order mark and leading whitespace', () => {
    expect(parseFeed('﻿  <rss><channel><title>B</title></channel></rss>', at('https://x.example/')).feed.title).toBe('B')
  })
})

describe('real feeds that are not well formed', () => {
  it('reads the complete items of a feed cut off mid-item, a stray & included', () => {
    const { feed, items } = parseFeed(fixture('malformed.xml'), at('https://chips.example/feed'))
    expect(feed.title).toBe('Fish & Chips Weekly')
    expect(items.map((item) => item.title)).toEqual(['Salt & vinegar', 'Mushy peas & a stray & in the title'])
    expect(items[1]!.summary).toBe('Cod < haddock, says nobody')
  })

  it('never expands an entity a DOCTYPE declares', () => {
    const { items } = parseFeed(fixture('doctype.xml'), at('https://doctype.example/feed'))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ title: 'Leak &xxe; and &remote;', summary: 'Laugh &lol3; & carry on' })
  })
})

describe('authors', () => {
  it('reads the name of an RSS address, else the value as written', () => {
    expect(authorName('lawyer@boyer.net (Lawyer Boyer)')).toBe('Lawyer Boyer')
    expect(authorName('lawyer@boyer.net')).toBe('lawyer@boyer.net')
    expect(authorName('<b>Jane</b>')).toBe('Jane')
  })
})

describe('ordering', () => {
  const item = (id: string, publishedAt: string, updatedAt = '') => ({ id, publishedAt, updatedAt }) as FeedItem
  const items = [
    item('a', '2026-01-02T00:00:00.000Z'),
    item('b', ''),
    item('c', '', '2026-01-03T00:00:00.000Z'),
    item('d', '2026-01-01T00:00:00.000Z'),
    item('e', ''),
    item('f', '2026-01-01T00:00:00.000Z')
  ]

  it('dates an item by its publication, else its update', () => {
    expect(itemTime(items[2]!)).toBe('2026-01-03T00:00:00.000Z')
  })

  it('sorts newest first with dateless items last, keeping feed order among equals', () => {
    expect(newestFirst(items).map((entry) => entry.id)).toEqual(['c', 'a', 'd', 'f', 'b', 'e'])
  })

  it('keeps dated items inside the window only', () => {
    const now = Date.parse('2026-01-03T12:00:00.000Z')
    expect(withinHours(items, 36, now).map((entry) => entry.id)).toEqual(['a', 'c'])
  })
})
