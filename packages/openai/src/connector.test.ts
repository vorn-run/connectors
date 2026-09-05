import { describe, expect, it, vi } from 'vitest'
import { createConnectorHarness, runConformance } from '@vornrun/connector-sdk'
import { API_ROOT } from './client'
import {
  DEFAULT_BATCH_LOOKBACK_HOURS,
  DEFAULT_FINE_TUNING_LOOKBACK_HOURS,
  FIRST_POLL_BATCH_HOURS,
  FIRST_POLL_FILE_HOURS,
  MAX_PAGES,
  PAGE_SIZE,
  connector as packaged,
  createOpenAIConnector,
  jsonObject,
  messageList,
  readSettings,
  responseText,
  textOrJsonArray
} from './connector'
import { SAMPLE_BATCH, SAMPLE_FILE, SAMPLE_FINE_TUNING_JOB, secondsOf, type OpenAIBatch, type OpenAIFile, type OpenAIFineTuningJob } from './items'

const NOW = '2026-09-05T12:00:00.000Z'
const NOW_S = secondsOf(NOW)
const HOUR = 3600

interface Route {
  match: string | RegExp
  method?: string
  status?: number
  body?: unknown | ((url: URL) => unknown)
  headers?: Record<string, string>
}

interface Call {
  method: string
  url: string
  body?: unknown
}

/** Answers each request from the first matching route and records what was asked. */
function router(routes: Route[]) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ method, url, ...(typeof init?.body === 'string' && { body: JSON.parse(init.body) }) })
    const route = routes.find(
      (candidate) =>
        (candidate.method ?? method).toUpperCase() === method &&
        (typeof candidate.match === 'string' ? url.includes(candidate.match) : candidate.match.test(url))
    )
    if (!route) throw new Error(`unrouted ${method} ${url}`)
    const body = typeof route.body === 'function' ? route.body(new URL(url)) : route.body
    return new Response(JSON.stringify(body === undefined ? {} : body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...route.headers }
    })
  })
  return { fetchImpl, calls }
}

const CONFIG = { apiKey: ' sk-test ', organization: 'org-1' }

function connectorWith(routes: Route[], config: Record<string, string> = CONFIG, env: NodeJS.ProcessEnv = {}) {
  const { fetchImpl, calls } = router(routes)
  const warnings: string[] = []
  const connector = createOpenAIConnector({
    version: '0.1.0',
    fetchImpl,
    sleep: async () => {},
    warn: (message) => {
      warnings.push(message)
    },
    env
  })
  const harness = createConnectorHarness(connector, { config, now: () => NOW, sleep: async () => {} })
  return { connector, harness, calls, warnings }
}

/** A list page with the paging fields the API sends. */
function list<T extends { id: string }>(data: T[], hasMore = false) {
  return { object: 'list', data, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null, has_more: hasMore }
}

function batch(id: string, status: string, createdAt: number, finishedAt: number | null, extra: Partial<OpenAIBatch> = {}): OpenAIBatch {
  return {
    ...SAMPLE_BATCH,
    id,
    status,
    created_at: createdAt,
    completed_at: status === 'completed' ? finishedAt : null,
    failed_at: status === 'failed' ? finishedAt : null,
    expired_at: status === 'expired' ? finishedAt : null,
    cancelled_at: status === 'cancelled' ? finishedAt : null,
    ...extra
  }
}

function file(id: string, createdAt: number, purpose = 'batch'): OpenAIFile {
  return { ...SAMPLE_FILE, id, created_at: createdAt, purpose }
}

function job(id: string, status: string, createdAt: number, finishedAt: number | null): OpenAIFineTuningJob {
  return { ...SAMPLE_FINE_TUNING_JOB, id, status, created_at: createdAt, finished_at: finishedAt }
}

describe('readSettings', () => {
  it('trims the key and keeps only the optional fields that are set', () => {
    expect(readSettings({ apiKey: ' sk-1 ', organization: ' ', project: 'proj_1', batchEndpoint: '', filePurpose: 'batch' })).toEqual({
      apiKey: 'sk-1',
      project: 'proj_1',
      filePurpose: 'batch',
      batchLookbackHours: DEFAULT_BATCH_LOOKBACK_HOURS,
      fineTuningLookbackHours: DEFAULT_FINE_TUNING_LOOKBACK_HOURS
    })
  })

  it('reads the look-backs as hours and refuses nonsense', () => {
    expect(readSettings({ apiKey: 'k', batchLookbackHours: '1.5', fineTuningLookbackHours: '0' })).toMatchObject({
      batchLookbackHours: 1.5,
      fineTuningLookbackHours: 0
    })
    expect(() => readSettings({ apiKey: 'k', batchLookbackHours: 'soon' })).toThrow(/OPENAI_BATCH_LOOKBACK_HOURS must be a number of hours/)
    expect(() => readSettings({ apiKey: 'k', fineTuningLookbackHours: '-1' })).toThrow(/OPENAI_FINE_TUNING_LOOKBACK_HOURS/)
    expect(() => readSettings({})).toThrow(/OPENAI_API_KEY is required/)
  })
})

