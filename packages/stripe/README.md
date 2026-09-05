# @vornrun/connector-stripe

Trigger Vorn workflows from new Stripe customers, succeeded payments and paid
or failed invoices, and create customers, issue refunds or read balances and
charges from a workflow step. Talks to the REST API at
`https://api.stripe.com/v1`, pinned to API version `2026-08-26.dahlia`.

## Signing in

There is no key to paste. This connector borrows the Stripe CLI's login:

```sh
brew install stripe/stripe-cli/stripe   # or see https://docs.stripe.com/stripe-cli#install
stripe login
```

`stripe login list` is what the app asks to see who you are. The key itself is
read on demand from `stripe config --list`, the only documented command that
prints it, as the `test_mode_api_key` of the `[default]` profile (or of the
profile named by the **CLI profile** setting, and `live_mode_api_key` when
**Live mode** is `true`). Nothing is stored in the connection. The CLI's own
`STRIPE_API_KEY` variable takes precedence over the profile for the CLI, and
this connector reads the same name, so a shell that drives one drives both.

If you would rather not depend on the CLI, paste a key into the **API key**
field. Create one in the dashboard under **Developers → API keys** (the
sandbox lives at https://dashboard.stripe.com/test/apikeys): **Create
restricted key** is the documented recommendation, and a secret key works too.
Sandbox keys start `sk_test_` or `rk_test_`, live keys `sk_live_` or
`rk_live_`. A pasted key is used as-is and the CLI is never run. A publishable
key (`pk_…`) cannot call the API and is refused before any call is made.

A restricted key with these permissions is enough (write implies read):

| Resource | Permission | Needed by |
| --- | --- | --- |
| Customers | Write | `newCustomer`, `createCustomer`, `getCustomer`, `listCustomers` |
| Charges | Read | `listCharges` |
| PaymentIntents | Read | `paymentSucceeded` |
| Invoices | Read | `invoicePaid`, `invoicePaymentFailed` |
| Refunds | Write | `createRefund` |
| Balance | Read | `getBalance` |

A key missing a permission answers `403` with a message naming the permission
to add, and the connector surfaces it verbatim. A wrong or revoked key answers
`401`; a borrowed one is re-read from the CLI once before the connector reports
that you are signed out.

A note on the CLI login: the docs say the browser pairing flow keeps
credentials in the operating system's credential store, and they do not say
whether `stripe config --list` still prints the key from there. The documented
output of `stripe config --list` shows it does for a profile, and this was not
verified against a fresh install while building the connector. If it turns out
not to, `stripe login --interactive` (paste a key) and
`stripe config --set test_mode_api_key sk_test_…` are the documented ways to
write the key into the profile the connector reads, and the pasted-key field
always works. `stripe sandbox create --email you@example.com` provisions a
throwaway sandbox whose key is saved to the profile, which is a zero-setup way
to try this.

## Settings

| Field | Env | Required | What it does |
| --- | --- | --- | --- |
| `apiKey` | `STRIPE_API_KEY` | no | Restricted or secret key. Leave empty to borrow the CLI login. |
| `liveMode` | `STRIPE_LIVE_MODE` | no | `true` borrows the live key from the CLI profile. Default `false`. A pasted key carries its own mode. |
| `project` | `STRIPE_PROJECT` | no | The `--project-name` profile to borrow from. Blank for `default`. |
| `customer` | `STRIPE_CUSTOMER` | no | Only this customer's invoices, for the two invoice triggers. |
| `lookbackMinutes` | `STRIPE_LOOKBACK_MINUTES` | no | How far before the watermark the payment and paid-invoice polls re-read. Default 60. |
| `failedLookbackMinutes` | `STRIPE_FAILED_LOOKBACK_MINUTES` | no | How far before now the failed-invoice poll reads. Default 1440. |

Objects in one mode are invisible to the other, so a sandbox key sees only
sandbox customers. Every item and output carries `livemode`, and dashboard
links insert `/test` for sandbox objects.

## Amounts

Every amount, in triggers and actions alike, is an integer in the currency's
smallest unit exactly as Stripe returns it: `1099` is 10.99 USD, `500` is 500
JPY. The connector never divides, and the `amount` input of a refund takes the
same integer.

## Triggers

All four poll, each walking `starting_after` up to ten pages of 100 per poll
and delivering oldest first. The very first poll looks an hour back rather
than replaying the account. Each item's `data` carries the object's fields
under camelCase names with times as ISO 8601.

**A customer is created** (`newCustomer`) asks
`GET /v1/customers?created[gte]=<watermark>`. The watermark is `created`,
sent as `gte` rather than `gt` because `created` has one-second resolution;
the customer sitting on the boundary comes back and the SDK recognises it by
id.

**A payment succeeds** (`paymentSucceeded`) lists payment intents and keeps the
ones whose `status` is `succeeded`; the list endpoint has no status filter and
the Search API can lag by up to an hour, so the filter is client-side. An
intent's `created` is when it was made, not when it succeeded, and Stripe
records no time of success, so the watermark is the poll time: an intent
created since the last poll is new, and one created earlier but succeeded
since (a bank debit, say) is recognised by its id for as long as the window,
which opens `lookbackMinutes` before the watermark, still holds it. An intent
that takes longer than the look-back to succeed is missed; widen the setting
if that matters. The window is anchored to the watermark rather than to now,
so a machine that was asleep catches up on everything created meanwhile.

**An invoice is paid** (`invoicePaid`) asks `GET /v1/invoices?status=paid`
from `lookbackMinutes` before the watermark and stamps each item with
`status_transitions.paid_at`, so only an invoice paid since the last poll is
delivered. Items are keyed `<invoice id>:paid`.

**An invoice payment fails** (`invoicePaymentFailed`) has no status to ask
for: a failed attempt leaves the invoice `open`. It reads open invoices created
in the `failedLookbackMinutes` before now and keeps those with `attempted`
true, `attempt_count` above zero and `amount_remaining` above zero. Items are
keyed `<invoice id>:failed:<attempt_count>`, so each failed retry fires once
and a retry that succeeds ends the series. Retries are days apart, hence the
one-day default window.

Status suggestions: payments `succeeded → done`; paid invoices `paid → done`;
failed invoice payments `open → todo`.

## Actions

| Action | Idempotent | Notes |
| --- | --- | --- |
| Create a customer | no | `email`, `name`, `description`, `metadata` (a JSON object of string values). Retry-safe for a day through the idempotency key. |
| Get a customer | yes | By id. A deleted customer comes back with `deleted` true and little else; an unknown id answers `404 resource_missing`. |
| List recent charges | yes | `limit` 1 to 100, optional `customer` and `startingAfter`. Returns `charges` and `hasMore`. |
| Refund a payment | no | `paymentIntent` or `charge`, optional `amount` in the smallest unit and `reason`. Retry-safe for a day. |
| Get the account balance | yes | No inputs. `available`, `pending` and `connectReserved` per currency. |
| List customers | yes | `limit` 1 to 100, optional exact case-sensitive `email` and `startingAfter`. Returns `customers` and `hasMore`. |

Every action is hand-written against one client rather than declared as an SDK
request, because a declared request can only send `{{config.apiKey}}`, which is
empty whenever the key is borrowed from the CLI. The client sends
`Authorization: Bearer <key>` and `Stripe-Version` on every call, form-encodes
writes with bracketed keys (`metadata[order_id]=6735`) as the reference does,
and throws `<type>/<code>: <message> (<Request-Id>)` on a non-2xx answer.

The two writes send an `Idempotency-Key`: the SHA-256 of the action name and
the step's inputs with keys sorted, 64 hex characters, so nothing sensitive
reaches the header. Identical inputs within 24 hours get the first answer back
instead of a second customer or refund; after 24 hours Stripe has pruned the
key and the same inputs create again. Different inputs under the same key
cannot happen, because the key is derived from the inputs. Writes are retried
twice on `429` and `5xx` with jittered backoff, which the key makes safe; reads
are retried by the SDK.

The live check calls the four reads. `getCustomer`'s sample is the API
reference's own example id, which a sandbox does not hold, so that one answers
`404` unless a customer by that id exists; `scripts/check-live.sh` reads a
real one from `STRIPE_CUSTOMER_ID` instead.

## What this connector cannot do

- **No webhooks.** It polls. The default seeded workflows run every 5 minutes
  (15 for failed invoice payments).
- **No time of success on a payment intent**, so `paymentSucceeded` items carry
  the poll time as `updatedAt`; `data.created` is when the intent was made.
- **A backlog over 1,000 items in one poll** is cut at ten pages, newest first,
  and the rest is not asked for again.
- **Nothing beyond the key's permissions.** A `403` is reported with Stripe's
  own message naming the permission to add.

Rate limits: Stripe allows 100 requests a second live and 25 in a sandbox, and
answers `429` with a `Stripe-Rate-Limited-Reason` header. Reads are retried by
the SDK with backoff; writes twice by the client. A quiet account costs one
request per trigger per poll, because every poll filters on `created` and
stops paging at the cursor.

## Checks

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/stripe/dist/index.js --mock --receipt packages/stripe/verified.json
```

`scripts/check.sh` in this package runs exactly this from the repository root.
`scripts/check-live.sh` runs the read-only endpoints and then
`vorn-connector check --live` against a sandbox when `STRIPE_API_KEY` is set
or a `stripe login` profile can lend a test key, refuses a live key outright,
and exits 0 with a note when there is nothing to run with. Nothing is created
or refunded by either. Tests make no network calls and never spawn `stripe`.

## Built from

- [API reference](https://docs.stripe.com/api)
- [Authentication](https://docs.stripe.com/api/authentication)
- [Errors](https://docs.stripe.com/api/errors), [error codes](https://docs.stripe.com/error-codes) and [error handling](https://docs.stripe.com/error-handling)
- [Rate limits](https://docs.stripe.com/rate-limits)
- [Pagination](https://docs.stripe.com/api/pagination)
- [Idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- [Request IDs](https://docs.stripe.com/api/request_ids)
- [Versioning](https://docs.stripe.com/api/versioning)
- [Metadata](https://docs.stripe.com/api/metadata)
- [Currencies and smallest units](https://docs.stripe.com/currencies)
- [Customers](https://docs.stripe.com/api/customers)
- [Charges](https://docs.stripe.com/api/charges)
- [PaymentIntents](https://docs.stripe.com/api/payment_intents)
- [Invoices](https://docs.stripe.com/api/invoices)
- [Refunds](https://docs.stripe.com/api/refunds)
- [Balance](https://docs.stripe.com/api/balance/balance_retrieve)
- [Event types](https://docs.stripe.com/api/events/types)
- [API keys](https://docs.stripe.com/keys) and [restricted API keys](https://docs.stripe.com/keys/restricted-api-keys)
- [Stripe CLI](https://docs.stripe.com/stripe-cli) and its [reference](https://docs.stripe.com/cli):
  [`stripe login`](https://docs.stripe.com/cli/login),
  [`stripe login list`](https://docs.stripe.com/cli/login/list),
  [`stripe config`](https://docs.stripe.com/cli/config),
  [API keys and environment variables](https://docs.stripe.com/cli/api_keys),
  [`stripe sandbox`](https://docs.stripe.com/cli/sandbox)
