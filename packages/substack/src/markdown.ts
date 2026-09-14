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
        // Only a picture on Substack and alone in its paragraph becomes a block; any other keeps a link to it.
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

/** Where Upload image puts a picture, and the address Substack serves it through. */
const MEDIA_HOST = /^(substack-post-media\.s3\.amazonaws\.com|substackcdn\.com)$/
/** Substack writes an uploaded picture's size into its file name, as `_1456x816.png`. */
const SIZE_IN_NAME = /_(\d+)x(\d+)\.\w+$/

/** The editor's picture block, for a paragraph holding nothing but a picture uploaded to Substack. */
function uploadedImage(tokens: Token[]): DocNode | undefined {
  const kept = tokens.filter((token) => !(token.type === 'text' && token.raw.trim() === ''))
  if (kept.length !== 1 || kept[0]!.type !== 'image') return undefined
  const image = kept[0] as Tokens.Image
  const url = URL.canParse(image.href) ? new URL(image.href) : undefined
  if (url?.protocol !== 'https:' || !MEDIA_HOST.test(url.hostname)) return undefined
  const size = SIZE_IN_NAME.exec(url.pathname)
  return node('captionedImage', [
    {
      type: 'image2',
      attrs: {
        src: image.href,
        width: size ? Number(size[1]) : null,
        height: size ? Number(size[2]) : null,
        alt: image.text || null,
        title: image.title || null
      }
    }
  ])
}

function paragraph(tokens: Token[]): DocNode[] {
  const picture = uploadedImage(tokens)
  if (picture) return [picture]
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

/** Markdown as the document Substack's editor saves: headings, lists, quotes, code, rules, pictures, and inline marks. */
export function markdownToDoc(markdown: string): DocNode {
  const content = blocks(Lexer.lex(markdown, { gfm: true }))
  return {
    type: 'doc',
    content: content.length > 0 ? content : [{ type: 'paragraph' }]
  }
}
