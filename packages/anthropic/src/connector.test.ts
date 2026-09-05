import { describe, expect, it, vi } from 'vitest'
import { createConnectorHarness, type ConnectorConfig } from '@vornrun/connector-sdk'
import { BATCH_LOOKBACK_MS, MODEL_LOOKBACK_MS, connector as packaged, createAnthropicConnector } from './connector'
import { ANTHROPIC_VERSION, API_ROOT } from './client'
import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL, MODEL_IDS, SAMPLE_BATCH, SAMPLE_MODEL } from './items'

const NOW = '2026-09-05T12:00:00.000Z'
const CONFIG: ConnectorConfig = { apiKey: 'test-key' }

interface Sent {
  method: string
  url: string
  headers: Record<string, string>
  body?: Record<string, unknown>
}

interface Route {
  when: RegExp
  status?: number
  body?: unknown
  text?: string
  headers?: Record<string, string>
  /** Answers in order for repeated hits; the last one repeats. */
  bodies?: unknown[]
  statuses?: number[]
}

// A fake api.anthropic.com driven by the URL asked for, so a test says what the account holds and asserts on what was sent.
function anthropicServing(routes: Route[]) {
  const sent: Sent[] = []
  const hits = new Map<Route, number>()
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    sent.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === 'string' && { body: JSON.parse(init.body) as Record<string, unknown> })
    })
    const route = routes.find((candidate) => candidate.when.test(url))
    if (!route) throw new Error(`No fake route for ${url}`)
    const hit = hits.get(route) ?? 0
    hits.set(route, hit + 1)
    const body = route.bodies ? route.bodies[Math.min(hit, route.bodies.length - 1)] : route.body
    const status = route.statuses ? route.statuses[Math.min(hit, route.statuses.length - 1)] : route.status
    return new Response(route.text ?? JSON.stringify(body ?? {}), {
      status: status ?? 200,
      headers: { 'content-type': 'application/json', ...route.headers }
    })
  }) as unknown as typeof fetch
  return { fetchImpl, sent }
}

function harnessOver(routes: Route[], options: { config?: ConnectorConfig; env?: NodeJS.ProcessEnv } = {}) {
  const { fetchImpl, sent } = anthropicServing(routes)
  const waits: number[] = []
  let clock = Date.parse(NOW)
  const connector = createAnthropicConnector({
    env: options.env ?? {},
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms)
      clock += ms
    },
    random: () => 0.5
  })
  const harness = createConnectorHarness(connector, {
    config: options.config ?? CONFIG,
    now: () => NOW,
    fetchImpl,
    sleep: async () => undefined
  })
  return { connector, harness, sent, waits }
}

const BATCHES = /\/messages\/batches\?/
const MODELS = /\/models\?/

const batch = (id: string, created: string, ended: string | null, status = ended ? 'ended' : 'in_progress') => ({
  id,
  type: 'message_batch',
  processing_status: status,
  request_counts: { processing: ended ? 0 : 1, succeeded: ended ? 1 : 0, errored: 0, canceled: 0, expired: 0 },
  created_at: created,
  ended_at: ended,
  expires_at: new Date(Date.parse(created) + BATCH_LOOKBACK_MS).toISOString()
})

const model = (id: string, created: string) => ({ id, type: 'model', display_name: id, created_at: created })

const page = (data: unknown[], last?: string) => ({ data, has_more: last !== undefined, first_id: null, last_id: last ?? null })

