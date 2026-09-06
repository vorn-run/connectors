import { describe, expect, it } from 'vitest'
import { adfText, toAdf } from './adf'

describe('toAdf', () => {
  it('splits paragraphs on blank lines and lines on hardBreak', () => {
    expect(toAdf('First line\nsecond line\n\nSecond paragraph')).toEqual({
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'First line' }, { type: 'hardBreak' }, { type: 'text', text: 'second line' }]
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph' }] }
      ]
    })
  })

  it('normalises Windows line endings and drops surrounding blank lines', () => {
    expect(toAdf('\r\na\r\nb\r\n\r\n\r\nc\n')).toEqual({
      version: 1,
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'c' }] }
      ]
    })
  })

  it('yields an empty document for empty text', () => {
    expect(toAdf('')).toEqual({ version: 1, type: 'doc', content: [] })
    expect(toAdf(undefined)).toEqual({ version: 1, type: 'doc', content: [] })
    expect(toAdf('   \n\n  ')).toEqual({ version: 1, type: 'doc', content: [] })
  })

  it('passes an ADF document through, as JSON text or as an object', () => {
    const doc = { version: 1 as const, type: 'doc' as const, content: [{ type: 'rule' }] }
    expect(toAdf(JSON.stringify(doc))).toEqual(doc)
    expect(toAdf(doc)).toBe(doc)
  })

  it('treats JSON that is not a document, or is not JSON, as text', () => {
    expect(toAdf('{"type":"paragraph"}').content[0]?.content?.[0]).toEqual({ type: 'text', text: '{"type":"paragraph"}' })
    expect(toAdf('{not json').content[0]?.content?.[0]).toEqual({ type: 'text', text: '{not json' })
  })
})

describe('adfText', () => {
  it('flattens a document to text with paragraphs separated by a blank line', () => {
    expect(adfText(toAdf('First line\nsecond line\n\nSecond paragraph'))).toBe('First line\nsecond line\n\nSecond paragraph')
  })

  it('reads mentions, emoji and statuses by their text, and skips what it does not know', () => {
    expect(
      adfText({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Hi ' },
              { type: 'mention', attrs: { text: '@Mia' } },
              { type: 'emoji', attrs: { shortName: ':wave:' } },
              { type: 'status', attrs: {} },
              { type: 'inlineCard', attrs: { url: 'x' } }
            ]
          },
          { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] }
        ]
      })
    ).toBe('Hi @Mia:wave:\n\none')
  })

  it('returns a string as itself and nothing for nothing', () => {
    expect(adfText('plain')).toBe('plain')
    expect(adfText(undefined)).toBe('')
    expect(adfText(null)).toBe('')
    expect(adfText(42)).toBe('42')
  })
})
