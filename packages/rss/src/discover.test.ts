import { describe, expect, it } from 'vitest'
import { fixture } from '../fixtures/serve'
import { discoverFeeds } from './discover'

describe('autodiscovery', () => {
  it('reads RSS, Atom and JSON Feed links against <base href>, skipping duplicates, stylesheets and comments', () => {
    expect(discoverFeeds(fixture('page.html'), 'https://blog.example/')).toEqual([
      { url: 'https://blog.example/base/feed.xml', title: 'Posts & notes', type: 'application/rss+xml', format: 'rss2' },
      { url: 'https://blog.example/atom.xml', title: 'Atom', type: 'application/atom+xml', format: 'atom' },
      { url: 'https://blog.example/base/feed.json', title: 'JSON Feed', type: 'application/feed+json', format: 'json' }
    ])
  })

  it('accepts application/json when no application/feed+json link exists, resolving against the page', () => {
    const page =
      '<head><link rel="alternate" type="application/json" href="/feed.json"><link rel="alternate" type="application/atom+xml"></head>'
    expect(discoverFeeds(page, 'https://p.example/blog/')).toEqual([
      { url: 'https://p.example/feed.json', title: '', type: 'application/json', format: 'json' }
    ])
  })

  it("returns the rssboard.org home page's feed as declared", () => {
    const page =
      '<link rel="alternate" type="application/rss+xml" title="RSS Advisory Board" href="http://feeds.rssboard.org/rssboard" />'
    expect(discoverFeeds(page, 'https://www.rssboard.org/')).toEqual([
      { url: 'http://feeds.rssboard.org/rssboard', title: 'RSS Advisory Board', type: 'application/rss+xml', format: 'rss2' }
    ])
  })

  it('reads unquoted and bare attributes, keeps the first of a repeated one, and skips a link with no rel', () => {
    const page =
      '<link type="application/rss+xml" href="/no-rel.xml"><link rel=alternate type=application/rss+xml href=/u.xml href="/second.xml" hidden>'
    expect(discoverFeeds(page, 'https://p.example/')).toEqual([
      { url: 'https://p.example/u.xml', title: '', type: 'application/rss+xml', format: 'rss2' }
    ])
  })

  it('finds nothing on a page that declares nothing', () => {
    expect(discoverFeeds('<html><head><title>x</title></head></html>', 'https://p.example/')).toEqual([])
  })
})