describe('the definition', () => {
  const connector = createAnthropicConnector({ version: '1.2.3', env: {} })

  it('asks for a key exactly as the spec declares it', () => {
    expect(connector.auth).toEqual({ rung: 'key', keys: ['apiKey'] })
    expect(connector.config).toHaveLength(1)
    expect(connector.config[0]).toMatchObject({ key: 'apiKey', env: 'ANTHROPIC_API_KEY', secret: true, required: true })
  })

  it('leaves a hint for whoever builds on it, on every setting and every input', () => {
    for (const field of connector.config) expect(field.builderHint, field.key).toBeTruthy()
    for (const action of connector.actions) {
      expect(typeof action.idempotent, action.type).toBe('boolean')
      expect(action.outputs?.length, action.type).toBeGreaterThan(0)
      for (const input of action.inputs ?? []) {
        expect(input.builderHint, `${action.type}.${input.key}`).toBeTruthy()
        expect(input.description, `${action.type}.${input.key}`).toBeTruthy()
      }
    }
  })

  it('offers the triggers and actions the spec lists', () => {
    expect(connector.triggers.map((trigger) => trigger.type)).toEqual(['batchEnded', 'newModel'])
    expect(connector.actions.map((action) => action.type)).toEqual([
      'createMessage',
      'countTokens',
      'listModels',
      'getModel',
      'createMessageBatch',
      'getMessageBatch',
      'getBatchResults',
      'cancelMessageBatch'
    ])
    const idempotent = connector.actions.filter((action) => action.idempotent).map((action) => action.type)
    expect(idempotent).toEqual(['countTokens', 'listModels', 'getModel', 'getMessageBatch', 'getBatchResults'])
  })

  it('lists the current model ids in the model hint', () => {
    const input = connector.actions[0].inputs?.find((entry) => entry.key === 'model')
    for (const id of MODEL_IDS) expect(input?.builderHint).toContain(id)
    expect(input?.description).toContain(DEFAULT_MODEL)
  })

  it('draws the two legs of Anthropic’s mark', () => {
    expect(connector.icon?.viewBox).toBe('0 0 24 24')
    expect(connector.icon?.paths).toHaveLength(2)
    for (const path of connector.icon?.paths ?? []) expect(path).toMatch(/^M[\d.]+ [\d.]+.*z$/)
  })

  it('names the version it was built with, and the package version otherwise', () => {
    expect(connector.version).toBe('1.2.3')
    expect(packaged.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(createAnthropicConnector().version).toBe(packaged.version)
  })

  it('carries the documented sample items', () => {
    expect(connector.triggers[0].sample?.[0]).toMatchObject({ externalId: SAMPLE_BATCH.id, updatedAt: SAMPLE_BATCH.ended_at })
    expect(connector.triggers[1].sample?.[0]).toMatchObject({ externalId: SAMPLE_MODEL.id, title: 'Claude Opus 5' })
  })

  it('uses a placeholder batch id in samples until the environment names a real one', () => {
    const byType = Object.fromEntries(connector.actions.map((action) => [action.type, action.sample]))
    expect(byType.countTokens).toEqual({ model: DEFAULT_MODEL, messages: 'hello' })
    expect(byType.listModels).toEqual({})
    expect(byType.getModel).toEqual({ modelId: DEFAULT_MODEL })
    expect(byType.getMessageBatch).toEqual({ batchId: 'msgbatch_placeholder' })
    expect(byType.getBatchResults).toEqual({ batchId: 'msgbatch_placeholder' })
    expect(byType.createMessage).toBeUndefined()
    expect(byType.cancelMessageBatch).toBeUndefined()

    const live = createAnthropicConnector({ env: { ANTHROPIC_BATCH_ID: 'msgbatch_real' } })
    const liveByType = Object.fromEntries(live.actions.map((action) => [action.type, action.sample]))
    expect(liveByType.getMessageBatch).toEqual({ batchId: 'msgbatch_real' })
    expect(liveByType.getBatchResults).toEqual({ batchId: 'msgbatch_real' })
  })
})

describe('batchEnded', () => {
  it('delivers ended batches oldest first, skipping ones still running', async () => {
    const { harness, sent } = harnessOver([
      {
        when: BATCHES,
        body: page([
          batch('msgbatch_c', '2026-09-05T11:50:00Z', null),
          batch('msgbatch_b', '2026-09-05T11:40:00Z', '2026-09-05T11:55:00Z'),
          batch('msgbatch_a', '2026-09-05T11:30:00Z', '2026-09-05T11:45:00Z')
        ])
      }
    ])
    const page1 = await harness.poll('batchEnded')
    expect(page1.items.map((item) => item.externalId)).toEqual(['msgbatch_a', 'msgbatch_b'])
    expect(page1.items[0]).toMatchObject({ title: 'Batch msgbatch_a ended: 1 succeeded', updatedAt: '2026-09-05T11:45:00.000Z', status: 'ended' })
    expect(sent[0]).toMatchObject({
      method: 'GET',
      url: `${API_ROOT}/messages/batches?limit=100`,
      headers: { 'x-api-key': 'test-key', 'anthropic-version': ANTHROPIC_VERSION }
    })
  })

  it('walks newest-first pages until a batch older than the window, then stops', async () => {
    const { harness, sent } = harnessOver([
      {
        when: BATCHES,
        bodies: [
          page([batch('msgbatch_new', '2026-09-05T10:00:00Z', '2026-09-05T11:00:00Z')], 'msgbatch_new'),
          page([batch('msgbatch_old', '2026-09-03T10:00:00Z', '2026-09-03T11:00:00Z')], 'msgbatch_old'),
          page([batch('msgbatch_older', '2026-09-02T10:00:00Z', '2026-09-02T11:00:00Z')], 'msgbatch_older')
        ]
      }
    ])
    const page1 = await harness.poll('batchEnded', { since: '2026-09-04T12:00:00.000Z' })
    expect(page1.items.map((item) => item.externalId)).toEqual(['msgbatch_new'])
    expect(sent).toHaveLength(2)
    expect(new URL(sent[1].url).searchParams.get('after_id')).toBe('msgbatch_new')
  })

  it('looks a day back on the first poll and keeps a batch that ended after the cursor', async () => {
    const { harness } = harnessOver([
      {
        when: BATCHES,
        body: page([
          batch('msgbatch_late', '2026-09-05T11:00:00Z', '2026-09-05T11:59:00Z'),
          batch('msgbatch_seen', '2026-09-05T10:00:00Z', '2026-09-05T11:30:00Z'),
          batch('msgbatch_stale', '2026-09-04T11:00:00Z', '2026-09-04T12:00:00Z')
        ])
      }
    ])
    const first = await harness.poll('batchEnded')
    expect(first.items.map((item) => item.externalId)).toEqual(['msgbatch_seen', 'msgbatch_late'])
    const again = await harness.poll('batchEnded', { since: '2026-09-05T11:31:00.000Z' })
    expect(again.items.map((item) => item.externalId)).toEqual(['msgbatch_late'])
  })

  it('does not deliver the same batch twice', async () => {
    const { harness } = harnessOver([
      { when: BATCHES, body: page([batch('msgbatch_a', '2026-09-05T11:30:00Z', '2026-09-05T11:45:00Z')]) }
    ])
    expect(await harness.pollTwice('batchEnded')).toEqual([])
  })

  it('needs the key', async () => {
    const { harness } = harnessOver([], { config: {} })
    await expect(harness.poll('batchEnded')).rejects.toThrow('ANTHROPIC_API_KEY is required')
  })

  it('reports the API error as the docs word it', async () => {
    const { harness } = harnessOver([
      { when: BATCHES, status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' }, request_id: 'req_1' } }
    ])
    await expect(harness.poll('batchEnded')).rejects.toThrow('authentication_error: invalid x-api-key (HTTP 401, request req_1)')
  })
})

describe('newModel', () => {
  it('delivers models released since the cursor, oldest first, and drops epoch dates', async () => {
    const { harness } = harnessOver([
      {
        when: MODELS,
        body: page([
          model('claude-b', '2026-09-01T00:00:00Z'),
          model('claude-a', '2026-08-20T00:00:00Z'),
          model('claude-old', '2026-07-01T00:00:00Z'),
          model('claude-epoch', '1970-01-01T00:00:00Z')
        ])
      }
    ])
    const page1 = await harness.poll('newModel', { since: '2026-08-10T00:00:00.000Z' })
    expect(page1.items.map((item) => item.externalId)).toEqual(['claude-a', 'claude-b'])
    expect(page1.items[0]).toMatchObject({ title: 'claude-a', updatedAt: '2026-08-20T00:00:00.000Z' })
  })

  it('looks thirty days back on the first poll', async () => {
    const { harness } = harnessOver([
      {
        when: MODELS,
        body: page([
          model('claude-recent', new Date(Date.parse(NOW) - MODEL_LOOKBACK_MS + 1000).toISOString()),
          model('claude-older', new Date(Date.parse(NOW) - MODEL_LOOKBACK_MS - 1000).toISOString())
        ])
      }
    ])
    const page1 = await harness.poll('newModel')
    expect(page1.items.map((item) => item.externalId)).toEqual(['claude-recent'])
  })

  it('does not deliver the same model twice', async () => {
    const { harness } = harnessOver([{ when: MODELS, body: page([model('claude-a', '2026-09-01T00:00:00Z')]) }])
    expect(await harness.pollTwice('newModel')).toEqual([])
  })
})

describe('createMessage', () => {
  const reply = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'Hello there' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 3 }
  }

  it('sends text as one user turn with the defaults and returns the first text block', async () => {
    const { harness, sent } = harnessOver([{ when: /\/messages$/, body: reply }])
    const result = await harness.execute('createMessage', { messages: 'Hi' })
    expect(result).toEqual({
      id: 'msg_1',
      model: 'claude-sonnet-5',
      text: 'Hello there',
      stopReason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
      raw: reply
    })
    expect(sent[0]).toMatchObject({ method: 'POST', url: `${API_ROOT}/messages` })
    expect(sent[0].headers['content-type']).toBe('application/json')
    expect(sent[0].body).toEqual({
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: DEFAULT_MAX_TOKENS
    })
  })

  it('passes every optional field through under its API name', async () => {
    const { harness, sent } = harnessOver([{ when: /\/messages$/, body: reply }])
    await harness.execute('createMessage', {
      model: 'claude-opus-4-6',
      messages: '[{"role":"user","content":"Hi"},{"role":"assistant","content":"Yes?"}]',
      system: 'Be brief',
      maxTokens: '50',
      temperature: '0.2',
      tools: [{ name: 'lookup', description: 'Find', input_schema: { type: 'object' } }],
      stopSequences: 'END, STOP'
    })
    expect(sent[0].body).toEqual({
      model: 'claude-opus-4-6',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Yes?' }
      ],
      system: 'Be brief',
      max_tokens: 50,
      temperature: 0.2,
      tools: [{ name: 'lookup', description: 'Find', input_schema: { type: 'object' } }],
      stop_sequences: ['END', 'STOP']
    })
  })

  it('reports an API error with its type and message', async () => {
    const { harness } = harnessOver([
      { when: /\/messages$/, status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: must be positive' } } }
    ])
    await expect(harness.execute('createMessage', { messages: 'Hi', maxTokens: '-1' })).rejects.toThrow(
      'invalid_request_error: max_tokens: must be positive (HTTP 400)'
    )
  })

  it('retries an overloaded answer once, then reports it', async () => {
    const overloaded = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
    const recovered = harnessOver([{ when: /\/messages$/, statuses: [529, 200], bodies: [overloaded, reply] }])
    expect(await recovered.harness.execute('createMessage', { messages: 'Hi' })).toMatchObject({ id: 'msg_1' })
    expect(recovered.sent).toHaveLength(2)
    expect(recovered.waits).toEqual([1500])

    const down = harnessOver([{ when: /\/messages$/, status: 529, body: overloaded }])
    await expect(down.harness.execute('createMessage', { messages: 'Hi' })).rejects.toThrow('overloaded_error: Overloaded (HTTP 529)')
    expect(down.sent).toHaveLength(2)
  })

  it('requires messages', async () => {
    const { harness } = harnessOver([])
    await expect(harness.execute('createMessage', {})).rejects.toThrow(/requires "messages"/)
  })
})