describe('input helpers', () => {
  it('sends text as text and a JSON array as the array', () => {
    expect(textOrJsonArray('hello')).toBe('hello')
    expect(textOrJsonArray('[1, 2]')).toEqual([1, 2])
    expect(textOrJsonArray(' [{"role":"user","content":"hi"}]')).toEqual([{ role: 'user', content: 'hi' }])
    expect(textOrJsonArray('[not json')).toBe('[not json')
    expect(textOrJsonArray(undefined)).toBe('')
  })

  it('takes a message list, wrapping one object, and refuses anything else', () => {
    expect(messageList([{ role: 'user', content: 'hi' }])).toEqual([{ role: 'user', content: 'hi' }])
    expect(messageList({ role: 'user', content: 'hi' })).toEqual([{ role: 'user', content: 'hi' }])
    expect(() => messageList([])).toThrow(/at least one message/)
    expect(() => messageList(['hi'])).toThrow(/messages must be a JSON array of \{ role, content \} objects/)
    expect(() => messageList([null], 'input')).toThrow(/^input must be/)
  })

  it('accepts a JSON object or nothing, and refuses a list or scalar', () => {
    expect(jsonObject({ a: 1 }, 'schema')).toEqual({ a: 1 })
    expect(jsonObject(undefined, 'schema')).toBeUndefined()
    expect(jsonObject('', 'schema')).toBeUndefined()
    expect(jsonObject(null, 'schema')).toBeUndefined()
    expect(() => jsonObject([1], 'schema')).toThrow('schema must be a JSON object')
    expect(() => jsonObject(3, 'metadata')).toThrow('metadata must be a JSON object')
  })

  it('gathers the output_text parts of every message item', () => {
    expect(
      responseText({
        output: [
          { type: 'reasoning' },
          { type: 'message', content: [{ type: 'output_text', text: 'Hello' }, { type: 'refusal' }] },
          { type: 'message', content: [{ type: 'output_text', text: ', world' }] }
        ]
      })
    ).toBe('Hello, world')
    expect(responseText({})).toBe('')
    expect(responseText({ output: [{ type: 'message' }] })).toBe('')
  })
})

describe('the connector definition', () => {
  it('declares the key rung, the mark and every documented piece', () => {
    expect(packaged.id).toBe('openai')
    expect(packaged.name).toBe('OpenAI')
    expect(packaged.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(packaged.auth).toEqual({ rung: 'key', keys: ['apiKey'] })
    expect(packaged.icon?.paths[0]).toMatch(/^M22\.2819/)
    expect(packaged.triggers.map((trigger) => trigger.type)).toEqual(['batchFinished', 'fileUploaded', 'fineTuningJobFinished'])
    expect(packaged.actions.map((action) => action.type)).toEqual([
      'createResponse',
      'createChatCompletion',
      'createEmbeddings',
      'moderateText',
      'listModels',
      'getModel',
      'listFiles',
      'getBatch',
      'createBatch'
    ])
    const key = packaged.config.find((field) => field.key === 'apiKey')
    expect(key).toMatchObject({ env: 'OPENAI_API_KEY', secret: true, required: true })
    expect(packaged.config.every((field) => field.builderHint)).toBe(true)
  })

  it('names live samples only on idempotent actions', () => {
    for (const action of packaged.actions) {
      if (action.sample !== undefined) expect(action.idempotent).toBe(true)
      else expect(action.idempotent).toBe(false)
    }
  })

  it('passes conformance on its samples without a network', async () => {
    const { connector } = connectorWith([])
    const run = await runConformance(connector, { now: () => NOW })
    expect(run.findings.filter((finding) => finding.level === 'error')).toEqual([])
    expect(run.passed).toEqual(expect.arrayContaining(['manifest', 'auth', 'secrets', 'actions', 'dedupe']))
  })

  it('defaults version, warn and env when given nothing', () => {
    const plain = createOpenAIConnector()
    expect(plain.version).toBe('0.0.0')
  })
})

describe('preflight', () => {
  it('says what to set when the key is missing', async () => {
    const { connector, calls } = connectorWith([])
    expect(await connector.preflight!()).toEqual({ ok: false, message: expect.stringMatching(/Set OPENAI_API_KEY.*api-keys/) })
    expect(calls).toHaveLength(0)
  })

  it('lists models with the organization and project headers from the environment', async () => {
    const { connector, calls } = connectorWith([{ match: '/models', body: list([{ id: 'gpt-4o-mini' }, { id: 'o3' }]) }], CONFIG, {
      OPENAI_API_KEY: 'sk-env',
      OPENAI_ORGANIZATION: 'org-env',
      OPENAI_PROJECT: 'proj_env'
    })
    expect(await connector.preflight!()).toEqual({ ok: true, message: 'Signed in; 2 models available' })
    expect(calls[0]!.url).toBe(`${API_ROOT}/models`)
  })

  it('counts nothing when the list is not a list, and lets a refusal through', async () => {
    const ok = connectorWith([{ match: '/models', body: {} }], CONFIG, { OPENAI_API_KEY: 'sk-env' })
    expect(await ok.connector.preflight!()).toEqual({ ok: true, message: 'Signed in; 0 models available' })
    const bad = connectorWith(
      [{ match: '/models', status: 401, body: { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } } }],
      CONFIG,
      { OPENAI_API_KEY: 'sk-bad' }
    )
    await expect(bad.connector.preflight!()).rejects.toThrow('401 invalid_api_key: Incorrect API key provided')
  })
})

