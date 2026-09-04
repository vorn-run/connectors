import { defineConnector } from '@vornrun/connector-sdk'

export const connector = defineConnector({
  id: "slack",
  name: "Slack",
  description: "Slack connector for Vorn",
  version: '0.1.0',
  // Prefer a login the machine already has: { rung: 'cli', probe: { command: 'tool', args: ['auth', 'status'] } }
  auth: { rung: 'key', keys: ['apiToken'] },
  config: [
    {
      key: 'apiToken',
      label: 'API token',
      required: true,
      secret: true,
      builderHint: 'Say where a token is created and which scopes it needs'
    },
    { key: 'baseUrl', label: 'Base URL', default: 'https://api.example.com' }
  ],
  triggers: [
    {
      type: 'itemCreated',
      label: 'Item created',
      description: 'Items created since the last poll',
      // Return what is there; the SDK handles cursors and de-duplication.
      dedupe: 'timestamp',
      async fetch(context) {
        const url = new URL('/v1/items', context.config.baseUrl)
        if (context.since) url.searchParams.set('updated_since', context.since)
        // `context.fetch` retries and backs off; the global one does not.
        const response = await context.fetch(url, {
          headers: { authorization: 'Bearer ' + context.config.apiToken }
        })
        if (!response.ok) throw new Error('Listing items failed with ' + response.status)
        const body = (await response.json()) as { items: Array<Record<string, string>> }
        return body.items.map((item) => ({
          externalId: item.id,
          title: item.title,
          url: item.html_url,
          updatedAt: item.updated_at
        }))
      }
    }
  ],
  actions: [
    {
      type: 'createItem',
      label: 'Create item',
      description: 'Create one item',
      inputs: [
        { key: 'title', label: 'Title', required: true },
        { key: 'body', label: 'Body' }
      ],
      outputs: [{ key: 'id', type: 'string', description: 'The created item' }],
      // Declared, not written: the SDK fills the templates, sends it, and keeps what postReceive names.
      request: {
        method: 'POST',
        url: '{{config.baseUrl}}/v1/items',
        headers: { authorization: 'Bearer {{config.apiToken}}' },
        body: { title: '{{args.title}}', body: '{{args.body}}' }
      },
      postReceive: [{ op: 'pick', keys: ['id'] }]
    }
  ]
})
