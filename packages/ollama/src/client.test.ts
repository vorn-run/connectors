import { describe, expect, it, vi } from 'vitest'
import {
  CONNECTION_RETRY_WAIT_MS,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  LONG_TIMEOUT_MS,
  OllamaApiError,
  createOllamaClient,
  describeFailure,
  normalizeBaseUrl,
  type FetchLike
} from './client'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function refused(): Error {
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' })
  return Object.assign(new TypeError('fetch failed'), { cause })
}

describe('normalizeBaseUrl', () => {
  it('defaults to the local server', () => {
    expect(normalizeBaseUrl(undefined)).toBe(DEFAULT_BASE_URL)
    expect(normalizeBaseUrl('   ')).toBe(DEFAULT_BASE_URL)
  })

  it('strips a trailing slash or /api and prefixes a bare host with http', () => {
    expect(normalizeBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434')
    expect(normalizeBaseUrl('http://localhost:11434/api')).toBe('http://localhost:11434')
    expect(normalizeBaseUrl('http://localhost:11434/api/')).toBe('http://localhost:11434')
    expect(normalizeBaseUrl('0.0.0.0:11434')).toBe('http://0.0.0.0:11434')
    expect(normalizeBaseUrl('https://ollama.com/api')).toBe('https://ollama.com')
  })
})

describe('describeFailure', () => {
  it('says a missing model is not present and never pulls it', () => {
    expect(describeFailure("model 'nope' not found")).toBe("Model 'nope' is not present on the server; pull it first")
    expect(describeFailure('something else')).toBe('something else')
  })

  it('reports the server message with the status', () => {
    const error = new OllamaApiError(404, { error: "model 'nope' not found" })
    expect(error.message).toBe("Model 'nope' is not present on the server; pull it first (HTTP 404)")
    expect(error.status).toBe(404)
    expect(error.detail).toBe("model 'nope' not found")
    expect(new OllamaApiError(503, { error: 'server overloaded' }).message).toBe('server overloaded (HTTP 503)')
    expect(new OllamaApiError(502, 'bad gateway').message).toBe('bad gateway (HTTP 502)')
    expect(new OllamaApiError(500, undefined).message).toBe('no body (HTTP 500)')
    expect(new OllamaApiError(400, { detail: 'x' }).message).toBe('{"detail":"x"} (HTTP 400)')
    expect(new OllamaApiError(400, 'y'.repeat(400)).message).toBe(`${'y'.repeat(300)}… (HTTP 400)`)
  })
})

describe('createOllamaClient', () => {
  it('posts JSON to the api path under the base url and reads the reply', async () => {
    const fetchImpl = vi.fn(async () => json({ version: '0.33.3' })) as unknown as FetchLike
    const client = createOllamaClient({ baseUrl: 'http://box:11434/api/', fetchImpl })
    expect(client.baseUrl).toBe('http://box:11434')
    expect(await client.post('show', { model: 'x' })).toEqual({ version: '0.33.3' })
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://box:11434/api/show')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"model":"x"}')
    expect(init.headers).toEqual({ accept: 'application/json', 'content-type': 'application/json' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('sends the bearer header only when a key is given, and none on a GET body', async () => {
    const fetchImpl = vi.fn(async () => json({})) as unknown as FetchLike
    await createOllamaClient({ apiKey: ' <token> ', fetchImpl }).get('version')
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${DEFAULT_BASE_URL}/api/version`)
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
    expect(init.headers).toEqual({ accept: 'application/json', authorization: 'Bearer <token>' })
  })

  it('returns undefined for an empty body and text for one that is not JSON', async () => {
    const replies = [new Response(null, { status: 200 }), new Response('plain', { status: 200 })]
    const fetchImpl = vi.fn(async () => replies.shift()!) as unknown as FetchLike
    const client = createOllamaClient({ fetchImpl })
    expect(await client.request('DELETE', 'delete', { body: { model: 'x' } })).toBeUndefined()
    expect(await client.get('version')).toBe('plain')
  })

  it('throws the server message with the status on a failed reply', async () => {
    const fetchImpl = vi.fn(async () => json({ error: "model 'nope' not found" }, 404)) as unknown as FetchLike
    await expect(createOllamaClient({ fetchImpl }).post('chat', {})).rejects.toThrow(
      "Model 'nope' is not present on the server; pull it first (HTTP 404)"
    )
    const notJson = vi.fn(async () => new Response('<html>', { status: 502 })) as unknown as FetchLike
    await expect(createOllamaClient({ fetchImpl: notJson }).get('tags')).rejects.toThrow('<html> (HTTP 502)')
  })

  it('retries once after a connection refused and then says the server may be starting', async () => {
    const waits: number[] = []
    const sleep = async (ms: number) => {
      waits.push(ms)
    }
    const recovers = vi.fn<FetchLike>()
    recovers.mockImplementationOnce(async () => {
      throw refused()
    })
    recovers.mockImplementationOnce(async () => json({ version: '1' }))
    expect(await createOllamaClient({ fetchImpl: recovers, sleep }).get('version')).toEqual({
      version: '1'
    })
    expect(waits).toEqual([CONNECTION_RETRY_WAIT_MS])

    const down = vi.fn(async () => {
      throw refused()
    }) as unknown as FetchLike
    await expect(createOllamaClient({ fetchImpl: down, sleep }).get('version')).rejects.toThrow(
      `Ollama did not answer at ${DEFAULT_BASE_URL}; the server may be starting or not running`
    )
    expect(down).toHaveBeenCalledTimes(2)
  })

  it('recognises a refusal wrapped in an aggregate cause', async () => {
    const aggregate = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('AggregateError'), { errors: [Object.assign(new Error('x'), { code: 'ECONNREFUSED' })] })
    })
    const fetchImpl = vi.fn(async () => {
      throw aggregate
    }) as unknown as FetchLike
    await expect(createOllamaClient({ fetchImpl, sleep: async () => {} }).get('version')).rejects.toThrow('may be starting')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retry any other network failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) })
    }) as unknown as FetchLike
    await expect(createOllamaClient({ fetchImpl }).get('version')).rejects.toThrow('fetch failed')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const plain = vi.fn(async () => {
      throw new Error('boom')
    }) as unknown as FetchLike
    await expect(createOllamaClient({ fetchImpl: plain }).get('version')).rejects.toThrow('boom')
  })

  it('gives up after the timeout and names the route', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl: FetchLike = (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      const client = createOllamaClient({ fetchImpl })
      const pending = client.post('chat', {}, LONG_TIMEOUT_MS)
      const failure = expect(pending).rejects.toThrow('Ollama did not answer POST /api/chat within 600s')
      await vi.advanceTimersByTimeAsync(LONG_TIMEOUT_MS)
      await failure
      const short = client.get('tags')
      const shortFailure = expect(short).rejects.toThrow('Ollama did not answer GET /api/tags within 30s')
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      await shortFailure
    } finally {
      vi.useRealTimers()
    }
  })

  it('sleeps for real between connection attempts when no sleep is injected', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(async () => {
        throw refused()
      }) as unknown as FetchLike
      const pending = createOllamaClient({ fetchImpl }).get('version')
      const failure = expect(pending).rejects.toThrow('may be starting')
      await vi.advanceTimersByTimeAsync(CONNECTION_RETRY_WAIT_MS)
      await failure
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the global fetch when none is injected', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ version: '2' }))
    try {
      expect(await createOllamaClient().get('version')).toEqual({ version: '2' })
      expect(spy).toHaveBeenCalledWith(`${DEFAULT_BASE_URL}/api/version`, expect.objectContaining({ method: 'GET' }))
    } finally {
      spy.mockRestore()
    }
  })
})
