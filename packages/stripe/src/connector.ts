import {
  defineConnector,
  type ConnectorConfig,
  type ConnectorItem,
  type FetchContext
} from '@vornrun/connector-sdk'
import {
  MAX_PAGE_SIZE,
  createStripeClient,
  createTokenSource,
  idempotencyKey,
  stripePreflight,
  type Params,
  type RunStripe,
  type TokenSource
} from './client'
import {
  SAMPLE_CUSTOMER,
  SAMPLE_FAILED_INVOICE,
  SAMPLE_PAID_INVOICE,
  SAMPLE_PAYMENT_INTENT,
  chargeOutput,
  customerOutput,
  customerToItem,
  invoiceFailedToItem,
  invoicePaidToItem,
  isFailedAttempt,
  isoFromUnix,
  paymentIntentToItem,
  type StripeBalance,
  type StripeCharge,
  type StripeCustomer,
  type StripeInvoice,
  type StripePaymentIntent,
  type StripeRefund
} from './items'

export interface StripeConnectorOptions {
  version?: string
  /** Injected in tests so nothing spawns `stripe`. */
  stripe?: RunStripe
  /** Where preflight reads the key from; defaults to the process environment. */
  env?: NodeJS.ProcessEnv
  /** Replaced in tests so a write's backoff costs no real time. */
  sleep?: (ms: number) => Promise<void>
}

// How far back the very first poll looks, before any watermark exists.
const FIRST_POLL_LOOKBACK_MS = 60 * 60_000

const DEFAULT_LOOKBACK_MINUTES = 60

// Retries on a failed invoice are days apart, so its window is a day.
const DEFAULT_FAILED_LOOKBACK_MINUTES = 1440

const MAX_METADATA_KEYS = 50

export const REFUND_REASONS = ['duplicate', 'fraudulent', 'requested_by_customer'] as const

function text(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim()
  return trimmed || undefined
}

function minutes(value: unknown, env: string, fallback: number): number {
  const raw = text(value)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${env} must be a whole number of minutes, got "${raw}"`)
  }
  return parsed
}

// `limit` for a list action: what was asked for, held within Stripe's 1 to 100; unset stays unset so Stripe applies its default of 10.
function pageSize(limit: unknown): number | undefined {
  if (typeof limit !== 'number') return undefined
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)))
}

// Stripe's `created` filter takes integer Unix seconds; rounding down keeps the boundary second inside the window.
function unixSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000)
}

// Metadata as Stripe takes it: up to 50 string values under keys without square brackets.
export function metadataParams(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('metadata must be a JSON object of string values')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_METADATA_KEYS) {
    throw new Error(`metadata may hold at most ${MAX_METADATA_KEYS} keys, got ${entries.length}`)
  }
  const out: Record<string, string> = {}
  for (const [key, entry] of entries) {
    if (/[[\]]/.test(key)) throw new Error(`metadata key "${key}" may not contain square brackets`)
    if (entry !== null && typeof entry === 'object') {
      throw new Error(`metadata value for "${key}" must be a string, number or boolean`)
    }
    out[key] = entry === null ? '' : String(entry)
  }
  return out
}

// An amount is an integer in the currency's smallest unit; anything else would be a different amount once Stripe read it.
export function smallestUnit(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive whole number in the smallest currency unit, got "${String(value)}"`)
  }
  return value
}

const LIMIT_INPUT = {
  key: 'limit',
  label: 'Maximum',
  type: 'number' as const,
  description: 'How many to return, 1 to 100. Defaults to 10.',
  builderHint: 'Sent as limit; 100 is the documented maximum and lists come back newest first.'
}

const STARTING_AFTER_INPUT = (kind: string) => ({
  key: 'startingAfter',
  label: 'Starting after',
  description: `A ${kind} id from an earlier page, to fetch the next one.`,
  builderHint: 'Sent as starting_after, the documented cursor; pass the last id of the previous page while hasMore is true.'
})

