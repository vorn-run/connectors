# Changelog

All notable changes to `@vornrun/connector-stripe`.

## 0.1.0

First release.

Trigger a workflow from new Stripe customers, succeeded payments and paid or
failed invoices, and let a workflow step create a customer, issue a refund, or
read a customer, the recent charges, the customer list and the account balance.

- **Triggers:** `newCustomer`, `paymentSucceeded`, `invoicePaid`,
  `invoicePaymentFailed`.
- **Actions:** `createCustomer`, `getCustomer`, `listCharges`, `createRefund`,
  `getBalance`, `listCustomers`.
- **Signing in:** borrows the Stripe CLI's login. `stripe login` is all it
  needs; the connector reads `test_mode_api_key` (or the live key, when asked)
  from `stripe config --list` on demand and stores nothing. A pasted restricted
  or secret key is used instead when one is given, and a publishable `pk_` key
  is refused before any call.

Every action is hand-written against one small client rather than declared as
an SDK `request`: a declared request can only send `{{config.apiKey}}`, which is
empty whenever the key is borrowed from the CLI, because `stripe config --list`
prints a document rather than a bare token and so cannot be the host's borrow
command. The client sends `Stripe-Version: 2026-08-26.dahlia` on every call,
form-encodes writes the way the reference does, retries a `429` or `5xx` write
twice with jittered backoff, and reports a failure as
`<type>/<code>: <message> (<Request-Id>)`.

Both writes send an `Idempotency-Key`, the SHA-256 of the action name and its
inputs with keys sorted, so a retry with the same inputs returns the first
customer or refund rather than making a second one. Stripe keeps a key for 24
hours; after that the same inputs create again.

The four triggers are declarative polls on the SDK's timestamp strategy, each
walking `starting_after` up to ten pages of 100 and delivering oldest first.
Customers watermark on `created`; paid invoices on `paid_at`, read from a
window that opens a look-back before the watermark because an invoice is
created before it is paid. Succeeded payment intents have no time of success,
so the watermark is the poll time: an intent created since the last poll is
new, and one created earlier but succeeded since is recognised by its id for as
long as the look-back window holds it. Failed invoice payments have no time at
all; the window is a day before now, and the dedupe key carries the attempt
count so each failed retry fires once.

Amounts everywhere are integers in the currency's smallest unit, as Stripe
returns them; the connector never divides.

Ships as a pack with a conformance receipt covering the mock run and the dedupe
replay of every trigger. No runtime dependencies: `fetch`, `URLSearchParams`
and `node:crypto` cover the client, the form encoding and the idempotency hash,
and the CLI profile is one TOML table.
