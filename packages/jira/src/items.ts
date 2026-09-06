import type { ConnectorItem } from '@vornrun/connector-sdk'
import { adfText } from './adf'
import { browseUrl } from './client'

// What every trigger and the default search ask for: "The default is id", so the fields are always named.
export const TRIGGER_FIELDS = 'summary,status,issuetype,priority,assignee,reporter,project,labels,created,updated,resolution'

export interface JiraUser {
  accountId?: string
  displayName?: string
  emailAddress?: string
  accountType?: string
  active?: boolean
  timeZone?: string
  locale?: string
  self?: string
}

export interface JiraIssue {
  id?: string
  key?: string
  self?: string
  fields?: Record<string, unknown>
}

export interface JiraTransition {
  id?: string
  name?: string
  to?: { id?: string; name?: string; statusCategory?: { key?: string; name?: string } }
  hasScreen?: boolean
  isAvailable?: boolean
}

export interface JiraProject {
  id?: string
  key?: string
  name?: string
  projectTypeKey?: string
  simplified?: boolean
  style?: string
  self?: string
}

export interface SearchPage {
  issues?: JiraIssue[]
  isLast?: boolean
  nextPageToken?: string
}

// Jira's `2023-06-24T19:24:50.000+0000` as ISO 8601 UTC; undefined when it does not parse.
export function isoOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : new Date(at).toISOString()
}

type Named = { id?: string; name?: string; key?: string; statusCategory?: { key?: string; name?: string } }

function named(value: unknown): Named | undefined {
  return typeof value === 'object' && value !== null ? (value as Named) : undefined
}

function person(value: unknown): { accountId: string; displayName: string } | null {
  const user = named(value) as JiraUser | undefined
  if (!user) return null
  return { accountId: user.accountId ?? '', displayName: user.displayName ?? '' }
}

// The `getIssue` shape: the fields a step reaches for, flattened, and the description as text.
export function issueSummary(issue: JiraIssue, site: string): Record<string, unknown> {
  const fields = issue.fields ?? {}
  const key = issue.key ?? ''
  const status = named(fields.status)
  const project = named(fields.project)
  return {
    id: issue.id ?? '',
    key,
    url: key ? browseUrl(site, key) : '',
    summary: typeof fields.summary === 'string' ? fields.summary : '',
    status: status?.name ?? '',
    statusCategory: status?.statusCategory?.name ?? '',
    issueType: named(fields.issuetype)?.name ?? '',
    priority: named(fields.priority)?.name ?? '',
    assignee: person(fields.assignee),
    reporter: person(fields.reporter),
    project: { id: project?.id ?? '', key: project?.key ?? '', name: project?.name ?? '' },
    labels: Array.isArray(fields.labels) ? fields.labels : [],
    created: isoOf(fields.created) ?? '',
    updated: isoOf(fields.updated) ?? '',
    resolution: named(fields.resolution)?.name ?? null,
    descriptionText: adfText(fields.description)
  }
}

export type TriggerKind = 'created' | 'updated' | 'transitioned'

function titleOf(issue: JiraIssue, kind: TriggerKind, status: string): string {
  const key = issue.key ?? issue.id ?? ''
  const summary = typeof issue.fields?.summary === 'string' ? issue.fields.summary : ''
  if (kind === 'updated') return `${key} updated: ${summary}`
  if (kind === 'transitioned') return `${key} is now ${status}: ${summary}`
  return `${key}: ${summary}`
}

// Created issues are keyed by id; updates and transitions by id plus `updated`, so each edit fires once.
export function issueToItem(issue: JiraIssue, site: string, kind: TriggerKind): ConnectorItem {
  const fields = issue.fields ?? {}
  const id = issue.id ?? issue.key ?? ''
  const status = named(fields.status)?.name ?? ''
  const stamp = kind === 'created' ? fields.created : fields.updated
  const updatedAt = isoOf(stamp)
  const assignee = person(fields.assignee)
  return {
    externalId: kind === 'created' ? id : `${id}:${typeof stamp === 'string' ? stamp : ''}`,
    title: titleOf(issue, kind, status),
    ...(issue.key && { url: browseUrl(site, issue.key) }),
    description: adfText(fields.description),
    status,
    ...(Array.isArray(fields.labels) && { labels: fields.labels.filter((label): label is string => typeof label === 'string') }),
    ...(assignee?.displayName && { assignee: assignee.displayName }),
    ...(updatedAt && { updatedAt }),
    data: { id: issue.id ?? '', key: issue.key ?? '', self: issue.self ?? '', fields }
  }
}

export function transitionSummary(transition: JiraTransition): Record<string, unknown> {
  return {
    id: transition.id ?? '',
    name: transition.name ?? '',
    to: {
      id: transition.to?.id ?? '',
      name: transition.to?.name ?? '',
      statusCategory: transition.to?.statusCategory?.name ?? ''
    },
    hasScreen: transition.hasScreen === true,
    isAvailable: transition.isAvailable !== false
  }
}

export function projectSummary(project: JiraProject, site: string): Record<string, unknown> {
  return {
    id: project.id ?? '',
    key: project.key ?? '',
    name: project.name ?? '',
    projectTypeKey: project.projectTypeKey ?? '',
    simplified: project.simplified === true,
    style: project.style ?? '',
    url: project.key ? `${site}/browse/${encodeURIComponent(project.key)}` : ''
  }
}

export function userSummary(user: JiraUser): Record<string, unknown> {
  return {
    accountId: user.accountId ?? '',
    accountType: user.accountType ?? '',
    displayName: user.displayName ?? '',
    ...(user.emailAddress && { emailAddress: user.emailAddress }),
    active: user.active !== false,
    timeZone: user.timeZone ?? '',
    locale: user.locale ?? '',
    self: user.self ?? ''
  }
}

// The reference's own example issue, which `check --mock` replays through the dedupe pipeline.
export const SAMPLE_SITE = 'https://example.atlassian.net'

export const SAMPLE_ISSUE: JiraIssue = {
  id: '10002',
  key: 'EX-1',
  self: 'https://example.atlassian.net/rest/api/3/issue/10002',
  fields: {
    summary: 'Main order flow broken',
    status: { id: '10000', name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } },
    issuetype: { id: '10001', name: 'Bug', subtask: false },
    priority: { id: '3', name: 'Medium' },
    assignee: null,
    reporter: { accountId: '5b10a2844c20165700ede21g', displayName: 'Mia Krystof' },
    project: { id: '10000', key: 'EX', name: 'Example' },
    labels: ['bugfix'],
    created: '2023-06-24T19:24:50.000+0000',
    updated: '2023-06-24T19:24:50.000+0000',
    resolution: null
  }
}

export const SAMPLE_UPDATED_ISSUE: JiraIssue = {
  ...SAMPLE_ISSUE,
  fields: { ...SAMPLE_ISSUE.fields, updated: '2023-06-25T08:10:00.000+0000' }
}

export const SAMPLE_TRANSITIONED_ISSUE: JiraIssue = {
  ...SAMPLE_ISSUE,
  fields: {
    ...SAMPLE_ISSUE.fields,
    status: { id: '10001', name: 'Done', statusCategory: { key: 'done', name: 'Done' } },
    resolution: { name: 'Done' },
    updated: '2023-06-26T14:00:00.000+0000'
  }
}
