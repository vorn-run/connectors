import { defineConnector, type ConnectorConfig, type ConnectorItem, type FetchContext } from '@vornrun/connector-sdk'
import {
  DEFAULT_BASE_URL,
  LONG_TIMEOUT_MS,
  createOllamaClient,
  normalizeBaseUrl,
  type FetchLike,
  type OllamaClient,
  type Sleep
} from './client'
import {
  SAMPLE_MODEL,
  SAMPLE_RUNNING_MODEL,
  flag,
  formatArg,
  jsonObject,
  keepAliveArg,
  messagesArg,
  modelToItem,
  runningToItem,
  text,
  textOrJsonArray,
  type OllamaModel,
  type RunningModel
} from './items'
// Bundled at build time: a pack is one file, so a version read from disk is not there to read.
import pkg from '../package.json'

export const SAMPLE_MODEL_NAME = 'qwen2.5-coder:7b'

export interface OllamaConnectorOptions {
  version?: string
  /** Injected in tests, so nothing reaches the network. */
  fetchImpl?: FetchLike
  /** Injected in tests, so the connection retry spends no real time. */
  sleep?: Sleep
  /** Where the optional API key and the preflight host are read from; defaults to the process environment. */
  env?: NodeJS.ProcessEnv
}

interface GenerationReply {
  model?: string
  message?: { role?: string; content?: string; thinking?: string; tool_calls?: unknown[] }
  response?: string
  thinking?: string
  done_reason?: string
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
}

interface EmbedReply {
  model?: string
  embeddings?: number[][]
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
}

interface ShowReply {
  details?: Record<string, unknown>
  capabilities?: string[]
  modified_at?: string
  parameters?: string
  template?: string
  license?: string
  model_info?: Record<string, unknown>
}

const MODEL_INPUT = {
  key: 'model',
  label: 'Model',
  required: true,
  description: `The model name in model:tag form; the tag defaults to latest. listModels returns what is present.`,
  builderHint: `A name that is not on the server answers 404 and is reported as "not present; pull it first"; nothing is pulled on the caller's behalf.`
}

const SYSTEM_INPUT = {
  key: 'system',
  label: 'System prompt',
  description: 'Instructions for the model, kept apart from the conversation.',
  builderHint: 'On chat it is prepended as a system turn unless the messages already start with one; on generate it is sent as system.'
}

const FORMAT_INPUT = {
  key: 'format',
  label: 'Format',
  description: 'json for any valid JSON, or a JSON schema object the answer must match.',
  builderHint:
    'Sent as format untouched. With a schema, also describe it in the prompt so the model grounds its answer; the reply is text, so parse content yourself.'
}

const OPTIONS_INPUT = {
  key: 'options',
  label: 'Options',
  type: 'json' as const,
  description: 'Runtime options such as { "temperature": 0.2, "num_predict": 256 }.',
  builderHint: 'Passed through as options: temperature, num_predict, seed, top_k, top_p, min_p, stop, num_ctx and any other Modelfile parameter.'
}

const KEEP_ALIVE_INPUT = {
  key: 'keepAlive',
  label: 'Keep alive',
  description: 'How long the model stays loaded after the reply, such as 10m; 0 unloads it at once.',
  builderHint: 'Sent as keep_alive. A duration string or a number of seconds; a negative number keeps it loaded until the server stops.'
}

const TIMING_OUTPUTS = [
  { key: 'evalCount', type: 'number' as const, description: 'Tokens generated in the reply' },
  { key: 'promptEvalCount', type: 'number' as const, description: 'Prompt tokens evaluated' },
  { key: 'totalDuration', type: 'number' as const, description: 'Whole call in nanoseconds' },
  { key: 'loadDuration', type: 'number' as const, description: 'Loading the model, in nanoseconds' },
  { key: 'promptEvalDuration', type: 'number' as const, description: 'Evaluating the prompt, in nanoseconds' },
  { key: 'evalDuration', type: 'number' as const, description: 'Generating the reply, in nanoseconds' },
  { key: 'model', description: 'The model that answered' },
  { key: 'raw', description: 'The whole response as the server returned it' }
]

