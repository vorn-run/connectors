import {
  defineConnector,
  type ConnectorConfig,
  type ConnectorItem,
  type FetchContext
} from '@vornrun/connector-sdk'
import {
  KEY_HINT,
  createOpenAIClient,
  normalizeKey,
  type FetchLike,
  type OpenAIClient,
  type Sleep,
  type Warn
} from './client'
import {
  SAMPLE_BATCH_ITEM,
  SAMPLE_FILE_ITEM,
  SAMPLE_FINE_TUNING_JOB_ITEM,
  batchFinishedAt,
  batchOutput,
  batchToItem,
  fileSummary,
  fileToItem,
  fineTuningJobToItem,
  isBatchTerminal,
  isFineTuningTerminal,
  isoOf,
  jobFinishedAt,
  modelSummary,
  secondsOf,
  type OpenAIBatch,
  type OpenAIFile,
  type OpenAIFineTuningJob,
  type OpenAIList,
  type OpenAIModel
} from './items'
// Bundled at build time: a pack is one file, so a version read from disk is not there to read.
import pkg from '../package.json'

/** Objects asked for per page; the most batches and jobs allow. */
export const PAGE_SIZE = 100

/** Pages one poll walks before leaving the rest for the next. */
export const MAX_PAGES = 5

export const DEFAULT_BATCH_LOOKBACK_HOURS = 48

export const DEFAULT_FINE_TUNING_LOOKBACK_HOURS = 168

// Where the very first poll starts, before any watermark exists.
export const FIRST_POLL_BATCH_HOURS = 24 * 7

export const FIRST_POLL_FILE_HOURS = 1

export const DEFAULT_LIST_FILES_LIMIT = 100

export const DEFAULT_SCHEMA_NAME = 'output'

export const BATCH_ENDPOINTS = [
  '/v1/responses',
  '/v1/chat/completions',
  '/v1/embeddings',
  '/v1/completions',
  '/v1/moderations',
  '/v1/images/generations',
  '/v1/images/edits',
  '/v1/videos'
] as const

export const FILE_PURPOSES = [
  'assistants',
  'assistants_output',
  'batch',
  'batch_output',
  'fine-tune',
  'fine-tune-results',
  'vision',
  'user_data'
] as const

const HOUR_MS = 3_600_000

export interface OpenAIConnectorOptions {
  version?: string
  /** Injected in tests, so nothing reaches the network. */
  fetchImpl?: FetchLike
  /** Injected in tests, so no test spends real time asleep. */
  sleep?: Sleep
  /** Advisories go to stderr: stdout carries the MCP protocol. */
  warn?: Warn
  /** Where preflight and `$NAME` samples read from; defaults to the process environment. */
  env?: NodeJS.ProcessEnv
}

/* --------------------------------------------------------------- config -- */

function text(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim()
  return trimmed === '' ? undefined : trimmed
}

function hours(value: unknown, env: string, fallback: number): number {
  const raw = text(value)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${env} must be a number of hours of at least 0, got "${raw}"`)
  }
  return parsed
}

export interface Settings {
  apiKey: string
  organization?: string
  project?: string
  batchEndpoint?: string
  batchLookbackHours: number
  filePurpose?: string
  fineTuningLookbackHours: number
}

export function readSettings(config: ConnectorConfig): Settings {
  const organization = text(config.organization)
  const project = text(config.project)
  const batchEndpoint = text(config.batchEndpoint)
  const filePurpose = text(config.filePurpose)
  return {
    apiKey: normalizeKey(config.apiKey),
    ...(organization && { organization }),
    ...(project && { project }),
    ...(batchEndpoint && { batchEndpoint }),
    batchLookbackHours: hours(config.batchLookbackHours, 'OPENAI_BATCH_LOOKBACK_HOURS', DEFAULT_BATCH_LOOKBACK_HOURS),
    ...(filePurpose && { filePurpose }),
    fineTuningLookbackHours: hours(
      config.fineTuningLookbackHours,
      'OPENAI_FINE_TUNING_LOOKBACK_HOURS',
      DEFAULT_FINE_TUNING_LOOKBACK_HOURS
    )
  }
}

/* ---------------------------------------------------------------- input -- */

// Text is sent as text; a value that parses as a JSON array is sent as the array. Anything else is text.
export function textOrJsonArray(value: unknown): string | unknown[] {
  const raw = String(value ?? '')
  if (raw.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // Not JSON after all: a prompt may open with a bracket.
    }
  }
  return raw
}

export function messageList(value: unknown, key = 'messages'): Record<string, unknown>[] {
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0) throw new Error(`${key} must hold at least one message`)
  for (const message of list) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      throw new Error(`${key} must be a JSON array of { role, content } objects`)
    }
  }
  return list as Record<string, unknown>[]
}

export function jsonObject(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} must be a JSON object`)
  return value as Record<string, unknown>
}

