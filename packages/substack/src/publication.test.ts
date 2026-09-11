import { describe, expect, it } from 'vitest'
import { postRef, publicationHost, substackHost } from './publication'

describe('the host a publication answers on', () => {
  it('takes a bare name as its substack.com subdomain, and an address as given', () => {
    expect(publicationHost('novumai')).toBe('novumai.substack.com')
    expect(publicationHost(' NovumAI ')).toBe('novumai.substack.com')
    expect(publicationHost('novumai.substack.com')).toBe('novumai.substack.com')
    expect(publicationHost('https://novumai.substack.com/archive')).toBe('novumai.substack.com')
    expect(publicationHost('www.lennysnewsletter.com')).toBe('www.lennysnewsletter.com')
  })

  it('asks for a publication when given none', () => {
    expect(() => publicationHost('')).toThrow(/publication is required/)
    expect(() => publicationHost(undefined)).toThrow(/publication is required/)
  })

  it('keeps signed-in calls on substack.com, where the window signed in', () => {
    expect(substackHost('novumai')).toBe('novumai.substack.com')
    expect(() => substackHost('www.lennysnewsletter.com')).toThrow(/custom domain/)
    expect(() => substackHost('substack.com')).toThrow(/custom domain/)
  })
})

describe('a post address', () => {
  it('gives the host and slug', () => {
    expect(postRef('https://novumai.substack.com/p/anthropic-passed-openai-this-week')).toEqual({
      host: 'novumai.substack.com',
      slug: 'anthropic-passed-openai-this-week'
    })
    expect(postRef('https://www.lennysnewsletter.com/p/a-post/comments?x=1')).toEqual({
      host: 'www.lennysnewsletter.com',
      slug: 'a-post'
    })
  })

  it('refuses anything that is not a post page', () => {
    expect(() => postRef('199708472')).toThrow(/post's address/)
    expect(() => postRef('https://novumai.substack.com/archive')).toThrow(/post's address/)
    expect(() => postRef('http://novumai.substack.com/p/x')).toThrow(/post's address/)
  })
})
