import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  API_ROOT,
  MAX_LIST_PAGES,
  STRIPE_VERSION,
  StripeApiError,
  StripeNotFoundError,
  StripeSignedOutError,
  assertSecretKey,
  createStripeClient,
  createTokenSource,
  dashboardUrl,
  encodeParams,
  idempotencyKey,
  readProfileKey,
  runStripe,
  stripeInstallHint,
  stripePreflight
} from './client'

const CONFIG_TOML = `color = "on"

[default]
  device_name = "st-stripe1"
  live_mode_api_key = "rk_live_abc123"
  live_mode_publishable_key = "pk_live_abc123"
  test_mode_api_key = "rk_test_abc123"
  test_mode_publishable_key = "pk_test_abc123"

["acme shop"]
  test_mode_api_key = "rk_test_acme"
`

/** A fake `stripe` that answers with the documents given, in order. */
function stripeReturning(...documents: string[]) {
  const calls: string[][] = []
  let next = 0
  return {
    calls,
    stripe: async (args: string[]) => {
      calls.push(args)
      return documents[Math.min(next++, documents.length - 1)]
    }
  }
}

interface Reply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
  text?: string
}

/** A fetch that serves the replies given, in order, and records each request. */
function fetchReplying(...replies: Reply[]) {
  const sent: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = []
  let index = 0
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === 'string' && { body: init.body })
    })
    const reply = replies[Math.min(index++, replies.length - 1)]
    const body = reply.text ?? JSON.stringify(reply.body ?? {})
    return new Response(body, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers }
    })
  }) as unknown as typeof fetch
  return { fetchImpl, sent }
}

const noSleep = async () => undefined

describe('readProfileKey', () => {
  it('reads the test key of the default profile', () => {
    expect(readProfileKey(CONFIG_TOML, 'default', false)).toBe('rk_test_abc123')
  })

  it('reads the live key when asked', () => {
    expect(readProfileKey(CONFIG_TOML, 'default', true)).toBe('rk_live_abc123')
  })

  it('reads a named profile, quoted or not', () => {
    expect(readProfileKey(CONFIG_TOML, 'acme shop', false)).toBe('rk_test_acme')
    expect(readProfileKey(CONFIG_TOML, 'acme shop', true)).toBeUndefined()
    expect(readProfileKey('[plain]\ntest_mode_api_key = "sk_test_p"\n', 'plain', false)).toBe('sk_test_p')
  })

  it('is nothing for a missing profile, an empty value or a keyless document', () => {
    expect(readProfileKey(CONFIG_TOML, 'nobody', false)).toBeUndefined()
    expect(readProfileKey('[default]\ntest_mode_api_key = ""\n', 'default', false)).toBeUndefined()
    expect(readProfileKey('color = "on"\r\n', 'default', false)).toBeUndefined()
  })
})

describe('assertSecretKey', () => {
  it('passes secret and restricted keys and refuses a publishable one', () => {
    expect(assertSecretKey('sk_test_1')).toBe('sk_test_1')
    expect(assertSecretKey('rk_live_1')).toBe('rk_live_1')
    expect(() => assertSecretKey('pk_test_1')).toThrow(/publishable key/)
  })
})

