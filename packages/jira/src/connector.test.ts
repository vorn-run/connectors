import { describe, expect, it, vi } from 'vitest'
import { createConnectorHarness, runConformance, type ConnectorConfig } from '@vornrun/connector-sdk'
import {
  DEFAULT_SEARCH_RESULTS,
  FIRST_POLL_CREATED_MS,
  FIRST_POLL_UPDATED_MS,
  MAX_PAGES,
  OVERLAP_MS,
  PAGE_SIZE,
  assigneeId,
  connector as packaged,
  count,
  createJiraConnector,
  jsonObject,
  labelList,
  readSettings
} from './connector'
import { SAMPLE_ISSUE, SAMPLE_TRANSITIONED_ISSUE, SAMPLE_UPDATED_ISSUE, TRIGGER_FIELDS, type JiraIssue } from './items'

const NOW = '2026-09-06T12:00:00.000Z'
const SITE = 'https://example.atlassian.net'
const API = `${SITE}/rest/api/3`
const CONFIG: ConnectorConfig = { siteUrl: `${SITE}/`, email: 'me@example.com', apiToken: 'token-value' }

interface Route {
  match: string | RegExp
  method?: string
  status?: number
  body?: unknown | ((url: URL, body: unknown) => unknown)
  headers?: Record<string, string>
}

interface Call {
  method: string
  url: string
  body?: unknown
}

// A fake Jira driven by the URL asked for, so a test says what the site holds and asserts on what was sent.
function jiraServing(routes: Route[]) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    calls.push({ method, url, ...(body !== undefined && { body }) })
    const route = routes.find(
      (candidate) =>
        (candidate.method ?? method).toUpperCase() === method &&
        (typeof candidate.match === 'string' ? url.includes(candidate.match) : candidate.match.test(url))
    )
    if (!route) throw new Error(`unrouted ${method} ${url}`)
    const answer = typeof route.body === 'function' ? route.body(new URL(url), body) : route.body
    return new Response(answer === undefined ? null : JSON.stringify(answer), {
      status: route.status ?? (answer === undefined ? 204 : 200),
      headers: { 'content-type': 'application/json', ...route.headers }
    })
  })
  return { fetchImpl, calls }
}

const MYSELF: Route = { match: '/myself', body: { accountId: 'me', displayName: 'Mia Krystof', timeZone: 'America/Los_Angeles' } }

function connectorWith(routes: Route[], config: ConnectorConfig = CONFIG, env: NodeJS.ProcessEnv = {}) {
  const { fetchImpl, calls } = jiraServing(routes)
  const waits: number[] = []
  const connector = createJiraConnector({
    version: '0.1.0',
    fetchImpl,
    sleep: async (ms) => {
      waits.push(ms)
    },
    now: () => Date.parse(NOW),
    random: () => 0.5,
    env
  })
  const harness = createConnectorHarness(connector, { config, now: () => NOW, sleep: async () => {} })
  return { connector, harness, calls, waits }
}

function searchRoute(pages: Array<{ issues: JiraIssue[]; nextPageToken?: string }>): Route {
  return {
    match: '/search/jql',
    body: (url: URL) => {
      const token = url.searchParams.get('nextPageToken')
      const index = token ? Number(token.replace('page-', '')) : 0
      const page = pages[index] ?? { issues: [] }
      return { issues: page.issues, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : { isLast: true }) }
    }
  }
}

function jqlOf(call: Call | undefined): string {
  return new URL(call?.url ?? 'http://x').searchParams.get('jql') ?? ''
}

/* ------------------------------------------------------------- settings -- */

describe('readSettings', () => {
  it('requires the three connection values and trims the rest', () => {
    expect(readSettings({ ...CONFIG, projectKey: ' EX ', jql: 'issuetype = Bug', status: 'Done' })).toEqual({
      siteUrl: `${SITE}/`,
      email: 'me@example.com',
      apiToken: 'token-value',
      projectKey: 'EX',
      jql: 'issuetype = Bug',
      status: 'Done'
    })
    expect(readSettings(CONFIG)).toEqual({ siteUrl: `${SITE}/`, email: 'me@example.com', apiToken: 'token-value' })
    expect(() => readSettings({ ...CONFIG, siteUrl: '' })).toThrow(/JIRA_SITE_URL is required/)
    expect(() => readSettings({ ...CONFIG, email: undefined })).toThrow(/JIRA_EMAIL is required/)
    expect(() => readSettings({ ...CONFIG, apiToken: '  ' })).toThrow(/JIRA_API_TOKEN is required/)
  })
})

