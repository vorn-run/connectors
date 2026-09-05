import { describe, expect, it } from 'vitest'
import {
  SAMPLE_CHARGE,
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
  paymentIntentToItem
} from './items'

describe('isoFromUnix', () => {
  it('turns Stripe seconds into ISO 8601 and leaves nothing as null', () => {
    expect(isoFromUnix(1680893993)).toBe('2023-04-07T18:59:53.000Z')
    expect(isoFromUnix(null)).toBeNull()
    expect(isoFromUnix(undefined)).toBeNull()
  })
})

describe('customerToItem', () => {
  it('keys on the id, titles with name and email, and links the sandbox dashboard', () => {
    expect(customerToItem(SAMPLE_CUSTOMER)).toEqual({
      externalId: 'cus_NffrFeUfNV2Hib',
      title: 'Jenny Rosen <jennyrosen@example.com>',
      url: 'https://dashboard.stripe.com/test/customers/cus_NffrFeUfNV2Hib',
      description: '',
      updatedAt: '2023-04-07T18:59:53.000Z',
      data: {
        id: 'cus_NffrFeUfNV2Hib',
        email: 'jennyrosen@example.com',
        name: 'Jenny Rosen',
        description: null,
        phone: null,
        currency: null,
        balance: 0,
        delinquent: false,
        created: '2023-04-07T18:59:53.000Z',
        metadata: {},
        deleted: false,
        livemode: false,
        url: 'https://dashboard.stripe.com/test/customers/cus_NffrFeUfNV2Hib'
      }
    })
  })

  it('falls back to whichever of name, email and id it has, and drops /test for live', () => {
    expect(customerToItem({ ...SAMPLE_CUSTOMER, name: null, livemode: true })).toMatchObject({
      title: 'jennyrosen@example.com',
      url: 'https://dashboard.stripe.com/customers/cus_NffrFeUfNV2Hib'
    })
    expect(customerToItem({ ...SAMPLE_CUSTOMER, name: 'Only Name', email: null }).title).toBe('Only Name')
    expect(customerToItem({ id: 'cus_bare', created: 1 }).title).toBe('cus_bare')
  })
})

describe('paymentIntentToItem', () => {
  it('carries the poll time it was given, or no time at all', () => {
    const fresh = paymentIntentToItem(SAMPLE_PAYMENT_INTENT, '2026-09-05T10:00:00.000Z')
    expect(fresh).toEqual({
      externalId: 'pi_3MtwBwLkdIwHu7ix28a3tqPa',
      title: '2000 usd succeeded',
      url: 'https://dashboard.stripe.com/test/payments/pi_3MtwBwLkdIwHu7ix28a3tqPa',
      description: '',
      status: 'succeeded',
      updatedAt: '2026-09-05T10:00:00.000Z',
      data: {
        id: 'pi_3MtwBwLkdIwHu7ix28a3tqPa',
        amount: 2000,
        amountReceived: 2000,
        currency: 'usd',
        customer: null,
        latestCharge: 'ch_3MtwBwLkdIwHu7ix0snN0B15',
        receiptEmail: null,
        metadata: {},
        created: '2023-04-06T17:01:44.000Z',
        livemode: false
      }
    })
    expect(paymentIntentToItem(SAMPLE_PAYMENT_INTENT)).not.toHaveProperty('updatedAt')
  })

  it('tolerates the optional fields being absent', () => {
    const bare = paymentIntentToItem({ id: 'pi_1', amount: 5, currency: 'jpy', status: 'succeeded', created: 1 })
    expect(bare.data).toMatchObject({ amountReceived: 0, latestCharge: null, metadata: {}, livemode: false })
  })
})

