export interface AdfNode {
  type: string
  text?: string
  content?: AdfNode[]
  [key: string]: unknown
}

export interface AdfDocument extends AdfNode {
  version: 1
  type: 'doc'
  content: AdfNode[]
}

function isDocument(value: unknown): value is AdfDocument {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'doc'
}

// A document already in ADF, given as JSON text or as the parsed object, is sent as it is.
function asDocument(value: unknown): AdfDocument | undefined {
  if (isDocument(value)) return value
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return isDocument(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

// Blank lines split paragraphs, single newlines become hardBreak nodes; empty text is an empty document.
export function toAdf(value: unknown): AdfDocument {
  const ready = asDocument(value)
  if (ready) return ready
  const text = String(value ?? '').replace(/\r\n?/g, '\n')
  const paragraphs = text
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => paragraph.replace(/^\n+|\n+$/g, ''))
    .filter((paragraph) => paragraph.trim() !== '')
  return {
    version: 1,
    type: 'doc',
    content: paragraphs.map((paragraph) => ({
      type: 'paragraph',
      content: paragraph.split('\n').flatMap((line, index) => [
        ...(index > 0 ? [{ type: 'hardBreak' }] : []),
        ...(line === '' ? [] : [{ type: 'text', text: line }])
      ])
    }))
  }
}

const BLOCK_TYPES = new Set(['paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem', 'tableRow', 'panel', 'rule'])

// The document's text, block nodes separated by newlines; a plain string (as the v2 API returns) is itself.
export function adfText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value !== 'object') return String(value)
  return textOf(value as AdfNode).replace(/\n{3,}/g, '\n\n').trim()
}

function textOf(node: AdfNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'mention' || node.type === 'emoji' || node.type === 'status') {
    const attrs = (node.attrs ?? {}) as { text?: string; shortName?: string }
    return attrs.text ?? attrs.shortName ?? ''
  }
  const inner = (node.content ?? []).map(textOf).join('')
  return BLOCK_TYPES.has(node.type) ? `${inner}\n\n` : inner
}