describe('input helpers', () => {
  it('reads a JSON object from text or an object and refuses the rest', () => {
    expect(jsonObject(undefined, 'fields')).toBeUndefined()
    expect(jsonObject('', 'fields')).toBeUndefined()
    expect(jsonObject(null, 'fields')).toBeUndefined()
    expect(jsonObject('{"a":1}', 'fields')).toEqual({ a: 1 })
    expect(jsonObject({ a: 1 }, 'fields')).toEqual({ a: 1 })
    expect(() => jsonObject('[1]', 'fields')).toThrow(/fields must be a JSON object/)
    expect(() => jsonObject('nope', 'fields')).toThrow(/fields must be a JSON object/)
    expect(() => jsonObject(3, 'fields')).toThrow(/fields must be a JSON object/)
  })

  it('splits labels and refuses one with a space', () => {
    expect(labelList(undefined)).toBeUndefined()
    expect(labelList(' a, b ,,c ')).toEqual(['a', 'b', 'c'])
    expect(() => labelList('a,needs triage')).toThrow(/labels cannot contain spaces, got "needs triage"/)
  })

  it('bounds a count and leaves unset alone', () => {
    expect(count(undefined, 'maxResults', 10)).toBeUndefined()
    expect(count('', 'maxResults', 10)).toBeUndefined()
    expect(count('5', 'maxResults', 10)).toBe(5)
    expect(count(10, 'maxResults', 10)).toBe(10)
    expect(() => count('0', 'maxResults', 10)).toThrow(/from 1 to 10, got "0"/)
    expect(() => count('11', 'maxResults', 10)).toThrow(/from 1 to 10/)
    expect(() => count('1.5', 'maxResults', 10)).toThrow(/whole number/)
  })

  it('reads an assignee, treating null and blank as unassigned', () => {
    expect(assigneeId(undefined)).toBeNull()
    expect(assigneeId('')).toBeNull()
    expect(assigneeId('null')).toBeNull()
    expect(assigneeId('None')).toBeNull()
    expect(assigneeId(' 5b10ac8d82e05b22cc7d4ef5 ')).toBe('5b10ac8d82e05b22cc7d4ef5')
    expect(assigneeId('-1')).toBe('-1')
  })
})

/* ------------------------------------------------------------- manifest -- */

describe('the connector', () => {
  it('declares its auth, config, triggers and actions', () => {
    expect(packaged.id).toBe('jira')
    expect(packaged.auth).toEqual({ rung: 'key', keys: ['apiToken'] })
    expect(packaged.config.map((field) => field.key)).toEqual(['siteUrl', 'email', 'apiToken', 'projectKey', 'jql', 'status'])
    expect(packaged.config.find((field) => field.key === 'apiToken')?.secret).toBe(true)
    expect(packaged.triggers.map((trigger) => trigger.type)).toEqual(['newIssue', 'issueUpdated', 'issueTransitioned'])
    expect(packaged.actions.map((action) => action.type)).toEqual([
      'createIssue',
      'updateIssue',
      'transitionIssue',
      'addComment',
      'assignIssue',
      'getIssue',
      'searchIssues',
      'listTransitions',
      'listProjects',
      'getCurrentUser'
    ])
    expect(packaged.icon?.paths).toHaveLength(3)
    expect(packaged.version).toMatch(/^\d+\.\d+\.\d+/)
    for (const action of packaged.actions) {
      expect(typeof action.idempotent).toBe('boolean')
      for (const input of action.inputs ?? []) expect(input.description).toBeTruthy()
    }
  })

  it('carries live samples for the issue reads only when the environment names an issue', () => {
    const bare = createJiraConnector({ env: {} })
    expect(bare.actions.find((action) => action.type === 'getIssue')?.sample).toBeUndefined()
    expect(bare.actions.find((action) => action.type === 'listTransitions')?.sample).toBeUndefined()
    const named = createJiraConnector({ env: { JIRA_ISSUE_KEY: 'EX-7' } })
    expect(named.actions.find((action) => action.type === 'getIssue')?.sample).toEqual({ issueKey: 'EX-7' })
    expect(named.actions.find((action) => action.type === 'listTransitions')?.sample).toEqual({ issueKey: 'EX-7' })
    expect(named.actions.find((action) => action.type === 'searchIssues')?.sample).toEqual({
      jql: 'order by created DESC',
      maxResults: '5'
    })
  })

  it('passes the SDK conformance checks against a stub, including the mock run of every action', async () => {
    const connector = createJiraConnector({ version: '0.1.0', sleep: async () => {} })
    const result = await runConformance(connector, { mock: true, now: () => NOW })
    expect(result.findings.filter((finding) => finding.level === 'error')).toEqual([])
    expect(result.findings.filter((finding) => finding.code.startsWith('mock'))).toEqual([])
    expect(result.receipt?.checks).toEqual(expect.arrayContaining(['manifest', 'auth', 'secrets', 'actions', 'dedupe', 'mock']))
  })
})

