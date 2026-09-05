import {
  defineConnector,
  type ConnectorConfig,
  type ConnectorItem,
  type FetchContext
} from '@vornrun/connector-sdk'
import {
  ANTHROPIC_VERSION,
  API_ROOT,
  createAnthropicClient,
  createRateGate,
  type AnthropicModel,
  type MessageBatch
} from './client'
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  MODEL_IDS,
  SAMPLE_BATCH,
  SAMPLE_MODEL,
  batchOutput,
  batchToItem,
  listArg,
  messageOutput,
  messagesArg,
  modelToItem,
  numberArg,
  stopSequencesArg
} from './items'
// Bundled at build time: a pack is one file, so a version read from disk is not there to read.
import pkg from '../package.json'

export interface AnthropicConnectorOptions {
  version?: string
  /** Where live samples are read from; defaults to the process environment. */
  env?: NodeJS.ProcessEnv
  /** Replaced in tests so a rate-limit wait costs no real time. */
  sleep?: (ms: number) => Promise<void>
  /** The clock retry waits are measured on, in milliseconds. */
  now?: () => number
  random?: () => number
}

// A batch expires 24 hours after creation, so anything created earlier than this before the cursor ended before it.
export const BATCH_LOOKBACK_MS = 24 * 60 * 60_000

// The first model poll looks a month back rather than firing the whole catalog.
export const MODEL_LOOKBACK_MS = 30 * 24 * 60 * 60_000

const PLACEHOLDER_BATCH_ID = 'msgbatch_placeholder'

const HEADERS = {
  'x-api-key': '{{config.apiKey}}',
  'anthropic-version': ANTHROPIC_VERSION
}

function text(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim()
  return trimmed || undefined
}

function required(config: ConnectorConfig, key: string, env: string): string {
  const value = text(config[key])
  if (value === undefined) throw new Error(`${env} is required`)
  return value
}

// A batch or model time as milliseconds; an unreadable one sorts as the epoch, which never passes a window.
function millis(value: string | null | undefined): number {
  const at = Date.parse(value ?? '')
  return Number.isNaN(at) ? 0 : at
}

const MODEL_INPUT = {
  key: 'model',
  label: 'Model',
  description: `The model that will complete your prompt. Defaults to ${DEFAULT_MODEL}.`,
  builderHint: `Sent as model. Ids the reference lists today: ${MODEL_IDS.join(', ')}; listModels returns the live set and getModel resolves an alias.`
}

const MESSAGES_INPUT = {
  key: 'messages',
  label: 'Messages',
  required: true,
  description: 'Prompt text, sent as one user turn, or a JSON array of { "role", "content" } turns.',
  builderHint:
    'Text becomes [{ role: "user", content: text }]; a value starting with [ is parsed as the messages array and passed through, so multi-turn and content blocks work. Consecutive turns of one role are merged by the API.'
}

const SYSTEM_INPUT = {
  key: 'system',
  label: 'System prompt',
  description: 'Context and instructions for the model, kept apart from the conversation.',
  builderHint: 'Sent as the top-level system string only when set; the API takes no system role inside messages.'
}

const BATCH_ID_INPUT = {
  key: 'batchId',
  label: 'Batch',
  required: true,
  description: 'The message batch id, msgbatch_…',
  builderHint: 'Sent URL-encoded as the path segment; an unknown id answers 404 not_found_error.'
}

const BATCH_OUTPUTS = [
  { key: 'id', description: 'Batch id, msgbatch_…' },
  { key: 'processingStatus', description: 'in_progress, canceling or ended' },
  { key: 'requestCounts', description: '{ processing, succeeded, errored, canceled, expired }' },
  { key: 'createdAt', description: 'When the batch was created, RFC 3339' },
  { key: 'endedAt', description: 'When processing ended; null until then' },
  { key: 'expiresAt', description: '24 hours after creation, when unfinished requests expire' },
  { key: 'resultsUrl', description: 'Where the results stream from once processing has ended; null until then' }
]

