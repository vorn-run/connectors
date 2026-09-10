import { describe, expect, it, vi } from 'vitest'
import { createConnectorHarness, runConformance, type ConnectorConfig } from '@vornrun/connector-sdk'
import { SAMPLE_MODEL_NAME, connector as packaged, createOllamaConnector } from './connector'
import { DEFAULT_BASE_URL } from './client'
import { SAMPLE_MODEL, SAMPLE_RUNNING_MODEL, type OllamaModel, type RunningModel } from './items'

const NOW = '2026-09-10T14:00:00.000Z'
const CONFIG: ConnectorConfig = { baseUrl: 'http://localhost:11434/api' }

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
  /** Answers in order for repeated hits; the last one repeats. */
  bodies?: unknown[]
}

// A fake Ollama driven by the URL asked for, so a test says what the server holds and asserts on what was sent.
function ollamaServing(routes: Route[]) {
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
    if (route.text === undefined && body === undefined) return new Response(null, { status: route.status ?? 200 })
    return new Response(route.text ?? JSON.stringify(body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as unknown as typeof fetch
  return { fetchImpl, sent }
}

function harnessOver(routes: Route[], options: { config?: ConnectorConfig; env?: NodeJS.ProcessEnv } = {}) {
  const { fetchImpl, sent } = ollamaServing(routes)
  const connector = createOllamaConnector({ env: options.env ?? {}, fetchImpl, sleep: async () => {} })
  const harness = createConnectorHarness(connector, { config: options.config ?? CONFIG, now: () => NOW, fetchImpl })
  return { connector, harness, sent }
}

const TAGS = /\/api\/tags$/
const PS = /\/api\/ps$/

const model = (name: string, digest: string, modified: string): OllamaModel => ({
  ...SAMPLE_MODEL,
  name,
  model: name,
  digest,
  modified_at: modified
})

const running = (name: string, expires: string): RunningModel => ({ ...SAMPLE_RUNNING_MODEL, name, model: name, expires_at: expires })

const EMPTY = [{ when: /./, body: {} }]

describe('the definition', () => {
  const connector = createOllamaConnector({ version: '1.2.3', env: {} })

  it('needs no sign-in and declares only the server url', () => {
    expect(connector.auth).toEqual({ rung: 'none' })
    expect(connector.config.map((field) => field.key)).toEqual(['baseUrl'])
    expect(connector.config[0]).toMatchObject({ env: 'OLLAMA_HOST', default: DEFAULT_BASE_URL })
    expect(connector.config[0]?.secret).toBeUndefined()
    expect(connector.version).toBe('1.2.3')
    expect(packaged.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(connector.icon?.paths[0]).toMatch(/^M/)
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

  it('offers the triggers and actions the spec lists, with samples on the idempotent ones', () => {
    expect(connector.triggers.map((trigger) => trigger.type)).toEqual(['modelChanged', 'modelLoaded'])
    expect(connector.actions.map((action) => action.type)).toEqual([
      'chat',
      'generate',
      'embed',
      'listModels',
      'showModel',
      'listRunningModels',
      'version',
      'pullModel',
      'deleteModel',
      'copyModel'
    ])
    for (const action of connector.actions) {
      expect(action.sample !== undefined, action.type).toBe(action.idempotent === true)
    }
    expect(connector.actions.find((action) => action.type === 'embed')?.sample).toEqual({ model: SAMPLE_MODEL_NAME, input: 'hello' })
  })

  it('passes the SDK conformance checks against a stub, including the mock run of every action', async () => {
    const result = await runConformance(connector, { mock: true, now: () => NOW })
    expect(result.findings.filter((finding) => finding.level === 'error')).toEqual([])
    expect(result.findings.filter((finding) => finding.code.startsWith('mock'))).toEqual([])
    expect(result.receipt?.checks).toEqual(expect.arrayContaining(['manifest', 'auth', 'secrets', 'actions', 'dedupe', 'mock']))
  })

  it('survives a bare {} reply on every action', async () => {
    const { harness } = harnessOver(EMPTY)
    const args = { model: 'm', messages: 'hi', prompt: 'p', input: 'x', source: 'a', destination: 'b' }
    for (const action of connector.actions) {
      await expect(harness.execute(action.type, args), action.type).resolves.toBeTruthy()
    }
  })
})

describe('preflight', () => {
  it('reports the version at the host from the environment', async () => {
    const { connector, sent } = harnessOver([{ when: /version/, body: { version: '0.33.3' } }], {
      env: { OLLAMA_HOST: 'box:11434/api/' }
    })
    expect(await connector.preflight?.()).toEqual({ ok: true, message: 'Ollama 0.33.3 answered at http://box:11434' })
    expect(sent[0]?.url).toBe('http://box:11434/api/version')
    const bare = harnessOver([{ when: /version/, body: {} }])
    expect(await bare.connector.preflight?.()).toEqual({ ok: true, message: `Ollama unknown version answered at ${DEFAULT_BASE_URL}` })
  })

  it('says what went wrong when the server does not answer', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) })
    }) as unknown as typeof fetch
    const connector = createOllamaConnector({ env: {}, fetchImpl, sleep: async () => {} })
    expect(await connector.preflight?.()).toEqual({
      ok: false,
      message: `Ollama did not answer at ${DEFAULT_BASE_URL}; the server may be starting or not running`
    })
    const odd = createOllamaConnector({
      env: {},
      fetchImpl: vi.fn(async () => {
        throw 'odd'
      }) as unknown as typeof fetch
    })
    expect(await odd.preflight?.()).toEqual({ ok: false, message: 'odd' })
  })
})

