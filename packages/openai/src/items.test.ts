import { describe, expect, it } from 'vitest'
import {
  SAMPLE_BATCH,
  SAMPLE_BATCH_ITEM,
  SAMPLE_FILE,
  SAMPLE_FILE_ITEM,
  SAMPLE_FINE_TUNING_JOB,
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
  secondsOf
} from './items'

describe('times', () => {
  it('converts Unix seconds to ISO and back', () => {
    expect(isoOf(1711493163)).toBe('2024-03-26T22:46:03.000Z')
    expect(secondsOf('2024-03-26T22:46:03.000Z')).toBe(1711493163)
  })

  it('keeps a null or missing timestamp null', () => {
    expect(isoOf(null)).toBeNull()
    expect(isoOf(undefined)).toBeNull()
    expect(isoOf(Number.NaN)).toBeNull()
  })

  it('knows which statuses are terminal', () => {
    expect(isBatchTerminal('completed')).toBe(true)
    expect(isBatchTerminal('in_progress')).toBe(false)
    expect(isBatchTerminal(undefined)).toBe(false)
    expect(isFineTuningTerminal('cancelled')).toBe(true)
    expect(isFineTuningTerminal('running')).toBe(false)
  })

  it('picks the terminal stamp a batch or job carries, falling back to creation', () => {
    expect(batchFinishedAt(SAMPLE_BATCH)).toBe(1711493163)
    expect(batchFinishedAt({ id: 'b', created_at: 5, failed_at: 9 })).toBe(9)
    expect(batchFinishedAt({ id: 'b', created_at: 5, expired_at: 8 })).toBe(8)
    expect(batchFinishedAt({ id: 'b', created_at: 5, cancelled_at: 7 })).toBe(7)
    expect(batchFinishedAt({ id: 'b', created_at: 5 })).toBe(5)
    expect(batchFinishedAt({ id: 'b' })).toBeUndefined()
    expect(jobFinishedAt(SAMPLE_FINE_TUNING_JOB)).toBe(1721851200)
    expect(jobFinishedAt({ id: 'j', created_at: 3, finished_at: null })).toBe(3)
    expect(jobFinishedAt({ id: 'j' })).toBeUndefined()
  })
})

describe('items', () => {
  it('shapes a batch as the spec shows', () => {
    expect(SAMPLE_BATCH_ITEM).toEqual({
      externalId: 'batch_abc123:completed',
      title: 'Batch batch_abc123 completed: 95 of 100 requests, 5 failed',
      url: 'https://platform.openai.com/batches/batch_abc123',
      status: 'completed',
      updatedAt: '2024-03-26T22:46:03.000Z',
      data: SAMPLE_BATCH
    })
  })

  it('copes with a batch missing its counts, status and stamps', () => {
    const item = batchToItem({ id: 'batch_x' })
    expect(item.externalId).toBe('batch_x:unknown')
    expect(item.title).toBe('Batch batch_x unknown: 0 of 0 requests, 0 failed')
    expect(item.updatedAt).toBeUndefined()
  })

  it('shapes a file as the spec shows', () => {
    expect(SAMPLE_FILE_ITEM).toEqual({
      externalId: 'file-abc123',
      title: 'salesOverview.pdf (assistants, 175 bytes)',
      url: 'https://platform.openai.com/storage/files/file-abc123',
      updatedAt: '2021-02-18T19:43:05.000Z',
      data: SAMPLE_FILE
    })
    expect(fileToItem({ id: 'file-y' }).title).toBe('file-y (unknown purpose, 0 bytes)')
  })

  it('shapes a fine-tuning job as the spec shows, naming the error when it failed', () => {
    expect(SAMPLE_FINE_TUNING_JOB_ITEM).toEqual({
      externalId: 'ftjob-abc123:succeeded',
      title: 'Fine-tuning job ftjob-abc123 succeeded: ft:gpt-4o-mini-2024-07-18:org::abc123',
      url: 'https://platform.openai.com/finetune/ftjob-abc123',
      status: 'succeeded',
      updatedAt: '2024-07-24T20:00:00.000Z',
      data: SAMPLE_FINE_TUNING_JOB
    })
    const failed = fineTuningJobToItem({
      id: 'ftjob-f',
      status: 'failed',
      model: 'gpt-4o-mini',
      created_at: 1,
      finished_at: null,
      error: { code: 'invalid_training_file', message: 'The training file is malformed' }
    })
    expect(failed.title).toBe('Fine-tuning job ftjob-f failed: The training file is malformed')
    expect(failed.updatedAt).toBe('1970-01-01T00:00:01.000Z')
    expect(fineTuningJobToItem({ id: 'ftjob-c', status: 'cancelled', model: 'gpt-4o-mini' }).title).toBe(
      'Fine-tuning job ftjob-c cancelled: gpt-4o-mini'
    )
    expect(fineTuningJobToItem({ id: 'ftjob-n' }).title).toBe('Fine-tuning job ftjob-n unknown: ftjob-n')
  })
})

describe('outputs', () => {
  it('flattens a batch with ISO times and nulls where the API has none', () => {
    expect(batchOutput(SAMPLE_BATCH)).toEqual({
      id: 'batch_abc123',
      status: 'completed',
      endpoint: '/v1/chat/completions',
      inputFileId: 'file-abc123',
      outputFileId: 'file-cvaTdG',
      errorFileId: 'file-HOWS94',
      requestCounts: { total: 100, completed: 95, failed: 5 },
      createdAt: '2024-03-26T16:45:33.000Z',
      completedAt: '2024-03-26T22:46:03.000Z',
      failedAt: null,
      expiredAt: null,
      cancelledAt: null,
      errors: null,
      metadata: { customer_id: 'user_123456789', batch_description: 'Nightly job' },
      batch: SAMPLE_BATCH
    })
    const bare = batchOutput({ id: 'b' })
    expect(bare.requestCounts).toEqual({ total: 0, completed: 0, failed: 0 })
    expect(bare.status).toBeNull()
    expect(bare.metadata).toBeNull()
  })

  it('summarises files and models', () => {
    expect(fileSummary(SAMPLE_FILE)).toEqual({
      id: 'file-abc123',
      filename: 'salesOverview.pdf',
      bytes: 175,
      purpose: 'assistants',
      createdAt: '2021-02-18T19:43:05.000Z',
      expiresAt: '2023-02-28T19:56:42.000Z'
    })
    expect(fileSummary({ id: 'f' })).toEqual({ id: 'f', filename: null, bytes: null, purpose: null, createdAt: null, expiresAt: null })
    expect(modelSummary({ id: 'gpt-4o-mini', created: 1721172741, owned_by: 'system' })).toEqual({
      id: 'gpt-4o-mini',
      created: '2024-07-16T23:32:21.000Z',
      ownedBy: 'system',
      shutdownDate: null
    })
    expect(modelSummary({ id: 'm', shutdown_date: '2026-12-01' }).shutdownDate).toBe('2026-12-01')
  })
})
