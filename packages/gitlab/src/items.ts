/**
 * What GitLab returns, and how each becomes the item Vorn indexes.
 *
 * Kept apart from anything that talks to the network so the mappings — and
 * the one non-obvious choice in them, which timestamp is the watermark — are
 * tested directly against the payloads gitlab.com actually returned.
 */

import type { ConnectorItem } from '@vornrun/connector-sdk'

interface GitLabUser {
  id?: number
  username: string
  name?: string
}

export interface GitLabIssue {
  id: number
  iid: number
  project_id: number
  title: string
  description?: string | null
  state: string
  created_at: string
  updated_at: string
  closed_at?: string | null
  labels?: string[]
  author?: GitLabUser | null
  assignees?: GitLabUser[]
  web_url: string
  issue_type?: string
  confidential?: boolean
}

export interface GitLabMergeRequest {
  id: number
  iid: number
  project_id: number
  title: string
  description?: string | null
  state: string
  draft?: boolean
  created_at: string
  updated_at: string
  merged_at?: string | null
  closed_at?: string | null
  source_branch: string
  target_branch: string
  sha?: string
  author?: GitLabUser | null
  labels?: string[]
  web_url: string
  has_conflicts?: boolean
  detailed_merge_status?: string
}

export interface GitLabPipeline {
  id: number
  iid?: number
  project_id: number
  sha: string
  ref: string
  status: string
  source?: string
  created_at: string
  updated_at: string
  web_url: string
  name?: string | null
}

/**
 * Pipeline statuses that will not change again, from the documented enum.
 *
 * The rest — `created`, `waiting_for_resource`, `preparing`,
 * `waiting_for_callback`, `pending`, `running`, `canceling`, `manual`,
 * `scheduled` — describe a pipeline still in flight. One of those is neither
 * delivered nor remembered, so it fires once it finishes.
 */
export const TERMINAL_PIPELINE_STATUSES: ReadonlySet<string> = new Set([
  'success',
  'failed',
  'canceled',
  'skipped'
])

export function isFinishedPipeline(pipeline: Pick<GitLabPipeline, 'status'>): boolean {
  return TERMINAL_PIPELINE_STATUSES.has(pipeline.status)
}

/**
 * Map an issue onto the shape Vorn indexes.
 *
 * `updatedAt` is `created_at`, deliberately. The trigger asks GitLab for
 * issues `created_after` its watermark, and the SDK sets that watermark from
 * this field; if it carried `updated_at` instead, a poll cut short by `limit`
 * could move the watermark past an issue created earlier but touched later,
 * and that issue would never be asked for again. The real `updated_at` rides
 * along as `changedAt` (`updatedAt` is a reserved key in `data`).
 */
export function issueToItem(issue: GitLabIssue): ConnectorItem {
  return {
    externalId: String(issue.iid),
    title: issue.title,
    url: issue.web_url,
    description: issue.description ?? '',
    status: issue.state,
    labels: issue.labels ?? [],
    ...(issue.assignees?.[0]?.username && { assignee: issue.assignees[0].username }),
    updatedAt: issue.created_at,
    data: {
      id: issue.id,
      iid: issue.iid,
      projectId: issue.project_id,
      author: issue.author?.username ?? '',
      assignees: (issue.assignees ?? []).map((user) => user.username),
      createdAt: issue.created_at,
      changedAt: issue.updated_at,
      closedAt: issue.closed_at ?? null,
      issueType: issue.issue_type ?? 'issue',
      confidential: issue.confidential === true
    }
  }
}

/** Map a merge request onto the shape Vorn indexes. Same watermark rule as issues. */
export function mergeRequestToItem(mr: GitLabMergeRequest): ConnectorItem {
  return {
    externalId: String(mr.iid),
    title: mr.title,
    url: mr.web_url,
    description: mr.description ?? '',
    status: mr.state,
    labels: mr.labels ?? [],
    updatedAt: mr.created_at,
    data: {
      id: mr.id,
      iid: mr.iid,
      projectId: mr.project_id,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      draft: mr.draft === true,
      sha: mr.sha ?? '',
      author: mr.author?.username ?? '',
      createdAt: mr.created_at,
      changedAt: mr.updated_at,
      mergedAt: mr.merged_at ?? null,
      closedAt: mr.closed_at ?? null,
      hasConflicts: mr.has_conflicts === true,
      detailedMergeStatus: mr.detailed_merge_status ?? ''
    }
  }
}