/* ------------------------------------------------------------- triggers -- */

describe('newIssue', () => {
  it('searches created issues since a day back in the user’s zone on the first poll and delivers oldest first', async () => {
    const later: JiraIssue = { ...SAMPLE_ISSUE, id: '10003', key: 'EX-2', fields: { ...SAMPLE_ISSUE.fields, created: '2023-06-24T20:00:00.000+0000' } }
    const { harness, calls } = connectorWith([MYSELF, searchRoute([{ issues: [later, SAMPLE_ISSUE] }])], {
      ...CONFIG,
      projectKey: 'ex',
      jql: 'issuetype = Bug OR priority = High'
    })
    const page = await harness.poll('newIssue')
    expect(page.items.map((item) => item.externalId)).toEqual(['10002', '10003'])
    expect(page.items[0]?.title).toBe('EX-1: Main order flow broken')
    expect(page.items[0]?.url).toBe(`${SITE}/browse/EX-1`)
    expect(calls[0]?.url).toBe(`${API}/myself`)
    const search = new URL(calls[1]?.url ?? '')
    expect(search.pathname).toBe('/rest/api/3/search/jql')
    const dayBack = new Date(Date.parse(NOW) - FIRST_POLL_CREATED_MS)
    expect(search.searchParams.get('jql')).toBe(
      `project = EX AND (created >= "2026-09-05 05:00") AND (issuetype = Bug OR priority = High) ORDER BY created ASC`
    )
    expect(dayBack.toISOString()).toBe('2026-09-05T12:00:00.000Z')
    expect(search.searchParams.get('fields')).toBe(TRIGGER_FIELDS)
    expect(search.searchParams.get('maxResults')).toBe(String(PAGE_SIZE))
  })

  it('starts two minutes before the watermark, reads the zone once, and redelivers nothing on a repeat', async () => {
    const { harness, calls } = connectorWith([MYSELF, searchRoute([{ issues: [SAMPLE_ISSUE] }])])
    const since = '2026-09-06T11:30:30.000Z'
    const page = await harness.poll('newIssue', { since })
    expect(page.items).toHaveLength(0)
    expect(jqlOf(calls[1])).toBe('created >= "2026-09-06 04:28" ORDER BY created ASC')
    expect(new Date(Date.parse(since) - OVERLAP_MS).toISOString()).toBe('2026-09-06T11:28:30.000Z')
    await harness.poll('newIssue', { since })
    expect(calls.filter((call) => call.url.endsWith('/myself'))).toHaveLength(1)
    expect(await harness.pollTwice('newIssue')).toEqual([])
  })

  it('walks nextPageToken up to the page cap and stops on an empty page', async () => {
    const pages = Array.from({ length: MAX_PAGES + 2 }, (_, index) => ({
      issues: [{ ...SAMPLE_ISSUE, id: String(20000 + index), key: `EX-${index}` }],
      nextPageToken: `page-${index + 1}`
    }))
    const { harness, calls } = connectorWith([MYSELF, searchRoute(pages)])
    const page = await harness.poll('newIssue')
    expect(page.items).toHaveLength(MAX_PAGES)
    expect(calls.filter((call) => call.url.includes('/search/jql'))).toHaveLength(MAX_PAGES)
    expect(new URL(calls[2]?.url ?? '').searchParams.get('nextPageToken')).toBe('page-1')

    const empty = connectorWith([MYSELF, { match: '/search/jql', body: {} }])
    expect((await empty.harness.poll('newIssue')).items).toEqual([])
    const zoneless = connectorWith([{ match: '/myself', body: {} }, { match: '/search/jql', body: { issues: [], nextPageToken: 'x' } }])
    expect((await zoneless.harness.poll('newIssue')).items).toEqual([])
    expect(jqlOf(zoneless.calls[1])).toBe('created >= "2026-09-05 12:00" ORDER BY created ASC')
  })
})