describe('createTokenSource', () => {
  it('uses a pasted key as-is and never runs stripe', async () => {
    const { stripe, calls } = stripeReturning(CONFIG_TOML)
    const tokens = createTokenSource({ apiKey: ' sk_test_pasted ', stripe })

    expect(tokens.borrowed).toBe(false)
    expect(await tokens.get()).toBe('sk_test_pasted')
    tokens.invalidate()
    expect(await tokens.get()).toBe('sk_test_pasted')
    expect(calls).toEqual([])
  })

  it('borrows the test key of the default profile and remembers it until invalidated', async () => {
    const { stripe, calls } = stripeReturning(CONFIG_TOML, CONFIG_TOML.replace('rk_test_abc123', 'rk_test_fresh'))
    const tokens = createTokenSource({ stripe })

    expect(tokens.borrowed).toBe(true)
    expect(await tokens.get()).toBe('rk_test_abc123')
    expect(await tokens.get()).toBe('rk_test_abc123')
    expect(calls).toEqual([['config', '--list']])

    tokens.invalidate()
    expect(await tokens.get()).toBe('rk_test_fresh')
    expect(calls).toHaveLength(2)
  })

  it('borrows the live key, and a named profile through --project-name', async () => {
    const live = stripeReturning(CONFIG_TOML)
    expect(await createTokenSource({ liveMode: true, stripe: live.stripe }).get()).toBe('rk_live_abc123')

    const named = stripeReturning(CONFIG_TOML)
    expect(await createTokenSource({ project: ' acme shop ', stripe: named.stripe }).get()).toBe('rk_test_acme')
    expect(named.calls).toEqual([['config', '--list', '--project-name', 'acme shop']])
  })

  it('treats a profile without the key as signed out, naming the key and profile', async () => {
    const { stripe } = stripeReturning('color = "on"\n')
    const error = await createTokenSource({ stripe }).get().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(StripeSignedOutError)
    expect((error as Error).message).toContain('stripe login')
    expect((error as Error).message).toContain('test_mode_api_key for profile "default"')

    const live = await createTokenSource({ liveMode: true, project: 'acme shop', stripe }).get().catch((c: unknown) => c)
    expect((live as Error).message).toContain('live_mode_api_key for profile "acme shop"')
  })

  it('treats a blank pasted key as absent and borrows instead', async () => {
    const { stripe, calls } = stripeReturning(CONFIG_TOML)
    const tokens = createTokenSource({ apiKey: '   ', stripe })
    expect(tokens.borrowed).toBe(true)
    expect(await tokens.get()).toBe('rk_test_abc123')
    expect(calls).toHaveLength(1)
  })

  it('refuses a publishable key wherever it came from', async () => {
    await expect(createTokenSource({ apiKey: 'pk_test_x' }).get()).rejects.toThrow(/publishable/)
    const { stripe } = stripeReturning('[default]\ntest_mode_api_key = "pk_test_y"\n')
    await expect(createTokenSource({ stripe }).get()).rejects.toThrow(/publishable/)
  })
})

describe('encodeParams', () => {
  it('brackets nested values and leaves out what is unset', () => {
    const encoded = encodeParams({
      limit: 100,
      created: { gte: 1680000000, lt: undefined },
      metadata: { order_id: '6735', note: '' },
      expand: ['data.customer', 'data.charge'],
      email: null,
      status: 'paid'
    })
    expect(encoded.toString()).toBe(
      'limit=100&created%5Bgte%5D=1680000000&metadata%5Border_id%5D=6735&expand%5B0%5D=data.customer&expand%5B1%5D=data.charge&status=paid'
    )
    expect(decodeURIComponent(encoded.toString())).toContain('created[gte]=1680000000')
  })
})

describe('idempotencyKey', () => {
  it('is 64 hex characters, the same for the same inputs in any order, different otherwise', () => {
    const one = idempotencyKey('createCustomer', { email: 'a@b.c', metadata: { x: '1', y: '2' } })
    const two = idempotencyKey('createCustomer', { metadata: { y: '2', x: '1' }, email: 'a@b.c' })
    expect(one).toMatch(/^[0-9a-f]{64}$/)
    expect(two).toBe(one)
    expect(idempotencyKey('createRefund', { email: 'a@b.c', metadata: { x: '1', y: '2' } })).not.toBe(one)
    expect(idempotencyKey('createCustomer', { email: 'a@b.d' })).not.toBe(one)
    expect(one).not.toContain('a@b.c')
  })

  it('canonicalises arrays too', () => {
    expect(idempotencyKey('x', { list: [{ b: 1, a: 2 }] })).toBe(idempotencyKey('x', { list: [{ a: 2, b: 1 }] }))
  })
})

describe('dashboardUrl', () => {
  it('inserts /test for sandbox objects and not for live ones', () => {
    expect(dashboardUrl('customers/cus_1', false)).toBe('https://dashboard.stripe.com/test/customers/cus_1')
    expect(dashboardUrl('customers/cus_1', undefined)).toBe('https://dashboard.stripe.com/test/customers/cus_1')
    expect(dashboardUrl('payments/pi_1', true)).toBe('https://dashboard.stripe.com/payments/pi_1')
  })
})

