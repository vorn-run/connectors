import { decodeEntities } from './text'

export const NS = {
  rss1: 'http://purl.org/rss/1.0/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  content: 'http://purl.org/rss/1.0/modules/content/',
  dc: 'http://purl.org/dc/elements/1.1/',
  atom: 'http://www.w3.org/2005/Atom',
  media: 'http://search.yahoo.com/mrss/',
  xml: 'http://www.w3.org/XML/1998/namespace'
} as const

/** Where a prefix a feed uses without declaring it conventionally points. */
const CONVENTIONAL = new Map<string, string>([
  ['rdf', NS.rdf],
  ['content', NS.content],
  ['dc', NS.dc],
  ['atom', NS.atom],
  ['media', NS.media],
  ['xml', NS.xml]
])

export interface XmlAttribute {
  ns: string
  local: string
  value: string
}

export interface XmlText {
  text: string
  cdata: boolean
}

export interface XmlElement {
  /** The name as written, prefix included. */
  name: string
  ns: string
  local: string
  attrs: XmlAttribute[]
  children: Array<XmlElement | XmlText>
  /** What relative references inside resolve against: the nearest xml:base, else the document's address. */
  base: string
  /** Offsets of the content between the start and end tags in `source`. */
  start: number
  end: number
  /** Ended by the document running out rather than by a tag. */
  truncated: boolean
  source: string
}