describe('issueUpdated', () => {
  it('searches on updated from an hour back and keys each edit by id and time', async () => {
    const { harness, calls } = connectorWith([MYSELF, searchRoute([{ issues: [SAMPLE_UPDATED_ISSUE] }])])
    const page = await harness.poll('issueUpdated')
    expect(page.items.map((item) => item.externalId)).toEqual(['10002:2023-06-25T08:10:00.000+0000'])
    expect(page.items[0]?.title).toBe('EX-1 updated: Main order flow broken')
    expect(jqlOf(calls[1])).toBe('updated >= "2026-09-06 04:00" ORDER BY updated ASC')
    expect(new Date(Date.parse(NOW) - FIRST_POLL_UPDATED_MS).toISOString()).toBe('2026-09-06T11:00:00.000Z')
  })
})

describe('issueTransitioned', () => {
  it('needs a status and searches with CHANGED TO … AFTER', async () => {
    const { harness, calls } = connectorWith([MYSELF, searchRoute([{ issues: [SAMPLE_TRANSITIONED_ISSUE] }])], {
      ...CONFIG,
      status: 'Done',
      projectKey: 'EX'
    })
    const page = await harness.poll('issueTransitioned')
    expect(page.items.map((item) => item.externalId)).toEqual(['10002:2023-06-26T14:00:00.000+0000'])
    expect(page.items[0]?.title).toBe('EX-1 is now Done: Main order flow broken')
    expect(page.items[0]?.status).toBe('Done')
    expect(jqlOf(calls[1])).toBe('project = EX AND (status CHANGED TO "Done" AFTER "2026-09-06 04:00") ORDER BY updated ASC')

    const unset = connectorWith([MYSELF])
    await expect(unset.harness.poll('issueTransitioned')).rejects.toThrow(/JIRA_STATUS is required/)
    expect(unset.calls).toHaveLength(0)
  })

  it('surfaces a search failure with Jira’s message', async () => {
    const { harness } = connectorWith([
      MYSELF,
      { match: '/search/jql', status: 400, body: { errorMessages: ['Error in the JQL Query: bounded query required'], errors: {} } }
    ])
    await expect(harness.poll('newIssue')).rejects.toThrow('400: Error in the JQL Query: bounded query required')
  })
})

/* -------------------------------------------------------------- actions -- */