describe('createStripeClient', () => {
  const config = { apiKey: 'sk_test_pasted' }

  it('sends the bearer key and the pinned API version on a GET with a query', async () => {
    const { fetchImpl, sent } = fetchReplying({ body: { id: 'cus_1' } })
    const client = createStripeClient({ config, fetch: fetchImpl })

    const customer = await client.get<{ id: string }>('/customers/cus_1', { expand: undefined })

    expect(customer).toEqual({ id: 'cus_1' })
    expect(sent[0]).toMatchObject({
      url: `${API_ROOT}/customers/cus_1`,
      method: 'GET',
      headers: { Authorization: 'Bearer sk_test_pasted', 'Stripe-Version': STRIPE_VERSION }
    })
    expect(STRIPE_VERSION).toBe('2026-08-26.dahlia')
  })

  it('walks a list with starting_after while has_more, newest first as Stripe returns it', async () => {
    const { fetchImpl, sent } = fetchReplying(
      { body: { object: 'list', data: [{ id: 'c3' }, { id: 'c2' }], has_more: true } },
      { body: { object: 'list', data: [{ id: 'c1' }], has_more: false } }
    )
    const client = createStripeClient({ config, fetch: fetchImpl })

    const items = await client.list<{ id: string }>('/customers', { created: { gte: 5 } })

    expect(items.map((item) => item.id)).toEqual(['c3', 'c2', 'c1'])
    expect(sent).toHaveLength(2)
    expect(decodeURIComponent(sent[0].url)).toBe(`${API_ROOT}/customers?created[gte]=5&limit=100`)
    expect(decodeURIComponent(sent[1].url)).toBe(`${API_ROOT}/customers?created[gte]=5&limit=100&starting_after=c2`)
  })

  it('stops at the page bound rather than walking an account forever', async () => {
    let page = 0
    const fetchImpl = vi.fn(async () => {
      page += 1
      return new Response(JSON.stringify({ data: [{ id: `c${page}` }], has_more: true }), {
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch
    const client = createStripeClient({ config, fetch: fetchImpl })

    const items = await client.list('/customers', {})

    expect(items).toHaveLength(MAX_LIST_PAGES)
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_LIST_PAGES)
    expect(await client.list('/customers', {}, { maxPages: 2 })).toHaveLength(2)
  })

  it('stops when a page claims more but holds nothing, and refuses a non-list', async () => {
    const empty = createStripeClient({ config, fetch: fetchReplying({ body: { data: [], has_more: true } }).fetchImpl })
    expect(await empty.list('/customers', {})).toEqual([])

    const wrong = createStripeClient({ config, fetch: fetchReplying({ body: { id: 'cus_1' } }).fetchImpl })
    await expect(wrong.list('/customers', {})).rejects.toThrow('Stripe answered /customers with something other than a list')
  })

  it('posts a form body with the idempotency key and content type', async () => {
    const { fetchImpl, sent } = fetchReplying({ body: { id: 're_1' } })
    const client = createStripeClient({ config, fetch: fetchImpl })

    const refund = await client.post<{ id: string }>('/refunds', { charge: 'ch_1', amount: 500, reason: undefined }, 'abc')

    expect(refund).toEqual({ id: 're_1' })
    expect(sent[0]).toEqual({
      url: `${API_ROOT}/refunds`,
      method: 'POST',
      headers: {
        Authorization: 'Bearer sk_test_pasted',
        'Stripe-Version': STRIPE_VERSION,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': 'abc'
      },
      body: 'charge=ch_1&amount=500'
    })
  })

  it('retries a POST twice on 429 and 5xx with jittered backoff, then answers', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined)
    const { fetchImpl, sent } = fetchReplying(
      { status: 429, body: { error: { type: 'rate_limit_error', message: 'slow down' } } },
      { status: 503, text: 'unavailable' },
      { body: { id: 'cus_1' } }
    )
    const client = createStripeClient({ config, fetch: fetchImpl, sleep, random: () => 0.5 })

    expect(await client.post('/customers', {}, 'k')).toEqual({ id: 'cus_1' })
    expect(sent).toHaveLength(3)
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000])
  })

  it('gives up on a POST after the second retry and quotes the rate limit', async () => {
    const { fetchImpl, sent } = fetchReplying({
      status: 429,
      body: { error: { type: 'rate_limit_error', message: 'Too many requests' } },
      headers: { 'request-id': 'req_9' }
    })
    const client = createStripeClient({ config, fetch: fetchImpl, sleep: noSleep })

    await expect(client.post('/customers', {}, 'k')).rejects.toThrow('rate_limit_error: Too many requests (req_9)')
    expect(sent).toHaveLength(3)
  })

  it('does not retry a GET itself; the SDK fetch it is handed already does', async () => {
    const { fetchImpl, sent } = fetchReplying({ status: 500, text: 'boom' })
    const client = createStripeClient({ config, fetch: fetchImpl, sleep: noSleep })

    await expect(client.get('/balance')).rejects.toThrow('Stripe API 500: boom')
    expect(sent).toHaveLength(1)
  })

  it('formats an error as type/code: message (request id)', async () => {
    const { fetchImpl } = fetchReplying({
      status: 404,
      body: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such customer', param: 'id' } },
      headers: { 'request-id': 'req_abc' }
    })
    const client = createStripeClient({ config, fetch: fetchImpl })

    const error = await client.get('/customers/x').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(StripeApiError)
    expect((error as Error).message).toBe('invalid_request_error/resource_missing: No such customer (req_abc)')
    expect(error).toMatchObject({ status: 404, type: 'invalid_request_error', errorCode: 'resource_missing', requestId: 'req_abc' })
  })

  it('surfaces a permission refusal verbatim, without a code or request id when Stripe sent none', async () => {
    const { fetchImpl } = fetchReplying({
      status: 403,
      body: { error: { type: 'invalid_request_error', message: 'This API key does not have the permissions rak_customer_read' } }
    })
    const client = createStripeClient({ config, fetch: fetchImpl })

    await expect(client.get('/customers')).rejects.toThrow(
      /^invalid_request_error: This API key does not have the permissions rak_customer_read$/
    )
  })

  it('quotes a body that is not a Stripe error, truncated, and copes with an empty one', async () => {
    const html = createStripeClient({ config, fetch: fetchReplying({ status: 502, text: '<html>bad gateway</html>' }).fetchImpl })
    await expect(html.get('/balance')).rejects.toThrow('Stripe API 502: <html>bad gateway</html>')

    const long = createStripeClient({ config, fetch: fetchReplying({ status: 400, text: 'x'.repeat(400) }).fetchImpl })
    const error = (await long.get('/balance').catch((caught: unknown) => caught)) as Error
    expect(error.message).toMatch(/x{300}…$/)

    const empty = createStripeClient({
      config,
      fetch: fetchReplying({ status: 500, text: '', headers: { 'request-id': 'req_e' } }).fetchImpl
    })
    await expect(empty.get('/balance')).rejects.toThrow(/^Stripe API 500 \(req_e\)$/)

    const shaped = createStripeClient({ config, fetch: fetchReplying({ status: 400, body: { error: 'odd' } }).fetchImpl })
    await expect(shaped.get('/balance')).rejects.toThrow('Stripe API 400: {"error":"odd"}')
  })

  it('re-reads a borrowed key once when Stripe rejects it', async () => {
    const { stripe, calls } = stripeReturning(
      '[default]\ntest_mode_api_key = "rk_test_stale"\n',
      '[default]\ntest_mode_api_key = "rk_test_fresh"\n'
    )
    const { fetchImpl, sent } = fetchReplying(
      { status: 401, body: { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } } },
      { body: { id: 'cus_1' } }
    )
    const client = createStripeClient({ config: {}, fetch: fetchImpl, stripe })

    expect(await client.get('/customers/cus_1')).toEqual({ id: 'cus_1' })
    expect(sent.map((call) => call.headers.Authorization)).toEqual(['Bearer rk_test_stale', 'Bearer rk_test_fresh'])
    expect(calls).toHaveLength(2)
  })

  it('reports a borrowed key rejected twice as signed out', async () => {
    const { stripe } = stripeReturning('[default]\ntest_mode_api_key = "rk_test_stale"\n')
    const { fetchImpl } = fetchReplying({ status: 401, body: { error: { type: 'invalid_request_error', message: 'Invalid' } } })
    const client = createStripeClient({ config: { liveMode: 'false' }, fetch: fetchImpl, stripe })

    const error = await client.get('/balance').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(StripeSignedOutError)
    expect((error as Error).message).toContain('rejected twice')
  })

  it('does not re-read a pasted key, which would only be the same key', async () => {
    const { fetchImpl, sent } = fetchReplying({
      status: 401,
      body: { error: { type: 'invalid_request_error', message: 'Invalid API Key provided: sk_test_***' } }
    })
    const client = createStripeClient({ config, fetch: fetchImpl })

    await expect(client.get('/balance')).rejects.toThrow('invalid_request_error: Invalid API Key provided: sk_test_***')
    expect(sent).toHaveLength(1)
  })

  it('reads the profile and mode from config when no token source is given', async () => {
    const { stripe, calls } = stripeReturning(CONFIG_TOML)
    const { fetchImpl, sent } = fetchReplying({ body: {} })
    const client = createStripeClient({ config: { project: 'acme shop', liveMode: 'true' }, fetch: fetchImpl, stripe })

    await expect(client.get('/balance')).rejects.toThrow('live_mode_api_key for profile "acme shop"')
    expect(calls).toEqual([['config', '--list', '--project-name', 'acme shop']])
    expect(sent).toHaveLength(0)
  })
})

