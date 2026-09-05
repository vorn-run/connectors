import type { ConnectorItem } from '@vornrun/connector-sdk'

export const PLATFORM_URL = 'https://platform.openai.com'

export const BATCH_TERMINAL_STATUSES = ['completed', 'failed', 'expired', 'cancelled'] as const

export const FINE_TUNING_TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled'] as const

/* -------------------------------------------------------------- shapes -- */

export interface OpenAIList<T> {
  object?: string
  data?: T[]
  first_id?: string | null
  last_id?: string | null
  has_more?: boolean
}

export interface OpenAIBatch {
  id: string
  object?: string
  endpoint?: string
  errors?: unknown
  input_file_id?: string
  completion_window?: string
  status?: string
  output_file_id?: string | null
  error_file_id?: string | null
  created_at?: number
  in_progress_at?: number | null
  expires_at?: number | null
  finalizing_at?: number | null
  completed_at?: number | null
  failed_at?: number | null
  expired_at?: number | null
  cancelling_at?: number | null
  cancelled_at?: number | null
  request_counts?: { total?: number; completed?: number; failed?: number }
  metadata?: Record<string, unknown> | null
}

export interface OpenAIFile {
  id: string
  object?: string
  bytes?: number
  created_at?: number
  expires_at?: number | null
  filename?: string
  purpose?: string
}

export interface OpenAIFineTuningJob {
  id: string
  object?: string
  model?: string
  created_at?: number
  finished_at?: number | null
  fine_tuned_model?: string | null
  organization_id?: string
  result_files?: string[]
  status?: string
  validation_file?: string | null
  training_file?: string
  trained_tokens?: number | null
  error?: { code?: string; message?: string; param?: string | null } | null
  metadata?: Record<string, unknown> | null
}

export interface OpenAIModel {
  id: string
  object?: string
  created?: number
  owned_by?: string
  shutdown_date?: string | null
}

/* --------------------------------------------------------------- times -- */

/** An ISO string for a Unix-second timestamp, or null when the API left it null. */
export function isoOf(seconds: number | null | undefined): string | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null
}

/** Unix seconds for an ISO string. */
export function secondsOf(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000)
}

export function isBatchTerminal(status: string | undefined): boolean {
  return (BATCH_TERMINAL_STATUSES as readonly string[]).includes(status ?? '')
}

export function isFineTuningTerminal(status: string | undefined): boolean {
  return (FINE_TUNING_TERMINAL_STATUSES as readonly string[]).includes(status ?? '')
}

// The instant a batch stopped: whichever terminal stamp is set, else its creation.
export function batchFinishedAt(batch: OpenAIBatch): number | undefined {
  return batch.completed_at ?? batch.failed_at ?? batch.expired_at ?? batch.cancelled_at ?? batch.created_at ?? undefined
}

export function jobFinishedAt(job: OpenAIFineTuningJob): number | undefined {
  return job.finished_at ?? job.created_at ?? undefined
}

/* --------------------------------------------------------------- items -- */

function requestCountsText(batch: OpenAIBatch): string {
  const counts = batch.request_counts ?? {}
  const total = counts.total ?? 0
  const completed = counts.completed ?? 0
  const failed = counts.failed ?? 0
  return `${completed} of ${total} requests, ${failed} failed`
}

export function batchToItem(batch: OpenAIBatch): ConnectorItem {
  const status = batch.status ?? 'unknown'
  return {
    externalId: `${batch.id}:${status}`,
    title: `Batch ${batch.id} ${status}: ${requestCountsText(batch)}`,
    url: `${PLATFORM_URL}/batches/${encodeURIComponent(batch.id)}`,
    status,
    updatedAt: isoOf(batchFinishedAt(batch)) ?? undefined,
    data: { ...batch }
  }
}

export function fileToItem(file: OpenAIFile): ConnectorItem {
  const name = file.filename ?? file.id
  const purpose = file.purpose ?? 'unknown purpose'
  return {
    externalId: file.id,
    title: `${name} (${purpose}, ${file.bytes ?? 0} bytes)`,
    url: `${PLATFORM_URL}/storage/files/${encodeURIComponent(file.id)}`,
    updatedAt: isoOf(file.created_at) ?? undefined,
    data: { ...file }
  }
}

