import { describe, expect, it, vi } from 'vitest'
import { createConnectorHarness, type ConnectorConfig } from '@vornrun/connector-sdk'
import { REFUND_REASONS, createStripeConnector, metadataParams, smallestUnit } from './connector'
import { idempotencyKey } from './client'
import {
  SAMPLE_CHARGE,
  SAMPLE_CUSTOMER,
  SAMPLE_FAILED_INVOICE,
  SAMPLE_PAID_INVOICE,
  SAMPLE_PAYMENT_INTENT,
  type StripeInvoice,
  type StripePaymentIntent
} from './items'

const NOW = '2026-09-05T12:00:00.000Z'
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1000)
const CONFIG: ConnectorConfig = { apiKey: 'sk_test_pasted', liveMode: 'false' }

interface Sent {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
}

interface Route {
  when: RegExp
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

// A fake api.stripe.com driven by the URL being asked for, so a test says what the service holds and asserts on what was asked.
function stripeServing(routes: Route[]) {
  const sent: Sent[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    sent.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === 'string' && { body: init.body })
    })
    const route = routes.find((candidate) => candidate.when.test(url))
    if (!route) throw new Error(`No fake route for ${url}`)
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...route.headers }
    })
  }) as unknown as typeof fetch
  return { fetchImpl, sent }
}

/** A fake `stripe` that answers `config --list` with the documents given, in order. */
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

const PROFILE = '[default]\n  test_mode_api_key = "rk_test_borrowed"\n  live_mode_api_key = "rk_live_borrowed"\n'

function harnessOver(
  routes: Route[],
  options: { config?: ConnectorConfig; stripe?: (args: string[]) => Promise<string>; now?: string } = {}
) {
  const { fetchImpl, sent } = stripeServing(routes)
  const connector = createStripeConnector({ ...(options.stripe && { stripe: options.stripe }), sleep: async () => undefined })
  const harness = createConnectorHarness(connector, {
    config: options.config ?? CONFIG,
    now: () => options.now ?? NOW,
    fetchImpl
  })
  return { connector, harness, sent }
}

const query = (url: string) => Object.fromEntries(new URL(url).searchParams)
const form = (body: string | undefined) => Object.fromEntries(new URLSearchParams(body ?? ''))
const list = (data: unknown[], has_more = false) => ({ object: 'list', data, has_more })

const intentAt = (id: string, created: number, status = 'succeeded'): StripePaymentIntent => ({
  ...SAMPLE_PAYMENT_INTENT,
  id,
  created,
  status
})

describe('the definition', () => {
  const connector = createStripeConnector({ version: '1.2.3' })

  it('borrows the Stripe CLI login exactly as the spec declares it', () => {
    expect(connector.auth).toEqual({
      rung: 'cli',
      probe: { command: 'stripe', args: ['login', 'list'] },
      borrow: { env: ['STRIPE_API_KEY'], tokenEnv: 'STRIPE_API_KEY' }
    })
  })

  it('reads the borrowed variable as its own key field, marked secret and optional', () => {
    const apiKey = connector.config.find((field) => field.key === 'apiKey')
    expect(apiKey).toMatchObject({ env: 'STRIPE_API_KEY', secret: true })
    expect(apiKey?.required).not.toBe(true)
    expect(connector.config.map((field) => field.env)).toEqual([
      'STRIPE_API_KEY',
      'STRIPE_LIVE_MODE',
      'STRIPE_PROJECT',
      'STRIPE_CUSTOMER',
      'STRIPE_LOOKBACK_MINUTES',
      'STRIPE_FAILED_LOOKBACK_MINUTES'
    ])
    expect(connector.config.find((field) => field.key === 'liveMode')?.default).toBe('false')
  })

  it('leaves a hint for whoever builds on it, on every setting and every input', () => {
    for (const field of connector.config) expect(field.builderHint).toBeTruthy()
    for (const action of connector.actions) {
      for (const input of action.inputs ?? []) {
        expect(input.builderHint, `${action.type}.${input.key}`).toBeTruthy()
        expect(input.description, `${action.type}.${input.key}`).toBeTruthy()
      }
    }
  })

  it('draws Stripe’s own mark', () => {
    expect(connector.icon?.viewBox).toBe('0 0 24 24')
    expect(connector.icon?.paths).toHaveLength(1)
    expect(connector.icon?.paths[0]).toMatch(/^M13\.976 9\.15c/)
  })

  it('names the version it was built with', () => {
    expect(connector.version).toBe('1.2.3')
    expect(createStripeConnector().version).toBe('0.0.0')
  })

  it('polls four things, each declaratively with the timestamp strategy and a sample', () => {
    expect(connector.triggers.map((trigger) => [trigger.type, trigger.dedupe])).toEqual([
      ['newCustomer', 'timestamp'],
      ['paymentSucceeded', 'timestamp'],
      ['invoicePaid', 'timestamp'],
      ['invoicePaymentFailed', 'timestamp']
    ])
    for (const trigger of connector.triggers) expect(trigger.sample).toHaveLength(1)
  })

  it('marks the reads idempotent and gives each a sample to call with', () => {
    expect(connector.actions.map((action) => [action.type, action.idempotent, action.sample])).toEqual([
      ['createCustomer', false, undefined],
      ['getCustomer', true, { customer: 'cus_NffrFeUfNV2Hib' }],
      ['listCharges', true, { limit: '5' }],
      ['createRefund', false, undefined],
      ['getBalance', true, {}],
      ['listCustomers', true, { limit: '5' }]
    ])
  })

  it('writes every action by hand, so a borrowed key reaches it', () => {
    for (const action of connector.actions) {
      expect(action.request).toBeUndefined()
      expect(typeof action.run).toBe('function')
    }
  })
})

