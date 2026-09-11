import { Lexer, type Token, type Tokens } from 'marked'

/** A mark in Substack's editor document; the names are the ones its editor saves. */
export interface DocMark {
  type: 'strong' | 'em' | 'code' | 'strikethrough' | 'link'
  attrs?: { href: string }
}

/** A node in Substack's editor document, the JSON a draft's body holds. */
export interface DocNode {
  type: string
  attrs?: Record<string, unknown>
  content?: DocNode[]
  text?: string
  marks?: DocMark[]
}

const SAFE_LINK = /^(https?:|mailto:)/i

function node(type: string, content: DocNode[], attrs?: Record<string, unknown>): DocNode {
  return {
    type,
    ...(attrs && { attrs }),
    ...(content.length > 0 && { content })
  }
}

function text(value: string, marks: DocMark[]): DocNode[] {
  if (value === '') return []
  return [{ type: 'text', text: value, ...(marks.length > 0 && { marks }) }]
}

function withMark(marks: DocMark[], mark: DocMark): DocMark[] {
  return marks.some((existing) => existing.type === mark.type) ? marks : [...marks, mark]
}

/** A script or data address keeps its words but never becomes something to click. */
function withLink(marks: DocMark[], href: string): DocMark[] {
  return SAFE_LINK.test(href) ? withMark(marks, { type: 'link', attrs: { href } }) : marks
}

function inline(tokens: Token[], marks: DocMark[] = []): DocNode[] {
  return tokens.flatMap((token): DocNode[] => {
    switch (token.type) {
      case 'strong':
        return inline((token as Tokens.Strong).tokens, withMark(marks, { type: 'strong' }))
      case 'em':
        return inline((token as Tokens.Em).tokens, withMark(marks, { type: 'em' }))
      case 'del':
        return inline((token as Tokens.Del).tokens, withMark(marks, { type: 'strikethrough' }))
      case 'codespan':
        return text((token as Tokens.Codespan).text, withMark(marks, { type: 'code' }))
      case 'link': {
        const link = token as Tokens.Link
        return inline(link.tokens, withLink(marks, link.href))
      }
      case 'image': {
        // A picture needs an upload the editor does itself; the draft keeps a link to it instead.
        const image = token as Tokens.Image
        return text(image.text || image.href, withLink(marks, image.href))
      }
      case 'br':
        return [{ type: 'hard_break' }]
      case 'text':
        return text((token as Tokens.Text).text, marks)
      default:
        return 'text' in token && typeof token.text === 'string' ? text(token.text, marks) : []
    }
  })
}

function paragraph(tokens: Token[]): DocNode[] {
  const content = inline(tokens)
  return content.length > 0 ? [node('paragraph', content)] : []
}

function blocks(tokens: Token[]): DocNode[] {
  return tokens.flatMap((token): DocNode[] => {
    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading
        return [
          node('heading', inline(heading.tokens), {
            level: heading.depth
          })
        ]
      }
      case 'paragraph':
        return paragraph((token as Tokens.Paragraph).tokens)
      case 'text': {
        const t = token as Tokens.Text
        return paragraph(t.tokens ?? [{ type: 'text', raw: t.raw, text: t.text } as Tokens.Text])
      }
      case 'list': {
        const list = token as Tokens.List
        const items = list.items.map((item) => {
          const content = blocks(item.tokens)
          return node('list_item', content.length > 0 ? content : [node('paragraph', [])])
        })
        if (!list.ordered) return [node('bullet_list', items)]
        return [node('ordered_list', items, { start: Number(list.start) })]
      }
      case 'blockquote':
        return [node('blockquote', blocks((token as Tokens.Blockquote).tokens))]
      case 'hr':
        return [{ type: 'horizontal_rule' }]
      case 'code': {
        const code = token as Tokens.Code
        return [
          node('code_block', text(code.text, []), {
            language: code.lang || null
          })
        ]
      }
      case 'table': {
        // The editor has no tables, so each row becomes a line of cells.
        const table = token as Tokens.Table
        const rows = [table.header, ...table.rows]
        return rows.flatMap((row) =>
          paragraph(
            row.flatMap((cell, i) => [
              ...(i > 0 ? [{ type: 'text', raw: ' | ', text: ' | ' } as Tokens.Text] : []),
              ...cell.tokens
            ])
          )
        )
      }
      case 'space':
        return []
      default:
        return 'text' in token && typeof token.text === 'string' && token.text.trim() !== ''
          ? [node('paragraph', text(token.text.trim(), []))]
          : []
    }
  })
}

/** Markdown as the document Substack's editor saves: headings, lists, quotes, code, rules, and inline marks. */
export function markdownToDoc(markdown: string): DocNode {
  const content = blocks(Lexer.lex(markdown, { gfm: true }))
  return {
    type: 'doc',
    content: content.length > 0 ? content : [{ type: 'paragraph' }]
  }
}
