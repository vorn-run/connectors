import type { ConnectorItem } from '@vornrun/connector-sdk'
import { dashboardUrl } from './client'

export interface StripeCustomer {
  id: string
  object?: string
  created: number
  email?: string | null
  name?: string | null
  description?: string | null
  phone?: string | null
  currency?: string | null
  balance?: number
  delinquent?: boolean | null
  metadata?: Record<string, string>
  deleted?: boolean
  livemode?: boolean
}

export interface StripePaymentIntent {
  id: string
  object?: string
  amount: number
  amount_received?: number
  currency: string
  status: string
  created: number
  customer?: string | null
  latest_charge?: string | null
  description?: string | null
  receipt_email?: string | null
  metadata?: Record<string, string>
  livemode?: boolean
}

export interface StripeInvoice {
  id: string
  object?: string
  number?: string | null
  status: string
  customer?: string | null
  customer_email?: string | null
  customer_name?: string | null
  amount_due: number
  amount_paid: number
  amount_remaining: number
  currency: string
  created: number
  attempted?: boolean
  attempt_count?: number
  next_payment_attempt?: number | null
  status_transitions?: {
    finalized_at?: number | null
    paid_at?: number | null
    marked_uncollectible_at?: number | null
    voided_at?: number | null
  }
  hosted_invoice_url?: string | null
  collection_method?: string
  billing_reason?: string | null
  livemode?: boolean
}

export interface StripeCharge {
  id: string
  amount: number
  amount_refunded?: number
  currency: string
  status: string
  paid?: boolean
  refunded?: boolean
  captured?: boolean
  customer?: string | null
  payment_intent?: string | null
  description?: string | null
  receipt_url?: string | null
  failure_code?: string | null
  failure_message?: string | null
  created: number
  livemode?: boolean
}

export interface StripeRefund {
  id: string
  amount: number
  currency: string
  status?: string | null
  charge?: string | null
  payment_intent?: string | null
  reason?: string | null
  failure_reason?: string | null
  created: number
}

export interface StripeBalance {
  available?: Array<{ amount: number; currency: string; source_types?: Record<string, number> }>
  pending?: Array<{ amount: number; currency: string; source_types?: Record<string, number> }>
  connect_reserved?: Array<{ amount: number; currency: string }>
  livemode?: boolean
}

// Stripe stamps everything in integer Unix seconds.
export function isoFromUnix(seconds: number | null | undefined): string | null {
  return typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null
}

function personLabel(name: string | null | undefined, email: string | null | undefined, id: string): string {
  if (name && email) return `${name} <${email}>`
  return name || email || id
}

// Amounts stay in the smallest currency unit: `2000 usd` is 20.00 USD and the connector never divides.
function money(amount: number, currency: string): string {
  return `${amount} ${currency}`
}

export function customerToItem(customer: StripeCustomer): ConnectorItem {
  return {
    externalId: customer.id,
    title: personLabel(customer.name, customer.email, customer.id),
    url: dashboardUrl(`customers/${customer.id}`, customer.livemode),
    description: customer.description ?? '',
    updatedAt: new Date(customer.created * 1000).toISOString(),
    data: customerOutput(customer)
  }
}

// Fresh intents carry the poll time as `updatedAt`; one created before the watermark carries none, so the SDK keeps its id instead of its time.
export function paymentIntentToItem(intent: StripePaymentIntent, updatedAt?: string): ConnectorItem {
  return {
    externalId: intent.id,
    title: `${money(intent.amount, intent.currency)} ${intent.status}`,
    url: dashboardUrl(`payments/${intent.id}`, intent.livemode),
    description: intent.description ?? '',
    status: intent.status,
    ...(updatedAt !== undefined && { updatedAt }),
    data: {
      id: intent.id,
      amount: intent.amount,
      amountReceived: intent.amount_received ?? 0,
      currency: intent.currency,
      customer: intent.customer ?? null,
      latestCharge: intent.latest_charge ?? null,
      receiptEmail: intent.receipt_email ?? null,
      metadata: intent.metadata ?? {},
      created: isoFromUnix(intent.created),
      livemode: intent.livemode === true
    }
  }
}

function invoiceData(invoice: StripeInvoice): Record<string, unknown> {
  const transitions = invoice.status_transitions ?? {}
  return {
    id: invoice.id,
    number: invoice.number ?? null,
    customer: invoice.customer ?? null,
    customerEmail: invoice.customer_email ?? null,
    customerName: invoice.customer_name ?? null,
    amountDue: invoice.amount_due,
    amountPaid: invoice.amount_paid,
    amountRemaining: invoice.amount_remaining,
    currency: invoice.currency,
    attempted: invoice.attempted === true,
    attemptCount: invoice.attempt_count ?? 0,
    nextPaymentAttempt: isoFromUnix(invoice.next_payment_attempt),
    paidAt: isoFromUnix(transitions.paid_at),
    finalizedAt: isoFromUnix(transitions.finalized_at),
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    collectionMethod: invoice.collection_method ?? '',
    billingReason: invoice.billing_reason ?? null,
    created: isoFromUnix(invoice.created),
    livemode: invoice.livemode === true
  }
}

function invoiceLabel(invoice: StripeInvoice): string {
  return `Invoice ${invoice.number || invoice.id}`
}

// Keyed on `${id}:paid` and stamped with `paid_at`, the one time Stripe records for the event.
export function invoicePaidToItem(invoice: StripeInvoice): ConnectorItem {
  const paidAt = isoFromUnix(invoice.status_transitions?.paid_at)
  return {
    externalId: `${invoice.id}:paid`,
    title: `${invoiceLabel(invoice)} paid: ${money(invoice.amount_paid, invoice.currency)}`,
    url: dashboardUrl(`invoices/${invoice.id}`, invoice.livemode),
    status: invoice.status,
    ...(paidAt !== null && { updatedAt: paidAt }),
    data: invoiceData(invoice)
  }
}