describe('polling new customers', () => {
  it('asks for customers created at or after the watermark and delivers them oldest first', async () => {
    const newer = { ...SAMPLE_CUSTOMER, id: 'cus_newer', created: SAMPLE_CUSTOMER.created + 60 }
    const { harness, sent } = harnessOver([{ when: /\/customers\?/, body: list([newer, SAMPLE_CUSTOMER]) }])

    const page = await harness.poll('newCustomer', { since: '2023-04-07T18:59:53.000Z' })

    expect(sent).toHaveLength(1)
    expect(sent[0].url).toMatch(/^https:\/\/api\.stripe\.com\/v1\/customers\?/)
    expect(query(sent[0].url)).toEqual({ 'created[gte]': '1680893993', limit: '100' })
    expect(sent[0].headers).toMatchObject({ Authorization: 'Bearer sk_test_pasted', 'Stripe-Version': '2026-08-26.dahlia' })
    expect(page.items.map((item) => item.externalId)).toEqual(['cus_NffrFeUfNV2Hib', 'cus_newer'])
    expect(page.items[0].updatedAt).toBe('2023-04-07T18:59:53.000Z')
    expect(page.nextCursor).toBeDefined()
  })

  it('does not deliver the same customer twice, even though Stripe returns it on the boundary', async () => {
    const { harness, sent } = harnessOver([{ when: /\/customers\?/, body: list([SAMPLE_CUSTOMER]) }])

    expect(await harness.pollTwice('newCustomer')).toEqual([])
    expect(query(sent[1].url)['created[gte]']).toBe('1680893993')
  })

  it('bounds the very first poll to the hour before it rather than replaying the account', async () => {
    const { harness, sent } = harnessOver([{ when: /\/customers\?/, body: list([]) }])

    const page = await harness.poll('newCustomer')

    expect(query(sent[0].url)['created[gte]']).toBe(String(NOW_SECONDS - 3600))
    expect(page.items).toEqual([])
  })

  it('follows starting_after while there is more', async () => {
    const older = { ...SAMPLE_CUSTOMER, id: 'cus_older', created: SAMPLE_CUSTOMER.created - 10 }
    const { harness, sent } = harnessOver([
      { when: /starting_after=cus_NffrFeUfNV2Hib/, body: list([older]) },
      { when: /\/customers\?/, body: list([SAMPLE_CUSTOMER], true) }
    ])

    const page = await harness.poll('newCustomer')

    expect(sent).toHaveLength(2)
    expect(page.items.map((item) => item.externalId)).toEqual(['cus_older', 'cus_NffrFeUfNV2Hib'])
  })
})

