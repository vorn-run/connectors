const LATIN1 =
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'

/** The only entity names ever expanded; a name a DOCTYPE declares is left as written. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  ...Object.fromEntries(LATIN1.split(' ').map((name, i) => [name, String.fromCodePoint(192 + i)]))
}

function codePoint(code: number): string | undefined {
  const valid = Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
  return valid ? String.fromCodePoint(code) : undefined
}

/** Numeric references and the fixed table of names decoded; anything else, a stray `&` included, stays as written. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (whole, name: string) => {
    if (name.startsWith('#')) {
      const hex = name[1] === 'x' || name[1] === 'X'
      return codePoint(hex ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)) ?? whole
    }
    return ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** Lines trimmed and runs of spaces collapsed, empty lines dropped. */
export function tidy(value: string): string {
  return value
    .split(/\r?\n|\r/)
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
}

/** Markup as plain text: whitespace collapsed as HTML does, one line per block, scripts and styles dropped, entities decoded. */
export function plainText(html: string): string {
  return tidy(
    decodeEntities(
      html
        .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/\s+/g, ' ')
        .replace(/<(br|hr)\b[^>]*>/gi, '\n')
        .replace(/<\/?(p|h[1-6]|li|blockquote|pre|div|ul|ol|figure|figcaption|table|tr)\b[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
    )
  )
}

/** Markup as one line of text, for titles and names. */
export function inlineText(html: string): string {
  return plainText(html).replace(/\n/g, ' ')
}

export function oneLine(value: string): string {
  return tidy(value).replace(/\n/g, ' ')
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export const SUMMARY_LENGTH = 2000

/** Text cut to `max` characters, the last one an ellipsis when anything was cut. */
export function cut(value: string, max = SUMMARY_LENGTH): string {
  const chars = Array.from(value)
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`
}