describe('batchFinished', () => {
  it('delivers terminal batches oldest first and skips the ones still running', async () => {
    const batches = [
      batch('batch_3', 'in_progress', NOW_S - 100, null),
      batch('batch_2', 'failed', NOW_S - 200, NOW_S - 50),
      batch('batch_1', 'completed', NOW_S - 300, NOW_S - 100)
    ]
    const { harness, calls } = connectorWith([{ match: '/batches', body: list(batches) }])
    const page = await harness.poll('batchFinished')
    expect(page.items.map((item) => item.externalId)).toEqual(['batch_1:completed', 'batch_2:failed'])
    expect(page.items[0]).toMatchObject({ status: 'completed', url: 'https://platform.openai.com/batches/batch_1' })
    expect(calls[0]!.url).toBe(`${API_ROOT}/batches?limit=${PAGE_SIZE}`)
  })

  it('does not deliver a batch twice, and fires again when it lands in another terminal state', async () => {
    const { harness } = connectorWith([{ match: '/batches', body: list([batch('batch_1', 'completed', NOW_S - 300, NOW_S - 100)]) }])
    expect(await harness.pollTwice('batchFinished')).toEqual([])
  })

  it('keeps only the configured endpoint', async () => {
    const batches = [
      batch('batch_e', 'completed', NOW_S - 300, NOW_S - 100, { endpoint: '/v1/embeddings' }),
      batch('batch_c', 'completed', NOW_S - 300, NOW_S - 90)
    ]
    const { harness } = connectorWith([{ match: '/batches', body: list(batches) }], { ...CONFIG, batchEndpoint: '/v1/embeddings' })
    const page = await harness.poll('batchFinished')
    expect(page.items.map((item) => item.externalId)).toEqual(['batch_e:completed'])
  })

  it('starts a week back on the first poll rather than replaying the account', async () => {
    const old = batch('batch_old', 'completed', NOW_S - 10 * 24 * HOUR, NOW_S - 9 * 24 * HOUR)
    const recent = batch('batch_new', 'expired', NOW_S - 2 * 24 * HOUR, NOW_S - 24 * HOUR)
    const { harness } = connectorWith([{ match: '/batches', body: list([recent, old]) }])
    const page = await harness.poll('batchFinished')
    expect(page.items.map((item) => item.externalId)).toEqual(['batch_new:expired'])
  })

  it('walks pages with after until one ends below the look-back, then stops', async () => {
    const since = NOW_S - HOUR
    const pages = [
      list([batch('batch_a', 'completed', NOW_S - 10, NOW_S - 5)], true),
      list([batch('batch_b', 'completed', since - DEFAULT_BATCH_LOOKBACK_HOURS * HOUR - 10, NOW_S - 6)], true),
      list([batch('batch_c', 'completed', 1, NOW_S - 7)], true)
    ]
    let served = 0
    const { harness, calls } = connectorWith([{ match: '/batches', body: () => pages[served++] }])
    const page = await harness.poll('batchFinished', { since: new Date(since * 1000).toISOString() })
    expect(calls).toHaveLength(2)
    expect(calls[1]!.url).toContain('after=batch_a')
    expect(page.items.map((item) => item.externalId)).toEqual(['batch_b:completed', 'batch_a:completed'])
  })

  it('stops at the page cap and at an empty page', async () => {
    let served = 0
    const capped = connectorWith([
      { match: '/batches', body: () => list([batch(`batch_${served++}`, 'completed', NOW_S - 10, NOW_S - 5)], true) }
    ])
    await capped.harness.poll('batchFinished')
    expect(capped.calls).toHaveLength(MAX_PAGES)

    const empty = connectorWith([{ match: '/batches', body: { object: 'list', data: [], has_more: true } }])
    expect((await empty.harness.poll('batchFinished')).items).toEqual([])
    expect(empty.calls).toHaveLength(1)

    const odd = connectorWith([{ match: '/batches', body: {} }])
    expect((await odd.harness.poll('batchFinished')).items).toEqual([])
  })

  it('falls back to the last item id when the page names no last_id, and skips entries without an id', async () => {
    let served = 0
    const pages = [
      { data: [{ status: 'completed' }, batch('batch_a', 'completed', NOW_S - 10, NOW_S - 5)], has_more: true },
      list([batch('batch_b', 'completed', NOW_S - 20, NOW_S - 6)])
    ]
    const { harness, calls } = connectorWith([{ match: '/batches', body: () => pages[served++] }])
    const page = await harness.poll('batchFinished')
    expect(calls[1]!.url).toContain('after=batch_a')
    expect(page.items).toHaveLength(2)
  })

  it('reads the look-back from the connection', async () => {
    const since = NOW_S - HOUR
    let served = 0
    const pages = [list([batch('batch_a', 'completed', since - 2 * HOUR, NOW_S - 5)], true), list([batch('batch_b', 'completed', 1, NOW_S - 6)])]
    const { harness, calls } = connectorWith([{ match: '/batches', body: () => pages[served++] }], { ...CONFIG, batchLookbackHours: '1' })
    const page = await harness.poll('batchFinished', { since: new Date(since * 1000).toISOString() })
    expect(calls).toHaveLength(1)
    expect(page.items.map((item) => item.externalId)).toEqual(['batch_a:completed'])
  })
})