function number(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function flag(value: unknown): boolean {
  return /^(true|1|yes)$/i.test(String(value ?? '').trim())
}

/* -------------------------------------------------------------- outputs -- */

interface ResponseObject {
  id?: string
  status?: string
  model?: string
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    output_tokens_details?: { reasoning_tokens?: number }
  }
  incomplete_details?: { reason?: string } | null
}

// The HTTP body has no `output_text`; that is an SDK convenience, so the text is gathered here.
export function responseText(response: ResponseObject): string {
  const parts: string[] = []
  for (const item of response.output ?? []) {
    if (item?.type !== 'message') continue
    for (const part of item.content ?? []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') parts.push(part.text)
    }
  }
  return parts.join('')
}

function parsedJson(textValue: string): unknown {
  try {
    return JSON.parse(textValue)
  } catch {
    return null
  }
}

interface ChatCompletion {
  id?: string
  model?: string
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

interface EmbeddingsResponse {
  model?: string
  data?: Array<{ index?: number; embedding?: number[] }>
  usage?: { prompt_tokens?: number; total_tokens?: number }
}

interface ModerationResponse {
  id?: string
  model?: string
  results?: Array<{ flagged?: boolean }>
}

/* ------------------------------------------------------------ connector -- */

export function createOpenAIConnector(options: OpenAIConnectorOptions = {}) {
  const version = options.version ?? '0.0.0'
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const env = options.env ?? process.env

  // A `$NAME` argument reads the environment: the live sample names an id only the machine running it knows.
  function fromEnv(value: unknown): string | undefined {
    const raw = text(value)
    if (raw === undefined) return undefined
    const match = /^\$([A-Z][A-Z0-9_]*)$/.exec(raw)
    return match ? text(env[match[1]!]) : raw
  }

  function clientFor(config: ConnectorConfig, fetchImpl?: typeof fetch): OpenAIClient {
    const settings = readSettings(config)
    return createOpenAIClient({
      apiKey: settings.apiKey,
      ...(settings.organization && { organization: settings.organization }),
      ...(settings.project && { project: settings.project }),
      fetchImpl: options.fetchImpl ?? (fetchImpl as FetchLike | undefined),
      ...(options.sleep && { sleep: options.sleep }),
      warn
    })
  }

  /* ---------------------------------------------------------- triggers -- */

  // Walks `after` pages newest-first until a page ends below `floor` seconds, the list ends, or the page cap.
  async function walk<T extends { id: string; created_at?: number }>(
    client: OpenAIClient,
    path: string,
    query: Record<string, string | number | undefined>,
    floor: number
  ): Promise<T[]> {
    const collected = new Map<string, T>()
    let after: string | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await client.get<OpenAIList<T>>(path, { ...query, limit: PAGE_SIZE, after })
      const data = Array.isArray(body?.data) ? body.data : []
      for (const entry of data) if (entry?.id) collected.set(entry.id, entry)
      if (data.length === 0 || body.has_more !== true) break
      const oldest = Math.min(...data.map((entry) => entry.created_at ?? Number.POSITIVE_INFINITY))
      if (oldest < floor) break
      after = body.last_id ?? data[data.length - 1]!.id
    }
    return [...collected.values()]
  }

  function sinceSeconds(context: FetchContext): number | undefined {
    return context.since ? secondsOf(context.since) : undefined
  }

  async function fetchBatches(context: FetchContext): Promise<ConnectorItem[]> {
    const settings = readSettings(context.config)
    const client = clientFor(context.config, context.fetch)
    const since = sinceSeconds(context)
    const firstPollFloor = secondsOf(context.now()) - FIRST_POLL_BATCH_HOURS * 3600
    // A batch finishes up to a day after creation and expires later still, so paging reads back a look-back before the watermark.
    const pagingFloor = since === undefined ? firstPollFloor : since - settings.batchLookbackHours * 3600
    const batches = await walk<OpenAIBatch>(client, 'batches', {}, pagingFloor)
    return batches
      .filter((batch) => isBatchTerminal(batch.status))
      .filter((batch) => settings.batchEndpoint === undefined || batch.endpoint === settings.batchEndpoint)
      .filter((batch) => since !== undefined || (batchFinishedAt(batch) ?? 0) >= firstPollFloor)
      .sort((left, right) => (batchFinishedAt(left) ?? 0) - (batchFinishedAt(right) ?? 0))
      .map(batchToItem)
  }