describe('stripePreflight', () => {
  it('is ready with a pasted key, without running stripe', async () => {
    const { stripe, calls } = stripeReturning(CONFIG_TOML)
    expect(await stripePreflight({ apiKey: 'sk_test_x', stripe })).toEqual({ ok: true })
    expect(calls).toEqual([])
  })

  it('is ready with a borrowed key', async () => {
    const { stripe } = stripeReturning(CONFIG_TOML)
    expect(await stripePreflight({ stripe })).toEqual({ ok: true })
  })

  it('says what to run when the CLI is signed out or missing', async () => {
    const signedOut = await stripePreflight({ stripe: stripeReturning('color = "on"\n').stripe })
    expect(signedOut.ok).toBe(false)
    expect(signedOut.message).toContain('stripe login')

    const missing = await stripePreflight({
      stripe: async () => {
        throw new StripeNotFoundError()
      }
    })
    expect(missing.ok).toBe(false)
    expect(missing.message).toContain('stripe) not found on PATH')
  })

  it('refuses a publishable key and reports anything else verbatim', async () => {
    const publishable = await stripePreflight({ apiKey: 'pk_test_x' })
    expect(publishable.ok).toBe(false)
    expect(publishable.message).toContain('publishable')

    expect(
      await stripePreflight({
        stripe: async () => {
          throw 'config is unreadable'
        }
      })
    ).toEqual({ ok: false, message: 'config is unreadable' })
  })
})

