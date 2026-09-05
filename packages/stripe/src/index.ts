import { createStripeConnector } from './connector'
import { serveIfEntryPoint } from './entry'

export { createStripeConnector } from './connector'
export type { StripeConnectorOptions } from './connector'
export {
  API_ROOT,
  MAX_LIST_PAGES,
  MAX_PAGE_SIZE,
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
export type { PreflightResult, RunStripe, StripeClient, TokenSource } from './client'
export {
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
export type {
  StripeBalance,
  StripeCharge,
  StripeCustomer,
  StripeInvoice,
  StripePaymentIntent,
  StripeRefund
} from './items'
import pkg from '../package.json'

const { version } = pkg

export const stripeConnector = createStripeConnector({ version })

// The names the SDK's own tooling loads a connector by.
export { stripeConnector as connector }
export default stripeConnector

serveIfEntryPoint(stripeConnector, import.meta.url)
