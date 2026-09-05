// Slack answers HTTP 200 with `ok: false` on failure, so the envelope is read here and the error code surfaced verbatim.

export const SLACK_API = 'https://slack.com/api'

export interface SlackEnvelope {
  ok?: boolean
  error?: string
  response_metadata?: { next_cursor?: string }
}

/** Query or body arguments; an undefined or empty one is left out. */
export type SlackParams = Record<string, string | number | boolean | undefined>

export interface SlackCallOptions {
  token: string
  fetch: typeof fetch
}

async function readEnvelope(method: string, response: Response): Promise<SlackEnvelope> {
  const payload = (await response.json().catch(() => undefined)) as SlackEnvelope | undefined
  // The envelope's own verdict comes first: a 429 also carries `ratelimited`.
  if (payload?.ok === false) {
    throw new Error(`Slack ${method} answered ${payload.error ?? 'an unnamed error'}`)
  }
  if (!response.ok) throw new Error(`Slack ${method} answered HTTP ${response.status}`)
  return payload ?? {}
}

/** A read: arguments travel in the query string. */
export async function slackGet<T>(
  method: string,
  params: SlackParams,
  options: SlackCallOptions
): Promise<T & SlackEnvelope> {
  const url = new URL(`${SLACK_API}/${method}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
  }
  const response = await options.fetch(url.toString(), {
    headers: { authorization: `Bearer ${options.token}` }
  })
  return (await readEnvelope(method, response)) as T & SlackEnvelope
}

/** A write: arguments travel as a JSON body. */
export async function slackPost<T>(
  method: string,
  body: Record<string, unknown>,
  options: SlackCallOptions
): Promise<T & SlackEnvelope> {
  const response = await options.fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(body)
  })
  return (await readEnvelope(method, response)) as T & SlackEnvelope
}

/** How far a walk goes: it ends at `items` collected, at `pages` fetched, or when Slack has no more. */
export interface SlackWalk {
  items: number
  pages: number
}

/** Follow `next_cursor` until the walk's bounds are met or Slack has no more pages. */
export async function slackPages<T, R>(
  method: string,
  params: SlackParams,
  options: SlackCallOptions,
  entries: (page: T & SlackEnvelope) => R[],
  walk: SlackWalk
): Promise<R[]> {
  const collected: R[] = []
  let cursor: string | undefined
  for (let index = 0; index < walk.pages && collected.length < walk.items; index++) {
    const page = await slackGet<T>(method, { ...params, cursor }, options)
    collected.push(...entries(page))
    cursor = page.response_metadata?.next_cursor || undefined
    if (cursor === undefined) break
  }
  return collected
}