export function fineTuningJobToItem(job: OpenAIFineTuningJob): ConnectorItem {
  const status = job.status ?? 'unknown'
  const detail =
    status === 'failed' && job.error?.message ? job.error.message : (job.fine_tuned_model ?? job.model ?? job.id)
  return {
    externalId: `${job.id}:${status}`,
    title: `Fine-tuning job ${job.id} ${status}: ${detail}`,
    url: `${PLATFORM_URL}/finetune/${encodeURIComponent(job.id)}`,
    status,
    updatedAt: isoOf(jobFinishedAt(job)) ?? undefined,
    data: { ...job }
  }
}

/* ------------------------------------------------------------- outputs -- */

export function batchOutput(batch: OpenAIBatch): Record<string, unknown> {
  const counts = batch.request_counts ?? {}
  return {
    id: batch.id,
    status: batch.status ?? null,
    endpoint: batch.endpoint ?? null,
    inputFileId: batch.input_file_id ?? null,
    outputFileId: batch.output_file_id ?? null,
    errorFileId: batch.error_file_id ?? null,
    requestCounts: { total: counts.total ?? 0, completed: counts.completed ?? 0, failed: counts.failed ?? 0 },
    createdAt: isoOf(batch.created_at),
    completedAt: isoOf(batch.completed_at),
    failedAt: isoOf(batch.failed_at),
    expiredAt: isoOf(batch.expired_at),
    cancelledAt: isoOf(batch.cancelled_at),
    errors: batch.errors ?? null,
    metadata: batch.metadata ?? null,
    batch
  }
}

export function fileSummary(file: OpenAIFile): Record<string, unknown> {
  return {
    id: file.id,
    filename: file.filename ?? null,
    bytes: file.bytes ?? null,
    purpose: file.purpose ?? null,
    createdAt: isoOf(file.created_at),
    expiresAt: isoOf(file.expires_at)
  }
}

export function modelSummary(model: OpenAIModel): Record<string, unknown> {
  return {
    id: model.id,
    created: isoOf(model.created),
    ownedBy: model.owned_by ?? null,
    shutdownDate: model.shutdown_date ?? null
  }
}

/* ------------------------------------------------------------- samples -- */

export const SAMPLE_BATCH: OpenAIBatch = {
  id: 'batch_abc123',
  object: 'batch',
  endpoint: '/v1/chat/completions',
  errors: null,
  input_file_id: 'file-abc123',
  completion_window: '24h',
  status: 'completed',
  output_file_id: 'file-cvaTdG',
  error_file_id: 'file-HOWS94',
  created_at: 1711471533,
  in_progress_at: 1711471538,
  expires_at: 1711557933,
  finalizing_at: 1711493133,
  completed_at: 1711493163,
  failed_at: null,
  expired_at: null,
  cancelling_at: null,
  cancelled_at: null,
  request_counts: { total: 100, completed: 95, failed: 5 },
  metadata: { customer_id: 'user_123456789', batch_description: 'Nightly job' }
}

export const SAMPLE_FILE: OpenAIFile = {
  id: 'file-abc123',
  object: 'file',
  bytes: 175,
  created_at: 1613677385,
  expires_at: 1677614202,
  filename: 'salesOverview.pdf',
  purpose: 'assistants'
}

export const SAMPLE_FINE_TUNING_JOB: OpenAIFineTuningJob = {
  object: 'fine_tuning.job',
  id: 'ftjob-abc123',
  model: 'gpt-4o-mini-2024-07-18',
  created_at: 1721764800,
  finished_at: 1721851200,
  fine_tuned_model: 'ft:gpt-4o-mini-2024-07-18:org::abc123',
  organization_id: 'org-123',
  result_files: ['file-results123'],
  status: 'succeeded',
  validation_file: null,
  training_file: 'file-abc123',
  trained_tokens: 5768,
  error: null,
  metadata: { key: 'value' }
}

export const SAMPLE_BATCH_ITEM = batchToItem(SAMPLE_BATCH)

export const SAMPLE_FILE_ITEM = fileToItem(SAMPLE_FILE)

export const SAMPLE_FINE_TUNING_JOB_ITEM = fineTuningJobToItem(SAMPLE_FINE_TUNING_JOB)
