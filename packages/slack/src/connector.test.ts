import { describe, expect, it, vi } from 'vitest'
import { createConnectorHarness } from '@vornrun/connector-sdk'
import { connector } from './connector'

/** Answers the connector's calls from here, so the test needs no network. */
function fakeFetch(body: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  ) as unknown as typeof fetch
}

const config = { apiToken: 'test-token', baseUrl: 'https://api.example.com' }

describe("Slack", () => {
  it('reports the items the source lists', async () => {
    const harness = createConnectorHarness(connector, {
      config,
      fetchImpl: fakeFetch({
        items: [
          {
            id: '1',
            title: 'First item',
            html_url: 'https://example.com/1',
            updated_at: '2026-01-01T00:00:00.000Z'
          }
        ]
      })
    })

    const page = await harness.poll('itemCreated')

    expect(page.items).toHaveLength(1)
    expect(page.items[0].externalId).toBe('1')
  })

  it('does not deliver the same item twice', async () => {
    const harness = createConnectorHarness(connector, {
      config,
      fetchImpl: fakeFetch({
        items: [
          {
            id: '1',
            title: 'First item',
            html_url: 'https://example.com/1',
            updated_at: '2026-01-01T00:00:00.000Z'
          }
        ]
      })
    })

    expect(await harness.pollTwice('itemCreated')).toEqual([])
  })

  it('creates an item and keeps only its id', async () => {
    const harness = createConnectorHarness(connector, {
      config,
      fetchImpl: fakeFetch({ id: '42', extra: 'ignored' })
    })

    expect(await harness.execute('createItem', { title: 'A title' })).toEqual({ id: '42' })
  })
})
