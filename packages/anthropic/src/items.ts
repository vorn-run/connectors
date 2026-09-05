import type { ConnectorItem } from '@vornrun/connector-sdk'
import type { AnthropicModel, MessageBatch, Params, RequestCounts } from './client'

export const DEFAULT_MODEL = 'claude-sonnet-5'

// "Avoid setting a large max_tokens value without … streaming"; the connector does not stream.
export const DEFAULT_MAX_TOKENS = 1024

// The ids the Messages reference enumerates today; listModels returns the live set.
export const MODEL_IDS = [
  'claude-fable-5-1',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-opus-4-5',
  'claude-sonnet-4-5'
] as const

export const MODELS_DOC_URL = 'https://platform.claude.com/docs/en/about-claude/models/overview'

export const SAMPLE_BATCH: MessageBatch = {
  id: 'msgbatch_013Zva2CMHLNnXjNJJKqJ2EF',
  type: 'message_batch',
  processing_status: 'ended',
  request_counts: { processing: 0, succeeded: 50, errored: 30, canceled: 10, expired: 10 },
  created_at: '2024-08-20T18:37:24.100435Z',
  ended_at: '2024-08-20T18:37:24.100435Z',
  expires_at: '2024-08-21T18:37:24.100435Z',
  archived_at: null,
  cancel_initiated_at: null,
  results_url: 'https://api.anthropic.com/v1/messages/batches/msgbatch_013Zva2CMHLNnXjNJJKqJ2EF/results'
}

export const SAMPLE_MODEL: AnthropicModel = {
  id: 'claude-opus-5',
  type: 'model',
  display_name: 'Claude Opus 5',
  created_at: '2026-07-24T00:00:00Z',
  max_input_tokens: 1000000,
  max_tokens: 128000,
  capabilities: {
    batch: { supported: true },
    thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A json input arrives parsed from the harness and as text from a direct call; both are read.
export function parsed(value: unknown, key: string): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${key} must be JSON`)
  }
}

// Prompt text becomes one user turn; a JSON array of turns is passed through as is.
export function messagesArg(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined || value === null || value === '') throw new Error('messages is required')
  const raw = typeof value === 'string' && value.trimStart().startsWith('[') ? parsed(value, 'messages') : value
  if (typeof raw === 'string') return [{ role: 'user', content: raw }]
  const turns = Array.isArray(raw) ? raw : [raw]
  if (!turns.every(isRecord)) throw new Error('messages must be prompt text or a JSON array of { role, content } turns')
  return turns
}

// A JSON array, or one object taken as a list of one; unset stays unset.
export function listArg(value: unknown, key: string): unknown[] | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const raw = parsed(value, key)
  return Array.isArray(raw) ? raw : [raw]
}

// Stop sequences as a JSON array or one comma-separated line, whichever the step found easier to write.
export function stopSequencesArg(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const raw = typeof value === 'string' && value.trimStart().startsWith('[') ? parsed(value, 'stopSequences') : value
  const list = Array.isArray(raw) ? raw : String(raw).split(',')
  if (list.some((entry) => typeof entry !== 'string')) throw new Error('stopSequences must be strings')
  const sequences = (list as string[]).map((entry) => entry.trim()).filter((entry) => entry !== '')
  return sequences.length > 0 ? sequences : undefined
}

// A finite number; unset stays unset so the API applies its own default.
export function numberArg(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${key} must be a number, got "${String(value)}"`)
  return number
}

// The text of the first text block, or nothing when the model answered with a tool call alone.
export function firstText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const block = content.find((entry) => isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string')
  return block ? String((block as Record<string, unknown>).text) : ''
}

export function messageOutput(message: Params): Record<string, unknown> {
  return {
    id: message.id ?? '',
    model: message.model ?? '',
    text: firstText(message.content),
    stopReason: message.stop_reason ?? '',
    usage: message.usage ?? {},
    raw: message
  }
}

export function batchOutput(batch: MessageBatch): Record<string, unknown> {
  return {
    id: batch.id ?? '',
    processingStatus: batch.processing_status ?? '',
    requestCounts: batch.request_counts ?? {},
    createdAt: batch.created_at ?? '',
    endedAt: batch.ended_at ?? null,
    expiresAt: batch.expires_at ?? '',
    cancelInitiatedAt: batch.cancel_initiated_at ?? null,
    resultsUrl: batch.results_url ?? null,
    raw: batch
  }
}

function countsSummary(counts: RequestCounts | undefined): string {
  const parts = (['succeeded', 'errored', 'canceled', 'expired'] as const)
    .filter((key) => (counts?.[key] ?? 0) > 0)
    .map((key) => `${counts?.[key]} ${key}`)
  return parts.length > 0 ? parts.join(', ') : 'no requests'
}

// The docs give no console URL for a batch, so the item carries none.
export function batchToItem(batch: MessageBatch): ConnectorItem {
  return {
    externalId: batch.id,
    title: `Batch ${batch.id} ended: ${countsSummary(batch.request_counts)}`,
    status: batch.processing_status ?? '',
    ...(batch.ended_at && { updatedAt: batch.ended_at }),
    data: { ...batch }
  }
}

export function modelToItem(model: AnthropicModel): ConnectorItem {
  return {
    externalId: model.id,
    title: model.display_name ?? model.id,
    url: MODELS_DOC_URL,
    ...(model.created_at && { updatedAt: model.created_at }),
    data: { ...model }
  }
}