describe('fileUploaded', () => {
  it('asks for files newest first with the purpose filter and delivers oldest first', async () => {
    const files = [file('file-2', NOW_S - 100), file('file-1', NOW_S - 200)]
    const { harness, calls } = connectorWith([{ match: '/files', body: list(files) }], { ...CONFIG, filePurpose: 'batch' })
    const page = await harness.poll('fileUploaded')
    expect(calls[0]!.url).toBe(`${API_ROOT}/files?order=desc&purpose=batch&limit=${PAGE_SIZE}`)
    expect(page.items.map((item) => item.externalId)).toEqual(['file-1', 'file-2'])
    expect(page.items[0]).toMatchObject({ title: 'salesOverview.pdf (batch, 175 bytes)', updatedAt: new Date((NOW_S - 200) * 1000).toISOString() })
  })

  it('looks an hour back on the first poll and does not redeliver', async () => {
    const files = [file('file-new', NOW_S - 10), file('file-old', NOW_S - FIRST_POLL_FILE_HOURS * HOUR - 10)]
    const { harness } = connectorWith([{ match: '/files', body: list(files) }])
    expect((await harness.poll('fileUploaded')).items.map((item) => item.externalId)).toEqual(['file-new'])
    expect(await harness.pollTwice('fileUploaded')).toEqual([])
  })

  it('keeps the file sitting on the watermark second so the SDK can recognise it by id', async () => {
    const since = NOW_S - 100
    const files = [file('file-after', since + 1), file('file-on', since), file('file-before', since - 1)]
    const { harness } = connectorWith([{ match: '/files', body: list(files) }])
    const page = await harness.poll('fileUploaded', { since: new Date(since * 1000).toISOString() })
    expect(page.items.map((item) => item.externalId)).toEqual(['file-on', 'file-after'])
  })

  it('pages until a page reaches below the watermark', async () => {
    const since = NOW_S - 100
    let served = 0
    const pages = [list([file('file-a', NOW_S - 10)], true), list([file('file-b', since - 5)], true), list([file('file-c', 1)], true)]
    const { harness, calls } = connectorWith([{ match: '/files', body: () => pages[served++] }])
    const page = await harness.poll('fileUploaded', { since: new Date(since * 1000).toISOString() })
    expect(calls).toHaveLength(2)
    expect(page.items.map((item) => item.externalId)).toEqual(['file-a'])
  })
})

