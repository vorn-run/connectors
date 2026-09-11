import { describe, expect, it } from 'vitest'
import { decodeEntities, parseFeed, plainText } from './feed'

/** Two items shaped like novumai's feed on 2026-09-10: CDATA text, a guid, and a body that carries markup of its own. */
const FEED = `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" version="2.0">
<channel><title><![CDATA[Novum AI]]></title><link>https://novumai.substack.com</link>
<item><title><![CDATA[Anthropic passed OpenAI this week. The $65 billion shows what the lead costs.]]></title>
<description><![CDATA[Both moves are really about one question: who can pay for compute.]]></description>
<link>https://novumai.substack.com/p/anthropic-passed-openai-this-week</link>
<guid isPermaLink="false">https://novumai.substack.com/p/anthropic-passed-openai-this-week</guid>
<dc:creator><![CDATA[Javier Canizalez]]></dc:creator>
<pubDate>Fri, 29 May 2026 20:03:32 GMT</pubDate>
<enclosure url="https://substackcdn.com/image/fetch/cover.png" length="0" type="image/jpeg"/>
<content:encoded><![CDATA[<p>First <strong>point</strong> &amp; more.</p><ul><li>one</li><li>two</li></ul><link rel="x"><title>not the post</title></link><blockquote><p>quoted</p></blockquote>]]></content:encoded>
</item>
<item><title>Plain &amp; escaped &#8220;title&#8221;</title><link>https://novumai.substack.com/p/second</link>
<pubDate>not a date</pubDate></item>
<item><title>No address at all</title></item>
</channel></rss>`

describe('a publication feed', () => {
  it('reads each post, taking CDATA as written and ignoring markup inside a body', () => {
    const [first] = parseFeed(FEED)
    expect(first).toEqual({
      id: 'https://novumai.substack.com/p/anthropic-passed-openai-this-week',
      title: 'Anthropic passed OpenAI this week. The $65 billion shows what the lead costs.',
      subtitle: 'Both moves are really about one question: who can pay for compute.',
      url: 'https://novumai.substack.com/p/anthropic-passed-openai-this-week',
      author: 'Javier Canizalez',
      publishedAt: '2026-05-29T20:03:32.000Z',
      html: expect.stringContaining('<strong>point</strong>'),
      text: 'First point & more.\none\ntwo\nnot the post\nquoted'
    })
  })

  it('decodes entities outside CDATA, falls back to the link for an id, and drops an item with neither', () => {
    const posts = parseFeed(FEED)
    expect(posts).toHaveLength(2)
    expect(posts[1]).toMatchObject({
      id: 'https://novumai.substack.com/p/second',
      title: 'Plain & escaped “title”',
      publishedAt: '',
      author: ''
    })
  })

  it('has nothing to say about a page that is not a feed', () => {
    expect(parseFeed('')).toEqual([])
    expect(parseFeed('{"error":"not found"}')).toEqual([])
  })
})

describe('text out of markup', () => {
  it('decodes named and numeric entities, and leaves an unknown one alone', () => {
    expect(decodeEntities('a &amp; b &#39;c&#x27; &hellip; &#99999999;')).toBe("a & b 'c' &hellip; &#99999999;")
  })

  it('keeps one line per block', () => {
    expect(plainText('<h2>Title</h2><p>One&nbsp; two<br>three</p><hr/><p> </p>')).toBe('Title\nOne two\nthree')
  })
})