describe('the api key', () => {
  it('is sent as a bearer only when OLLAMA_API_KEY is set', async () => {
    const withKey = harnessOver([{ when: /version/, body: { version: '1' } }], { env: { OLLAMA_API_KEY: '<token>' } })
    await withKey.harness.execute('version', {})
    expect(withKey.sent[0]?.headers.authorization).toBe('Bearer <token>')
    const without = harnessOver([{ when: /version/, body: { version: '1' } }])
    await without.harness.execute('version', {})
    expect(without.sent[0]?.headers.authorization).toBeUndefined()
  })
})

/* ------------------------------------------------------------- triggers -- */

describe('modelChanged', () => {
  it('delivers every model on the first poll, oldest first, and nothing again', async () => {
    const newer = model('gemma3:latest', 'bbb', '2026-09-01T10:00:00.000Z')
    const older = model('qwen2.5-coder:7b', 'aaa', '2026-08-02T16:07:41.209152383-06:00')
    const { harness, sent } = harnessOver([{ when: TAGS, body: { models: [newer, older, { size: 1 }] } }])
    const page = await harness.poll('modelChanged')
    expect(page.items.map((item) => item.externalId)).toEqual(['qwen2.5-coder:7b@aaa', 'gemma3:latest@bbb'])
    expect(page.items[0]?.title).toBe('qwen2.5-coder:7b (qwen2, 7.6B)')
    expect(sent[0]?.url).toBe('http://localhost:11434/api/tags')
    expect(await harness.pollTwice('modelChanged')).toEqual([])
  })

  it('fires again when a pull changes the digest and copes with an empty server', async () => {
    const before = model('gemma3:latest', 'aaa', '2026-09-01T10:00:00.000Z')
    const after = model('gemma3:latest', 'bbb', '2026-09-02T10:00:00.000Z')
    const { harness } = harnessOver([{ when: TAGS, bodies: [{ models: [before] }, { models: [after] }, {}] }])
    const first = await harness.poll('modelChanged')
    expect(first.items.map((item) => item.externalId)).toEqual(['gemma3:latest@aaa'])
    const since = first.items[0]!.updatedAt
    expect((await harness.poll('modelChanged', { since })).items.map((item) => item.externalId)).toEqual(['gemma3:latest@bbb'])
    expect((await harness.poll('modelChanged', { since })).items).toEqual([])
  })
})