  async function fetchFiles(context: FetchContext): Promise<ConnectorItem[]> {
    const settings = readSettings(context.config)
    const client = clientFor(context.config, context.fetch)
    const floor = sinceSeconds(context) ?? secondsOf(context.now()) - FIRST_POLL_FILE_HOURS * 3600
    const files = await walk<OpenAIFile>(client, 'files', { order: 'desc', purpose: settings.filePurpose }, floor)
    return files
      .filter((file) => (file.created_at ?? 0) >= floor)
      .sort((left, right) => (left.created_at ?? 0) - (right.created_at ?? 0))
      .map(fileToItem)
  }

  async function fetchFineTuningJobs(context: FetchContext): Promise<ConnectorItem[]> {
    const settings = readSettings(context.config)
    const client = clientFor(context.config, context.fetch)
    const lookback = settings.fineTuningLookbackHours * 3600
    const since = sinceSeconds(context) ?? secondsOf(context.now()) - lookback
    // Jobs are created long before they finish, so paging on `created_at` reaches a look-back further back than the watermark.
    const jobs = await walk<OpenAIFineTuningJob>(client, 'fine_tuning/jobs', {}, since - lookback)
    return jobs
      .filter((job) => isFineTuningTerminal(job.status))
      .filter((job) => (jobFinishedAt(job) ?? 0) >= since)
      .sort((left, right) => (jobFinishedAt(left) ?? 0) - (jobFinishedAt(right) ?? 0))
      .map(fineTuningJobToItem)
  }

  /* ----------------------------------------------------------- actions -- */

  function requiredArg(args: Record<string, unknown>, key: string): string {
    const value = fromEnv(args[key])
    if (!value) throw new Error(`${key} is required`)
    return value
  }

  const MODEL_INPUT = {
    key: 'model',
    label: 'Model',
    required: true,
    description: 'Model id, such as gpt-4o-mini.',
    builderHint: 'Any id listModels returns. A fine-tuned model is its ft:… id.'
  }

  const TEMPERATURE_INPUT = {
    key: 'temperature',
    label: 'Temperature',
    type: 'number' as const,
    description: 'Sampling temperature, 0 to 2. Lower is more deterministic.',
    builderHint: 'Alter this or top_p, not both; leave empty for the model default of 1.'
  }