describe('createIssue', () => {
  it('posts the fields with the description as ADF and merges extra fields', async () => {
    const { harness, calls } = connectorWith([
      { match: '/issue', method: 'POST', status: 201, body: { id: '10010', key: 'EX-10', self: `${API}/issue/10010` } }
    ])
    const result = await harness.execute('createIssue', {
      projectKey: 'EX',
      issueType: 'Bug',
      summary: 'Broken',
      description: 'First\n\nSecond',
      assigneeAccountId: 'u1',
      labels: 'a,b',
      priority: 'High',
      parentKey: 'EX-1',
      fields: '{"customfield_10000":"v","priority":{"name":"Highest"}}'
    })
    expect(result).toEqual({ id: '10010', key: 'EX-10', url: `${SITE}/browse/EX-10`, self: `${API}/issue/10010` })
    expect(calls[0]?.url).toBe(`${API}/issue`)
    expect(calls[0]?.body).toEqual({
      fields: {
        project: { key: 'EX' },
        issuetype: { name: 'Bug' },
        summary: 'Broken',
        description: {
          version: 1,
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] }
          ]
        },
        assignee: { id: 'u1' },
        labels: ['a', 'b'],
        priority: { name: 'Highest' },
        parent: { key: 'EX-1' },
        customfield_10000: 'v'
      }
    })
  })

  it('sends only the required fields when the rest are blank, and survives an empty reply', async () => {
    const { harness, calls } = connectorWith([{ match: '/issue', method: 'POST', body: {} }])
    const result = await harness.execute('createIssue', { projectKey: 'EX', issueType: 'Task', summary: 'S', labels: ' , ' })
    expect(result).toEqual({ id: '', key: '', url: '', self: '' })
    expect(calls[0]?.body).toEqual({ fields: { project: { key: 'EX' }, issuetype: { name: 'Task' }, summary: 'S' } })
  })

  it('repeats Jira’s field errors and never retries a 5xx', async () => {
    const { harness, calls } = connectorWith([
      { match: '/issue', method: 'POST', status: 400, body: { errorMessages: [], errors: { priority: "Field 'priority' is required" } } }
    ])
    await expect(harness.execute('createIssue', { projectKey: 'EX', issueType: 'Bug', summary: 'S' })).rejects.toThrow(
      "400: priority: Field 'priority' is required"
    )
    const flaky = connectorWith([{ match: '/issue', method: 'POST', status: 503, body: {} }])
    await expect(flaky.harness.execute('createIssue', { projectKey: 'EX', issueType: 'Bug', summary: 'S' })).rejects.toThrow('503')
    expect(flaky.calls).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  it('refuses a fields value that is not an object before calling', async () => {
    const { harness, calls } = connectorWith([])
    await expect(
      harness.execute('createIssue', { projectKey: 'EX', issueType: 'Bug', summary: 'S', fields: '[1]' })
    ).rejects.toThrow(/fields must be a JSON object/)
    expect(calls).toHaveLength(0)
  })
})