describe('countTokens', () => {
  it('counts a prompt against the default model', async () => {
    const { harness, sent } = harnessOver([{ when: /count_tokens$/, body: { input_tokens: 2095 } }])
    expect(await harness.execute('countTokens', { messages: 'hello', system: 'Be brief' })).toEqual({ inputTokens: 2095 })
    expect(sent[0]).toMatchObject({ method: 'POST', url: `${API_ROOT}/messages/count_tokens` })
    expect(sent[0].body).toEqual({ model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hello' }], system: 'Be brief' })
  })
})

describe('listModels and getModel', () => {
  it('walks every page of models', async () => {
    const { harness, sent } = harnessOver([
      {
        when: MODELS,
        bodies: [page([model('claude-b', '2026-09-01T00:00:00Z')], 'claude-b'), page([model('claude-a', '2026-08-01T00:00:00Z')])]
      }
    ])
    const result = await harness.execute('listModels', {})
    expect(result.count).toBe(2)
    expect((result.models as Array<{ id: string }>).map((entry) => entry.id)).toEqual(['claude-b', 'claude-a'])
    expect(sent).toHaveLength(2)
  })

  it('reads one model as a declared request and renames its fields', async () => {
    const { harness, sent } = harnessOver([{ when: /\/models\/claude-sonnet-5$/, body: SAMPLE_MODEL }])
    expect(await harness.execute('getModel', { modelId: 'claude-sonnet-5' })).toEqual({
      id: 'claude-opus-5',
      displayName: 'Claude Opus 5',
      createdAt: '2026-07-24T00:00:00Z',
      maxInputTokens: 1000000,
      maxTokens: 128000,
      capabilities: SAMPLE_MODEL.capabilities
    })
    expect(sent[0].headers).toMatchObject({ 'x-api-key': 'test-key', 'anthropic-version': ANTHROPIC_VERSION })
  })
})

describe('message batches', () => {
  it('creates a batch from an array or a single request', async () => {
    const created = { ...SAMPLE_BATCH, processing_status: 'in_progress', ended_at: null, results_url: null }
    const { harness, sent } = harnessOver([{ when: /\/messages\/batches$/, body: created }])
    const request = { custom_id: 'one', params: { model: DEFAULT_MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] } }
    expect(await harness.execute('createMessageBatch', { requests: [request] })).toMatchObject({
      id: SAMPLE_BATCH.id,
      processingStatus: 'in_progress',
      endedAt: null,
      resultsUrl: null,
      raw: created
    })
    await harness.execute('createMessageBatch', { requests: request })
    expect(sent[0].body).toEqual({ requests: [request] })
    expect(sent[1].body).toEqual({ requests: [request] })
  })

  it('reads a batch as a declared request', async () => {
    const { harness } = harnessOver([{ when: /\/messages\/batches\/msgbatch_1$/, body: SAMPLE_BATCH }])
    expect(await harness.execute('getMessageBatch', { batchId: 'msgbatch_1' })).toEqual({
      id: SAMPLE_BATCH.id,
      processingStatus: 'ended',
      requestCounts: SAMPLE_BATCH.request_counts,
      createdAt: SAMPLE_BATCH.created_at,
      endedAt: SAMPLE_BATCH.ended_at,
      expiresAt: SAMPLE_BATCH.expires_at,
      resultsUrl: SAMPLE_BATCH.results_url
    })
  })

  it('parses batch results from JSONL', async () => {
    const { harness } = harnessOver([
      {
        when: /\/results$/,
        text: '{"custom_id":"one","result":{"type":"succeeded","message":{"id":"msg_1"}}}\n{"custom_id":"two","result":{"type":"errored","error":{"type":"invalid_request"}}}\n'
      }
    ])
    const result = await harness.execute('getBatchResults', { batchId: 'msgbatch_1' })
    expect(result.count).toBe(2)
    expect(result.results).toEqual([
      { custom_id: 'one', result: { type: 'succeeded', message: { id: 'msg_1' } } },
      { custom_id: 'two', result: { type: 'errored', error: { type: 'invalid_request' } } }
    ])
  })

  it('cancels a batch as a declared request', async () => {
    const canceling = { ...SAMPLE_BATCH, processing_status: 'canceling', cancel_initiated_at: '2026-09-05T11:59:00Z' }
    const { harness, sent } = harnessOver([{ when: /\/cancel$/, body: canceling }])
    expect(await harness.execute('cancelMessageBatch', { batchId: 'msgbatch_1' })).toEqual({
      id: SAMPLE_BATCH.id,
      processingStatus: 'canceling',
      cancelInitiatedAt: '2026-09-05T11:59:00Z',
      requestCounts: SAMPLE_BATCH.request_counts
    })
    expect(sent[0]).toMatchObject({ method: 'POST', url: `${API_ROOT}/messages/batches/msgbatch_1/cancel` })
  })
})

describe('against a bare reply', () => {
  it('every action resolves on {} with placeholder arguments, as the mock check runs it', async () => {
    const { connector, harness } = harnessOver([{ when: /.*/, body: {} }])
    for (const action of connector.actions) {
      const args = Object.fromEntries(
        (action.inputs ?? []).map((input) => [input.key, input.type === 'json' ? {} : input.type === 'number' ? 1 : 'check'])
      )
      await expect(harness.execute(action.type, args), action.type).resolves.toBeDefined()
    }
  })
})