describe('fineTuningJobFinished', () => {
  it('delivers finished jobs, keyed by id and status, oldest finish first', async () => {
    const jobs = [
      job('ftjob-running', 'running', NOW_S - 100, null),
      job('ftjob-failed', 'failed', NOW_S - 3 * HOUR, NOW_S - 10),
      job('ftjob-done', 'succeeded', NOW_S - 5 * HOUR, NOW_S - 20)
    ]
    const { harness, calls } = connectorWith([{ match: '/fine_tuning/jobs', body: list(jobs) }])
    const page = await harness.poll('fineTuningJobFinished')
    expect(calls[0]!.url).toBe(`${API_ROOT}/fine_tuning/jobs?limit=${PAGE_SIZE}`)
    expect(page.items.map((item) => item.externalId)).toEqual(['ftjob-done:succeeded', 'ftjob-failed:failed'])
    expect(page.items[0]!.url).toBe('https://platform.openai.com/finetune/ftjob-done')
    expect(await harness.pollTwice('fineTuningJobFinished')).toEqual([])
  })

  it('emits only jobs finished since the watermark, and uses creation when finished_at is null', async () => {
    const since = NOW_S - HOUR
    const jobs = [
      job('ftjob-late', 'succeeded', NOW_S - 30 * HOUR, since + 5),
      job('ftjob-early', 'succeeded', NOW_S - 30 * HOUR, since - 5),
      job('ftjob-cancelled', 'cancelled', since + 1, null)
    ]
    const { harness } = connectorWith([{ match: '/fine_tuning/jobs', body: list(jobs) }])
    const page = await harness.poll('fineTuningJobFinished', { since: new Date(since * 1000).toISOString() })
    expect(page.items.map((item) => item.externalId)).toEqual(['ftjob-cancelled:cancelled', 'ftjob-late:succeeded'])
  })

  it('looks a week back on the first poll and pages a look-back further on created_at', async () => {
    const lookback = DEFAULT_FINE_TUNING_LOOKBACK_HOURS * HOUR
    let served = 0
    const pages = [
      list([job('ftjob-a', 'succeeded', NOW_S - 10, NOW_S - 5)], true),
      list([job('ftjob-b', 'succeeded', NOW_S - 2 * lookback - 10, NOW_S - lookback - 5)], true),
      list([job('ftjob-c', 'succeeded', NOW_S - 3 * lookback, NOW_S - 3 * lookback)], true)
    ]
    const { harness, calls } = connectorWith([{ match: '/fine_tuning/jobs', body: () => pages[served++] }])
    const page = await harness.poll('fineTuningJobFinished')
    expect(calls).toHaveLength(2)
    expect(page.items.map((item) => item.externalId)).toEqual(['ftjob-a:succeeded'])
  })
})