// An open invoice with a failed attempt and money still owed; there is no `failed` status to ask Stripe for.
export function isFailedAttempt(invoice: StripeInvoice): boolean {
  return (
    invoice.status === 'open' &&
    invoice.attempted === true &&
    (invoice.attempt_count ?? 0) > 0 &&
    invoice.amount_remaining > 0
  )
}

// Keyed on the attempt count so each failed retry fires once, and carrying no time because Stripe records none for a failure.
export function invoiceFailedToItem(invoice: StripeInvoice): ConnectorItem {
  const attempt = invoice.attempt_count ?? 0
  return {
    externalId: `${invoice.id}:failed:${attempt}`,
    title: `${invoiceLabel(invoice)} payment failed (attempt ${attempt}): ${money(invoice.amount_remaining, invoice.currency)}`,
    url: dashboardUrl(`invoices/${invoice.id}`, invoice.livemode),
    status: invoice.status,
    data: invoiceData(invoice)
  }
}

export function customerOutput(customer: StripeCustomer): Record<string, unknown> {
  return {
    id: customer.id,
    email: customer.email ?? null,
    name: customer.name ?? null,
    description: customer.description ?? null,
    phone: customer.phone ?? null,
    currency: customer.currency ?? null,
    balance: customer.balance ?? 0,
    delinquent: customer.delinquent === true,
    created: isoFromUnix(customer.created),
    metadata: customer.metadata ?? {},
    deleted: customer.deleted === true,
    livemode: customer.livemode === true,
    url: dashboardUrl(`customers/${customer.id}`, customer.livemode)
  }
}

export function chargeOutput(charge: StripeCharge): Record<string, unknown> {
  return {
    id: charge.id,
    amount: charge.amount,
    amountRefunded: charge.amount_refunded ?? 0,
    currency: charge.currency,
    status: charge.status,
    paid: charge.paid === true,
    refunded: charge.refunded === true,
    captured: charge.captured === true,
    customer: charge.customer ?? null,
    paymentIntent: charge.payment_intent ?? null,
    description: charge.description ?? null,
    receiptUrl: charge.receipt_url ?? null,
    failureCode: charge.failure_code ?? null,
    failureMessage: charge.failure_message ?? null,
    created: isoFromUnix(charge.created),
    livemode: charge.livemode === true
  }
}

// What the API reference shows for each object, trimmed to the fields the mappings read; `check --mock` replays these through the dedupe pipeline.
export const SAMPLE_CUSTOMER: StripeCustomer = {
  id: 'cus_NffrFeUfNV2Hib',
  object: 'customer',
  created: 1680893993,
  email: 'jennyrosen@example.com',
  name: 'Jenny Rosen',
  description: null,
  phone: null,
  currency: null,
  balance: 0,
  delinquent: false,
  metadata: {},
  livemode: false
}

export const SAMPLE_PAYMENT_INTENT: StripePaymentIntent = {
  id: 'pi_3MtwBwLkdIwHu7ix28a3tqPa',
  object: 'payment_intent',
  amount: 2000,
  amount_received: 2000,
  currency: 'usd',
  status: 'succeeded',
  created: 1680800504,
  customer: null,
  latest_charge: 'ch_3MtwBwLkdIwHu7ix0snN0B15',
  description: null,
  receipt_email: null,
  metadata: {},
  livemode: false
}

export const SAMPLE_PAID_INVOICE: StripeInvoice = {
  id: 'in_1MtHbELkdIwHu7ixl4OzzPMv',
  object: 'invoice',
  number: 'F1B2C3D-0001',
  status: 'paid',
  customer: 'cus_NeZwdNtLEOXuvB',
  customer_email: 'jennyrosen@example.com',
  customer_name: 'Jenny Rosen',
  amount_due: 4900,
  amount_paid: 4900,
  amount_remaining: 0,
  currency: 'usd',
  created: 1680644467,
  attempted: true,
  attempt_count: 1,
  next_payment_attempt: null,
  status_transitions: {
    finalized_at: 1680644467,
    paid_at: 1680644467,
    marked_uncollectible_at: null,
    voided_at: null
  },
  hosted_invoice_url: 'https://invoice.stripe.com/i/acct_1/test_YWNjdF8x',
  collection_method: 'charge_automatically',
  billing_reason: 'subscription_cycle',
  livemode: false
}

export const SAMPLE_FAILED_INVOICE: StripeInvoice = {
  ...SAMPLE_PAID_INVOICE,
  status: 'open',
  amount_paid: 0,
  amount_remaining: 4900,
  attempted: true,
  attempt_count: 2,
  next_payment_attempt: 1681249267,
  status_transitions: {
    finalized_at: 1680644467,
    paid_at: null,
    marked_uncollectible_at: null,
    voided_at: null
  }
}

export const SAMPLE_CHARGE: StripeCharge = {
  id: 'ch_3MmlLrLkdIwHu7ix0snN0B15',
  amount: 1099,
  amount_refunded: 0,
  currency: 'usd',
  status: 'succeeded',
  paid: true,
  refunded: false,
  captured: true,
  customer: null,
  payment_intent: null,
  description: null,
  receipt_url: 'https://pay.stripe.com/receipts/payment/example',
  failure_code: null,
  failure_message: null,
  created: 1679090539,
  livemode: false
}