const START_TAG = /<([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/y
const END_TAG = /<\/\s*([^\s<>]+)\s*>/y
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

/** An address resolved against a base, or as written when either is not a URL. */
export function resolveUrl(href: string, base: string): string {
  const trimmed = href.trim()
  if (trimmed === '') return ''
  try {
    return new URL(trimmed, base || undefined).href
  } catch {
    return trimmed
  }
}

/** An xml:base resolved against the base around it, which stays when the value is not a URL. */
function rebase(value: string, parent: string): string {
  try {
    return new URL(value.trim(), parent || undefined).href
  } catch {
    return parent
  }
}

function qualify(name: string, scope: Map<string, string>, attribute: boolean): { ns: string; local: string } {
  const colon = name.indexOf(':')
  if (colon === -1) return { ns: attribute ? '' : (scope.get('') ?? ''), local: name }
  const prefix = name.slice(0, colon)
  return {
    ns: scope.get(prefix) ?? CONVENTIONAL.get(prefix) ?? `urn:undeclared:${prefix}`,
    local: name.slice(colon + 1)
  }
}

function after(source: string, close: string, from: number): number {
  const at = source.indexOf(close, from)
  return at === -1 ? source.length : at + close.length
}

/** Past a `<!…>` declaration, a DOCTYPE's internal subset included; nothing in it is read. */
function skipDeclaration(source: string, from: number): number {
  let depth = 0
  let quote = ''
  for (let j = from + 2; j < source.length; j++) {
    const c = source[j]
    if (quote) {
      if (c === quote) quote = ''
    } else if (source.startsWith('<!--', j)) {
      j = after(source, '-->', j + 4) - 1
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '[') {
      depth++
    } else if (c === ']') {
      depth = Math.max(0, depth - 1)
    } else if (c === '>' && depth === 0) {
      return j + 1
    }
  }
  return source.length
}

function attributes(raw: string): Array<[string, string]> {
  return [...raw.matchAll(ATTRIBUTE)].map((m) => [m[1]!, decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')])
}

/**
 * The document's root element as a light tree, read tolerantly: an unclosed
 * element ends at its parent's end tag, a stray `<` or `&` is text, and
 * declarations, comments and processing instructions are skipped unread.
 */
export function parseXml(source: string, baseUrl = ''): XmlElement | undefined {
  const stack: Array<{ el: XmlElement; scope: Map<string, string> }> = []
  let root: XmlElement | undefined
  let i = 0
  const n = source.length

  const addText = (text: string, cdata: boolean) => {
    stack.at(-1)?.el.children.push({ text, cdata })
  }
  const close = (name: string, at: number) => {
    const lower = name.toLowerCase()
    let k = stack.length - 1
    while (k >= 0 && stack[k]!.el.name.toLowerCase() !== lower) k--
    if (k >= 0) for (const open of stack.splice(k)) open.el.end = at
  }

  while (i < n) {
    const lt = source.indexOf('<', i)
    const stop = lt === -1 ? n : lt
    if (stop > i) addText(decodeEntities(source.slice(i, stop)), false)
    if (lt === -1) break
    i = lt
    if (source.startsWith('<!--', i)) {
      i = after(source, '-->', i + 4)
    } else if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i + 9)
      addText(source.slice(i + 9, end === -1 ? n : end), true)
      i = end === -1 ? n : end + 3
    } else if (source.startsWith('<?', i)) {
      i = after(source, '?>', i + 2)
    } else if (source.startsWith('<!', i)) {
      i = skipDeclaration(source, i)
    } else {
      const tag = source[i + 1] === '/' ? END_TAG : START_TAG
      tag.lastIndex = i
      const m = tag.exec(source)
      if (!m) {
        addText('<', false)
        i++
        continue
      }
      i = tag.lastIndex
      if (tag === END_TAG) {
        close(m[1]!, lt)
        continue
      }
      if (root !== undefined && stack.length === 0) continue
      const parent = stack.at(-1)
      const raw = attributes(m[2] ?? '')
      let scope = parent?.scope ?? new Map<string, string>()
      const declared = raw.filter(([name]) => name === 'xmlns' || name.startsWith('xmlns:'))
      if (declared.length > 0) {
        scope = new Map(scope)
        for (const [name, value] of declared) scope.set(name === 'xmlns' ? '' : name.slice(6), value)
      }
      const attrs = raw
        .filter(([name]) => name !== 'xmlns' && !name.startsWith('xmlns:'))
        .map(([name, value]) => ({ ...qualify(name, scope, true), value }))
      const parentBase = parent?.el.base ?? baseUrl
      const xmlBase = attrs.find((a) => a.ns === NS.xml && a.local === 'base')
      const el: XmlElement = {
        name: m[1]!,
        ...qualify(m[1]!, scope, false),
        attrs,
        children: [],
        base: xmlBase ? rebase(xmlBase.value, parentBase) : parentBase,
        start: i,
        end: i,
        truncated: false,
        source
      }
      if (parent) parent.el.children.push(el)
      else root = el
      if (m[3] !== '/') stack.push({ el, scope })
    }
  }
  for (const open of stack) {
    open.el.end = n
    open.el.truncated = true
  }
  return root
}

export function isElement(node: XmlElement | XmlText): node is XmlElement {
  return 'local' in node
}

export function elements(el: XmlElement | undefined, local: string, ns: string): XmlElement[] {
  return (el?.children ?? []).filter((c): c is XmlElement => isElement(c) && c.local === local && c.ns === ns)
}

export function child(el: XmlElement | undefined, local: string, ns: string): XmlElement | undefined {
  return elements(el, local, ns)[0]
}

export function attr(el: XmlElement | undefined, local: string, ns = ''): string {
  return el?.attrs.find((a) => a.local === local && a.ns === ns)?.value ?? ''
}

export function innerXml(el: XmlElement): string {
  return el.source.slice(el.start, el.end).trim()
}

/**
 * An element's text: character data as written, decoded once more when it
 * holds only escaped markup, the rest with entities decoded. Markup inside is
 * returned as written.
 */
export function textOf(el: XmlElement | undefined): string {
  if (!el) return ''
  if (el.children.some(isElement)) return innerXml(el)
  return el.children
    .map((node) => {
      const { text, cdata } = node as XmlText
      return cdata && text.includes('&lt;') && !text.includes('<') ? decodeEntities(text) : text
    })
    .join('')
    .trim()
}