/**
 * Map a pipeline onto the shape Vorn indexes.
 *
 * Here `updatedAt` really is `updated_at`: the trigger filters on
 * `updated_after`, and a pipeline's `updated_at` moving as it runs is what
 * makes a finished one reappear after the poll that first saw it running.
 */
export function pipelineToItem(pipeline: GitLabPipeline): ConnectorItem {
  return {
    externalId: String(pipeline.id),
    title: `${pipeline.name || pipeline.ref}: ${pipeline.status}`,
    url: pipeline.web_url,
    status: pipeline.status,
    updatedAt: pipeline.updated_at,
    data: {
      id: pipeline.id,
      iid: pipeline.iid ?? null,
      projectId: pipeline.project_id,
      ref: pipeline.ref,
      sha: pipeline.sha,
      source: pipeline.source ?? '',
      name: pipeline.name ?? '',
      createdAt: pipeline.created_at
    }
  }
}

/**
 * What gitlab.com returned for gitlab-org/gitlab on 2026-09-04, trimmed to the
 * fields the mappings read. `vorn-connector check --mock` replays these through
 * the real dedupe pipeline, so the connector is verified before anyone has
 * credentials for it.
 */
export const SAMPLE_ISSUE: GitLabIssue = {
  id: 201377309,
  iid: 627684,
  project_id: 278964,
  title: 'Restructure Package Metadata Database documentation and split the offline quick start guide',
  description:
    'This issue tracks a documentation follow-up agreed during review of https://gitlab.com/gitlab-org/gitlab/-/merge_requests/...',
  state: 'opened',
  created_at: '2026-09-04T02:23:26.054Z',
  updated_at: '2026-09-04T03:10:09.633Z',
  closed_at: null,
  labels: ['automation:quick-win-judged', 'documentation', 'group::composition analysis', 'type::maintenance'],
  author: { id: 32685309, username: 'azaydan', name: 'Ahmad Zaydan' },
  assignees: [],
  web_url: 'https://gitlab.com/gitlab-org/gitlab/-/work_items/627684',
  issue_type: 'issue',
  confidential: false
}

export const SAMPLE_MERGE_REQUEST: GitLabMergeRequest = {
  id: 527853893,
  iid: 253583,
  project_id: 278964,
  title: 'Add scope, engine and level properties to perform_search',
  description:
    'Nothing in GitLab measured whether a search returned any results, so the zero-result rate could not be computed. This adds...',
  state: 'opened',
  draft: false,
  created_at: '2026-09-04T03:07:05.722Z',
  updated_at: '2026-09-04T03:12:24.611Z',
  merged_at: null,
  closed_at: null,
  source_branch: 'wt/telemetry-zero-result',
  target_branch: 'master',
  sha: 'ae17207bc7b8ea3696979d9888fd25e0629c8bde',
  author: { id: 9717668, username: 'johnmason', name: 'John Mason' },
  labels: ['analytics instrumentation', 'backend', 'feature::addition', 'type::feature'],
  web_url: 'https://gitlab.com/gitlab-org/gitlab/-/merge_requests/253583',
  has_conflicts: false,
  detailed_merge_status: 'not_approved'
}

/** The list endpoint returned this one `running`; a delivered item has a terminal status. */
export const SAMPLE_PIPELINE: GitLabPipeline = {
  id: 2818962738,
  iid: 6291260,
  project_id: 278964,
  sha: '631b08ab8c69929b88af7f06d64500c3e5f400ae',
  ref: 'master',
  status: 'success',
  source: 'push',
  created_at: '2026-09-04T03:12:16.050Z',
  updated_at: '2026-09-04T03:12:20.492Z',
  web_url: 'https://gitlab.com/gitlab-org/gitlab/-/pipelines/2818962738',
  name: 'Ruby 3.3.12 master branch'
}