describe('modelLoaded', () => {
  it('fires when a model appears with an expiry not yet seen', async () => {
    const first = running('qwen2.5-coder:7b', '2026-09-10T13:31:16.885215Z')
    const extended = running('qwen2.5-coder:7b', '2026-09-10T13:45:00.000000Z')
    const { harness, sent } = harnessOver([{ when: PS, bodies: [{ models: [first] }, { models: [first] }, { models: [first] }, { models: [extended] }] }])
    const page = await harness.poll('modelLoaded')
    expect(page.items.map((item) => item.externalId)).toEqual(['qwen2.5-coder:7b@2026-09-10T13:31:16.885215Z'])
    expect(page.items[0]?.title).toBe('qwen2.5-coder:7b loaded (4.7 GB in VRAM, context 4096)')
    expect(sent[0]?.url).toBe('http://localhost:11434/api/ps')
    const since = page.items[0]!.updatedAt
    expect(since).toBe('2026-09-10T13:31:16.885Z')
    expect(await harness.pollTwice('modelLoaded', { since })).toEqual([])
    expect((await harness.poll('modelLoaded', { since })).items.map((item) => item.externalId)).toEqual([
      'qwen2.5-coder:7b@2026-09-10T13:45:00.000000Z'
    ])
  })

  it('sorts several loaded models by expiry and skips a nameless entry', async () => {
    const later = running('b', '2026-09-10T13:50:00Z')
    const sooner = running('a', '2026-09-10T13:40:00Z')
    const { harness } = harnessOver([{ when: PS, body: { models: [later, sooner, {}] } }])
    expect((await harness.poll('modelLoaded')).items.map((item) => item.externalId)).toEqual([
      'a@2026-09-10T13:40:00Z',
      'b@2026-09-10T13:50:00Z'
    ])
  })
})

/* -------------------------------------------------------------- actions -- */

const CHAT_REPLY = {
  model: 'gemma4',
  created_at: '2025-10-17T23:14:07.414671Z',
  message: { role: 'assistant', content: 'Hello! How can I help you today?' },
  done: true,
  done_reason: 'stop',
  total_duration: 174560334,
  load_duration: 101397084,
  prompt_eval_count: 11,
  prompt_eval_duration: 13074791,
  eval_count: 18,
  eval_duration: 52479709
}

describe('chat', () => {
  it('sends one user turn with the system prompt, format, options and keep-alive, never streaming', async () => {
    const { harness, sent } = harnessOver([{ when: /chat/, body: CHAT_REPLY }])
    const result = await harness.execute('chat', {
      model: 'gemma4',
      messages: 'hello',
      system: 'be brief',
      format: 'json',
      options: '{"temperature":0.2,"num_predict":256}',
      keepAlive: '10m'
    })
    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: 'http://localhost:11434/api/chat',
      body: {
        model: 'gemma4',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hello' }
        ],
        format: 'json',
        options: { temperature: 0.2, num_predict: 256 },
        keep_alive: '10m',
        stream: false
      }
    })
    expect(result).toEqual({
      content: 'Hello! How can I help you today?',
      thinking: null,
      toolCalls: null,
      doneReason: 'stop',
      evalCount: 18,
      promptEvalCount: 11,
      totalDuration: 174560334,
      loadDuration: 101397084,
      promptEvalDuration: 13074791,
      evalDuration: 52479709,
      model: 'gemma4',
      raw: CHAT_REPLY
    })
  })

  it('passes a message array and a schema through and surfaces thinking and tool calls', async () => {
    const reply = { ...CHAT_REPLY, message: { role: 'assistant', content: '', thinking: 'hmm', tool_calls: [{ function: { name: 'f' } }] } }
    const { harness, sent } = harnessOver([{ when: /chat/, body: reply }])
    const result = await harness.execute('chat', {
      model: 'gemma4',
      messages: '[{"role":"user","content":"hi","images":["abc"]}]',
      format: '{"type":"object","properties":{"a":{"type":"string"}}}'
    })
    expect(sent[0]?.body).toEqual({
      model: 'gemma4',
      messages: [{ role: 'user', content: 'hi', images: ['abc'] }],
      format: { type: 'object', properties: { a: { type: 'string' } } },
      stream: false
    })
    expect(result).toMatchObject({ content: '', thinking: 'hmm', toolCalls: [{ function: { name: 'f' } }] })
  })

  it('reports a missing model as not present instead of pulling it', async () => {
    const { harness, sent } = harnessOver([{ when: /chat/, status: 404, body: { error: "model 'nope' not found" } }])
    await expect(harness.execute('chat', { model: 'nope', messages: 'hi' })).rejects.toThrow(
      "Model 'nope' is not present on the server; pull it first (HTTP 404)"
    )
    expect(sent.every((call) => !call.url.endsWith('/api/pull'))).toBe(true)
  })

  it('needs a model and messages', async () => {
    const { harness, connector } = harnessOver(EMPTY)
    await expect(harness.execute('chat', { messages: 'hi' })).rejects.toThrow(/requires "model"/)
    await expect(harness.execute('chat', { model: 'm', messages: 'hi', options: 'nope' })).rejects.toThrow(/Expected JSON/)
    const chat = connector.actions.find((action) => action.type === 'chat')!
    await expect(chat.run!({ model: '  ', messages: 'hi' }, { config: CONFIG, now: () => NOW, fetch })).rejects.toThrow(
      'model is required'
    )
  })
})

