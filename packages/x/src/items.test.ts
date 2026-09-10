import { describe, expect, it } from 'vitest'
import { SAMPLE_ITEM, TITLE_LIMIT, joinAuthor, postToItem, postUrl } from './items'

describe('joinAuthor', () => {
  it('joins the author from includes and builds the post URL', () => {
    const record = joinAuthor(
      { id: '1', text: 'Hello', author_id: '9', created_at: '2024-01-15T12:00:00.000Z', conversation_id: '1' },
      [{ id: '8', username: 'other' }, { id: '9', username: 'xdevelopers', name: 'X Developers' }]
    )
    expect(record).toEqual({
      id: '1',
      text: 'Hello',
      createdAt: '2024-01-15T12:00:00.000Z',
      conversationId: '1',
      inReplyToUserId: null,
      author: { id: '9', username: 'xdevelopers', name: 'X Developers' },
      url: 'https://x.com/xdevelopers/status/1'
    })
  })

  it('falls back to the /i/status form when the author is missing', () => {
    const record = joinAuthor({ id: '1', in_reply_to_user_id: '3' }, undefined)
    expect(record.author).toEqual({ id: '', username: '', name: '' })
    expect(record.url).toBe('https://x.com/i/status/1')
    expect(record.inReplyToUserId).toBe('3')
    expect(joinAuthor({}, [{ username: 'noid' }]).id).toBe('')
  })
})

describe('postToItem', () => {
  it('reproduces the sample item', () => {
    const record = joinAuthor(
      { id: '1346889436626259968', text: 'Hello world!', author_id: '2244994945', created_at: '2024-01-15T12:00:00.000Z', conversation_id: '1346889436626259968' },
      [{ id: '2244994945', username: 'xdevelopers', name: 'X Developers' }]
    )
    expect(postToItem(record)).toEqual(SAMPLE_ITEM)
  })

  it('shortens the title and leaves updatedAt out without a creation time', () => {
    const record = joinAuthor({ id: '2', text: `line one\n${'a'.repeat(100)}` }, [])
    const item = postToItem(record)
    expect(item.title).toBe(`@: ${Array.from(`line one ${'a'.repeat(100)}`).slice(0, TITLE_LIMIT).join('')}`)
    expect(item.updatedAt).toBeUndefined()
  })
})

describe('postUrl', () => {
  it('uses the username when there is one', () => {
    expect(postUrl('1', 'x')).toBe('https://x.com/x/status/1')
    expect(postUrl('1')).toBe('https://x.com/i/status/1')
  })
})
