import { describe, expect, it } from 'vitest'
import { normalizeItem } from '@vornrun/connector-sdk'
import {
  SAMPLE_ISSUE,
  SAMPLE_MERGE_REQUEST,
  SAMPLE_PIPELINE,
  TERMINAL_PIPELINE_STATUSES,
  isFinishedPipeline,
  issueToItem,
  mergeRequestToItem,
  pipelineToItem
} from './items'

const POLLED_AT = '2026-09-04T04:00:00.000Z'

describe('issueToItem', () => {
  it('keys on the project-scoped iid and watermarks on created_at', () => {
    const item = issueToItem(SAMPLE_ISSUE)

    expect(item.externalId).toBe('627684')
    expect(item.title).toBe(SAMPLE_ISSUE.title)
    expect(item.url).toBe('https://gitlab.com/gitlab-org/gitlab/-/work_items/627684')
    expect(item.status).toBe('opened')
    expect(item.labels).toEqual(SAMPLE_ISSUE.labels)
    // The trigger filters on created_after, so the watermark has to be created_at.
    expect(item.updatedAt).toBe('2026-09-04T02:23:26.054Z')
    expect(item.assignee).toBeUndefined()
    expect(item.data).toEqual({
      id: 201377309,
      iid: 627684,
      projectId: 278964,
      author: 'azaydan',
      assignees: [],
      createdAt: '2026-09-04T02:23:26.054Z',
      changedAt: '2026-09-04T03:10:09.633Z',
      closedAt: null,
      issueType: 'issue',
      confidential: false
    })
  })

  it('takes the first assignee and survives the optional fields being absent', () => {
    const item = issueToItem({
      id: 1,
      iid: 2,
      project_id: 3,
      title: 'Bare',
      state: 'closed',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      web_url: 'https://gitlab.com/g/p/-/issues/2',
      description: null,
      author: null,
      assignees: [{ username: 'ada' }, { username: 'grace' }],
      closed_at: '2026-01-02T00:00:00.000Z'
    })

    expect(item.description).toBe('')
    expect(item.labels).toEqual([])
    expect(item.assignee).toBe('ada')
    expect(item.data).toMatchObject({
      author: '',
      assignees: ['ada', 'grace'],
      closedAt: '2026-01-02T00:00:00.000Z',
      issueType: 'issue',
      confidential: false
    })
  })

  it('normalizes into the exact shape Vorn sees, with the extras flattened', () => {
    const normalized = normalizeItem(issueToItem(SAMPLE_ISSUE), POLLED_AT)

    expect(normalized.externalId).toBe('627684')
    expect(normalized.iid).toBe(627684)
    expect(normalized.author).toBe('azaydan')
    expect(normalized.changedAt).toBe('2026-09-04T03:10:09.633Z')
    expect(normalized.updatedAt).toBe('2026-09-04T02:23:26.054Z')
  })
})

describe('mergeRequestToItem', () => {
  it('keys on the iid and carries the branches and merge state', () => {
    const item = mergeRequestToItem(SAMPLE_MERGE_REQUEST)

    expect(item.externalId).toBe('253583')
    expect(item.url).toBe('https://gitlab.com/gitlab-org/gitlab/-/merge_requests/253583')
    expect(item.status).toBe('opened')
    expect(item.updatedAt).toBe('2026-09-04T03:07:05.722Z')
    expect(item.data).toEqual({
      id: 527853893,
      iid: 253583,
      projectId: 278964,
      sourceBranch: 'wt/telemetry-zero-result',
      targetBranch: 'master',
      draft: false,
      sha: 'ae17207bc7b8ea3696979d9888fd25e0629c8bde',
      author: 'johnmason',
      createdAt: '2026-09-04T03:07:05.722Z',
      changedAt: '2026-09-04T03:12:24.611Z',
      mergedAt: null,
      closedAt: null,
      hasConflicts: false,
      detailedMergeStatus: 'not_approved'
    })
  })

  it('survives the optional fields being absent', () => {
    const item = mergeRequestToItem({
      id: 1,
      iid: 2,
      project_id: 3,
      title: 'Bare',
      state: 'merged',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      source_branch: 'a',
      target_branch: 'b',
      web_url: 'https://gitlab.com/g/p/-/merge_requests/2',
      merged_at: '2026-01-02T00:00:00.000Z'
    })

    expect(item.description).toBe('')
    expect(item.labels).toEqual([])
    expect(item.data).toMatchObject({
      draft: false,
      sha: '',
      author: '',
      mergedAt: '2026-01-02T00:00:00.000Z',
      closedAt: null,
      hasConflicts: false,
      detailedMergeStatus: ''
    })
  })
})

describe('pipelineToItem', () => {
  it('keys on the pipeline id and puts the status in the title', () => {
    const item = pipelineToItem(SAMPLE_PIPELINE)

    expect(item.externalId).toBe('2818962738')
    expect(item.title).toBe('Ruby 3.3.12 master branch: success')
    expect(item.status).toBe('success')
    expect(item.url).toBe('https://gitlab.com/gitlab-org/gitlab/-/pipelines/2818962738')
    // The trigger filters on updated_after, so here the watermark is updated_at.
    expect(item.updatedAt).toBe('2026-09-04T03:12:20.492Z')
    expect(item.data).toEqual({
      id: 2818962738,
      iid: 6291260,
      projectId: 278964,
      ref: 'master',
      sha: '631b08ab8c69929b88af7f06d64500c3e5f400ae',
      source: 'push',
      name: 'Ruby 3.3.12 master branch',
      createdAt: '2026-09-04T03:12:16.050Z'
    })
  })

  it('falls back to the ref when a pipeline has no name', () => {
    const item = pipelineToItem({
      id: 7,
      project_id: 3,
      sha: 'abc',
      ref: 'feature/x',
      status: 'failed',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:05:00.000Z',
      web_url: 'https://gitlab.com/g/p/-/pipelines/7',
      name: null
    })

    expect(item.title).toBe('feature/x: failed')
    expect(item.data).toMatchObject({ iid: null, source: '', name: '' })
  })
})

describe('isFinishedPipeline', () => {
  it('accepts exactly the documented terminal statuses', () => {
    expect([...TERMINAL_PIPELINE_STATUSES].sort()).toEqual(['canceled', 'failed', 'skipped', 'success'])
    for (const status of TERMINAL_PIPELINE_STATUSES) {
      expect(isFinishedPipeline({ status })).toBe(true)
    }
  })

  it('leaves every in-flight status for a later poll', () => {
    for (const status of [
      'created',
      'waiting_for_resource',
      'preparing',
      'waiting_for_callback',
      'pending',
      'running',
      'canceling',
      'manual',
      'scheduled'
    ]) {
      expect(isFinishedPipeline({ status })).toBe(false)
    }
  })
})