describe('updateIssue', () => {
  it('puts fields and update operations with returnIssue and answers with the issue', async () => {
    const { harness, calls } = connectorWith([
      { match: /\/issue\/EX-1\?/, method: 'PUT', body: { id: '10002', key: 'EX-1', fields: { summary: 'New' } } }
    ])
    const result = await harness.execute('updateIssue', {
      issueKey: 'EX-1',
      summary: 'New',
      description: 'Text',
      fields: '{"duedate":"2026-09-30"}',
      update: '{"labels":[{"add":"triaged"}]}',
      notifyUsers: 'false'
    })
    expect(result).toEqual({
      id: '10002',
      key: 'EX-1',
      url: `${SITE}/browse/EX-1`,
      issue: { id: '10002', key: 'EX-1', fields: { summary: 'New' } }
    })
    const url = new URL(calls[0]?.url ?? '')
    expect(url.pathname).toBe('/rest/api/3/issue/EX-1')
    expect(url.searchParams.get('returnIssue')).toBe('true')
    expect(url.searchParams.get('notifyUsers')).toBe('false')
    expect(calls[0]?.body).toEqual({
      fields: {
        summary: 'New',
        description: { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Text' }] }] },
        duedate: '2026-09-30'
      },
      update: { labels: [{ add: 'triaged' }] }
    })
  })

  it('falls back to the given key on a 204, and refuses an empty edit', async () => {
    const { harness, calls } = connectorWith([{ match: /\/issue\/10002/, method: 'PUT' }])
    expect(await harness.execute('updateIssue', { issueKey: '10002', update: '{"labels":[{"add":"x"}]}' })).toEqual({
      id: '',
      key: '10002',
      url: `${SITE}/browse/10002`,
      issue: {}
    })
    expect(new URL(calls[0]?.url ?? '').searchParams.get('notifyUsers')).toBeNull()
    expect(calls[0]?.body).toEqual({ update: { labels: [{ add: 'x' }] } })
    await expect(harness.execute('updateIssue', { issueKey: 'EX-1' })).rejects.toThrow(/at least one of summary, description, fields or update/)
    expect(calls).toHaveLength(1)
  })
})

describe('transitionIssue', () => {
  const TRANSITIONS: Route = {
    match: '/transitions',
    method: 'GET',
    body: {
      transitions: [
        { id: '11', name: 'Start progress', to: { id: '3', name: 'In Progress' } },
        { id: '31', name: 'Close it', to: { id: '10001', name: 'Done' } }
      ]
    }
  }

  it('resolves a name against the transition names, then the target statuses', async () => {
    const { harness, calls } = connectorWith([TRANSITIONS, { match: '/transitions', method: 'POST' }])
    expect(await harness.execute('transitionIssue', { issueKey: 'EX-1', transition: 'close IT', comment: 'Fixed', fields: '{"resolution":{"name":"Done"}}' })).toEqual({
      key: 'EX-1',
      id: '31',
      name: 'Close it',
      to: 'Done'
    })
    expect(calls[1]?.url).toBe(`${API}/issue/EX-1/transitions`)
    expect(calls[1]?.body).toEqual({
      transition: { id: '31' },
      update: { comment: [{ add: { body: { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fixed' }] }] } } }] },
      fields: { resolution: { name: 'Done' } }
    })
    expect(await harness.execute('transitionIssue', { issueKey: 'EX-1', transition: 'done' })).toMatchObject({ id: '31', to: 'Done' })
    expect(calls[3]?.body).toEqual({ transition: { id: '31' } })
  })

  it('sends an id as it is, naming it when the list knows it', async () => {
    const { harness } = connectorWith([TRANSITIONS, { match: '/transitions', method: 'POST' }])
    expect(await harness.execute('transitionIssue', { issueKey: 'EX-1', transition: '11' })).toEqual({
      key: 'EX-1',
      id: '11',
      name: 'Start progress',
      to: 'In Progress'
    })
    expect(await harness.execute('transitionIssue', { issueKey: 'EX-1', transition: '99' })).toEqual({ key: 'EX-1', id: '99', name: '', to: '' })
  })

  it('lists what the issue offers when a name matches nothing, and defers to Jira when it offers nothing', async () => {
    const { harness, calls } = connectorWith([TRANSITIONS, { match: '/transitions', method: 'POST' }])
    await expect(harness.execute('transitionIssue', { issueKey: 'EX-1', transition: 'Reopen' })).rejects.toThrow(
      'EX-1 offers no transition named "Reopen"; it offers: Start progress (11), Close it (31)'
    )
    expect(calls).toHaveLength(1)
    const bare = connectorWith([{ match: '/transitions', method: 'GET', body: {} }, { match: '/transitions', method: 'POST' }])
    expect(await bare.harness.execute('transitionIssue', { issueKey: 'EX-1', transition: 'Reopen' })).toEqual({ key: 'EX-1', id: 'Reopen', name: '', to: '' })
    expect(bare.calls[1]?.body).toEqual({ transition: { id: 'Reopen' } })
  })
})

describe('addComment', () => {
  it('posts the body as ADF and shapes the comment', async () => {
    const { harness, calls } = connectorWith([
      {
        match: '/comment',
        method: 'POST',
        status: 201,
        body: {
          id: '10000',
          created: '2021-01-17T12:34:00.000+0000',
          updated: '2021-01-17T12:35:00.000+0000',
          author: { accountId: 'me', displayName: 'Mia Krystof' },
          self: `${API}/issue/10010/comment/10000`
        }
      }
    ])
    expect(await harness.execute('addComment', { issueKey: 'EX-1', body: 'Looks good' })).toEqual({
      id: '10000',
      created: '2021-01-17T12:34:00.000Z',
      updated: '2021-01-17T12:35:00.000Z',
      author: { accountId: 'me', displayName: 'Mia Krystof' },
      self: `${API}/issue/10010/comment/10000`,
      url: `${SITE}/browse/EX-1?focusedCommentId=10000`
    })
    expect(calls[0]?.url).toBe(`${API}/issue/EX-1/comment`)
    expect(calls[0]?.body).toEqual({ body: { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Looks good' }] }] } })
    const empty = connectorWith([{ match: '/comment', method: 'POST', body: {} }])
    expect(await empty.harness.execute('addComment', { issueKey: 'EX-1', body: 'x' })).toEqual({
      id: '',
      created: '',
      updated: '',
      author: { accountId: '', displayName: '' },
      self: '',
      url: `${SITE}/browse/EX-1`
    })
  })
})

describe('assignIssue', () => {
  it('puts the account id, or null to unassign', async () => {
    const { harness, calls } = connectorWith([{ match: '/assignee', method: 'PUT' }])
    expect(await harness.execute('assignIssue', { issueKey: 'EX-1', accountId: 'u1' })).toEqual({ key: 'EX-1', accountId: 'u1' })
    expect(calls[0]?.url).toBe(`${API}/issue/EX-1/assignee`)
    expect(calls[0]?.body).toEqual({ accountId: 'u1' })
    expect(await harness.execute('assignIssue', { issueKey: 'EX-1' })).toEqual({ key: 'EX-1', accountId: null })
    expect(calls[1]?.body).toEqual({ accountId: null })
  })
})

describe('getIssue', () => {
  it('reads one issue with every navigable field by default and flattens it', async () => {
    const { harness, calls } = connectorWith([{ match: /\/issue\/EX-1\?/, body: SAMPLE_ISSUE }])
    const result = await harness.execute('getIssue', { issueKey: 'EX-1' })
    expect(result).toMatchObject({ id: '10002', key: 'EX-1', summary: 'Main order flow broken', status: 'To Do', issue: SAMPLE_ISSUE })
    expect(new URL(calls[0]?.url ?? '').searchParams.get('fields')).toBe('*navigable')
    await harness.execute('getIssue', { issueKey: 'EX-1', fields: 'summary,status' })
    expect(new URL(calls[1]?.url ?? '').searchParams.get('fields')).toBe('summary,status')
    const missing = connectorWith([{ match: /\/issue\//, status: 404, body: { errorMessages: ['Issue does not exist or you do not have permission to see it.'], errors: {} } }])
    await expect(missing.harness.execute('getIssue', { issueKey: 'EX-404' })).rejects.toThrow('404: Issue does not exist or you do not have permission to see it.')
  })
})

describe('searchIssues', () => {
  it('bounds a bare order by, sends the default fields, and pages until maxResults', async () => {
    const pages = [
      { issues: [{ ...SAMPLE_ISSUE, id: '1', key: 'EX-1' }, { ...SAMPLE_ISSUE, id: '2', key: 'EX-2' }], nextPageToken: 'page-1' },
      { issues: [{ ...SAMPLE_ISSUE, id: '3', key: 'EX-3' }, { ...SAMPLE_ISSUE, id: '4', key: 'EX-4' }], nextPageToken: 'page-2' },
      { issues: [{ ...SAMPLE_ISSUE, id: '5', key: 'EX-5' }] }
    ]
    const { harness, calls } = connectorWith([searchRoute(pages)])
    const result = await harness.execute('searchIssues', { jql: 'order by created DESC', maxResults: '3' })
    expect(result).toMatchObject({ count: 3, isLast: false, nextPageToken: 'page-2' })
    expect((result.issues as Array<{ key: string }>).map((issue) => issue.key)).toEqual(['EX-1', 'EX-2', 'EX-3'])
    const first = new URL(calls[0]?.url ?? '')
    expect(first.searchParams.get('jql')).toBe('created >= "1970-01-01" order by created DESC')
    expect(first.searchParams.get('fields')).toBe(TRIGGER_FIELDS)
    expect(first.searchParams.get('maxResults')).toBe('3')
    expect(new URL(calls[1]?.url ?? '').searchParams.get('maxResults')).toBe('1')
    expect(calls).toHaveLength(2)
  })

  it('applies the default count, custom fields, and survives an empty reply', async () => {
    const { harness, calls } = connectorWith([{ match: '/search/jql', body: {} }])
    expect(await harness.execute('searchIssues', { jql: 'project = EX', fields: 'summary' })).toEqual({ issues: [], count: 0, isLast: true })
    const url = new URL(calls[0]?.url ?? '')
    expect(url.searchParams.get('maxResults')).toBe(String(DEFAULT_SEARCH_RESULTS))
    expect(url.searchParams.get('fields')).toBe('summary')
    expect(url.searchParams.get('jql')).toBe('project = EX')
    await expect(harness.execute('searchIssues', { jql: 'project = EX', maxResults: '6000' })).rejects.toThrow(/maxResults must be a whole number from 1 to 5000/)
  })
})

describe('listTransitions', () => {
  it('shapes the transitions an issue offers', async () => {
    const { harness, calls } = connectorWith([
      { match: '/transitions', body: { transitions: [{ id: '31', name: 'Done', to: { id: '10001', name: 'Done', statusCategory: { name: 'Done' } } }] } }
    ])
    expect(await harness.execute('listTransitions', { issueKey: 'EX-1' })).toEqual({
      transitions: [{ id: '31', name: 'Done', to: { id: '10001', name: 'Done', statusCategory: 'Done' }, hasScreen: false, isAvailable: true }],
      count: 1
    })
    expect(calls[0]?.url).toBe(`${API}/issue/EX-1/transitions`)
    const empty = connectorWith([{ match: '/transitions', body: {} }])
    expect(await empty.harness.execute('listTransitions', { issueKey: 'EX-1' })).toEqual({ transitions: [], count: 0 })
  })
})

describe('listProjects', () => {
  it('pages project search on startAt while isLast is false', async () => {
    const { harness, calls } = connectorWith([
      {
        match: '/project/search',
        body: (url: URL) =>
          url.searchParams.get('startAt') === '0'
            ? { values: [{ id: '1', key: 'EX', name: 'Example', projectTypeKey: 'software' }], isLast: false }
            : { values: [{ id: '2', key: 'OPS', name: 'Ops', projectTypeKey: 'business' }], isLast: true }
      }
    ])
    const result = await harness.execute('listProjects', { query: 'e', typeKey: 'software' })
    expect(result.count).toBe(2)
    expect((result.projects as Array<{ key: string; url: string }>).map((project) => project.key)).toEqual(['EX', 'OPS'])
    expect((result.projects as Array<{ url: string }>)[0]?.url).toBe(`${SITE}/browse/EX`)
    const first = new URL(calls[0]?.url ?? '')
    expect(first.pathname).toBe('/rest/api/3/project/search')
    expect(first.searchParams.get('maxResults')).toBe('100')
    expect(first.searchParams.get('orderBy')).toBe('key')
    expect(first.searchParams.get('query')).toBe('e')
    expect(first.searchParams.get('typeKey')).toBe('software')
    expect(new URL(calls[1]?.url ?? '').searchParams.get('startAt')).toBe('1')
    const empty = connectorWith([{ match: '/project/search', body: {} }])
    expect(await empty.harness.execute('listProjects', {})).toEqual({ projects: [], count: 0 })
    expect(new URL(empty.calls[0]?.url ?? '').searchParams.has('query')).toBe(false)
  })
})

describe('getCurrentUser', () => {
  it('shapes GET /myself', async () => {
    const { harness, calls } = connectorWith([MYSELF])
    expect(await harness.execute('getCurrentUser', {})).toEqual({
      accountId: 'me',
      accountType: '',
      displayName: 'Mia Krystof',
      active: true,
      timeZone: 'America/Los_Angeles',
      locale: '',
      self: ''
    })
    expect(calls[0]?.url).toBe(`${API}/myself`)
  })

  it('reports a wrong token without retrying', async () => {
    const { harness, calls } = connectorWith([{ match: '/myself', status: 401, body: {} }])
    await expect(harness.execute('getCurrentUser', {})).rejects.toThrow('401: ')
    expect(calls).toHaveLength(1)
  })
})

/* ------------------------------------------------------------ preflight -- */

describe('preflight', () => {
  it('names the missing variables without calling anything', async () => {
    const { connector, calls } = connectorWith([MYSELF], CONFIG, { JIRA_SITE_URL: SITE })
    expect(await connector.preflight?.()).toEqual({
      ok: false,
      message: expect.stringMatching(/^Set JIRA_EMAIL, JIRA_API_TOKEN\. Create one at/)
    })
    expect(calls).toHaveLength(0)
  })

  it('reads GET /myself with the environment’s values', async () => {
    const env = { JIRA_SITE_URL: `${SITE}/`, JIRA_EMAIL: 'me@example.com', JIRA_API_TOKEN: 'token-value' }
    const { connector, calls } = connectorWith([MYSELF], CONFIG, env)
    expect(await connector.preflight?.()).toEqual({ ok: true, message: `Signed in to ${SITE} as Mia Krystof` })
    expect(calls[0]?.url).toBe(`${API}/myself`)
    const nameless = connectorWith([{ match: '/myself', body: {} }], CONFIG, env)
    expect(await nameless.connector.preflight?.()).toEqual({ ok: true, message: `Signed in to ${SITE} as the token's account` })
    const wrong = connectorWith([{ match: '/myself', status: 401, body: {} }], CONFIG, env)
    await expect(wrong.connector.preflight?.()).rejects.toThrow('401')
  })
})