const CUSTOMER_FIELDS = [
  { key: 'id', description: 'Customer id, cus_…' },
  { key: 'email', description: 'Email address, or null' },
  { key: 'name', description: 'Full or business name, or null' },
  { key: 'description', description: 'Free text shown alongside the customer' },
  { key: 'phone', description: 'Phone number, or null' },
  { key: 'currency', description: 'Three-letter currency of recurring billing, or null' },
  { key: 'balance', type: 'number' as const, description: 'Current balance in the smallest currency unit; negative is credit' },
  { key: 'delinquent', type: 'boolean' as const, description: 'Whether the latest invoice is unpaid past due' },
  { key: 'created', description: 'When the customer was created, ISO 8601' },
  { key: 'metadata', description: 'The metadata object as stored' },
  { key: 'livemode', type: 'boolean' as const, description: 'False for a sandbox customer' },
  { key: 'url', description: 'Where to open it in the dashboard' }
]

export function createStripeConnector(options: StripeConnectorOptions = {}) {
  const env = options.env ?? process.env

  // One token source per pasted key and profile, kept across polls so a borrowed key is read from `stripe` once rather than on every call.
  const sources = new Map<string, TokenSource>()
  function tokensFor(config: ConnectorConfig): TokenSource {
    const apiKey = text(config.apiKey)
    const project = text(config.project)
    const liveMode = text(config.liveMode) === 'true'
    const key = `${apiKey ?? ''} ${project ?? ''} ${liveMode}`
    let source = sources.get(key)
    if (!source) {
      source = createTokenSource({
        ...(apiKey !== undefined && { apiKey }),
        ...(project !== undefined && { project }),
        liveMode,
        ...(options.stripe && { stripe: options.stripe })
      })
      sources.set(key, source)
    }
    return source
  }

  function client(context: { config: ConnectorConfig; fetch: typeof fetch }) {
    return createStripeClient({
      config: context.config,
      fetch: context.fetch,
      tokens: tokensFor(context.config),
      ...(options.sleep && { sleep: options.sleep })
    })
  }

  // The watermark, or the hour before now on the very first poll rather than the account's whole history.
  function watermarkOf(context: FetchContext): string {
    return context.since ?? new Date(Date.parse(context.now()) - FIRST_POLL_LOOKBACK_MS).toISOString()
  }

  function lookbackOf(config: ConnectorConfig): number {
    return minutes(config.lookbackMinutes, 'STRIPE_LOOKBACK_MINUTES', DEFAULT_LOOKBACK_MINUTES)
  }

  function customerFilter(config: ConnectorConfig): Params {
    const customer = text(config.customer)
    return customer ? { customer } : {}
  }

  async function fetchCustomers(context: FetchContext): Promise<ConnectorItem[]> {
    const customers = await client(context).list<StripeCustomer>('/customers', {
      created: { gte: unixSeconds(watermarkOf(context)) }
    })
    return customers.reverse().map(customerToItem)
  }

  // Every intent created after the watermark is fresh; one created before it and now succeeded is keyed by id, so the look-back window costs re-reads but never duplicates.
  async function fetchSucceededPayments(context: FetchContext): Promise<ConnectorItem[]> {
    const watermark = Date.parse(watermarkOf(context))
    const since = context.since === undefined ? undefined : Date.parse(context.since)
    const from = watermark - lookbackOf(context.config) * 60_000
    const polledAt = context.now()
    const intents = await client(context).list<StripePaymentIntent>('/payment_intents', {
      created: { gte: Math.floor(from / 1000) }
    })
    return intents
      .reverse()
      .filter((intent) => intent.status === 'succeeded')
      .map((intent) =>
        since !== undefined && intent.created * 1000 <= since
          ? paymentIntentToItem(intent)
          : paymentIntentToItem(intent, polledAt)
      )
  }

  // Invoices are created before they are paid, so the window opens a look-back before the watermark and `paid_at` decides what is new.
  async function fetchPaidInvoices(context: FetchContext): Promise<ConnectorItem[]> {
    const from = Date.parse(watermarkOf(context)) - lookbackOf(context.config) * 60_000
    const invoices = await client(context).list<StripeInvoice>('/invoices', {
      status: 'paid',
      created: { gte: Math.floor(from / 1000) },
      ...customerFilter(context.config)
    })
    return invoices
      .reverse()
      .filter((invoice) => typeof invoice.status_transitions?.paid_at === 'number')
      .map(invoicePaidToItem)
  }

  // No time on a failed attempt to watermark on: the window is the look-back before now, and the SDK keeps every id it delivered.
  async function fetchFailedInvoices(context: FetchContext): Promise<ConnectorItem[]> {
    const lookback = minutes(
      context.config.failedLookbackMinutes,
      'STRIPE_FAILED_LOOKBACK_MINUTES',
      DEFAULT_FAILED_LOOKBACK_MINUTES
    )
    const from = Date.parse(context.now()) - lookback * 60_000
    const invoices = await client(context).list<StripeInvoice>('/invoices', {
      status: 'open',
      created: { gte: Math.floor(from / 1000) },
      ...customerFilter(context.config)
    })
    return invoices.reverse().filter(isFailedAttempt).map(invoiceFailedToItem)
  }

  return defineConnector({
    id: 'stripe',
    name: 'Stripe',
    ...(options.version && { version: options.version }),
    description:
      'Trigger workflows from new Stripe customers, succeeded payments and paid or failed invoices, and create customers, issue refunds or read balances and charges from a step.',
    // Stripe's own S.
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z'
      ]
    },
    auth: {
      rung: 'cli',
      probe: { command: 'stripe', args: ['login', 'list'] },
      // No tokenArgs: `stripe config --list` prints a TOML document rather than a bare key, so the connector reads the profile itself.
      borrow: { env: ['STRIPE_API_KEY'], tokenEnv: 'STRIPE_API_KEY' }
    },
    config: [
      {
        key: 'apiKey',
        env: 'STRIPE_API_KEY',
        label: 'API key',
        secret: true,
        description:
          'Leave empty to borrow the Stripe CLI login. A restricted key with read access to customers, charges, invoices and payment intents plus write access to customers and refunds is enough.',
        builderHint:
          'Created under Developers, API keys, Create restricted key; sandbox keys start sk_test_ or rk_test_, live keys sk_live_ or rk_live_. Filled, it is sent as-is and stripe is never run; empty, the connector reads test_mode_api_key from stripe config --list. A publishable pk_ key is refused before any call.'
      },
      {
        key: 'liveMode',
        env: 'STRIPE_LIVE_MODE',
        label: 'Live mode',
        default: 'false',
        description: 'true borrows the live key from the CLI profile instead of the test one. A pasted key carries its own mode.',
        builderHint:
          'Reads live_mode_api_key rather than test_mode_api_key from the CLI profile. Objects in one mode are invisible to the other, and every item and output carries livemode.'
      },
      {
        key: 'project',
        env: 'STRIPE_PROJECT',
        label: 'CLI profile',
        description: 'The stripe --project-name profile to borrow from. Blank for the default profile.',
        builderHint: 'Passed as --project-name to stripe config --list and read as the TOML table of that name; the default table is [default].'
      },
      {
        key: 'customer',
        env: 'STRIPE_CUSTOMER',
        label: 'Customer',
        description: 'Only this customer’s invoices, for the two invoice triggers. Blank for every customer.',
        builderHint: 'Sent as the customer filter on GET /v1/invoices; the customer and payment triggers ignore it.'
      },
      {
        key: 'lookbackMinutes',
        env: 'STRIPE_LOOKBACK_MINUTES',
        label: 'Look-back minutes',
        default: String(DEFAULT_LOOKBACK_MINUTES),
        description:
          'How far before the watermark the payment and paid-invoice polls re-read, to catch an intent or invoice that succeeded a while after it was created.',
        builderHint:
          'created is when an intent or invoice was made, not when it was paid, so the created filter opens this many minutes before the watermark; bank debits that settle later than this are missed.'
      },
      {
        key: 'failedLookbackMinutes',
        env: 'STRIPE_FAILED_LOOKBACK_MINUTES',
        label: 'Failed invoice look-back minutes',
        default: String(DEFAULT_FAILED_LOOKBACK_MINUTES),
        description: 'How far before now the failed-invoice poll reads open invoices. A day by default, because retries are days apart.',
        builderHint: 'Stripe records no time for a failed attempt, so this window is measured from now and the dedupe key carries the attempt count.'
      }
    ],
    preflight: () =>
      stripePreflight({
        ...(text(env.STRIPE_API_KEY) !== undefined && { apiKey: env.STRIPE_API_KEY }),
        ...(text(env.STRIPE_PROJECT) !== undefined && { project: env.STRIPE_PROJECT }),
        liveMode: text(env.STRIPE_LIVE_MODE) === 'true',
        ...(options.stripe && { stripe: options.stripe })
      }),
    triggers: [
      {
        type: 'newCustomer',
        label: 'A customer is created',
        description: 'Fires once for each customer created since the last poll.',
        dedupe: 'timestamp',
        fetch: fetchCustomers,
        defaultWorkflow: { name: 'Stripe: new customers', defaultCronFromMinutes: 5 },
        sample: [customerToItem(SAMPLE_CUSTOMER)]
      },
      {
        type: 'paymentSucceeded',
        label: 'A payment succeeds',
        description:
          'Fires once for each payment intent that reaches succeeded. Amounts are integers in the smallest currency unit.',
        dedupe: 'timestamp',
        fetch: fetchSucceededPayments,
        statusMapping: [{ upstream: 'succeeded', suggestedLocal: 'done' }],
        defaultWorkflow: { name: 'Stripe: payments', defaultCronFromMinutes: 5 },
        sample: [paymentIntentToItem(SAMPLE_PAYMENT_INTENT)]
      },
      {
        type: 'invoicePaid',
        label: 'An invoice is paid',
        description: 'Fires once for each invoice that becomes paid, stamped with when it was paid.',
        dedupe: 'timestamp',
        fetch: fetchPaidInvoices,
        statusMapping: [{ upstream: 'paid', suggestedLocal: 'done' }],
        defaultWorkflow: { name: 'Stripe: paid invoices', defaultCronFromMinutes: 5 },
        sample: [invoicePaidToItem(SAMPLE_PAID_INVOICE)]
      },
      {
        type: 'invoicePaymentFailed',
        label: 'An invoice payment fails',
        description:
          'Fires once for each failed payment attempt on an open invoice, and again for each failed retry.',
        dedupe: 'timestamp',
        fetch: fetchFailedInvoices,
        statusMapping: [{ upstream: 'open', suggestedLocal: 'todo' }],
        defaultWorkflow: { name: 'Stripe: failed invoice payments', defaultCronFromMinutes: 15 },
        sample: [invoiceFailedToItem(SAMPLE_FAILED_INVOICE)]
      }
    ],
    actions: [
      {
        type: 'createCustomer',
        label: 'Create a customer',
        description: 'Create a customer. Identical inputs within 24 hours return the first customer rather than a second one.',
        // Not idempotent in Stripe's sense: the Idempotency-Key makes a retry safe for a day, after which the same inputs create again.
        idempotent: false,
        inputs: [
          {
            key: 'email',
            label: 'Email',
            description: 'Up to 512 characters, shown in the dashboard.',
            builderHint: 'Not validated for uniqueness by Stripe; two customers may share one.'
          },
          {
            key: 'name',
            label: 'Name',
            description: 'Full or business name, up to 256 characters.',
            builderHint: 'Sent as name; Stripe stores it as typed.'
          },
          {
            key: 'description',
            label: 'Description',
            description: 'Free text shown alongside the customer.',
            builderHint: 'Sent as description, often used for an internal account reference.'
          },
          {
            key: 'metadata',
            label: 'Metadata',
            type: 'json',
            description: 'A JSON object of string values, up to 50 keys of 40 characters with values of 500.',
            builderHint: 'Sent as metadata[key]=value form fields; keys may not contain square brackets. Not shown to the customer.'
          }
        ],
        outputs: [
          { key: 'id', description: 'The new customer id, cus_…' },
          { key: 'email', description: 'Email as saved, or null' },
          { key: 'name', description: 'Name as saved, or null' },
          { key: 'description', description: 'Description as saved, or null' },
          { key: 'created', description: 'When it was created, ISO 8601' },
          { key: 'metadata', description: 'The metadata object as stored' },
          { key: 'livemode', type: 'boolean', description: 'False for a sandbox customer' },
          { key: 'url', description: 'Where to open it in the dashboard' }
        ],
        async run(args, context) {
          const customer = await client(context).post<StripeCustomer>(
            '/customers',
            {
              email: text(args.email),
              name: text(args.name),
              description: text(args.description),
              metadata: metadataParams(args.metadata)
            },
            idempotencyKey('createCustomer', args)
          )
          const output = customerOutput(customer)
          return {
            id: output.id,
            email: output.email,
            name: output.name,
            description: output.description,
            created: output.created,
            metadata: output.metadata,
            livemode: output.livemode,
            url: output.url
          }
        }
      },
      {
        type: 'getCustomer',
        label: 'Get a customer',
        description: 'Read a customer by id. A deleted customer comes back with deleted true and little else.',
        idempotent: true,
        inputs: [
          {
            key: 'customer',
            label: 'Customer',
            required: true,
            description: 'Customer id such as cus_NffrFeUfNV2Hib.',
            builderHint: 'Sent URL-encoded as the path segment of GET /v1/customers/:id; an unknown id answers 404 resource_missing.'
          }
        ],
        outputs: [
          ...CUSTOMER_FIELDS,
          { key: 'deleted', type: 'boolean', description: 'True when the customer was deleted' }
        ],
        // The reference's own example id, standing in for a real customer the live check may not have.
        sample: { customer: 'cus_NffrFeUfNV2Hib' },
        async run(args, context) {
          const customer = await client(context).get<StripeCustomer>(
            `/customers/${encodeURIComponent(String(args.customer))}`
          )
          return customerOutput(customer)
        }
      },
      {
        type: 'listCharges',
        label: 'List recent charges',
        description: 'The most recent charges, newest first. Amounts are integers in the smallest currency unit.',
        idempotent: true,
        inputs: [
          LIMIT_INPUT,
          {
            key: 'customer',
            label: 'Customer',
            description: 'Only this customer’s charges. Blank for all.',
            builderHint: 'Sent as the customer filter on GET /v1/charges.'
          },
          STARTING_AFTER_INPUT('charge')
        ],
        outputs: [
          {
            key: 'charges',
            description:
              'One entry per charge: id, amount, amountRefunded, currency, status, paid, refunded, captured, customer, paymentIntent, description, receiptUrl, failureCode, failureMessage, created, livemode'
          },
          { key: 'hasMore', type: 'boolean', description: 'Whether another page follows the last id' }
        ],
        sample: { limit: '5' },
        async run(args, context) {
          const page = await client(context).get<{ data?: StripeCharge[]; has_more?: boolean }>('/charges', {
            limit: pageSize(args.limit),
            customer: text(args.customer),
            starting_after: text(args.startingAfter)
          })
          return { charges: (page.data ?? []).map(chargeOutput), hasMore: page.has_more === true }
        }
      },
      {
        type: 'createRefund',
        label: 'Refund a payment',
        description:
          'Refund a payment intent or charge, in full or for an amount in the smallest currency unit. Identical inputs within 24 hours return the first refund.',
        // A retry with the same inputs replays the first refund; different inputs on a refunded charge answer charge_already_refunded.
        idempotent: false,
        inputs: [
          {
            key: 'paymentIntent',
            label: 'Payment intent',
            description: 'The pi_… to refund. Give this or a charge.',
            builderHint: 'Sent as payment_intent; Stripe refunds its latest charge.'
          },
          {
            key: 'charge',
            label: 'Charge',
            description: 'The ch_… to refund. Give this or a payment intent.',
            builderHint: 'Sent as charge; the trigger and listCharges outputs carry ids that fit here.'
          },
          {
            key: 'amount',
            label: 'Amount',
            type: 'number',
            description: 'Integer in the smallest currency unit: 1099 is 10.99 USD, 500 is 500 JPY. Omitted refunds what remains.',
            builderHint: 'Never a decimal; refunding more than remains is an error from Stripe.'
          },
          {
            key: 'reason',
            label: 'Reason',
            type: 'select',
            options: REFUND_REASONS.map((value) => ({ value })),
            description: 'duplicate, fraudulent or requested_by_customer. fraudulent adds the card to the block list.',
            builderHint: 'Optional; shown in the dashboard and reported to the customer’s bank as given.'
          }
        ],
        outputs: [
          { key: 'id', description: 'Refund id, re_…' },
          { key: 'amount', type: 'number', description: 'Refunded amount in the smallest currency unit' },
          { key: 'currency', description: 'Three-letter currency' },
          { key: 'status', description: 'pending, requires_action, succeeded, failed or canceled' },
          { key: 'charge', description: 'The charge refunded' },
          { key: 'paymentIntent', description: 'The payment intent refunded, or null' },
          { key: 'reason', description: 'The reason as saved, or null' },
          { key: 'failureReason', description: 'Why a refund failed, or null' },
          { key: 'created', description: 'When it was created, ISO 8601' }
        ],
        async run(args, context) {
          const paymentIntent = text(args.paymentIntent)
          const charge = text(args.charge)
          if (!paymentIntent && !charge) throw new Error('createRefund needs a paymentIntent or a charge')
          const reason = text(args.reason)
          if (reason !== undefined && !REFUND_REASONS.includes(reason as (typeof REFUND_REASONS)[number])) {
            throw new Error(`reason must be one of ${REFUND_REASONS.join(', ')}, got "${reason}"`)
          }
          const refund = await client(context).post<StripeRefund>(
            '/refunds',
            {
              payment_intent: paymentIntent,
              charge,
              amount: smallestUnit(args.amount, 'amount'),
              reason
            },
            idempotencyKey('createRefund', args)
          )
          return {
            id: refund.id,
            amount: refund.amount,
            currency: refund.currency,
            status: refund.status ?? null,
            charge: refund.charge ?? null,
            paymentIntent: refund.payment_intent ?? null,
            reason: refund.reason ?? null,
            failureReason: refund.failure_reason ?? null,
            created: isoFromUnix(refund.created)
          }
        }
      },
      {
        type: 'getBalance',
        label: 'Get the account balance',
        description: 'The current balance of the account the key belongs to, in the smallest currency unit per currency.',
        idempotent: true,
        inputs: [],
        outputs: [
          { key: 'available', description: 'Funds that can be paid out, as {amount, currency, sourceTypes} per currency' },
          { key: 'pending', description: 'Funds not yet available, in the same shape' },
          { key: 'connectReserved', description: 'Funds held in reserve for Connect, as {amount, currency}' },
          { key: 'livemode', type: 'boolean', description: 'False for a sandbox balance' }
        ],
        sample: {},
        async run(_args, context) {
          const balance = await client(context).get<StripeBalance>('/balance')
          const funds = (entries: StripeBalance['available']) =>
            (entries ?? []).map((entry) => ({
              amount: entry.amount,
              currency: entry.currency,
              sourceTypes: entry.source_types ?? {}
            }))
          return {
            available: funds(balance.available),
            pending: funds(balance.pending),
            connectReserved: (balance.connect_reserved ?? []).map((entry) => ({
              amount: entry.amount,
              currency: entry.currency
            })),
            livemode: balance.livemode === true
          }
        }
      },
      {
        type: 'listCustomers',
        label: 'List customers',
        description: 'Customers newest first, optionally only those with one exact email address.',
        idempotent: true,
        inputs: [
          LIMIT_INPUT,
          {
            key: 'email',
            label: 'Email',
            description: 'Exact, case-sensitive email address to filter by.',
            builderHint: 'Sent as the email filter, which Stripe documents as a case-sensitive exact match.'
          },
          STARTING_AFTER_INPUT('customer')
        ],
        outputs: [
          {
            key: 'customers',
            description:
              'One entry per customer: id, email, name, description, phone, currency, balance, delinquent, created, metadata, deleted, livemode, url'
          },
          { key: 'hasMore', type: 'boolean', description: 'Whether another page follows the last id' }
        ],
        sample: { limit: '5' },
        async run(args, context) {
          const page = await client(context).get<{ data?: StripeCustomer[]; has_more?: boolean }>('/customers', {
            limit: pageSize(args.limit),
            email: text(args.email),
            starting_after: text(args.startingAfter)
          })
          return { customers: (page.data ?? []).map(customerOutput), hasMore: page.has_more === true }
        }
      }
    ]
  })
}
