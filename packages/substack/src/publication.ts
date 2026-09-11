const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i

/** The host a publication answers on: a bare name is its substack.com subdomain, an address is taken as given. */
export function publicationHost(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (raw === '') throw new Error('publication is required: its substack.com subdomain, such as "novumai"')
  if (SUBDOMAIN.test(raw)) return `${raw.toLowerCase()}.substack.com`
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase()
  } catch {
    throw new Error(`"${raw}" is neither a publication subdomain nor an address`)
  }
}

/** A host the signed-in window may act on: a custom domain is outside the origins it signed in to. */
export function substackHost(value: unknown): string {
  const host = publicationHost(value)
  if (!host.endsWith('.substack.com')) {
    throw new Error(
      `${host} is a custom domain; use the publication's substack.com address instead, such as novumai.substack.com`
    )
  }
  return host
}

export interface PostRef {
  host: string
  slug: string
}

/** Where a post lives and its slug, read from the address a feed or a search gave for it. */
export function postRef(value: unknown): PostRef {
  const raw = String(value ?? '').trim()
  const notAPost = new Error(
    `post must be a post's address, such as https://novumai.substack.com/p/its-slug; got "${raw}"`
  )
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw notAPost
  }
  const slug = /^\/p\/([^/]+)\/?/.exec(url.pathname)?.[1]
  if (url.protocol !== 'https:' || !slug) throw notAPost
  return { host: url.hostname.toLowerCase(), slug: decodeURIComponent(slug) }
}