describe('runStripe', () => {
  // Driven against a stub `stripe` on PATH: the failure translation is what matters, not whether this machine has the CLI.
  async function withFakeStripe<T>(script: string, run: () => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'stripe-stub-'))
    writeFileSync(join(dir, 'stripe'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = dir
    try {
      return await run()
    } finally {
      process.env.PATH = path
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('returns what stripe printed', async () => {
    await expect(
      withFakeStripe("echo '[default]'; echo '  test_mode_api_key = \"rk_test_1\"'", () => runStripe(['config', '--list']))
    ).resolves.toBe('[default]\n  test_mode_api_key = "rk_test_1"\n')
  })

  it('reports the install hint when stripe is not on PATH', async () => {
    const path = process.env.PATH
    process.env.PATH = '/nonexistent'
    try {
      await expect(runStripe(['--version'])).rejects.toBeInstanceOf(StripeNotFoundError)
    } finally {
      process.env.PATH = path
    }
  })

  it('surfaces what stripe printed on stderr when it fails, or the error itself', async () => {
    await expect(
      withFakeStripe("echo 'You have not logged in yet' >&2; exit 1", () => runStripe(['login', 'list']))
    ).rejects.toThrow('You have not logged in yet')
    await expect(withFakeStripe('exit 3', () => runStripe(['login', 'list']))).rejects.toThrow(/3|failed/i)
  })
})

describe('stripeInstallHint', () => {
  it('names the package manager for each platform', () => {
    expect(stripeInstallHint('darwin')).toContain('brew install stripe/stripe-cli/stripe')
    expect(stripeInstallHint('win32')).toContain('scoop')
    expect(stripeInstallHint('linux')).toContain('docs.stripe.com/stripe-cli')
    expect(stripeInstallHint()).toBe(stripeInstallHint(process.platform))
  })
})

describe('the errors a user can act on', () => {
  it('say what to run and carry a code', () => {
    expect(new StripeNotFoundError().message).toMatch(/stripe\) not found on PATH/)
    expect(new StripeNotFoundError().code).toBe('STRIPE_CLI_NOT_FOUND')
    expect(new StripeSignedOutError().message).toBe('Not signed in to Stripe. Run `stripe login`.')
    expect(new StripeSignedOutError('because').message).toContain('\nbecause')
    expect(new StripeSignedOutError().code).toBe('STRIPE_SIGNED_OUT')
  })
})
