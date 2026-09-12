import { describe, expect, it } from 'vitest'
import { SUMMARY_LENGTH, cut, decodeEntities, escapeHtml, inlineText, oneLine, plainText, tidy } from './text'

describe('entities', () => {
  it('decodes the five XML names, numeric references and the fixed table of HTML names', () => {
    expect(decodeEntities('&amp;&lt;&gt;&quot;&apos; &#8220;x&#x201D; &hellip;&nbsp;&Eacute;&eacute;&AMP;')).toBe(
      '&<>"\' “x” … Éé&'
    )
  })

  it('leaves an undeclared name, an invalid code point and a stray ampersand as written', () => {
    const raw = '&xxe; &#0; &#xD800; &#99999999; fish & chips'
    expect(decodeEntities(raw)).toBe(raw)
  })
})

describe('plain text', () => {
  it('collapses whitespace as HTML does, keeps one line per block and drops scripts and styles', () => {
    expect(
      plainText('<h2>Title</h2><p>One&nbsp; two<br>three\nfour</p><script>alert(1)</script><style>p{}</style><hr/><p> </p>')
    ).toBe('Title\nOne two\nthree four')
  })

  it('reads markup as one line for titles', () => {
    expect(inlineText('<b>A</b><p>B</p>')).toBe('A B')
    expect(oneLine('  a \n b  ')).toBe('a b')
    expect(tidy('a\r\n\r\n  b\tc ')).toBe('a\nb c')
  })

  it('escapes text for HTML', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
  })
})

describe('cut', () => {
  it('ends a cut text with an ellipsis and leaves a short one alone', () => {
    expect(cut('abcdef', 4)).toBe('abc…')
    expect(cut('abc', 4)).toBe('abc')
    expect(cut('😀😀😀😀😀', 3)).toBe('😀😀…')
  })

  it('cuts a summary to 2000 characters', () => {
    const summary = cut('x'.repeat(SUMMARY_LENGTH + 1))
    expect(summary).toHaveLength(SUMMARY_LENGTH)
    expect(summary.endsWith('…')).toBe(true)
  })
})