describe('generate', () => {
  it('sends the prompt with system, format and options and returns the text with timings', async () => {
    const reply = { ...CHAT_REPLY, message: undefined, response: 'Hello!', context: [1, 2] }
    const { harness, sent } = harnessOver([{ when: /generate/, body: reply }])
    const result = await harness.execute('generate', {
      model: 'gemma4',
      prompt: 'Why is the sky blue?',
      system: 'short',
      format: 'json',
      options: '{"temperature":0}',
      keepAlive: '0'
    })
    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: 'http://localhost:11434/api/generate',
      body: {
        model: 'gemma4',
        prompt: 'Why is the sky blue?',
        system: 'short',
        format: 'json',
        options: { temperature: 0 },
        keep_alive: 0,
        stream: false
      }
    })
    expect(result).toMatchObject({ response: 'Hello!', thinking: null, doneReason: 'stop', evalCount: 18, model: 'gemma4' })
    expect((result.raw as { context: number[] }).context).toEqual([1, 2])
    const bare = await harness.execute('generate', { model: 'gemma4', prompt: 'x' })
    expect(sent[1]?.body).toEqual({ model: 'gemma4', prompt: 'x', stream: false })
    expect(bare).toMatchObject({ response: 'Hello!' })
  })
})

describe('embed', () => {
  it('embeds one text or an array and reports the count', async () => {
    const reply = { model: 'all-minilm', embeddings: [[0.01, -0.001]], total_duration: 14143917, load_duration: 1019500, prompt_eval_count: 8 }
    const { harness, sent } = harnessOver([{ when: /embed/, body: reply }])
    expect(await harness.execute('embed', { model: 'all-minilm', input: 'hello' })).toEqual({
      embeddings: [[0.01, -0.001]],
      count: 1,
      model: 'all-minilm',
      promptEvalCount: 8,
      totalDuration: 14143917,
      loadDuration: 1019500,
      raw: reply
    })
    expect(sent[0]?.body).toEqual({ model: 'all-minilm', input: 'hello' })
    await harness.execute('embed', { model: 'all-minilm', input: '["a","b"]', truncate: 'false' })
    expect(sent[1]?.body).toEqual({ model: 'all-minilm', input: ['a', 'b'], truncate: false })
  })

  it('reports a runner that does not serve embeddings with the server message', async () => {
    const { harness } = harnessOver([{ when: /embed/, status: 501, body: { error: 'This server does not support embeddings. Start it with --embeddings' } }])
    await expect(harness.execute('embed', { model: 'qwen2.5-coder:7b', input: 'hello' })).rejects.toThrow(
      'This server does not support embeddings. Start it with --embeddings (HTTP 501)'
    )
  })
})

