import type { ConnectorItem } from '@vornrun/connector-sdk'
import type { XPost, XUser } from './client'

/** How much of a post's text becomes the item title. */
export const TITLE_LIMIT = 80

export interface PostRecord extends Record<string, unknown> {
  id: string
  text: string
  createdAt: string
  conversationId: string
  inReplyToUserId: string | null
  author: { id: string; username: string; name: string }
  url: string
}

/** The post's page: with the username when known, otherwise the `/i/status/` form X resolves without one. */
export function postUrl(id: string, username?: string): string {
  return username ? `https://x.com/${username}/status/${id}` : `https://x.com/i/status/${id}`
}

export function joinAuthor(post: XPost, users: XUser[] | undefined): PostRecord {
  const id = post.id ?? ''
  const author = users?.find((user) => user.id !== undefined && user.id === post.author_id)
  const username = author?.username ?? ''
  return {
    id,
    text: post.text ?? '',
    createdAt: post.created_at ?? '',
    conversationId: post.conversation_id ?? '',
    inReplyToUserId: post.in_reply_to_user_id ?? null,
    author: { id: post.author_id ?? '', username, name: author?.name ?? '' },
    url: postUrl(id, username)
  }
}

export function postToItem(record: PostRecord): ConnectorItem {
  const firstLine = record.text.replace(/\s+/g, ' ').trim()
  const excerpt = Array.from(firstLine).slice(0, TITLE_LIMIT).join('')
  return {
    externalId: record.id,
    title: `@${record.author.username}: ${excerpt}`,
    ...(record.createdAt && { updatedAt: record.createdAt }),
    url: record.url,
    data: record
  }
}

export const SAMPLE_ITEM: ConnectorItem = {
  externalId: '1346889436626259968',
  title: '@xdevelopers: Hello world!',
  updatedAt: '2024-01-15T12:00:00.000Z',
  url: 'https://x.com/xdevelopers/status/1346889436626259968',
  data: {
    id: '1346889436626259968',
    text: 'Hello world!',
    createdAt: '2024-01-15T12:00:00.000Z',
    conversationId: '1346889436626259968',
    inReplyToUserId: null,
    author: { id: '2244994945', username: 'xdevelopers', name: 'X Developers' },
    url: 'https://x.com/xdevelopers/status/1346889436626259968'
  }
}