export function createAnthropicConnector(options: AnthropicConnectorOptions = {}) {
  const env = options.env ?? process.env
  const clock = options.now ?? Date.now

  // One gate for the whole process, so a poll and a step on the same key wait for the same reset.
  const gate = createRateGate({ now: clock, ...(options.sleep && { sleep: options.sleep }) })

  function client(context: { config: ConnectorConfig; fetch: typeof fetch }) {
    return createAnthropicClient({
      apiKey: required(context.config, 'apiKey', 'ANTHROPIC_API_KEY'),
      fetch: context.fetch,
      gate,
      now: clock,
      ...(options.sleep && { sleep: options.sleep }),
      ...(options.random && { random: options.random })
    })
  }

  // Newest-first pages are walked until one holds a batch created before the window; ended ones are delivered oldest first.
  async function fetchEndedBatches(context: FetchContext): Promise<ConnectorItem[]> {
    const floor = (context.since ? Date.parse(context.since) : Date.parse(context.now())) - BATCH_LOOKBACK_MS
    const batches = await client(context).listBatches({
      until: (batch: MessageBatch) => millis(batch.created_at) < floor
    })
    return batches
      .filter((batch) => batch.processing_status === 'ended' && millis(batch.created_at) >= floor)
      .sort((left, right) => millis(left.ended_at) - millis(right.ended_at))
      .map(batchToItem)
  }

  // Models released at or after the cursor; an epoch created_at never passes.
  async function fetchNewModels(context: FetchContext): Promise<ConnectorItem[]> {
    const floor = context.since ? Date.parse(context.since) : Date.parse(context.now()) - MODEL_LOOKBACK_MS
    const models = await client(context).listModels({
      until: (model: AnthropicModel) => millis(model.created_at) < floor
    })
    return models
      .filter((model) => millis(model.created_at) >= floor)
      .sort((left, right) => millis(left.created_at) - millis(right.created_at))
      .map(modelToItem)
  }

  // Live samples read a batch id from the environment; the placeholder stands in for the mock run.
  const batchId = text(env.ANTHROPIC_BATCH_ID) ?? PLACEHOLDER_BATCH_ID

  return defineConnector({
    id: 'anthropic',
    name: 'Anthropic',
    version: options.version ?? pkg.version,
    description:
      'Trigger workflows when a message batch finishes or a model becomes available, and create messages, count tokens, list models and run message batches from a step.',
    // Anthropic's crossbar-less A: the full-height right leg and the shorter left leg meeting below its apex.
    icon: {
      viewBox: '0 0 24 24',
      paths: ['M9 3 15 3 22.5 21 16.5 21z', 'M1.5 21 7.5 21 12.5 8.5 9.5 3.8z']
    },
    auth: { rung: 'key', keys: ['apiKey'] },
    config: [
      {
        key: 'apiKey',
        env: 'ANTHROPIC_API_KEY',
        label: 'API key',
        secret: true,
        required: true,
        description: 'An API key from console.anthropic.com/settings/keys, for a single workspace.',
        builderHint:
          'Sent as x-api-key with anthropic-version: 2023-06-01 on every call. Keys have no scopes: a key without access answers 403 permission_error, a bad one 401 authentication_error. A multi-workspace key also needs anthropic-workspace-id, which is not sent, so use a single-workspace key. There is no CLI to borrow a login from.'
      }
    ],
    triggers: [
      {
        type: 'batchEnded',
        label: 'A message batch finished',
        description:
          'Fires once for each message batch whose processing has ended since the last poll, oldest first. Read the results with getBatchResults.',
        dedupe: 'timestamp',
        fetch: fetchEndedBatches,
        defaultWorkflow: { name: 'Anthropic: finished batches', defaultCronFromMinutes: 5 },
        sample: [batchToItem(SAMPLE_BATCH)]
      },
      {
        type: 'newModel',
        label: 'A model became available',
        description: 'Fires once for each model released since the last poll, oldest first. The first poll looks 30 days back.',
        dedupe: 'timestamp',
        fetch: fetchNewModels,
        defaultWorkflow: { name: 'Anthropic: new models', defaultCronFromMinutes: 60 },
        sample: [modelToItem(SAMPLE_MODEL)]
      }
    ],
    actions: [
      {
        type: 'createMessage',
        label: 'Create a message',
        description: 'Send a conversation to a model and get its reply. Every call bills a generation.',
        idempotent: false,
        inputs: [
          MODEL_INPUT,
          MESSAGES_INPUT,
          SYSTEM_INPUT,
          {
            key: 'maxTokens',
            label: 'Maximum tokens',
            type: 'number',
            description: `The most tokens to generate before stopping; the model may stop sooner. Defaults to ${DEFAULT_MAX_TOKENS}.`,
            builderHint:
              'Sent as max_tokens. The connector does not stream, so keep it modest; a large job belongs in createMessageBatch.'
          },
          {
            key: 'temperature',
            label: 'Temperature',
            type: 'number',
            description: 'Randomness from 0.0 to 1.0. Leave unset for the default.',
            builderHint:
              'Sent only when set. Models released after Claude Opus 4.6, the default model included, accept only 1.0 and reject other values with a 400.'
          },
          {
            key: 'tools',
            label: 'Tools',
            type: 'json',
            description: 'A JSON array of tool definitions, each { "name", "description", "input_schema" }.',
            builderHint:
              'Sent as tools; a single object is taken as one tool. input_schema is a JSON schema for the tool input; a tool call comes back as a tool_use block in raw.content with stopReason tool_use.'
          },
          {
            key: 'stopSequences',
            label: 'Stop sequences',
            description: 'Strings that end generation when the model emits one, comma-separated or as a JSON array.',
            builderHint: 'Sent as stop_sequences; a hit sets stopReason to stop_sequence and raw.stop_sequence names it.'
          }
        ],
        outputs: [
          { key: 'id', description: 'Message id, msg_…' },
          { key: 'model', description: 'The model that answered' },
          { key: 'text', description: 'The text of the first text block; empty when the model answered with a tool call alone' },
          {
            key: 'stopReason',
            description: 'end_turn, max_tokens, stop_sequence, tool_use, pause_turn, refusal or model_context_window_exceeded'
          },
          { key: 'usage', description: '{ input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }' },
          { key: 'raw', description: 'The whole response, with every content block and stop_details' }
        ],
        async run(args, context) {
          const message = await client(context).createMessage({
            model: text(args.model) ?? DEFAULT_MODEL,
            messages: messagesArg(args.messages),
            system: text(args.system),
            max_tokens: numberArg(args.maxTokens, 'maxTokens') ?? DEFAULT_MAX_TOKENS,
            temperature: numberArg(args.temperature, 'temperature'),
            tools: listArg(args.tools, 'tools'),
            stop_sequences: stopSequencesArg(args.stopSequences)
          })
          return messageOutput(message)
        }
      },
      {
        type: 'countTokens',
        label: 'Count tokens',
        description: 'Count the tokens a conversation and system prompt would use, without creating a message.',
        idempotent: true,
        inputs: [MODEL_INPUT, MESSAGES_INPUT, SYSTEM_INPUT],
        outputs: [
          { key: 'inputTokens', type: 'number', description: 'Tokens across the messages, system prompt and tools' }
        ],
        sample: { model: DEFAULT_MODEL, messages: 'hello' },
        async run(args, context) {
          const counted = await client(context).countTokens({
            model: text(args.model) ?? DEFAULT_MODEL,
            messages: messagesArg(args.messages),
            system: text(args.system)
          })
          return { inputTokens: counted.input_tokens ?? 0 }
        }
      },
      {
        type: 'listModels',
        label: 'List models',
        description: 'The models the key can use, newest release first.',
        idempotent: true,
        inputs: [],
        outputs: [
          { key: 'models', description: 'One entry per model: id, display_name, created_at, max_input_tokens, max_tokens, capabilities' },
          { key: 'count', type: 'number', description: 'How many models came back' }
        ],
        sample: {},
        async run(_args, context) {
          const models = await client(context).listModels()
          return { models, count: models.length }
        }
      },
      {
        type: 'getModel',
        label: 'Get a model',
        description: 'Read one model by id, or resolve an alias to its model id.',
        idempotent: true,
        inputs: [
          {
            key: 'modelId',
            label: 'Model',
            required: true,
            description: 'A model id or alias, such as claude-sonnet-5.',
            builderHint: 'Sent URL-encoded as the path segment of GET models/{modelId}; an unknown id answers 404 not_found_error.'
          }
        ],
        outputs: [
          { key: 'id', description: 'The resolved model id' },
          { key: 'displayName', description: 'Human-readable name' },
          { key: 'createdAt', description: 'Release time, RFC 3339; an epoch when unknown' },
          { key: 'maxInputTokens', type: 'number', description: 'Context window in tokens' },
          { key: 'maxTokens', type: 'number', description: 'Most output tokens per message' },
          { key: 'capabilities', description: 'What the model supports, such as batch and thinking' }
        ],
        sample: { modelId: DEFAULT_MODEL },
        request: { url: `${API_ROOT}/models/{{args.modelId}}`, headers: HEADERS },
        postReceive: [
          { op: 'rename', from: 'display_name', to: 'displayName' },
          { op: 'rename', from: 'created_at', to: 'createdAt' },
          { op: 'rename', from: 'max_input_tokens', to: 'maxInputTokens' },
          { op: 'rename', from: 'max_tokens', to: 'maxTokens' },
          { op: 'pick', keys: ['id', 'displayName', 'createdAt', 'maxInputTokens', 'maxTokens', 'capabilities'] }
        ]
      },
      {
        type: 'createMessageBatch',
        label: 'Create a message batch',
        description: 'Queue up to 100,000 message requests for asynchronous processing. Two calls queue two batches.',
        idempotent: false,
        inputs: [
          {
            key: 'requests',
            label: 'Requests',
            type: 'json',
            required: true,
            description:
              'A JSON array of { "custom_id", "params" } where params is a full createMessage body: model, max_tokens, messages, ….',
            builderHint:
              'Sent as requests; a single object is taken as a batch of one. custom_id matches ^[a-zA-Z0-9_-]{1,64}$ and must be unique within the batch; results come back keyed by it, not in order.'
          }
        ],
        outputs: BATCH_OUTPUTS,
        async run(args, context) {
          const batch = await client(context).createBatch(listArg(args.requests, 'requests') ?? [])
          return batchOutput(batch)
        }
      },
      {
        type: 'getMessageBatch',
        label: 'Get a message batch',
        description: 'Read a batch and its request counts; poll it until processingStatus is ended.',
        idempotent: true,
        inputs: [BATCH_ID_INPUT],
        outputs: BATCH_OUTPUTS,
        sample: { batchId },
        request: { url: `${API_ROOT}/messages/batches/{{args.batchId}}`, headers: HEADERS },
        postReceive: [
          { op: 'rename', from: 'processing_status', to: 'processingStatus' },
          { op: 'rename', from: 'request_counts', to: 'requestCounts' },
          { op: 'rename', from: 'created_at', to: 'createdAt' },
          { op: 'rename', from: 'ended_at', to: 'endedAt' },
          { op: 'rename', from: 'expires_at', to: 'expiresAt' },
          { op: 'rename', from: 'results_url', to: 'resultsUrl' },
          { op: 'pick', keys: BATCH_OUTPUTS.map((output) => output.key) }
        ]
      },
      {
        type: 'getBatchResults',
        label: 'Get batch results',
        description: 'Read the results of an ended batch, one entry per request, matched by custom_id rather than by order.',
        idempotent: true,
        inputs: [BATCH_ID_INPUT],
        outputs: [
          {
            key: 'results',
            description:
              'One entry per request: { custom_id, result } where result.type is succeeded (with result.message), errored (with result.error), canceled or expired'
          },
          { key: 'count', type: 'number', description: 'How many results came back' }
        ],
        sample: { batchId },
        async run(args, context) {
          const results = await client(context).getBatchResults(String(args.batchId))
          return { results, count: results.length }
        }
      },
      {
        type: 'cancelMessageBatch',
        label: 'Cancel a message batch',
        description: 'Ask for a batch to stop; it enters canceling and requests already running may still finish.',
        idempotent: false,
        inputs: [BATCH_ID_INPUT],
        outputs: [
          { key: 'id', description: 'Batch id' },
          { key: 'processingStatus', description: 'canceling, or ended when it already had' },
          { key: 'cancelInitiatedAt', description: 'When cancellation was asked for, RFC 3339' },
          { key: 'requestCounts', description: '{ processing, succeeded, errored, canceled, expired }' }
        ],
        request: { method: 'POST', url: `${API_ROOT}/messages/batches/{{args.batchId}}/cancel`, headers: HEADERS },
        postReceive: [
          { op: 'rename', from: 'processing_status', to: 'processingStatus' },
          { op: 'rename', from: 'cancel_initiated_at', to: 'cancelInitiatedAt' },
          { op: 'rename', from: 'request_counts', to: 'requestCounts' },
          { op: 'pick', keys: ['id', 'processingStatus', 'cancelInitiatedAt', 'requestCounts'] }
        ]
      }
    ]
  })
}

export const connector = createAnthropicConnector()
