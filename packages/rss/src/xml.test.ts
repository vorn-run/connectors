import { describe, expect, it } from 'vitest'
import { NS, attr, child, elements, innerXml, isElement, parseXml, resolveUrl, textOf, type XmlElement } from './xml'

function root(source: string, base = ''): XmlElement {
  const parsed = parseXml(source, base)
  if (!parsed) throw new Error('no root')
  return parsed
}

function names(el: XmlElement): string[] {
  return el.children.filter(isElement).map((c) => c.name)
}

describe('namespaces', () => {
  it('matches elements by namespace and local name, whatever the prefix', () => {
    const feed = root('<a:feed xmlns:a="http://www.w3.org/2005/Atom"><a:title>x</a:title></a:feed>')
    expect(feed).toMatchObject({ ns: NS.atom, local: 'feed' })
    expect(textOf(child(feed, 'title', NS.atom))).toBe('x')
  })

  it('inherits a default namespace, leaves unprefixed attributes without one, and falls back for undeclared prefixes', () => {
    const rdf = root(
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><item rdf:about="u" kind="k"><dc:creator>A</dc:creator><foo:bar>b</foo:bar></item></rdf:RDF>'
    )
    const item = child(rdf, 'item', NS.rss1)!
    expect(attr(item, 'about', NS.rdf)).toBe('u')
    expect(attr(item, 'kind')).toBe('k')
    expect(textOf(child(item, 'creator', NS.dc))).toBe('A')
    expect(child(item, 'bar', 'urn:undeclared:foo')).toBeDefined()
  })
})

describe('text', () => {
  it('keeps CDATA as written and decodes everything else', () => {
    expect(textOf(root('<t><![CDATA[<b>&amp;</b>]]></t>'))).toBe('<b>&amp;</b>')
    expect(textOf(root('<t>a &amp; b &xxe;</t>'))).toBe('a & b &xxe;')
  })

  it('decodes CDATA once more when it holds only escaped markup', () => {
    expect(textOf(root('<t><![CDATA[&lt;p&gt;x &amp; y&lt;/p&gt;]]></t>'))).toBe('<p>x & y</p>')
  })

  it('returns markup inside an element as written', () => {
    expect(textOf(root('<d>Hi <b>there</b> &amp;</d>'))).toBe('Hi <b>there</b> &amp;')
    expect(textOf(undefined)).toBe('')
  })

  it('reads a stray < as text', () => {
    expect(textOf(root('<r>1 < 2 <3 and a </ b</r>'))).toBe('1 < 2 <3 and a </ b')
  })
})

describe('what is skipped unread', () => {
  it('drops the declaration, comments, processing instructions and a DOCTYPE with its internal subset', () => {
    const r = root('<?xml version="1.0"?><!-- c --><!DOCTYPE r [<!ENTITY a "]>"><!-- ] --><!ELEMENT r ANY>]><?pi x?><r>ok &a;</r>')
    expect(textOf(r)).toBe('ok &a;')
  })

  it('finds no root in a document that never gets past a declaration, comment or instruction', () => {
    expect(parseXml('<!DOCTYPE r [')).toBeUndefined()
    expect(parseXml('<!-- never closed <r/>')).toBeUndefined()
    expect(parseXml('<?xml version="1.0"')).toBeUndefined()
    expect(parseXml('just text')).toBeUndefined()
    expect(parseXml('')).toBeUndefined()
  })
})

describe('tolerance', () => {
  it('ends an unclosed element at its parent end tag', () => {
    const r = root('<r><a><b>text</a><c/></r>')
    expect(names(r)).toEqual(['a', 'c'])
    const b = child(child(r, 'a', ''), 'b', '')!
    expect(b.truncated).toBe(false)
    expect(textOf(b)).toBe('text')
  })

  it('ignores a stray end tag and matches end tags ignoring case', () => {
    expect(names(root('<r></x><a/></r>'))).toEqual(['a'])
    expect(root('<r><A>x</a></r>').truncated).toBe(false)
  })

  it('marks what the document cut off', () => {
    const r = root('<r><a><![CDATA[abc')
    expect(r.truncated).toBe(true)
    expect(child(r, 'a', '')!.truncated).toBe(true)
    expect(textOf(child(r, 'a', ''))).toBe('abc')
  })

  it('ignores text and elements outside the root', () => {
    const r = root('junk <r>x</r><s>y</s> tail')
    expect(r.name).toBe('r')
    expect(textOf(r)).toBe('x')
  })
})

describe('attributes', () => {
  it('reads either quote, unquoted values, entities and bare names', () => {
    const r = root(`<r a='1' b=2 c="&amp;" d/>`)
    expect([attr(r, 'a'), attr(r, 'b'), attr(r, 'c'), attr(r, 'd'), attr(r, 'e'), attr(undefined, 'a')]).toEqual([
      '1',
      '2',
      '&',
      '',
      '',
      ''
    ])
  })
})

describe('xml:base', () => {
  it('resolves nested bases against the document address', () => {
    const feed = root(
      '<feed xml:base="https://a.example/x/"><entry xml:base="y/"><link href="z"/></entry><other/></feed>',
      'https://feed.example/f.xml'
    )
    const entry = child(feed, 'entry', '')!
    expect(entry.base).toBe('https://a.example/x/y/')
    expect(resolveUrl(attr(child(entry, 'link', ''), 'href'), child(entry, 'link', '')!.base)).toBe(
      'https://a.example/x/y/z'
    )
    expect(root('<r/>', 'https://feed.example/f.xml').base).toBe('https://feed.example/f.xml')
  })

  it('keeps the surrounding base when an xml:base is not a URL', () => {
    expect(child(root('<r><e xml:base="http://[bad"/></r>', 'https://feed.example/'), 'e', '')!.base).toBe(
      'https://feed.example/'
    )
  })
})

describe('helpers', () => {
  it('resolves addresses and leaves what cannot be resolved as written', () => {
    expect(resolveUrl('', 'https://x.example/')).toBe('')
    expect(resolveUrl('/a', 'https://x.example/b/c')).toBe('https://x.example/a')
    expect(resolveUrl(' rel ', '')).toBe('rel')
    expect(resolveUrl('https://abs.example', 'https://x.example/')).toBe('https://abs.example/')
  })

  it('answers nothing for a missing element', () => {
    expect(elements(undefined, 'a', '')).toEqual([])
    expect(child(undefined, 'a', '')).toBeUndefined()
    expect(innerXml(root('<r>  <a/>  </r>'))).toBe('<a/>')
  })
})
