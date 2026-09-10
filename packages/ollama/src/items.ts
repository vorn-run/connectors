import type { ConnectorItem } from '@vornrun/connector-sdk'

export interface ModelDetails {
  parent_model?: string
  format?: string
  family?: string
  families?: string[] | null
  parameter_size?: string
  quantization_level?: string
}

/** One entry of GET /api/tags. */
export interface OllamaModel {
  name?: string
  model?: string
  modified_at?: string
  size?: number
  digest?: string
  details?: ModelDetails
  remote_model?: string
  remote_host?: string
}

/** One entry of GET /api/ps. */
export interface RunningModel {
  name?: string
  model?: string
  size?: number
  digest?: string
  details?: ModelDetails
  expires_at?: string
  size_vram?: number
  context_length?: number
}

export const SAMPLE_MODEL: OllamaModel = {
  name: 'qwen2.5-coder:7b',
  model: 'qwen2.5-coder:7b',
  modified_at: '2026-08-02T16:07:41.209152383-06:00',
  size: 4683087561,
  digest: 'dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364',
  details: {
    parent_model: '',
    format: 'gguf',
    family: 'qwen2',
    families: ['qwen2'],
    parameter_size: '7.6B',
    quantization_level: 'Q4_K_M'
  }
}

export const SAMPLE_RUNNING_MODEL: RunningModel = {
  name: 'qwen2.5-coder:7b',
  model: 'qwen2.5-coder:7b',
  size: 4740716952,
  size_vram: 4740716952,
  digest: 'dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364',
  details: SAMPLE_MODEL.details,
  expires_at: '2026-09-10T07:31:16.885215-06:00',
  context_length: 4096
}

/* ---------------------------------------------------------------- text -- */

export function text(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim()
  return trimmed === '' ? undefined : trimmed
}

export function flag(value: unknown): boolean {
  return value === true || /^(true|1|yes)$/i.test(String(value ?? '').trim())
}

// Text is sent as text; a value that parses as a JSON array is sent as the array. Anything else is text.
export function textOrJsonArray(value: unknown): string | unknown[] {
  if (Array.isArray(value)) return value
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

export function jsonObject(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} must be a JSON object`)
  return value as Record<string, unknown>
}

/** A single user text becomes one user turn; a JSON array of turns passes through. */
export function messagesArg(value: unknown, system?: string): Record<string, unknown>[] {
  // A value that is neither text nor an array, such as the mock's placeholder object, is sent as no turns.
  const parsed = typeof value === 'object' && value !== null && !Array.isArray(value) ? [] : textOrJsonArray(value)
  const turns: Record<string, unknown>[] =
    typeof parsed === 'string'
      ? [{ role: 'user', content: parsed }]
      : parsed.filter((turn): turn is Record<string, unknown> => typeof turn === 'object' && turn !== null && !Array.isArray(turn))
  if (system !== undefined && turns[0]?.role !== 'system') return [{ role: 'system', content: system }, ...turns]
  return turns
}

/** `json` stays the word; a JSON schema object is sent as the object; other text is left for the server to judge. */
export function formatArg(value: unknown): string | Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  const raw = text(value)
  if (raw === undefined) return undefined
  if (raw.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // Not a schema after all; the server reports what it makes of the text.
    }
  }
  return raw
}

/** A keep-alive is a duration string such as `5m`, or a number of seconds; `0` unloads at once. */
export function keepAliveArg(value: unknown): string | number | undefined {
  const raw = text(value)
  if (raw === undefined) return undefined
  return /^-?\d+$/.test(raw) ? Number(raw) : raw
}

/* --------------------------------------------------------------- items -- */

// The SDK compares cursors as ISO strings, so a nanosecond or offset time is reduced to UTC milliseconds.
export function isoOf(value: unknown): string | undefined {
  const at = Date.parse(String(value ?? ''))
  return Number.isNaN(at) ? undefined : new Date(at).toISOString()
}

export function gigabytes(bytes: number | undefined): string {
  return `${((bytes ?? 0) / 1_000_000_000).toFixed(1)} GB`
}

// Only library models have a page: a namespaced name or a remote host is somewhere else.
export function libraryUrl(model: OllamaModel): string | undefined {
  const name = model.name ?? model.model ?? ''
  if (name === '' || name.includes('/') || text(model.remote_host) !== undefined) return undefined
  return `https://ollama.com/library/${encodeURIComponent(name.split(':')[0]!)}`
}

export function modelToItem(model: OllamaModel): ConnectorItem {
  const name = model.name ?? model.model ?? ''
  const digest = model.digest ?? ''
  const family = text(model.details?.family)
  const size = text(model.details?.parameter_size)
  const detail = [family, size].filter((part) => part !== undefined).join(', ')
  const url = libraryUrl(model)
  const updatedAt = isoOf(model.modified_at)
  return {
    externalId: `${name}@${digest}`,
    title: detail ? `${name} (${detail})` : name,
    ...(url && { url }),
    ...(updatedAt && { updatedAt }),
    data: {
      name,
      digest,
      size: model.size ?? 0,
      modified_at: model.modified_at ?? null,
      family: family ?? null,
      parameter_size: size ?? null,
      details: model.details ?? {}
    }
  }
}

export function runningToItem(model: RunningModel): ConnectorItem {
  const name = model.name ?? model.model ?? ''
  const expires = model.expires_at ?? ''
  const updatedAt = isoOf(model.expires_at)
  return {
    externalId: `${name}@${expires}`,
    title: `${name} loaded (${gigabytes(model.size_vram ?? model.size)} in VRAM, context ${model.context_length ?? 0})`,
    ...(updatedAt && { updatedAt }),
    data: {
      name,
      digest: model.digest ?? '',
      size: model.size ?? 0,
      size_vram: model.size_vram ?? 0,
      expires_at: model.expires_at ?? null,
      context_length: model.context_length ?? 0,
      details: model.details ?? {}
    }
  }
}