function timings(body: GenerationReply) {
  return {
    doneReason: body.done_reason ?? null,
    evalCount: body.eval_count ?? 0,
    promptEvalCount: body.prompt_eval_count ?? 0,
    totalDuration: body.total_duration ?? 0,
    loadDuration: body.load_duration ?? 0,
    promptEvalDuration: body.prompt_eval_duration ?? 0,
    evalDuration: body.eval_duration ?? 0,
    model: body.model ?? null,
    raw: body
  }
}

export function createOllamaConnector(options: OllamaConnectorOptions = {}) {
  const env = options.env ?? process.env

  function clientFor(config: ConnectorConfig, fetchImpl?: typeof fetch): OllamaClient {
    return createOllamaClient({
      baseUrl: normalizeBaseUrl(config.baseUrl),
      ...(text(env.OLLAMA_API_KEY) && { apiKey: text(env.OLLAMA_API_KEY) }),
      fetchImpl: options.fetchImpl ?? (fetchImpl as FetchLike | undefined),
      ...(options.sleep && { sleep: options.sleep })
    })
  }

  function requiredArg(args: Record<string, unknown>, key: string): string {
    const value = text(args[key])
    if (value === undefined) throw new Error(`${key} is required`)
    return value
  }

  async function fetchModels(context: FetchContext): Promise<ConnectorItem[]> {
    const body = await clientFor(context.config, context.fetch).get<{ models?: OllamaModel[] }>('tags')
    return (Array.isArray(body?.models) ? body.models : [])
      .filter((model) => text(model?.name ?? model?.model) !== undefined)
      .sort((left, right) => String(left.modified_at ?? '').localeCompare(String(right.modified_at ?? '')))
      .map(modelToItem)
  }

  async function fetchRunningModels(context: FetchContext): Promise<ConnectorItem[]> {
    const body = await clientFor(context.config, context.fetch).get<{ models?: RunningModel[] }>('ps')
    return (Array.isArray(body?.models) ? body.models : [])
      .filter((model) => text(model?.name ?? model?.model) !== undefined)
      .sort((left, right) => String(left.expires_at ?? '').localeCompare(String(right.expires_at ?? '')))
      .map(runningToItem)
  }

  return defineConnector({
    id: 'ollama',
    name: 'Ollama',
    version: options.version ?? pkg.version,
    description:
      'Trigger workflows when a local Ollama model is added, updated or loaded into memory, and chat, generate, embed, and list, show, pull, copy or delete models from a step.',
    // The llama's face: two upright ears over a rounded head, the eyes punched through by reversed winding.
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M8 7.2 7 1.5 10.2 6.4h3.6L17 1.5 16 7.2Q19 8.8 19 12.2V18.6Q19 22 15.6 22H8.4Q5 22 5 18.6V12.2Q5 8.8 8 7.2ZM9.4 11.3a1.3 1.3 0 0 0 0 2.6 1.3 1.3 0 0 0 0-2.6ZM14.6 11.3a1.3 1.3 0 0 0 0 2.6 1.3 1.3 0 0 0 0-2.6ZM12 15.6l-1.6 1.6h3.2Z'
      ]
    },
    auth: { rung: 'none' },
    config: [
      {
        key: 'baseUrl',
        env: 'OLLAMA_HOST',
        label: 'Server URL',
        default: DEFAULT_BASE_URL,
        description: `The server origin, ${DEFAULT_BASE_URL} by default. A trailing / or /api is stripped and a bare host:port gets http://.`,
        builderHint:
          'The same variable the ollama CLI reads. A hosted or proxied server that wants a key takes it from OLLAMA_API_KEY in the environment, sent as Authorization: Bearer; the SDK refuses a secret field on a connector that needs no sign-in, so there is no config field for it.'
      }
    ],
    async preflight() {
      const client = clientFor({ baseUrl: env.OLLAMA_HOST })
      try {
        const body = await client.get<{ version?: string }>('version')
        return { ok: true, message: `Ollama ${body?.version ?? 'unknown version'} answered at ${client.baseUrl}` }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    triggers: [
      {
        type: 'modelChanged',
        label: 'A model was added or updated',
        description:
          'Fires once per model build from GET /api/tags: a new name, or a pull that changed a digest. The first poll delivers every model present.',
        defaultWorkflow: { name: 'Ollama: added or updated models', defaultCronFromMinutes: 15 },
        dedupe: 'timestamp',
        sample: [modelToItem(SAMPLE_MODEL)],
        fetch: fetchModels
      },
      {
        type: 'modelLoaded',
        label: 'A model was loaded into memory',
        description:
          'Fires when a model appears in GET /api/ps with an expiry not yet seen. Every request extends the expiry, so a busy model fires again on each poll; poll slowly.',
        defaultWorkflow: { name: 'Ollama: loaded models', defaultCronFromMinutes: 5 },
        dedupe: 'timestamp',
        sample: [runningToItem(SAMPLE_RUNNING_MODEL)],
        fetch: fetchRunningModels
      }
    ],
    actions: [
      {
        type: 'chat',
        label: 'Chat',
        description: 'Generate the next assistant message of a conversation with POST /api/chat. Every call runs a generation.',
        idempotent: false,
        inputs: [
          MODEL_INPUT,
          {
            key: 'messages',
            label: 'Messages',
            required: true,
            description: 'A single user text, or a JSON array of { "role", "content" } with role system, user, assistant or tool.',
            builderHint:
              'Text becomes [{ role: "user", content: text }]; a value starting with [ is parsed as the array and passed through, so images and tool_calls on a turn survive.'
          },
          SYSTEM_INPUT,
          FORMAT_INPUT,
          OPTIONS_INPUT,
          KEEP_ALIVE_INPUT
        ],
        outputs: [
          { key: 'content', description: 'The assistant message text' },
          { key: 'thinking', description: 'The thinking text when the model produced one, else null' },
          { key: 'toolCalls', description: 'The tool_calls array when the model made any, else null' },
          { key: 'doneReason', description: 'stop, length or load' },
          ...TIMING_OUTPUTS
        ],
        async run(args, context) {
          const system = text(args.system)
          const format = formatArg(args.format)
          const modelOptions = jsonObject(args.options, 'options')
          const keepAlive = keepAliveArg(args.keepAlive)
          const body = await clientFor(context.config, context.fetch).post<GenerationReply>(
            'chat',
            {
              model: requiredArg(args, 'model'),
              messages: messagesArg(args.messages, system),
              ...(format !== undefined && { format }),
              ...(modelOptions && { options: modelOptions }),
              ...(keepAlive !== undefined && { keep_alive: keepAlive }),
              stream: false
            },
            LONG_TIMEOUT_MS
          )
          const reply = body ?? {}
          return {
            content: reply.message?.content ?? '',
            thinking: reply.message?.thinking ?? null,
            toolCalls: reply.message?.tool_calls ?? null,
            ...timings(reply)
          }
        }
      },
      {
        type: 'generate',
        label: 'Generate a completion',
        description: 'Generate a response for a prompt with POST /api/generate. Every call runs a generation.',
        idempotent: false,
        inputs: [
          MODEL_INPUT,
          {
            key: 'prompt',
            label: 'Prompt',
            required: true,
            description: 'Text for the model to generate a response from.',
            builderHint: 'Sent as prompt. Use chat for a conversation with roles; this is the raw completion endpoint.'
          },
          SYSTEM_INPUT,
          FORMAT_INPUT,
          OPTIONS_INPUT,
          KEEP_ALIVE_INPUT
        ],
        outputs: [
          { key: 'response', description: 'The generated text' },
          { key: 'thinking', description: 'The thinking text when the model produced one, else null' },
          { key: 'doneReason', description: 'stop, length or load' },
          ...TIMING_OUTPUTS
        ],
        async run(args, context) {
          const system = text(args.system)
          const format = formatArg(args.format)
          const modelOptions = jsonObject(args.options, 'options')
          const keepAlive = keepAliveArg(args.keepAlive)
          const body = await clientFor(context.config, context.fetch).post<GenerationReply>(
            'generate',
            {
              model: requiredArg(args, 'model'),
              prompt: requiredArg(args, 'prompt'),
              ...(system && { system }),
              ...(format !== undefined && { format }),
              ...(modelOptions && { options: modelOptions }),
              ...(keepAlive !== undefined && { keep_alive: keepAlive }),
              stream: false
            },
            LONG_TIMEOUT_MS
          )
          const reply = body ?? {}
          return { response: reply.response ?? '', thinking: reply.thinking ?? null, ...timings(reply) }
        }
      },
      {
        type: 'embed',
        label: 'Generate embeddings',
        description: 'Turn text into embedding vectors with POST /api/embed. The same input and model give the same vectors.',
        idempotent: true,
        sample: { model: SAMPLE_MODEL_NAME, input: 'hello' },
        inputs: [
          {
            ...MODEL_INPUT,
            builderHint: `${MODEL_INPUT.builderHint} A runner that does not serve embeddings answers 501; showModel lists embedding under capabilities when it does.`
          },
          {
            key: 'input',
            label: 'Input',
            required: true,
            description: 'Text, or a JSON array of texts, to embed in one call.',
            builderHint: 'A value starting with [ is parsed as the array; one vector comes back per entry, in order.'
          },
          {
            key: 'truncate',
            label: 'Truncate',
            type: 'boolean',
            description: 'Truncate an input that exceeds the context window instead of failing. The server default is true.',
            builderHint: 'Sent as truncate only when set; false makes an oversized input an error.'
          }
        ],
        outputs: [
          { key: 'embeddings', description: 'One number array per input, in input order' },
          { key: 'count', type: 'number', description: 'How many vectors' },
          { key: 'model', description: 'The model used' },
          { key: 'promptEvalCount', type: 'number', description: 'Input tokens processed' },
          { key: 'totalDuration', type: 'number', description: 'Whole call in nanoseconds' },
          { key: 'loadDuration', type: 'number', description: 'Loading the model, in nanoseconds' },
          { key: 'raw', description: 'The whole response as the server returned it' }
        ],
        async run(args, context) {
          const truncate = text(args.truncate)
          const body = await clientFor(context.config, context.fetch).post<EmbedReply>('embed', {
            model: requiredArg(args, 'model'),
            input: textOrJsonArray(args.input),
            ...(truncate !== undefined && { truncate: flag(truncate) })
          })
          const embeddings = Array.isArray(body?.embeddings) ? body.embeddings : []
          return {
            embeddings,
            count: embeddings.length,
            model: body?.model ?? null,
            promptEvalCount: body?.prompt_eval_count ?? 0,
            totalDuration: body?.total_duration ?? 0,
            loadDuration: body?.load_duration ?? 0,
            raw: body ?? {}
          }
        }
      },
      {
        type: 'listModels',
        label: 'List models',
        description: 'List the models on the server with GET /api/tags.',
        idempotent: true,
        sample: {},
        outputs: [
          { key: 'models', description: 'Array of { name, model, modified_at, size, digest, details }' },
          { key: 'count', type: 'number', description: 'How many models' },
          { key: 'raw', description: 'The whole response as the server returned it' }
        ],
        async run(_args, context) {
          const body = await clientFor(context.config, context.fetch).get<{ models?: OllamaModel[] }>('tags')
          const models = Array.isArray(body?.models) ? body.models : []
          return { models, count: models.length, raw: body ?? {} }
        }
      },
      {
        type: 'showModel',
        label: 'Show a model',
        description: 'Read a model’s details, capabilities, parameters, template and license with POST /api/show.',
        idempotent: true,
        sample: { model: SAMPLE_MODEL_NAME },
        inputs: [
          MODEL_INPUT,
          {
            key: 'verbose',
            label: 'Verbose',
            type: 'boolean',
            description: 'Include the large fields, such as the full tokenizer, in modelInfo.',
            builderHint: 'Sent as verbose only when true; the reply can run to megabytes.'
          }
        ],
        outputs: [
          { key: 'model', description: 'The model name asked for; the reply carries none' },
          { key: 'details', description: '{ parent_model, format, family, families, parameter_size, quantization_level }' },
          { key: 'capabilities', description: 'Array such as completion, tools, vision, embedding' },
          { key: 'modifiedAt', description: 'When the model was last modified, ISO 8601' },
          { key: 'parameters', description: 'Model parameter settings as text' },
          { key: 'template', description: 'The prompt template' },
          { key: 'license', description: 'The license text' },
          { key: 'modelInfo', description: 'Additional model metadata' },
          { key: 'raw', description: 'The whole response as the server returned it' }
        ],
        async run(args, context) {
          const model = requiredArg(args, 'model')
          const body = await clientFor(context.config, context.fetch).post<ShowReply>('show', {
            model,
            ...(flag(args.verbose) && { verbose: true })
          })
          return {
            model,
            details: body?.details ?? {},
            capabilities: Array.isArray(body?.capabilities) ? body.capabilities : [],
            modifiedAt: body?.modified_at ?? null,
            parameters: body?.parameters ?? '',
            template: body?.template ?? '',
            license: body?.license ?? '',
            modelInfo: body?.model_info ?? {},
            raw: body ?? {}
          }
        }
      },
      {
        type: 'listRunningModels',
        label: 'List running models',
        description: 'List the models loaded into memory with GET /api/ps.',
        idempotent: true,
        sample: {},
        outputs: [
          { key: 'models', description: 'Array of { name, model, size, digest, details, expires_at, size_vram, context_length }' },
          { key: 'count', type: 'number', description: 'How many models are loaded' },
          { key: 'raw', description: 'The whole response as the server returned it' }
        ],
        async run(_args, context) {
          const body = await clientFor(context.config, context.fetch).get<{ models?: RunningModel[] }>('ps')
          const models = Array.isArray(body?.models) ? body.models : []
          return { models, count: models.length, raw: body ?? {} }
        }
      },
      {
        type: 'version',
        label: 'Get the server version',
        description: 'Read the server version with GET /api/version. The live check probes this.',
        idempotent: true,
        sample: {},
        outputs: [{ key: 'version', description: 'The server version, such as 0.12.6' }],
        async run(_args, context) {
          const body = await clientFor(context.config, context.fetch).get<{ version?: string }>('version')
          return { version: body?.version ?? null }
        }
      },
      {
        type: 'pullModel',
        label: 'Pull a model',
        description: 'Download a model from the library with POST /api/pull. Downloads, so it is slow and not repeatable in a live check.',
        idempotent: false,
        inputs: [
          { ...MODEL_INPUT, builderHint: 'A library name such as gemma3, or user/model for a shared one. A cancelled pull resumes where it left off.' },
          {
            key: 'insecure',
            label: 'Insecure',
            type: 'boolean',
            description: 'Allow downloading over an insecure connection.',
            builderHint: 'Sent as insecure only when true; only for a library you run yourself during development.'
          }
        ],
        outputs: [
          { key: 'status', description: 'The final status, success when the model is present' },
          { key: 'raw', description: 'The whole response as the server returned it' }
        ],
        async run(args, context) {
          const body = await clientFor(context.config, context.fetch).post<{ status?: string }>(
            'pull',
            { model: requiredArg(args, 'model'), ...(flag(args.insecure) && { insecure: true }), stream: false },
            LONG_TIMEOUT_MS
          )
          return { status: body?.status ?? null, raw: body ?? {} }
        }
      },
      {
        type: 'deleteModel',
        label: 'Delete a model',
        description: 'Delete a model and its data with DELETE /api/delete. A second call answers 404.',
        idempotent: false,
        inputs: [{ ...MODEL_INPUT, builderHint: 'Deleting a tag another name was copied from leaves the copy in place; layers are shared.' }],
        outputs: [
          { key: 'deleted', type: 'boolean', description: 'True once the server answered 200' },
          { key: 'model', description: 'The model that was deleted' }
        ],
        async run(args, context) {
          const model = requiredArg(args, 'model')
          await clientFor(context.config, context.fetch).request('DELETE', 'delete', { body: { model } })
          return { deleted: true, model }
        }
      },
      {
        type: 'copyModel',
        label: 'Copy a model',
        description: 'Create a new name for an existing model with POST /api/copy. Creates a tag, so it is not repeatable.',
        idempotent: false,
        inputs: [
          {
            key: 'source',
            label: 'Source',
            required: true,
            description: 'Existing model name to copy from.',
            builderHint: 'A missing source answers 404 and is reported as not present.'
          },
          {
            key: 'destination',
            label: 'Destination',
            required: true,
            description: 'New model name to create.',
            builderHint: 'model:tag form; an existing name is overwritten.'
          }
        ],
        outputs: [
          { key: 'copied', type: 'boolean', description: 'True once the server answered 200' },
          { key: 'source', description: 'The name copied from' },
          { key: 'destination', description: 'The name created' }
        ],
        async run(args, context) {
          const source = requiredArg(args, 'source')
          const destination = requiredArg(args, 'destination')
          await clientFor(context.config, context.fetch).post('copy', { source, destination })
          return { copied: true, source, destination }
        }
      }
    ]
  })
}

export const connector = createOllamaConnector()