describe('createResponse', () => {
  const RESPONSE = {
    id: 'resp_1',
    status: 'completed',
    model: 'gpt-4o-mini-2024-07-18',
    output: [{ type: 'message', content: [{ type: 'output_text', text: '{"answer":42}' }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, output_tokens_details: { reasoning_tokens: 2 } },
    incomplete_details: null
  }

  it('sends text input with store off and gathers the text', async () => {
    const { harness, calls } = connectorWith([{ match: '/responses', method: 'POST', body: RESPONSE }])
    const result = await harness.execute('createResponse', { model: 'gpt-4o-mini', input: 'hi' })
    expect(calls[0]!.body).toEqual({ model: 'gpt-4o-mini', input: 'hi', store: false })
    expect(result).toEqual({
      id: 'resp_1',
      status: 'completed',
      text: '{"answer":42}',
      json: null,
      model: 'gpt-4o-mini-2024-07-18',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, reasoning_tokens: 2 },
      incompleteReason: null,
      response: RESPONSE
    })
  })

  it('sends messages, instructions, limits, the schema as a strict format, and parses the json', async () => {
    const { harness, calls } = connectorWith([{ match: '/responses', method: 'POST', body: RESPONSE }])
    const result = await harness.execute('createResponse', {
      model: 'gpt-4o-mini',
      input: '[{"role":"user","content":"hi"}]',
      instructions: 'Be brief',
      temperature: '0.2',
      maxOutputTokens: '64',
      schema: '{"type":"object","properties":{"answer":{"type":"number"}},"required":["answer"],"additionalProperties":false}',
      schemaName: 'answer',
      store: 'true'
    })
    expect(calls[0]!.body).toEqual({
      model: 'gpt-4o-mini',
      input: [{ role: 'user', content: 'hi' }],
      store: true,
      instructions: 'Be brief',
      temperature: 0.2,
      max_output_tokens: 64,
      text: {
        format: {
          type: 'json_schema',
          name: 'answer',
          schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false },
          strict: true
        }
      }
    })
    expect(result.json).toEqual({ answer: 42 })
  })

  it('names the default schema name, reports an incomplete response and copes with an empty body', async () => {
    const incomplete = { ...RESPONSE, status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' } }
    const { harness, calls } = connectorWith([{ match: '/responses', method: 'POST', body: incomplete }])
    const result = await harness.execute('createResponse', { model: 'm', input: 'x', schema: '{}' })
    expect((calls[0]!.body as { text: { format: { name: string } } }).text.format.name).toBe('output')
    expect(result).toMatchObject({ status: 'incomplete', text: '', json: null, incompleteReason: 'max_output_tokens' })

    const bare = connectorWith([{ match: '/responses', method: 'POST', body: {} }])
    expect(await bare.harness.execute('createResponse', { model: 'm', input: 'x' })).toEqual({
      id: null,
      status: null,
      text: '',
      json: null,
      model: null,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, reasoning_tokens: 0 },
      incompleteReason: null,
      response: {}
    })
  })

  it('refuses a schema that is not an object and requires the model', async () => {
    const { harness, calls } = connectorWith([])
    await expect(harness.execute('createResponse', { model: 'm', input: 'x', schema: '[1]' })).rejects.toThrow('schema must be a JSON object')
    await expect(harness.execute('createResponse', { input: 'x' })).rejects.toThrow(/requires "model"/)
    await expect(harness.execute('createResponse', { model: ' ', input: 'x' })).rejects.toThrow('model is required')
    expect(calls).toHaveLength(0)
  })

  it('surfaces the API error with its code', async () => {
    const { harness } = connectorWith([
      { match: '/responses', method: 'POST', status: 404, body: { error: { message: 'The model does not exist', type: 'invalid_request_error', code: 'model_not_found', param: 'model' } } }
    ])
    await expect(harness.execute('createResponse', { model: 'nope', input: 'x' })).rejects.toThrow('404 model_not_found: The model does not exist')
  })
})