describe('polling succeeded payments', () => {
  const route = (intents: StripePaymentIntent[]): Route[] => [{ when: /\/payment_intents\?/, body: list(intents) }]

  it('opens the window a look-back before the watermark and keeps only succeeded intents', async () => {
    const since = '2026-09-05T11:00:00.000Z'
    const succeeded = intentAt('pi_ok', NOW_SECONDS - 600)
    const pending = intentAt('pi_wait', NOW_SECONDS - 500, 'requires_payment_method')
    const { harness, sent } = harnessOver(route([pending, succeeded]), { config: { ...CONFIG, lookbackMinutes: '30' } })

    const page = await harness.poll('paymentSucceeded', { since })

    expect(query(sent[0].url)).toEqual({ 'created[gte]': String(Math.floor(Date.parse(since) / 1000) - 1800), limit: '100' })
    expect(page.items.map((item) => [item.externalId, item.status])).toEqual([['pi_ok', 'succeeded']])
    expect(page.items[0].updatedAt).toBe(NOW)
    expect(page.items[0].title).toBe('2000 usd succeeded')
  })

  it('defaults the look-back to an hour and the first watermark to an hour ago', async () => {
    const { harness, sent } = harnessOver(route([]))

    await harness.poll('paymentSucceeded')

    expect(query(sent[0].url)['created[gte]']).toBe(String(NOW_SECONDS - 7200))
  })

  it('delivers an intent that succeeds after the watermark once, and never again', async () => {
    const early = intentAt('pi_early', NOW_SECONDS - 1800, 'processing')
    const card = intentAt('pi_card', NOW_SECONDS - 60)
    let intents = [card, early]
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify(list(intents)), { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    let now = NOW
    const harness = createConnectorHarness(createStripeConnector(), { config: CONFIG, now: () => now, fetchImpl })

    const first = await harness.poll('paymentSucceeded')
    expect(first.items.map((item) => item.externalId)).toEqual(['pi_card'])

    // The bank debit settles half an hour later, well inside the look-back window.
    now = '2026-09-05T12:30:00.000Z'
    intents = [card, { ...early, status: 'succeeded' }]
    const second = await harness.poll('paymentSucceeded', { cursor: first.nextCursor })
    expect(second.items.map((item) => item.externalId)).toEqual(['pi_early'])

    now = '2026-09-05T12:35:00.000Z'
    const third = await harness.poll('paymentSucceeded', { cursor: second.nextCursor })
    expect(third.items).toEqual([])
    expect(third.nextCursor).toBe(second.nextCursor)

    // A new card payment moves the watermark on; the older two stay remembered while the window still holds them.
    now = '2026-09-05T12:40:00.000Z'
    intents = [intentAt('pi_next', NOW_SECONDS + 2000), card, { ...early, status: 'succeeded' }]
    const fourth = await harness.poll('paymentSucceeded', { cursor: third.nextCursor })
    expect(fourth.items.map((item) => item.externalId)).toEqual(['pi_next'])
    const fifth = await harness.poll('paymentSucceeded', { cursor: fourth.nextCursor })
    expect(fifth.items).toEqual([])
  })

  it('catches up on everything created while the host was away', async () => {
    const { fetchImpl } = stripeServing([])
    let intents: StripePaymentIntent[] = []
    const serving = vi.fn(async () => {
      void fetchImpl
      return new Response(JSON.stringify(list(intents)), { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    let now = NOW
    const harness = createConnectorHarness(createStripeConnector(), { config: CONFIG, now: () => now, fetchImpl: serving })

    const first = await harness.poll('paymentSucceeded')

    now = '2026-09-06T00:00:00.000Z'
    intents = [intentAt('pi_night2', NOW_SECONDS + 20000), intentAt('pi_night1', NOW_SECONDS + 10000)]
    const second = await harness.poll('paymentSucceeded', { cursor: first.nextCursor })
    expect(second.items.map((item) => item.externalId)).toEqual(['pi_night1', 'pi_night2'])
  })

  it('replays its own sample without redelivering it', async () => {
    const { harness } = harnessOver(route([SAMPLE_PAYMENT_INTENT]))
    expect(await harness.pollTwice('paymentSucceeded')).toEqual([])
  })

  it('refuses a look-back that is not a whole number of minutes', async () => {
    const { harness, sent } = harnessOver(route([]), { config: { ...CONFIG, lookbackMinutes: 'soon' } })
    await expect(harness.poll('paymentSucceeded')).rejects.toThrow('STRIPE_LOOKBACK_MINUTES must be a whole number of minutes, got "soon"')
    expect(sent).toHaveLength(0)
  })
})

describe('polling paid invoices', () => {
  const route = (invoices: StripeInvoice[]): Route[] => [{ when: /\/invoices\?/, body: list(invoices) }]

  it('asks for paid invoices created a look-back before the watermark, narrowed to a customer when asked', async () => {
    const { harness, sent } = harnessOver(route([SAMPLE_PAID_INVOICE]), {
      config: { ...CONFIG, customer: 'cus_NeZwdNtLEOXuvB', lookbackMinutes: '120' }
    })

    const page = await harness.poll('invoicePaid', { since: '2023-04-04T21:00:00.000Z' })

    expect(query(sent[0].url)).toEqual({
      status: 'paid',
      'created[gte]': String(Math.floor(Date.parse('2023-04-04T21:00:00.000Z') / 1000) - 7200),
      customer: 'cus_NeZwdNtLEOXuvB',
      limit: '100'
    })
    expect(page.items[0]).toMatchObject({
      externalId: 'in_1MtHbELkdIwHu7ixl4OzzPMv:paid',
      title: 'Invoice F1B2C3D-0001 paid: 4900 usd',
      updatedAt: '2023-04-04T21:41:07.000Z',
      status: 'paid'
    })
  })

  it('leaves the customer filter out when blank, and skips an invoice without paid_at', async () => {
    const unpaid = { ...SAMPLE_PAID_INVOICE, id: 'in_odd', status_transitions: { paid_at: null } }
    const { harness, sent } = harnessOver(route([unpaid, SAMPLE_PAID_INVOICE]), { config: { ...CONFIG, customer: ' ' } })

    const page = await harness.poll('invoicePaid')

    expect(query(sent[0].url).customer).toBeUndefined()
    expect(page.items.map((item) => item.externalId)).toEqual(['in_1MtHbELkdIwHu7ixl4OzzPMv:paid'])
  })

  it('delivers an invoice paid after the watermark once, and an old one never', async () => {
    const stale = { ...SAMPLE_PAID_INVOICE, id: 'in_old', status_transitions: { paid_at: 1680000000 } }
    const { harness } = harnessOver(route([SAMPLE_PAID_INVOICE, stale]))

    const page = await harness.poll('invoicePaid', { since: '2023-04-04T21:41:07.000Z' })
    expect(page.items.map((item) => item.externalId)).toEqual(['in_1MtHbELkdIwHu7ixl4OzzPMv:paid'])
    expect(await harness.pollTwice('invoicePaid')).toEqual([])
  })
})

describe('polling failed invoice payments', () => {
  const route = (invoices: StripeInvoice[]): Route[] => [{ when: /\/invoices\?/, body: list(invoices) }]

  it('reads open invoices from a day before now and keeps the ones with a failed attempt', async () => {
    const untried = { ...SAMPLE_FAILED_INVOICE, id: 'in_untried', attempted: false, attempt_count: 0 }
    const { harness, sent } = harnessOver(route([untried, SAMPLE_FAILED_INVOICE]))

    const page = await harness.poll('invoicePaymentFailed')

    expect(query(sent[0].url)).toEqual({ status: 'open', 'created[gte]': String(NOW_SECONDS - 86400), limit: '100' })
    expect(page.items.map((item) => item.externalId)).toEqual(['in_1MtHbELkdIwHu7ixl4OzzPMv:failed:2'])
    expect(page.items[0].title).toBe('Invoice F1B2C3D-0001 payment failed (attempt 2): 4900 usd')
  })

  it('fires once per failed attempt and again when a retry fails', async () => {
    let invoices = [SAMPLE_FAILED_INVOICE]
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify(list(invoices)), { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    let now = NOW
    const harness = createConnectorHarness(createStripeConnector(), { config: CONFIG, now: () => now, fetchImpl })

    const first = await harness.poll('invoicePaymentFailed')
    expect(first.items).toHaveLength(1)

    now = '2026-09-05T13:00:00.000Z'
    const second = await harness.poll('invoicePaymentFailed', { cursor: first.nextCursor })
    expect(second.items).toEqual([])

    now = '2026-09-08T13:00:00.000Z'
    invoices = [{ ...SAMPLE_FAILED_INVOICE, attempt_count: 3 }]
    const third = await harness.poll('invoicePaymentFailed', { cursor: second.nextCursor })
    expect(third.items.map((item) => item.externalId)).toEqual(['in_1MtHbELkdIwHu7ixl4OzzPMv:failed:3'])
    expect((await harness.poll('invoicePaymentFailed', { cursor: third.nextCursor })).items).toEqual([])
  })

  it('honours its own window and customer settings', async () => {
    const { harness, sent } = harnessOver(route([]), { config: { ...CONFIG, failedLookbackMinutes: '60', customer: 'cus_1' } })
    await harness.poll('invoicePaymentFailed')
    expect(query(sent[0].url)).toMatchObject({ 'created[gte]': String(NOW_SECONDS - 3600), customer: 'cus_1' })

    const bad = harnessOver(route([]), { config: { ...CONFIG, failedLookbackMinutes: '-1' } })
    await expect(bad.harness.poll('invoicePaymentFailed')).rejects.toThrow(/STRIPE_FAILED_LOOKBACK_MINUTES/)
  })
})

describe('borrowing the key from the Stripe CLI', () => {
  const noKey: ConnectorConfig = { liveMode: 'false' }

  it('reads the profile once and reuses the key across polls', async () => {
    const { stripe, calls } = stripeReturning(PROFILE)
    const { harness, sent } = harnessOver([{ when: /\/customers\?/, body: list([]) }], { config: noKey, stripe })

    await harness.poll('newCustomer')
    await harness.poll('newCustomer')

    expect(calls).toEqual([['config', '--list']])
    expect(sent[0].headers.Authorization).toBe('Bearer rk_test_borrowed')
  })

  it('borrows the live key, or a named profile, when the connection says so', async () => {
    const live = stripeReturning(PROFILE)
    const withLive = harnessOver([{ when: /\/balance/, body: {} }], { config: { liveMode: 'true' }, stripe: live.stripe })
    await withLive.harness.execute('getBalance')
    expect(withLive.sent[0].headers.Authorization).toBe('Bearer rk_live_borrowed')

    const named = stripeReturning('[shop]\n  test_mode_api_key = "rk_test_shop"\n')
    const withProject = harnessOver([{ when: /\/balance/, body: {} }], { config: { project: 'shop' }, stripe: named.stripe })
    await withProject.harness.execute('getBalance')
    expect(named.calls).toEqual([['config', '--list', '--project-name', 'shop']])
    expect(withProject.sent[0].headers.Authorization).toBe('Bearer rk_test_shop')
  })

  it('reads the key again when Stripe stops accepting it', async () => {
    const { stripe, calls } = stripeReturning(PROFILE, PROFILE.replace('rk_test_borrowed', 'rk_test_fresh'))
    const { harness, sent } = harnessOver(
      [{ when: /\/customers\?/, status: 401, body: { error: { type: 'invalid_request_error', message: 'Invalid API Key' } } }],
      { config: noKey, stripe }
    )

    await expect(harness.poll('newCustomer')).rejects.toThrow(/Not signed in to Stripe/)
    expect(calls).toHaveLength(2)
    expect(sent.map((call) => call.headers.Authorization)).toEqual(['Bearer rk_test_borrowed', 'Bearer rk_test_fresh'])
  })

  it('says what to run when the profile holds no key', async () => {
    const { stripe } = stripeReturning('color = "on"\n')
    const { harness } = harnessOver([{ when: /\/customers\?/, body: list([]) }], { config: noKey, stripe })

    await expect(harness.poll('newCustomer')).rejects.toThrow(/Run `stripe login`/)
  })
})

describe('preflight', () => {
  it('is ready when STRIPE_API_KEY is set, without running stripe', async () => {
    const { stripe, calls } = stripeReturning(PROFILE)
    const connector = createStripeConnector({ stripe, env: { STRIPE_API_KEY: 'sk_test_x' } })

    expect(await connector.preflight!()).toEqual({ ok: true })
    expect(calls).toEqual([])
  })

  it('reads the profile STRIPE_PROJECT and STRIPE_LIVE_MODE name when there is no key', async () => {
    const { stripe, calls } = stripeReturning('[shop]\n  live_mode_api_key = "rk_live_shop"\n')
    const connector = createStripeConnector({ stripe, env: { STRIPE_API_KEY: ' ', STRIPE_PROJECT: 'shop', STRIPE_LIVE_MODE: 'true' } })

    expect(await connector.preflight!()).toEqual({ ok: true })
    expect(calls).toEqual([['config', '--list', '--project-name', 'shop']])
  })

  it('says what to do when signed out, and reads the process environment when none is given', async () => {
    const signedOut = createStripeConnector({ stripe: stripeReturning('').stripe, env: {} })
    const result = await signedOut.preflight!()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('stripe login')

    const connector = createStripeConnector({ stripe: stripeReturning('').stripe })
    const before = process.env.STRIPE_API_KEY
    process.env.STRIPE_API_KEY = 'sk_test_from_env'
    try {
      expect(await connector.preflight!()).toEqual({ ok: true })
    } finally {
      if (before === undefined) delete process.env.STRIPE_API_KEY
      else process.env.STRIPE_API_KEY = before
    }
  })
})

describe('input rules', () => {
  it('turns metadata into string values and refuses what Stripe would', () => {
    expect(metadataParams(undefined)).toBeUndefined()
    expect(metadataParams({ order: 6735, vip: true, note: null })).toEqual({ order: '6735', vip: 'true', note: '' })
    expect(() => metadataParams('text')).toThrow('metadata must be a JSON object')
    expect(() => metadataParams([1])).toThrow('metadata must be a JSON object')
    expect(() => metadataParams({ 'a[b]': '1' })).toThrow('square brackets')
    expect(() => metadataParams({ nested: { x: 1 } })).toThrow('must be a string, number or boolean')
    expect(() => metadataParams(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'v'])))).toThrow('at most 50 keys')
  })

  it('takes an amount only as a positive whole number', () => {
    expect(smallestUnit(undefined, 'amount')).toBeUndefined()
    expect(smallestUnit(1099, 'amount')).toBe(1099)
    expect(() => smallestUnit(10.99, 'amount')).toThrow('amount must be a positive whole number in the smallest currency unit, got "10.99"')
    expect(() => smallestUnit(0, 'amount')).toThrow(/positive whole number/)
    expect(() => smallestUnit('5', 'amount')).toThrow(/positive whole number/)
  })
})

describe('actions', () => {
  it('creates a customer with a form body, metadata brackets and an idempotency key from the inputs', async () => {
    const { harness, sent } = harnessOver([
      { when: /\/customers$/, body: { ...SAMPLE_CUSTOMER, metadata: { order_id: '6735' } } }
    ])
    const args = { email: 'jennyrosen@example.com', name: 'Jenny Rosen', metadata: '{"order_id":"6735"}' }

    const result = await harness.execute('createCustomer', args)
    await harness.execute('createCustomer', args)
    await harness.execute('createCustomer', { ...args, name: 'Someone Else' })

    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.stripe.com/v1/customers',
      headers: {
        Authorization: 'Bearer sk_test_pasted',
        'Stripe-Version': '2026-08-26.dahlia',
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    })
    expect(form(sent[0].body)).toEqual({ email: 'jennyrosen@example.com', name: 'Jenny Rosen', 'metadata[order_id]': '6735' })
    expect(sent[0].headers['Idempotency-Key']).toMatch(/^[0-9a-f]{64}$/)
    expect(sent[0].headers['Idempotency-Key']).toBe(idempotencyKey('createCustomer', { ...args, metadata: { order_id: '6735' } }))
    expect(sent[1].headers['Idempotency-Key']).toBe(sent[0].headers['Idempotency-Key'])
    expect(sent[2].headers['Idempotency-Key']).not.toBe(sent[0].headers['Idempotency-Key'])
    expect(result).toEqual({
      id: 'cus_NffrFeUfNV2Hib',
      email: 'jennyrosen@example.com',
      name: 'Jenny Rosen',
      description: null,
      created: '2023-04-07T18:59:53.000Z',
      metadata: { order_id: '6735' },
      livemode: false,
      url: 'https://dashboard.stripe.com/test/customers/cus_NffrFeUfNV2Hib'
    })
  })

  it('creates a customer from nothing at all, and refuses metadata that is not JSON', async () => {
    const { harness, sent } = harnessOver([{ when: /\/customers$/, body: SAMPLE_CUSTOMER }])

    await harness.execute('createCustomer', {})
    expect(sent[0].body).toBe('')

    await expect(harness.execute('createCustomer', { metadata: 'nope' })).rejects.toThrow(/Expected JSON/)
    await expect(harness.execute('createCustomer', { metadata: '["a"]' })).rejects.toThrow('metadata must be a JSON object')
  })

  it('reads a customer by its encoded id, deleted or not', async () => {
    const { harness, sent } = harnessOver([
      { when: /\/customers\/cus_gone$/, body: { id: 'cus_gone', object: 'customer', deleted: true, created: 1 } },
      { when: /\/customers\/cus%2F1$/, body: SAMPLE_CUSTOMER }
    ])

    const result = await harness.execute('getCustomer', { customer: 'cus/1' })
    const gone = await harness.execute('getCustomer', { customer: 'cus_gone' })

    expect(sent[0]).toMatchObject({ method: 'GET', url: 'https://api.stripe.com/v1/customers/cus%2F1' })
    expect(result).toMatchObject({ id: 'cus_NffrFeUfNV2Hib', name: 'Jenny Rosen', deleted: false, balance: 0 })
    expect(gone).toMatchObject({ id: 'cus_gone', deleted: true, email: null })
  })

  it('lists charges with the limit held to 1 to 100 and the optional filters left out when blank', async () => {
    const { harness, sent } = harnessOver([{ when: /\/charges\?/, body: list([SAMPLE_CHARGE], true) }])

    const result = await harness.execute('listCharges', { limit: '5', customer: 'cus_1', startingAfter: 'ch_0' })
    await harness.execute('listCharges', { limit: '500' })
    await harness.execute('listCharges', { limit: '0', customer: ' ' })

    expect(query(sent[0].url)).toEqual({ limit: '5', customer: 'cus_1', starting_after: 'ch_0' })
    expect(query(sent[1].url)).toEqual({ limit: '100' })
    expect(query(sent[2].url)).toEqual({ limit: '1' })
    expect(result).toEqual({
      charges: [expect.objectContaining({ id: 'ch_3MmlLrLkdIwHu7ix0snN0B15', amount: 1099, paymentIntent: null })],
      hasMore: true
    })
  })

  it('answers an empty charge list when Stripe returns something else', async () => {
    const { harness } = harnessOver([{ when: /\/charges/, body: {} }])
    expect(await harness.execute('listCharges', {})).toEqual({ charges: [], hasMore: false })
  })

  it('refunds a payment intent for an amount, with the reason and an idempotency key', async () => {
    const refund = { id: 're_1', amount: 500, currency: 'usd', status: 'succeeded', charge: 'ch_1', payment_intent: 'pi_1', reason: 'duplicate', failure_reason: null, created: 1680000000 }
    const { harness, sent } = harnessOver([{ when: /\/refunds$/, body: refund }])

    const result = await harness.execute('createRefund', { paymentIntent: 'pi_1', amount: '500', reason: 'duplicate' })

    expect(sent[0]).toMatchObject({ method: 'POST', url: 'https://api.stripe.com/v1/refunds' })
    expect(form(sent[0].body)).toEqual({ payment_intent: 'pi_1', amount: '500', reason: 'duplicate' })
    expect(sent[0].headers['Idempotency-Key']).toBe(idempotencyKey('createRefund', { paymentIntent: 'pi_1', amount: 500, reason: 'duplicate' }))
    expect(result).toEqual({
      id: 're_1',
      amount: 500,
      currency: 'usd',
      status: 'succeeded',
      charge: 'ch_1',
      paymentIntent: 'pi_1',
      reason: 'duplicate',
      failureReason: null,
      created: '2023-03-28T10:40:00.000Z'
    })
  })

  it('refunds a charge in full when no amount is given', async () => {
    const { harness, sent } = harnessOver([{ when: /\/refunds$/, body: { id: 're_2', amount: 1099, currency: 'usd', created: 1 } }])

    const result = await harness.execute('createRefund', { charge: 'ch_1' })

    expect(form(sent[0].body)).toEqual({ charge: 'ch_1' })
    expect(result).toMatchObject({ id: 're_2', status: null, charge: null, paymentIntent: null, reason: null, failureReason: null })
  })

  it('refuses a refund with nothing to refund, a bad amount or an unknown reason', async () => {
    const { harness, sent } = harnessOver([])

    await expect(harness.execute('createRefund', {})).rejects.toThrow('createRefund needs a paymentIntent or a charge')
    await expect(harness.execute('createRefund', { charge: 'ch_1', amount: '10.99' })).rejects.toThrow(/smallest currency unit/)
    await expect(harness.execute('createRefund', { charge: 'ch_1', reason: 'because' })).rejects.toThrow(
      `reason must be one of ${REFUND_REASONS.join(', ')}, got "because"`
    )
    expect(sent).toHaveLength(0)
  })

  it('retries a refund Stripe rate-limited, sending the same idempotency key', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'busy' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'Stripe-Rate-Limited-Reason': 'global-rate' }
        })
      }
      return new Response(JSON.stringify({ id: 're_3', amount: 1, currency: 'usd', created: 1 }), { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const harness = createConnectorHarness(createStripeConnector({ sleep: async () => undefined }), { config: CONFIG, fetchImpl })

    expect(await harness.execute('createRefund', { charge: 'ch_1' })).toMatchObject({ id: 're_3' })
    expect(calls).toBe(2)
  })

  it('reads the balance with no arguments', async () => {
    const { harness, sent } = harnessOver([
      {
        when: /\/balance$/,
        body: {
          object: 'balance',
          available: [{ amount: 2000, currency: 'usd', source_types: { card: 2000 } }],
          pending: [{ amount: 100, currency: 'usd' }],
          connect_reserved: [{ amount: 5, currency: 'usd' }],
          livemode: false
        }
      }
    ])

    const result = await harness.execute('getBalance')

    expect(sent[0]).toMatchObject({ method: 'GET', url: 'https://api.stripe.com/v1/balance' })
    expect(result).toEqual({
      available: [{ amount: 2000, currency: 'usd', sourceTypes: { card: 2000 } }],
      pending: [{ amount: 100, currency: 'usd', sourceTypes: {} }],
      connectReserved: [{ amount: 5, currency: 'usd' }],
      livemode: false
    })
    expect(await createConnectorHarness(createStripeConnector(), { config: CONFIG, fetchImpl: stripeServing([{ when: /balance/, body: {} }]).fetchImpl }).execute('getBalance')).toEqual({
      available: [],
      pending: [],
      connectReserved: [],
      livemode: false
    })
  })

  it('lists customers by exact email', async () => {
    const { harness, sent } = harnessOver([{ when: /\/customers(\?|$)/, body: list([SAMPLE_CUSTOMER]) }])

    const result = await harness.execute('listCustomers', { limit: '5', email: 'jennyrosen@example.com' })
    await harness.execute('listCustomers', {})

    expect(query(sent[0].url)).toEqual({ limit: '5', email: 'jennyrosen@example.com' })
    expect(query(sent[1].url)).toEqual({})
    expect(result).toEqual({ customers: [expect.objectContaining({ id: 'cus_NffrFeUfNV2Hib', deleted: false })], hasMore: false })
    expect(await createConnectorHarness(createStripeConnector(), { config: CONFIG, fetchImpl: stripeServing([{ when: /customers/, body: {} }]).fetchImpl }).execute('listCustomers')).toEqual({ customers: [], hasMore: false })
  })

  it('insists on the arguments an action cannot do without, and refuses a limit that is not a number', async () => {
    const { harness } = harnessOver([])
    await expect(harness.execute('getCustomer', {})).rejects.toThrow('requires "customer"')
    await expect(harness.execute('listCharges', { limit: 'many' })).rejects.toThrow(/argument "limit": Expected a number/)
  })

  it('quotes Stripe when a call fails, request id included', async () => {
    const { harness } = harnessOver([
      {
        when: /\/customers\//,
        status: 404,
        body: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such customer: cus_nope' } },
        headers: { 'request-id': 'req_404' }
      }
    ])

    await expect(harness.execute('getCustomer', { customer: 'cus_nope' })).rejects.toThrow(
      'invalid_request_error/resource_missing: No such customer: cus_nope (req_404)'
    )
  })
})
