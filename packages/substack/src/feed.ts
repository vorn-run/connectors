/** One post as a publication's RSS feed describes it. */
export interface FeedPost extends Record<string, unknown> {
  id: string
  title: string
  subtitle: string
  url: string
  author: string
  publishedAt: string
  html: string
  text: string
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g

/** Character data kept as written, the rest with its entities decoded. */
function textOf(raw: string): string {
  let out = ''
  let last = 0
  for (const match of raw.matchAll(CDATA)) {
    out += decodeEntities(raw.slice(last, match.index)) + match[1]
    last = match.index + match[0].length
  }
  return (out + decodeEntities(raw.slice(last))).trim()
}

/** A tag's text, found with character data blanked out so markup inside a post body never matches. */
function tagText(item: string, masked: string, name: string): string {
  const open = new RegExp(`<${name}(?:\\s[^>]*)?>`).exec(masked)
  if (!open) return ''
  const start = open.index + open[0].length
  const end = masked.indexOf(`</${name}>`, start)
  return end === -1 ? '' : textOf(item.slice(start, end))
}

/** A post body as plain text: one line per block, entities decoded. */
export function plainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(br|hr)\s*\/?>/gi, '\n')
      .replace(/<(p|h[1-6]|li|blockquote|pre|div|ul|ol)(\s[^>]*)?>/gi, '\n')
      .replace(/<\/(p|h[1-6]|li|blockquote|pre|div)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
}

/** Every post in an RSS 2.0 feed, in the feed's order; an item with no id or link is left out. */
export function parseFeed(xml: string): FeedPost[] {
  const posts: FeedPost[] = []
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)) {
    const item = match[1] ?? ''
    const masked = item.replace(CDATA, (section) => ' '.repeat(section.length))
    const url = tagText(item, masked, 'link')
    const id = tagText(item, masked, 'guid') || url
    if (id === '') continue
    const published = new Date(tagText(item, masked, 'pubDate'))
    const html = tagText(item, masked, 'content:encoded')
    posts.push({
      id,
      title: tagText(item, masked, 'title'),
      subtitle: tagText(item, masked, 'description'),
      url,
      author: tagText(item, masked, 'dc:creator'),
      publishedAt: Number.isNaN(published.getTime()) ? '' : published.toISOString(),
      html,
      text: plainText(html)
    })
  }
  return posts
}
