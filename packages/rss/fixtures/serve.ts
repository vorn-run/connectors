import { readFileSync } from 'node:fs'

/** A recorded feed or page from this directory. */
export function fixture(name: string): string {
  return readFileSync(new URL(name, import.meta.url), 'utf8')
}

export interface Reply {
  body?: string | Uint8Array
  status?: number
  headers?: Record<string, string>
  /** The address after redirects, as `Response.url` reports it. */
  url?: string
}

export interface Seen {
  url: string
  headers: Headers
}

export type Handler = Reply | ((request: Seen) => Reply)

/** A fetch answering from `routes` by exact address; any other address fails the request, and so the test. */
export function serve(routes: Record<string, Handler>): { fetchImpl: typeof fetch; calls: Seen[] } {
  const calls: Seen[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = { url: String(input), headers: new Headers(init?.headers) }
    calls.push(request)
    const handler = routes[request.url]
    if (handler === undefined) throw new Error(`unexpected request to ${request.url}`)
    const reply = typeof handler === 'function' ? handler(request) : handler
    const status = reply.status ?? 200
    const res = new Response(status === 304 ? null : (reply.body ?? ''), { status, headers: reply.headers })
    if (reply.url) Object.defineProperty(res, 'url', { value: reply.url })
    return res
  }) as typeof fetch
  return { fetchImpl, calls }
}