describe('model reads', () => {
  it('lists models and running models with their counts', async () => {
    const { harness, sent } = harnessOver([
      { when: TAGS, body: { models: [SAMPLE_MODEL] } },
      { when: PS, body: { models: [SAMPLE_RUNNING_MODEL] } }
    ])
    expect(await harness.execute('listModels', {})).toEqual({ models: [SAMPLE_MODEL], count: 1, raw: { models: [SAMPLE_MODEL] } })
    expect(await harness.execute('listRunningModels', {})).toEqual({
      models: [SAMPLE_RUNNING_MODEL],
      count: 1,
      raw: { models: [SAMPLE_RUNNING_MODEL] }
    })
    expect(sent.map((call) => call.method)).toEqual(['GET', 'GET'])
  })

  it('shows a model and echoes the name the reply lacks', async () => {
    const reply = {
      details: SAMPLE_MODEL.details,
      capabilities: ['completion', 'tools'],
      modified_at: '2026-08-02T16:07:41.209152383-06:00',
      parameters: 'stop "<|im_end|>"',
      template: '{{ .Prompt }}',
      license: 'Apache',
      model_info: { 'general.architecture': 'qwen2' }
    }
    const { harness, sent } = harnessOver([{ when: /show/, body: reply }])
    expect(await harness.execute('showModel', { model: 'qwen2.5-coder:7b', verbose: 'true' })).toEqual({
      model: 'qwen2.5-coder:7b',
      details: SAMPLE_MODEL.details,
      capabilities: ['completion', 'tools'],
      modifiedAt: '2026-08-02T16:07:41.209152383-06:00',
      parameters: 'stop "<|im_end|>"',
      template: '{{ .Prompt }}',
      license: 'Apache',
      modelInfo: { 'general.architecture': 'qwen2' },
      raw: reply
    })
    expect(sent[0]).toMatchObject({ method: 'POST', url: 'http://localhost:11434/api/show', body: { model: 'qwen2.5-coder:7b', verbose: true } })
    await harness.execute('showModel', { model: 'qwen2.5-coder:7b' })
    expect(sent[1]?.body).toEqual({ model: 'qwen2.5-coder:7b' })
  })

  it('reads the version', async () => {
    const { harness } = harnessOver([{ when: /version/, body: { version: '0.12.6' } }])
    expect(await harness.execute('version', {})).toEqual({ version: '0.12.6' })
  })
})

describe('model writes', () => {
  it('pulls without streaming and returns the final status', async () => {
    const { harness, sent } = harnessOver([{ when: /pull/, body: { status: 'success' } }])
    expect(await harness.execute('pullModel', { model: 'gemma3', insecure: 'true' })).toEqual({ status: 'success', raw: { status: 'success' } })
    expect(sent[0]?.body).toEqual({ model: 'gemma3', insecure: true, stream: false })
    await harness.execute('pullModel', { model: 'gemma3' })
    expect(sent[1]?.body).toEqual({ model: 'gemma3', stream: false })
  })

  it('deletes and copies with an empty 200 reply, and reports a missing source', async () => {
    const { harness, sent } = harnessOver([
      { when: /delete/, status: 200 },
      { when: /copy/, bodies: [undefined, { error: "model 'a' not found" }] }
    ])
    expect(await harness.execute('deleteModel', { model: 'old:latest' })).toEqual({ deleted: true, model: 'old:latest' })
    expect(sent[0]).toMatchObject({ method: 'DELETE', url: 'http://localhost:11434/api/delete', body: { model: 'old:latest' } })
    expect(await harness.execute('copyModel', { source: 'a', destination: 'b' })).toEqual({ copied: true, source: 'a', destination: 'b' })
    expect(sent[1]).toMatchObject({ method: 'POST', url: 'http://localhost:11434/api/copy', body: { source: 'a', destination: 'b' } })
  })

  it('reports a copy whose source is missing', async () => {
    const { harness } = harnessOver([{ when: /copy/, status: 404, body: { error: "model 'a' not found" } }])
    await expect(harness.execute('copyModel', { source: 'a', destination: 'b' })).rejects.toThrow("Model 'a' is not present")
  })
})