  return defineConnector({
    id: 'openai',
    name: 'OpenAI',
    version,
    description:
      'Trigger workflows when an OpenAI batch or fine-tuning job finishes or a file is uploaded, and create responses, chat completions, embeddings, moderations and batches from a step.',
    auth: { rung: 'key', keys: ['apiKey'] },
    // The hexagonal knot: six interlaced loops as one path, the counters punched through by the evenodd rule.
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z'
      ]
    },
    config: [
      {
        key: 'apiKey',
        env: 'OPENAI_API_KEY',
        label: 'API key',
        secret: true,
        required: true,
        description: `Sent as \`Authorization: Bearer <key>\`. ${KEY_HINT}`,
        builderHint:
          'A standard or project key (sk-… or sk-proj-…), not an Admin key: Admin keys serve only the Administration API. Permissions are set per key at creation; a key that lacks an endpoint answers 401 insufficient permissions. Pasted whitespace is trimmed.'
      },
      {
        key: 'organization',
        env: 'OPENAI_ORGANIZATION',
        label: 'Organization',
        description:
          'Organization id (org-…), sent as OpenAI-Organization. Only needed when the key belongs to more than one organization.',
        builderHint: 'Settings → Organization → General. Leave empty for a project key, which is already scoped.'
      },
      {
        key: 'project',
        env: 'OPENAI_PROJECT',
        label: 'Project',
        description:
          'Project id (proj_…), sent as OpenAI-Project. Only needed when a legacy user key should bill one project.',
        builderHint: 'Settings → Project → General. Leave empty for a project key.'
      },
      {
        key: 'batchEndpoint',
        env: 'OPENAI_BATCH_ENDPOINT',
        label: 'Batch endpoint filter',
        description: 'Only batches for this endpoint, such as /v1/chat/completions. Empty delivers every batch.',
        builderHint: 'The list has no server-side filter; the connector compares the batch object’s endpoint field.'
      },
      {
        key: 'batchLookbackHours',
        env: 'OPENAI_BATCH_LOOKBACK_HOURS',
        label: 'Batch look-back (hours)',
        default: String(DEFAULT_BATCH_LOOKBACK_HOURS),
        description:
          'How far before the watermark the batch poll reads, because a batch finishes up to a day after it is created.',
        builderHint: 'Raise it if batches take longer than two days to finish or expire; lower it for a busy account.'
      },
      {
        key: 'filePurpose',
        env: 'OPENAI_FILE_PURPOSE',
        label: 'File purpose filter',
        description: `Only files uploaded with this purpose (${FILE_PURPOSES.join(', ')}). Empty delivers every file.`,
        builderHint: 'Passed through as the purpose query parameter, so the API does the filtering.'
      },
      {
        key: 'fineTuningLookbackHours',
        env: 'OPENAI_FINE_TUNING_LOOKBACK_HOURS',
        label: 'Fine-tuning look-back (hours)',
        default: String(DEFAULT_FINE_TUNING_LOOKBACK_HOURS),
        description:
          'How far before the watermark the fine-tuning poll reads, because a job is created long before it finishes.',
        builderHint: 'A week by default. Jobs that queue longer than this before finishing are missed.'
      }
    ],
    async preflight() {
      const key = text(env.OPENAI_API_KEY)
      if (!key) return { ok: false, message: `Set OPENAI_API_KEY. ${KEY_HINT}` }
      const client = createOpenAIClient({
        apiKey: normalizeKey(key),
        ...(text(env.OPENAI_ORGANIZATION) && { organization: text(env.OPENAI_ORGANIZATION) }),
        ...(text(env.OPENAI_PROJECT) && { project: text(env.OPENAI_PROJECT) }),
        ...(options.fetchImpl && { fetchImpl: options.fetchImpl }),
        ...(options.sleep && { sleep: options.sleep }),
        warn
      })
      const models = await client.get<OpenAIList<OpenAIModel>>('models')
      const count = Array.isArray(models?.data) ? models.data.length : 0
      return { ok: true, message: `Signed in; ${count} models available` }
    },
    triggers: [
      {
        type: 'batchFinished',
        label: 'A batch finishes',
        description:
          'Fires once when a batch reaches completed, failed, expired or cancelled. The list has no status filter, so every batch created inside the look-back is read and the terminal ones kept.',
        defaultWorkflow: { name: 'OpenAI: finished batches', defaultCronFromMinutes: 5 },
        statusMapping: [
          { upstream: 'completed', suggestedLocal: 'done' },
          { upstream: 'failed', suggestedLocal: 'todo' },
          { upstream: 'expired', suggestedLocal: 'cancelled' },
          { upstream: 'cancelled', suggestedLocal: 'cancelled' }
        ],
        dedupe: 'timestamp',
        sample: [SAMPLE_BATCH_ITEM],
        fetch: fetchBatches
      },
      {
        type: 'fileUploaded',
        label: 'A file is uploaded',
        description: 'Fires once per file uploaded since the last poll, newest first from GET /files.',
        defaultWorkflow: { name: 'OpenAI: uploaded files', defaultCronFromMinutes: 5 },
        dedupe: 'timestamp',
        sample: [SAMPLE_FILE_ITEM],
        fetch: fetchFiles
      },
      {
        type: 'fineTuningJobFinished',
        label: 'A fine-tuning job finishes',
        description: 'Fires once when a fine-tuning job reaches succeeded, failed or cancelled.',
        defaultWorkflow: { name: 'OpenAI: finished fine-tuning jobs', defaultCronFromMinutes: 15 },
        statusMapping: [
          { upstream: 'succeeded', suggestedLocal: 'done' },
          { upstream: 'failed', suggestedLocal: 'todo' },
          { upstream: 'cancelled', suggestedLocal: 'cancelled' }
        ],
        dedupe: 'timestamp',
        sample: [SAMPLE_FINE_TUNING_JOB_ITEM],
        fetch: fetchFineTuningJobs
      }
    ],
    actions: [
      {
        type: 'createResponse',
        label: 'Create a response',
        description:
          'Ask a model for a response with the Responses API, optionally constrained to a JSON schema. Spends tokens; not stored unless asked.',
        idempotent: false,
        inputs: [
          MODEL_INPUT,
          {
            key: 'input',
            label: 'Input',
            required: true,
            description:
              'Plain text, or a JSON array of message items { role, content } with role user, assistant, system or developer.',
            builderHint: 'A value that parses as a JSON array is sent as the array; anything else is sent as text.'
          },
          {
            key: 'instructions',
            label: 'Instructions',
            description: 'A system or developer message inserted into the model’s context.',
            builderHint: 'Prefer this over a system message in input; it is not carried into a later turn.'
          },
          TEMPERATURE_INPUT,
          {
            key: 'maxOutputTokens',
            label: 'Max output tokens',
            type: 'number',
            description: 'Upper bound on generated tokens, including reasoning tokens. Sent as max_output_tokens.',
            builderHint: 'The API refuses values under 16. A response cut here reports incompleteReason max_output_tokens.'
          },
          {
            key: 'schema',
            label: 'JSON schema',
            type: 'json',
            description: 'A JSON Schema object the output must match, sent as text.format json_schema with strict true.',
            builderHint:
              'Strict mode wants every property in required and additionalProperties false. The parsed result is the json output.'
          },
          {
            key: 'schemaName',
            label: 'Schema name',
            description: `Name of the format, letters, digits, underscores and dashes up to 64 characters. Default ${DEFAULT_SCHEMA_NAME}.`,
            builderHint: 'Only read when schema is given.'
          },
          {
            key: 'store',
            label: 'Store the response',
            type: 'boolean',
            description: 'Keep the response retrievable for 30 days. Off here by default, unlike the API.',
            builderHint: 'true when a later step needs previous_response_id.'
          }
        ],
        outputs: [
          { key: 'id', description: 'Response id' },
          { key: 'status', description: 'completed, incomplete, failed or in_progress' },
          { key: 'text', description: 'Every output_text part of every message, joined' },
          { key: 'json', description: 'The text parsed as JSON when a schema was given, else null' },
          { key: 'model', description: 'The model that answered' },
          { key: 'usage', description: '{ input_tokens, output_tokens, total_tokens, reasoning_tokens }' },
          { key: 'incompleteReason', description: 'Why the response stopped early, or null' },
          { key: 'response', description: 'The raw response object' }
        ],
        async run(args, context) {
          const schema = jsonObject(args.schema, 'schema')
          const schemaName = text(args.schemaName) ?? DEFAULT_SCHEMA_NAME
          const temperature = number(args.temperature)
          const maxOutputTokens = number(args.maxOutputTokens)
          const instructions = text(args.instructions)
          const client = clientFor(context.config, context.fetch)
          const response = await client.request<ResponseObject>('POST', 'responses', {
            body: {
              model: requiredArg(args, 'model'),
              input: textOrJsonArray(args.input),
              store: flag(args.store),
              ...(instructions && { instructions }),
              ...(temperature !== undefined && { temperature }),
              ...(maxOutputTokens !== undefined && { max_output_tokens: maxOutputTokens }),
              ...(schema && { text: { format: { type: 'json_schema', name: schemaName, schema, strict: true } } })
            }
          })
          const body = response ?? {}
          const output = responseText(body)
          return {
            id: body.id ?? null,
            status: body.status ?? null,
            text: output,
            json: schema ? parsedJson(output) : null,
            model: body.model ?? null,
            usage: {
              input_tokens: body.usage?.input_tokens ?? 0,
              output_tokens: body.usage?.output_tokens ?? 0,
              total_tokens: body.usage?.total_tokens ?? 0,
              reasoning_tokens: body.usage?.output_tokens_details?.reasoning_tokens ?? 0
            },
            incompleteReason: body.incomplete_details?.reason ?? null,
            response: body
          }
        }
      },
      {
        type: 'createChatCompletion',
        label: 'Create a chat completion',
        description: 'Ask a model for the next message in a conversation with the Chat Completions API. Spends tokens.',
        idempotent: false,
        inputs: [
          MODEL_INPUT,
          {
            key: 'messages',
            label: 'Messages',
            type: 'json',
            required: true,
            description: 'A JSON array of { role, content } with role system, developer, user, assistant or tool.',
            builderHint: 'One object is taken as a single message.'
          },
          TEMPERATURE_INPUT,
          {
            key: 'maxTokens',
            label: 'Max completion tokens',
            type: 'number',
            description: 'Upper bound on generated tokens, including reasoning tokens. Sent as max_completion_tokens.',
            builderHint: 'max_tokens is deprecated and refused by o-series models, so this never sends it.'
          },
          {
            key: 'responseFormat',
            label: 'Response format',
            type: 'json',
            description:
              'JSON: { "type": "text" }, { "type": "json_object" } or { "type": "json_schema", "json_schema": { name, schema, strict } }.',
            builderHint: 'json_object needs the word JSON somewhere in the messages or the API refuses.'
          }
        ],
        outputs: [
          { key: 'id', description: 'Completion id' },
          { key: 'text', description: 'Content of the first choice' },
          { key: 'finishReason', description: 'stop, length, tool_calls, content_filter or function_call' },
          { key: 'refusal', description: 'The refusal message of the first choice, or null' },
          { key: 'model', description: 'The model that answered' },
          { key: 'usage', description: '{ prompt_tokens, completion_tokens, total_tokens }' },
          { key: 'completion', description: 'The raw completion object' }
        ],
        async run(args, context) {
          const temperature = number(args.temperature)
          const maxTokens = number(args.maxTokens)
          const responseFormat = jsonObject(args.responseFormat, 'responseFormat')
          const client = clientFor(context.config, context.fetch)
          const completion = await client.request<ChatCompletion>('POST', 'chat/completions', {
            body: {
              model: requiredArg(args, 'model'),
              messages: messageList(args.messages),
              ...(temperature !== undefined && { temperature }),
              ...(maxTokens !== undefined && { max_completion_tokens: maxTokens }),
              ...(responseFormat && { response_format: responseFormat })
            }
          })
          const body = completion ?? {}
          const first = body.choices?.[0]
          return {
            id: body.id ?? null,
            text: first?.message?.content ?? '',
            finishReason: first?.finish_reason ?? null,
            refusal: first?.message?.refusal ?? null,
            model: body.model ?? null,
            usage: {
              prompt_tokens: body.usage?.prompt_tokens ?? 0,
              completion_tokens: body.usage?.completion_tokens ?? 0,
              total_tokens: body.usage?.total_tokens ?? 0
            },
            completion: body
          }
        }
      },
      {
        type: 'createEmbeddings',
        label: 'Create embeddings',
        description: 'Turn text into embedding vectors. The same input yields the same vectors and nothing is stored.',
        idempotent: true,
        sample: { model: 'text-embedding-3-small', input: 'hello' },
        inputs: [
          {
            ...MODEL_INPUT,
            description: 'text-embedding-3-small, text-embedding-3-large or text-embedding-ada-002.',
            builderHint: 'text-embedding-3-small is the cheapest; dimensions only works on the 3 series.'
          },
          {
            key: 'input',
            label: 'Input',
            required: true,
            description: 'Plain text, or a JSON array of strings to embed in one call.',
            builderHint: 'Each string at most 8192 tokens, an array at most 2048 entries.'
          },
          {
            key: 'dimensions',
            label: 'Dimensions',
            type: 'number',
            description: 'How many dimensions each vector should have. text-embedding-3 models only.',
            builderHint: 'Leave empty for the model default (1536 for small, 3072 for large).'
          }
        ],
        outputs: [
          { key: 'embeddings', description: 'Array of number arrays, in input order' },
          { key: 'dimensions', type: 'number', description: 'Length of the first vector' },
          { key: 'model', description: 'The model used' },
          { key: 'usage', description: '{ prompt_tokens, total_tokens }' }
        ],
        async run(args, context) {
          const dimensions = number(args.dimensions)
          const client = clientFor(context.config, context.fetch)
          const body = await client.request<EmbeddingsResponse>('POST', 'embeddings', {
            body: {
              model: requiredArg(args, 'model'),
              input: textOrJsonArray(args.input),
              ...(dimensions !== undefined && { dimensions })
            }
          })
          const embeddings = [...(body?.data ?? [])]
            .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
            .map((entry) => entry.embedding ?? [])
          return {
            embeddings,
            dimensions: embeddings[0]?.length ?? 0,
            model: body?.model ?? null,
            usage: { prompt_tokens: body?.usage?.prompt_tokens ?? 0, total_tokens: body?.usage?.total_tokens ?? 0 }
          }
        }
      },
      {
        type: 'moderateText',
        label: 'Moderate text',
        description: 'Classify text against OpenAI’s usage policies. Free, and nothing is stored.',
        idempotent: true,
        sample: { input: 'hello' },
        inputs: [
          {
            key: 'input',
            label: 'Input',
            required: true,
            description: 'Plain text, or a JSON array of strings to classify separately.',
            builderHint: 'One result per string, in order.'
          },
          {
            key: 'model',
            label: 'Model',
            description:
              'omni-moderation-latest (default), omni-moderation-2024-09-26, text-moderation-latest or text-moderation-stable.',
            builderHint: 'Leave empty for omni-moderation-latest.'
          }
        ],
        outputs: [
          { key: 'flagged', type: 'boolean', description: 'True when any result is flagged' },
          { key: 'results', description: 'Array of { flagged, categories, category_scores, category_applied_input_types }' },
          { key: 'model', description: 'The moderation model used' },
          { key: 'id', description: 'Moderation id' }
        ],
        async run(args, context) {
          const model = text(args.model)
          const client = clientFor(context.config, context.fetch)
          const body = await client.request<ModerationResponse>('POST', 'moderations', {
            body: { input: textOrJsonArray(args.input), ...(model && { model }) }
          })
          const results = Array.isArray(body?.results) ? body.results : []
          return {
            flagged: results.some((result) => result?.flagged === true),
            results,
            model: body?.model ?? null,
            id: body?.id ?? null
          }
        }
      },
      {
        type: 'listModels',
        label: 'List models',
        description: 'List the models the key can use, with their owner.',
        idempotent: true,
        sample: {},
        outputs: [
          { key: 'models', description: 'Array of { id, created, ownedBy, shutdownDate }' },
          { key: 'count', type: 'number', description: 'How many models' }
        ],
        async run(_args, context) {
          const client = clientFor(context.config, context.fetch)
          const body = await client.get<OpenAIList<OpenAIModel>>('models')
          const models = (Array.isArray(body?.data) ? body.data : []).map(modelSummary)
          return { models, count: models.length }
        }
      },
      {
        type: 'getModel',
        label: 'Get a model',
        description: 'Read one model by id. An unknown id answers 404 model_not_found.',
        idempotent: true,
        sample: { model: 'gpt-4o-mini' },
        inputs: [MODEL_INPUT],
        outputs: [
          { key: 'id', description: 'Model id' },
          { key: 'created', description: 'When it was created, ISO 8601' },
          { key: 'ownedBy', description: 'The organization that owns it' },
          { key: 'shutdownDate', description: 'Planned retirement date, or null' }
        ],
        async run(args, context) {
          const client = clientFor(context.config, context.fetch)
          const model = await client.get<OpenAIModel>(`models/${encodeURIComponent(requiredArg(args, 'model'))}`)
          return modelSummary(model ?? { id: requiredArg(args, 'model') })
        }
      },
      {
        type: 'listFiles',
        label: 'List files',
        description: 'List uploaded files, newest first, optionally by purpose.',
        idempotent: true,
        sample: { limit: '5' },
        inputs: [
          {
            key: 'purpose',
            label: 'Purpose',
            type: 'select',
            options: FILE_PURPOSES.map((value) => ({ value })),
            description: 'Only files uploaded with this purpose.',
            builderHint: 'Leave empty for every purpose.'
          },
          {
            key: 'limit',
            label: 'Limit',
            type: 'number',
            description: `1 to 10,000 files per page; default ${DEFAULT_LIST_FILES_LIMIT}.`,
            builderHint: 'The API default is 10,000, which is a lot to hand a workflow step.'
          },
          {
            key: 'order',
            label: 'Order',
            type: 'select',
            options: [{ value: 'desc', label: 'Newest first' }, { value: 'asc', label: 'Oldest first' }],
            description: 'Sort by created_at. Default desc.',
            builderHint: 'asc with after walks a backlog oldest first.'
          },
          {
            key: 'after',
            label: 'After',
            description: 'A file id from an earlier page; the list continues after it.',
            builderHint: 'Feed lastId from the previous call.'
          }
        ],
        outputs: [
          { key: 'files', description: 'Array of { id, filename, bytes, purpose, createdAt, expiresAt }' },
          { key: 'hasMore', type: 'boolean', description: 'Whether another page follows' },
          { key: 'lastId', description: 'Id of the last file listed, for after' }
        ],
        async run(args, context) {
          const client = clientFor(context.config, context.fetch)
          const body = await client.get<OpenAIList<OpenAIFile>>('files', {
            purpose: text(args.purpose),
            limit: number(args.limit) ?? DEFAULT_LIST_FILES_LIMIT,
            order: text(args.order),
            after: text(args.after)
          })
          const files = Array.isArray(body?.data) ? body.data : []
          return {
            files: files.map(fileSummary),
            hasMore: body?.has_more === true,
            lastId: body?.last_id ?? files[files.length - 1]?.id ?? null
          }
        }
      },
      {
        type: 'getBatch',
        label: 'Get a batch',
        description: 'Read one batch by id, with its status, request counts and output files.',
        idempotent: true,
        sample: { batch: '$OPENAI_BATCH_ID' },
        inputs: [
          {
            key: 'batch',
            label: 'Batch',
            required: true,
            description: 'Batch id, such as batch_abc123.',
            builderHint: 'Often {{trigger.item.id}} from the batch trigger. $NAME reads the environment for live checks.'
          }
        ],
        outputs: batchOutputs(),
        async run(args, context) {
          const client = clientFor(context.config, context.fetch)
          const id = requiredArg(args, 'batch')
          const batch = await client.get<OpenAIBatch>(`batches/${encodeURIComponent(id)}`)
          return batchOutput(batch ?? { id })
        }
      },
      {
        type: 'createBatch',
        label: 'Create a batch',
        description: 'Queue a batch of requests from an uploaded JSONL file. Each call queues a new batch that runs and bills.',
        idempotent: false,
        inputs: [
          {
            key: 'inputFileId',
            label: 'Input file',
            required: true,
            description: 'Id of an uploaded JSONL file with purpose batch, one request per line.',
            builderHint: 'Upload with the Files API first; this connector does not upload.'
          },
          {
            key: 'endpoint',
            label: 'Endpoint',
            type: 'select',
            required: true,
            options: BATCH_ENDPOINTS.map((value) => ({ value })),
            description: 'The endpoint every request in the file targets.',
            builderHint: 'Must match the url field of each line in the file.'
          },
          {
            key: 'completionWindow',
            label: 'Completion window',
            type: 'select',
            options: [{ value: '24h' }],
            description: 'How long the batch has to finish. Only 24h is supported; default 24h.',
            builderHint: 'Left as a select so a future window can be added without a code change.'
          },
          {
            key: 'metadata',
            label: 'Metadata',
            type: 'json',
            description: 'A JSON object of up to 16 string pairs, keys up to 64 characters and values up to 512.',
            builderHint: 'Comes back on the batch object and in the trigger item’s data.metadata.'
          }
        ],
        outputs: batchOutputs(),
        async run(args, context) {
          const metadata = jsonObject(args.metadata, 'metadata')
          const client = clientFor(context.config, context.fetch)
          const batch = await client.request<OpenAIBatch>('POST', 'batches', {
            body: {
              input_file_id: requiredArg(args, 'inputFileId'),
              endpoint: requiredArg(args, 'endpoint'),
              completion_window: text(args.completionWindow) ?? '24h',
              ...(metadata && { metadata })
            }
          })
          return batchOutput(batch ?? { id: '' })
        }
      }
    ]
  })
}

function batchOutputs() {
  return [
    { key: 'id', description: 'Batch id' },
    { key: 'status', description: 'validating, failed, in_progress, finalizing, completed, expired, cancelling or cancelled' },
    { key: 'endpoint', description: 'The endpoint the batch calls' },
    { key: 'inputFileId', description: 'The JSONL file of requests' },
    { key: 'outputFileId', description: 'The file of results, once completed' },
    { key: 'errorFileId', description: 'The file of failed requests, or null' },
    { key: 'requestCounts', description: '{ total, completed, failed }' },
    { key: 'createdAt', description: 'When it was created, ISO 8601' },
    { key: 'completedAt', description: 'When it completed, or null' },
    { key: 'failedAt', description: 'When it failed, or null' },
    { key: 'expiredAt', description: 'When it expired, or null' },
    { key: 'cancelledAt', description: 'When it was cancelled, or null' },
    { key: 'errors', description: 'Validation errors, or null' },
    { key: 'metadata', description: 'The metadata it was created with' },
    { key: 'batch', description: 'The raw batch object' }
  ]
}

// Kept for the entry point and the SDK's tooling, which load a connector by these names.
export const connector = createOpenAIConnector({ version: pkg.version })