describe('createChatCompletion', () => {
  const COMPLETION = {
    id: 'chatcmpl-1',
    model: 'gpt-4o-mini-2024-07-18',
    choices: [{ message: { content: 'Hello!', refusal: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
  }

  it('sends the messages and the optional fields under their API names', async () => {
    const { harness, calls } = connectorWith([{ match: '/chat/completions', method: 'POST', body: COMPLETION }])
    const result = await harness.execute('createChatCompletion', {
      model: 'gpt-4o-mini',
      messages: '[{"role":"user","content":"hi"}]',
      temperature: '1',
      maxTokens: '20',
      responseFormat: '{"type":"json_object"}'
    })
    expect(calls[0]!.body).toEqual({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 1,
      max_completion_tokens: 20,
      response_format: { type: 'json_object' }
    })
    expect(result).toEqual({
      id: 'chatcmpl-1',
      text: 'Hello!',
      finishReason: 'stop',
      refusal: null,
      model: 'gpt-4o-mini-2024-07-18',
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      completion: COMPLETION
    })
  })

  it('takes one message object, and copes with a refusal or an empty body', async () => {
    const refused = { ...COMPLETION, choices: [{ message: { content: null, refusal: 'No' }, finish_reason: 'stop' }] }
    const { harness, calls } = connectorWith([{ match: '/chat/completions', method: 'POST', body: refused }])
    const result = await harness.execute('createChatCompletion', { model: 'm', messages: '{"role":"user","content":"hi"}' })
    expect((calls[0]!.body as { messages: unknown[] }).messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(result).toMatchObject({ text: '', refusal: 'No' })

    const bare = connectorWith([{ match: '/chat/completions', method: 'POST', body: {} }])
    expect(await bare.harness.execute('createChatCompletion', { model: 'm', messages: '{}' })).toEqual({
      id: null,
      text: '',
      finishReason: null,
      refusal: null,
      model: null,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      completion: {}
    })
  })

  it('refuses messages that are not JSON or not objects', async () => {
    const { harness } = connectorWith([])
    await expect(harness.execute('createChatCompletion', { model: 'm', messages: 'hi' })).rejects.toThrow(/Expected JSON/)
    await expect(harness.execute('createChatCompletion', { model: 'm', messages: '["hi"]' })).rejects.toThrow(/messages must be/)
  })
})

describe('createEmbeddings', () => {
  it('embeds text and orders the vectors by index', async () => {
    const body = {
      model: 'text-embedding-3-small',
      data: [{ index: 1, embedding: [0.3, 0.4] }, { index: 0, embedding: [0.1, 0.2] }],
      usage: { prompt_tokens: 2, total_tokens: 2 }
    }
    const { harness, calls } = connectorWith([{ match: '/embeddings', method: 'POST', body }])
    const result = await harness.execute('createEmbeddings', { model: 'text-embedding-3-small', input: '["a","b"]', dimensions: '2' })
    expect(calls[0]!.body).toEqual({ model: 'text-embedding-3-small', input: ['a', 'b'], dimensions: 2 })
    expect(result).toEqual({
      embeddings: [[0.1, 0.2], [0.3, 0.4]],
      dimensions: 2,
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 2, total_tokens: 2 }
    })
  })

  it('sends plain text as text and copes with an empty body', async () => {
    const { harness, calls } = connectorWith([{ match: '/embeddings', method: 'POST', body: { data: [{}] } }])
    const result = await harness.execute('createEmbeddings', { model: 'text-embedding-3-small', input: 'hello' })
    expect(calls[0]!.body).toEqual({ model: 'text-embedding-3-small', input: 'hello' })
    expect(result).toEqual({ embeddings: [[]], dimensions: 0, model: null, usage: { prompt_tokens: 0, total_tokens: 0 } })
  })
})

describe('moderateText', () => {
  it('reports whether anything was flagged and passes the results through', async () => {
    const body = { id: 'modr-1', model: 'omni-moderation-latest', results: [{ flagged: false, categories: {} }, { flagged: true, categories: {} }] }
    const { harness, calls } = connectorWith([{ match: '/moderations', method: 'POST', body }])
    const result = await harness.execute('moderateText', { input: '["hello","bad"]', model: 'omni-moderation-latest' })
    expect(calls[0]!.body).toEqual({ input: ['hello', 'bad'], model: 'omni-moderation-latest' })
    expect(result).toEqual({ flagged: true, results: body.results, model: 'omni-moderation-latest', id: 'modr-1' })
  })

  it('leaves the model to the API by default and copes with an empty body', async () => {
    const { harness, calls } = connectorWith([{ match: '/moderations', method: 'POST', body: {} }])
    expect(await harness.execute('moderateText', { input: 'hello' })).toEqual({ flagged: false, results: [], model: null, id: null })
    expect(calls[0]!.body).toEqual({ input: 'hello' })
  })
})

describe('models', () => {
  it('lists models with ISO times and a count', async () => {
    const body = list([{ id: 'gpt-4o-mini', object: 'model', created: 1721172741, owned_by: 'system' }])
    const { harness, calls } = connectorWith([{ match: '/models', body }])
    expect(await harness.execute('listModels')).toEqual({
      models: [{ id: 'gpt-4o-mini', created: '2024-07-16T23:32:21.000Z', ownedBy: 'system', shutdownDate: null }],
      count: 1
    })
    expect(calls[0]!.url).toBe(`${API_ROOT}/models`)
    const bare = connectorWith([{ match: '/models', body: {} }])
    expect(await bare.harness.execute('listModels')).toEqual({ models: [], count: 0 })
  })

  it('reads one model by an escaped id', async () => {
    const { harness, calls } = connectorWith([{ match: '/models/', body: { id: 'ft:gpt-4o-mini:org::abc', created: 1721172741, owned_by: 'org-1' } }])
    expect(await harness.execute('getModel', { model: 'ft:gpt-4o-mini:org::abc' })).toEqual({
      id: 'ft:gpt-4o-mini:org::abc',
      created: '2024-07-16T23:32:21.000Z',
      ownedBy: 'org-1',
      shutdownDate: null
    })
    expect(calls[0]!.url).toBe(`${API_ROOT}/models/ft%3Agpt-4o-mini%3Aorg%3A%3Aabc`)
    const empty = connectorWith([{ match: '/models/', body: null }])
    expect(await empty.harness.execute('getModel', { model: 'gpt-4o-mini' })).toMatchObject({ id: 'gpt-4o-mini', created: null })
  })
})

describe('listFiles', () => {
  it('passes the filters through and summarises the page', async () => {
    const body = list([file('file-1', 1613677385)], true)
    const { harness, calls } = connectorWith([{ match: '/files', body }])
    const result = await harness.execute('listFiles', { purpose: 'batch', limit: '5', order: 'asc', after: 'file-0' })
    expect(calls[0]!.url).toBe(`${API_ROOT}/files?purpose=batch&limit=5&order=asc&after=file-0`)
    expect(result).toEqual({
      files: [{ id: 'file-1', filename: 'salesOverview.pdf', bytes: 175, purpose: 'batch', createdAt: '2021-02-18T19:43:05.000Z', expiresAt: '2023-02-28T19:56:42.000Z' }],
      hasMore: true,
      lastId: 'file-1'
    })
  })

  it('defaults the limit to 100 and copes with a bare or unpaged answer', async () => {
    const { harness, calls } = connectorWith([{ match: '/files', body: {} }])
    expect(await harness.execute('listFiles')).toEqual({ files: [], hasMore: false, lastId: null })
    expect(calls[0]!.url).toBe(`${API_ROOT}/files?limit=100`)
    const unpaged = connectorWith([{ match: '/files', body: { data: [file('file-9', 1)] } }])
    expect(await unpaged.harness.execute('listFiles')).toMatchObject({ lastId: 'file-9', hasMore: false })
  })
})

describe('batches', () => {
  it('reads a batch by id, taking $NAME from the environment', async () => {
    const { harness, calls } = connectorWith([{ match: '/batches/batch_abc123', body: SAMPLE_BATCH }], CONFIG, { OPENAI_BATCH_ID: 'batch_abc123' })
    const result = await harness.execute('getBatch', { batch: '$OPENAI_BATCH_ID' })
    expect(calls[0]!.url).toBe(`${API_ROOT}/batches/batch_abc123`)
    expect(result).toMatchObject({ id: 'batch_abc123', status: 'completed', requestCounts: { total: 100, completed: 95, failed: 5 } })
  })

  it('says the id is required when the environment lacks it, and copes with an empty answer', async () => {
    const { harness, calls } = connectorWith([{ match: '/batches/', body: null }])
    await expect(harness.execute('getBatch', { batch: '$OPENAI_BATCH_ID' })).rejects.toThrow('batch is required')
    expect(calls).toHaveLength(0)
    expect(await harness.execute('getBatch', { batch: 'batch_x' })).toMatchObject({ id: 'batch_x', status: null })
  })

  it('creates a batch with the file, endpoint, window and metadata', async () => {
    const { harness, calls } = connectorWith([{ match: '/batches', method: 'POST', body: SAMPLE_BATCH }])
    const result = await harness.execute('createBatch', {
      inputFileId: 'file-abc123',
      endpoint: '/v1/chat/completions',
      completionWindow: '24h',
      metadata: '{"customer_id":"user_123456789"}'
    })
    expect(calls[0]!.body).toEqual({
      input_file_id: 'file-abc123',
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
      metadata: { customer_id: 'user_123456789' }
    })
    expect(result).toMatchObject({ id: 'batch_abc123', endpoint: '/v1/chat/completions', createdAt: '2024-03-26T16:45:33.000Z' })
  })

  it('defaults the window, requires the file and endpoint, and copes with an empty answer', async () => {
    const { harness, calls } = connectorWith([{ match: '/batches', method: 'POST', body: null }])
    expect(await harness.execute('createBatch', { inputFileId: 'file-1', endpoint: '/v1/embeddings' })).toMatchObject({ id: '', status: null })
    expect(calls[0]!.body).toEqual({ input_file_id: 'file-1', endpoint: '/v1/embeddings', completion_window: '24h' })
    await expect(harness.execute('createBatch', { endpoint: '/v1/embeddings' })).rejects.toThrow(/requires "inputFileId"/)
    await expect(harness.execute('createBatch', { inputFileId: 'file-1', endpoint: '/v1/embeddings', metadata: '[]' })).rejects.toThrow('metadata must be a JSON object')
  })
})

describe('rate limits through the harness', () => {
  it('retries a limited poll once and warns about it', async () => {
    let served = 0
    const { harness, warnings } = connectorWith([
      {
        match: '/files',
        body: () => (served++ === 0 ? { error: { message: 'slow down', type: 'rate_limit_error' } } : list([file('file-1', NOW_S - 10)])),
        get status() {
          return served <= 1 ? 429 : 200
        },
        headers: { 'retry-after': '1' }
      }
    ])
    const page = await harness.poll('fileUploaded')
    expect(page.items).toHaveLength(1)
    expect(warnings[0]).toMatch(/rate limited/)
  })
})