describe('invoicePaidToItem', () => {
  it('keys on id:paid, stamps paid_at and titles with the amount paid', () => {
    const item = invoicePaidToItem(SAMPLE_PAID_INVOICE)
    expect(item).toMatchObject({
      externalId: 'in_1MtHbELkdIwHu7ixl4OzzPMv:paid',
      title: 'Invoice F1B2C3D-0001 paid: 4900 usd',
      url: 'https://dashboard.stripe.com/test/invoices/in_1MtHbELkdIwHu7ixl4OzzPMv',
      status: 'paid',
      updatedAt: '2023-04-04T21:41:07.000Z'
    })
    expect(item.data).toEqual({
      id: 'in_1MtHbELkdIwHu7ixl4OzzPMv',
      number: 'F1B2C3D-0001',
      customer: 'cus_NeZwdNtLEOXuvB',
      customerEmail: 'jennyrosen@example.com',
      customerName: 'Jenny Rosen',
      amountDue: 4900,
      amountPaid: 4900,
      amountRemaining: 0,
      currency: 'usd',
      attempted: true,
      attemptCount: 1,
      nextPaymentAttempt: null,
      paidAt: '2023-04-04T21:41:07.000Z',
      finalizedAt: '2023-04-04T21:41:07.000Z',
      hostedInvoiceUrl: 'https://invoice.stripe.com/i/acct_1/test_YWNjdF8x',
      collectionMethod: 'charge_automatically',
      billingReason: 'subscription_cycle',
      created: '2023-04-04T21:41:07.000Z',
      livemode: false
    })
  })

  it('names an unnumbered invoice by id and copes without transitions', () => {
    const item = invoicePaidToItem({ ...SAMPLE_PAID_INVOICE, number: null, status_transitions: undefined })
    expect(item.title).toBe('Invoice in_1MtHbELkdIwHu7ixl4OzzPMv paid: 4900 usd')
    expect(item).not.toHaveProperty('updatedAt')
    expect(item.data).toMatchObject({ paidAt: null, finalizedAt: null })
  })
})

describe('failed invoice attempts', () => {
  it('recognises an open invoice with a failed attempt and money still owed', () => {
    expect(isFailedAttempt(SAMPLE_FAILED_INVOICE)).toBe(true)
    expect(isFailedAttempt(SAMPLE_PAID_INVOICE)).toBe(false)
    expect(isFailedAttempt({ ...SAMPLE_FAILED_INVOICE, attempted: false })).toBe(false)
    expect(isFailedAttempt({ ...SAMPLE_FAILED_INVOICE, attempt_count: 0 })).toBe(false)
    expect(isFailedAttempt({ ...SAMPLE_FAILED_INVOICE, attempt_count: undefined })).toBe(false)
    expect(isFailedAttempt({ ...SAMPLE_FAILED_INVOICE, amount_remaining: 0 })).toBe(false)
  })

  it('keys on the attempt count and carries no timestamp', () => {
    const item = invoiceFailedToItem(SAMPLE_FAILED_INVOICE)
    expect(item).toMatchObject({
      externalId: 'in_1MtHbELkdIwHu7ixl4OzzPMv:failed:2',
      title: 'Invoice F1B2C3D-0001 payment failed (attempt 2): 4900 usd',
      status: 'open'
    })
    expect(item).not.toHaveProperty('updatedAt')
    expect(item.data).toMatchObject({
      attemptCount: 2,
      nextPaymentAttempt: '2023-04-11T21:41:07.000Z',
      paidAt: null,
      amountRemaining: 4900
    })
    expect(invoiceFailedToItem({ ...SAMPLE_FAILED_INVOICE, attempt_count: undefined }).externalId).toMatch(/:failed:0$/)
  })
})

describe('action outputs', () => {
  it('renders a customer under readable names, deleted included', () => {
    expect(customerOutput({ id: 'cus_gone', created: 1680893993, deleted: true })).toEqual({
      id: 'cus_gone',
      email: null,
      name: null,
      description: null,
      phone: null,
      currency: null,
      balance: 0,
      delinquent: false,
      created: '2023-04-07T18:59:53.000Z',
      metadata: {},
      deleted: true,
      livemode: false,
      url: 'https://dashboard.stripe.com/test/customers/cus_gone'
    })
  })

  it('renders a charge under camelCase names', () => {
    expect(chargeOutput(SAMPLE_CHARGE)).toEqual({
      id: 'ch_3MmlLrLkdIwHu7ix0snN0B15',
      amount: 1099,
      amountRefunded: 0,
      currency: 'usd',
      status: 'succeeded',
      paid: true,
      refunded: false,
      captured: true,
      customer: null,
      paymentIntent: null,
      description: null,
      receiptUrl: 'https://pay.stripe.com/receipts/payment/example',
      failureCode: null,
      failureMessage: null,
      created: '2023-03-17T22:02:19.000Z',
      livemode: false
    })
    expect(chargeOutput({ id: 'ch_1', amount: 1, currency: 'usd', status: 'failed', created: 1 })).toMatchObject({
      amountRefunded: 0,
      paid: false,
      receiptUrl: null
    })
  })
})
