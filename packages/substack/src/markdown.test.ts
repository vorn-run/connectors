import { describe, expect, it } from 'vitest'
import { markdownToDoc, type DocNode } from './markdown'

/** The node and mark names Substack's editor saved when each kind of formatting was pasted into a draft on 2026-09-10. */
const NODES = new Set([
  'doc',
  'paragraph',
  'heading',
  'text',
  'ordered_list',
  'bullet_list',
  'list_item',
  'blockquote',
  'code_block',
  'horizontal_rule',
  'hard_break'
])
const MARKS = new Set(['strong', 'em', 'code', 'strikethrough', 'link'])

function names(doc: DocNode): { nodes: string[]; marks: string[] } {
  const nodes = new Set<string>()
  const marks = new Set<string>()
  const walk = (n: DocNode): void => {
    nodes.add(n.type)
    for (const m of n.marks ?? []) marks.add(m.type)
    for (const c of n.content ?? []) walk(c)
  }
  walk(doc)
  return { nodes: [...nodes], marks: [...marks] }
}

const t = (text: string, marks?: DocNode['marks']): DocNode => ({
  type: 'text',
  text,
  ...(marks && { marks })
})

describe('markdown as a Substack draft body', () => {
  it('turns headings and inline marks into the editor’s own names', () => {
    const doc = markdownToDoc(
      '## Why it matters\n\nPlain, **bold**, *italic*, `a < b`, ~~gone~~ and [a link](https://vorn.run).'
    )
    expect(doc.content).toEqual([
      { type: 'heading', attrs: { level: 2 }, content: [t('Why it matters')] },
      {
        type: 'paragraph',
        content: [
          t('Plain, '),
          t('bold', [{ type: 'strong' }]),
          t(', '),
          t('italic', [{ type: 'em' }]),
          t(', '),
          t('a < b', [{ type: 'code' }]),
          t(', '),
          t('gone', [{ type: 'strikethrough' }]),
          t(' and '),
          t('a link', [{ type: 'link', attrs: { href: 'https://vorn.run' } }]),
          t('.')
        ]
      }
    ])
  })

  it('keeps lists, quotes, code, rules and line breaks', () => {
    const doc = markdownToDoc(
      '3. third\n4. fourth\n\n- one\n  - nested\n\n> quoted\n\n```ts\nconst x = 1\n```\n\n---\n\nline  \nbreak'
    )
    expect(doc.content?.map((n) => n.type)).toEqual([
      'ordered_list',
      'bullet_list',
      'blockquote',
      'code_block',
      'horizontal_rule',
      'paragraph'
    ])
    expect(doc.content?.[0]).toMatchObject({
      attrs: { start: 3 },
      content: [
        {
          type: 'list_item',
          content: [{ type: 'paragraph', content: [t('third')] }]
        },
        {}
      ]
    })
    expect(doc.content?.[1]?.content?.[0]?.content?.map((n) => n.type)).toEqual(['paragraph', 'bullet_list'])
    expect(doc.content?.[3]).toEqual({
      type: 'code_block',
      attrs: { language: 'ts' },
      content: [t('const x = 1')]
    })
    expect(doc.content?.[5]?.content).toEqual([t('line'), { type: 'hard_break' }, t('break')])
  })

  it('never makes a script or data address clickable', () => {
    const doc = markdownToDoc('[click](javascript:alert(1)) ![pic](data:image/png;base64,AAAA)')
    expect(names(doc).marks).toEqual([])
    expect(doc.content?.[0]?.content?.map((n) => n.text).join('')).toContain('click')
  })

  it('links a picture rather than dropping it, since uploading one is the editor’s job', () => {
    const doc = markdownToDoc('![the chart](https://example.com/chart.png)')
    expect(doc.content?.[0]?.content).toEqual([
      t('the chart', [{ type: 'link', attrs: { href: 'https://example.com/chart.png' } }])
    ])
  })

  it('writes a table as one line per row', () => {
    const doc = markdownToDoc('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(doc.content?.map((n) => n.content?.map((c) => c.text).join(''))).toEqual(['a | b', '1 | 2'])
  })

  it('gives an empty body one empty paragraph, as a new draft has', () => {
    expect(markdownToDoc('')).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph' }]
    })
  })

  it('uses no node or mark the editor did not save itself', () => {
    const doc = markdownToDoc(
      '# H\n\n**b** *i* `c` ~~s~~ [l](https://x.io)\n\n1. a\n\n- b\n\n> q\n\n```\nc\n```\n\n***\n\nx  \ny\n\n<div>raw</div>'
    )
    const found = names(doc)
    expect(found.nodes.filter((n) => !NODES.has(n))).toEqual([])
    expect(found.marks.filter((m) => !MARKS.has(m))).toEqual([])
  })
})
