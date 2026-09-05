id: stripe

# Stripe connector

Stripe's REST API at `https://api.stripe.com/v1`. Requests are plain HTTPS:
reads are `GET` with a query string, writes are `POST` with an
`application/x-www-form-urlencoded` body, and nested parameters use brackets
(`created[gte]=1680000000`, `metadata[order_id]=6735`), exactly as every
example in the reference does. Responses are JSON. A list is
`{ object: "list", data: [...], has_more, url }` and an error is
`{ error: { type, code, message, param, doc_url, request_log_url } }` with a
`Request-Id` response header worth quoting in every thrown error.

Package: `@vornrun/connector-stripe` in `packages/stripe`, shaped exactly like
the existing packages: scoped name, tsup, `vitest.config.ts` re-exporting
`vitest.shared.ts`, `CHANGELOG.md`, `README.md` with the links from the Docs
section, `verified.json` from `vorn-connector check --mock`, category
`Finance`, `packs: true`.

## Auth

Rung: **`cli`**, with a `key` fallback in the same connection.

Many developers already run `stripe login`. The current CLI's login is a
browser pairing flow: "the CLI stores your credentials in your operating
system's secure credential store (when available) and refreshes the session
automatically". The key it mints for the session is a restricted key
(`rk_test_…` / `rk_live_…`), which is what the documented `stripe config --list`
output shows.

| Role | Value |
| --- | --- |
| Probe (reports the session) | `stripe login list` |
| Prints the key | `stripe config --list`, then read `test_mode_api_key` (or `live_mode_api_key`) |
| Env variable the connector reads | `STRIPE_API_KEY` |
| Header sent to the API | `Authorization: Bearer <key>` |

What the docs say, and what follows from it:

- `stripe login list` "lists the account and sandbox contexts authorized for
  the current session. Each context shows its available sandbox or live mode,
  and the active context is marked." It is the closest thing to a whoami; the
  CLI has no `whoami` or `auth status` command. Its exit code when nothing is
  authorized is not documented, so the connector's own preflight must not
  trust exit 0 alone: it treats "the borrow found no key" as "not signed in"
  and says `Run stripe login`.
- The only documented command that prints the key is `stripe config --list`,
  which "lists all configured options (including defaults)" as TOML:

  ```
  color = "on"

  [default]
    device_name = "st-stripe1"
    live_mode_api_key = "rk_live_abc123"
    live_mode_publishable_key = "pk_live_abc123"
    test_mode_api_key = "rk_test_abc123"
    test_mode_publishable_key = "pk_test_abc123"
  ```

  It prints a document, not a bare token, so it cannot be the host's
  `borrow.tokenArgs` verbatim (that command must print the token and nothing
  else). The connector's own token source runs `stripe config --list` at
  spawn, takes the `[default]` table (or the `--project-name` table when the
  `project` config field is set), and reads `test_mode_api_key`, or
  `live_mode_api_key` when `liveMode` is true. Nothing is stored. Declare
  `auth: { rung: 'cli', probe: { command: 'stripe', args: ['login', 'list'] },
  borrow: { env: ['STRIPE_API_KEY'], tokenEnv: 'STRIPE_API_KEY' } }` so a host
  that already holds `STRIPE_API_KEY` passes it through, and leave
  `tokenArgs` unset.
- The CLI itself reads `STRIPE_API_KEY` ahead of everything: "You can set two
  environment variables, which take precedence over all other values:
  `STRIPE_API_KEY` ... `STRIPE_DEVICE_NAME`". The connector uses the same
  name, so a shell that already drives the CLI drives the connector.
- The config file is `$HOME/.config/stripe/config.toml` (global flag
  `--config`), and `--project-name` "enables multiple configurations across
  Stripe accounts (stored within one configuration file)" under a table named
  after the project, default `"default"`.
- **Risk to verify in develop, with the real CLI installed:** the docs for the
  browser login say credentials go to the OS credential store, and they do
  not say whether `stripe config --list` still prints the key from there.
  The `config` page's documented output shows it does for a profile; if a
  fresh install proves otherwise, the borrow falls back to the pasted key and
  the README says so. `stripe login --interactive` (paste a key) and
  `stripe config --set test_mode_api_key sk_test_123` write the key to the
  file and are the documented ways to make the borrow work regardless.
- `stripe sandbox create --email you@example.com` provisions a throwaway
  sandbox with keys (`rkcs_test_…`), "saved to your CLI profile", expiring in
  7 days: a zero-setup way to run the live checks.

Fallback, rung `key`:

| Config field | Env name | Where it comes from |
| --- | --- | --- |
| `apiKey` (secret) | `STRIPE_API_KEY` | Dashboard, **Developers → API keys** (https://dashboard.stripe.com/test/apikeys for the sandbox): **Create restricted key**, or a secret key |

The field is used as-is when filled and the CLI is never run; when empty the
connector borrows as above. Key prefixes, from the keys page: sandbox keys are
`sk_test_` (secret) and `rk_test_` (restricted); live keys are `sk_live_` and
`rk_live_`. A publishable key (`pk_`) answers `secret_key_required` and is
refused by the connector's preflight before any call. Stripe's own advice: "we
don't recommend using secret keys for new use cases", use a restricted key.

Restricted-key permissions that are enough, per resource (**Write implies
Read**):

| Resource | Permission | Needed by |
| --- | --- | --- |
| Customers | Write | `newCustomer`, `createCustomer`, `getCustomer`, `listCustomers` |
| Charges | Read | `listCharges` |
| PaymentIntents | Read | `paymentSucceeded` |
| Invoices | Read | `invoicePaid`, `invoicePaymentFailed` |
| Refunds | Write | `createRefund` |
| Balance | Read | `getBalance` |

A key missing a permission answers HTTP 403 with `type: invalid_request_error`
and "an error message explaining which permissions to add"; the connector
surfaces that message verbatim. A revoked or wrong key answers 401; an
expired one carries `code: api_key_expired`.

Modes: "objects in one mode aren't accessible to the other". Config
`liveMode` (boolean, default `false`) picks which CLI key to borrow; a pasted
key carries its own mode. `livemode` is on every object, so items and outputs
keep it.

## Versioning

Send `Stripe-Version: 2026-08-26.dahlia` on every request, the version these
shapes were read from. Without the header "requests made with curl use your
Stripe account's default API version", which differs per account.

## Rate limits

Per account, per second: live 100 requests, sandbox 25; individual endpoints
25. Over the limit Stripe answers `429 Too Many Requests` with a
`Stripe-Rate-Limited-Reason` header (`global-rate`, `endpoint-rate`,
`global-concurrency`, `endpoint-concurrency`, `resource-specific`). A 429
with `code: lock_timeout` and no such header is a lock, not a limit, and is
retried the same way. The docs ask for "an exponential backoff schedule" with
jitter; no `Retry-After` header is documented. The connector retries a 429
and a 5xx twice with jittered backoff and then throws.

Reads are also allocated: "must not exceed an average of 500 per transaction"
over 30 days, minimum 10,000 per month. Every poll uses the `created` filter
and stops paging at the cursor, so a quiet account costs one request per
trigger per poll.

## Pagination and the created filter

`limit` is 1 to 100, default 10. Lists come back "in reverse chronological
order"; `starting_after=<last id>` fetches the next page and `has_more: false`
ends it. The `created` filter takes `gt`, `gte`, `lt`, `lte` as integer Unix
seconds. Every poll below walks pages with `starting_after` while `has_more`
is true, at most 10 pages, and reverses the result so the workflow sees the
oldest item first.

## Triggers

All poll. Amounts everywhere are integers in the currency's smallest unit
(`1099` is 10.99 USD, `500` is 500 JPY); the connector never divides.

### `newCustomer` — a customer was created

- **Poll:** `GET /v1/customers?created[gte]=<cursor>&limit=100`.
- **Cursor:** the largest `created` seen. Sent as `gte`, not `gt`: `created`
  has one-second resolution, so `gt` would drop a customer created in the
  same second as the cursor; the repeat that `gte` allows is absorbed by
  dedupe. With no cursor yet, the first poll starts one hour back.
- **Dedupe key:** `id` (`cus_…`).
- **Config:** none beyond the connection.
- **Sample item** (`data` is the customer as returned):

```json
{
  "externalId": "cus_NffrFeUfNV2Hib",
  "title": "Jenny Rosen <jennyrosen@example.com>",
  "url": "https://dashboard.stripe.com/test/customers/cus_NffrFeUfNV2Hib",
  "updatedAt": "2023-04-07T19:39:53.000Z",
  "data": {
    "id": "cus_NffrFeUfNV2Hib",
    "object": "customer",
    "created": 1680893993,
    "email": "jennyrosen@example.com",
    "name": "Jenny Rosen",
    "description": null,
    "phone": null,
    "currency": null,
    "balance": 0,
    "delinquent": false,
    "metadata": {},
    "livemode": false
  }
}
```

The dashboard URL is `https://dashboard.stripe.com/customers/<id>`, with
`/test` inserted after the host when `livemode` is false.

### `paymentSucceeded` — a payment intent reached `succeeded`

- **Poll:** `GET /v1/payment_intents?created[gte]=<from>&limit=100`, then keep
  `status === "succeeded"`. The list endpoint has no `status` filter (its
  parameters are `created`, `customer`, `limit` and the cursors), so the
  filter is client-side. The Search API can filter on status but "data is
  searchable in less than a minute", "up to an hour behind during outages",
  and "not available to merchants in India", so it is not the poll.
- **Cursor:** the largest `created` among succeeded intents seen. `created`
  is when the intent was made, not when it succeeded, so `from` is the cursor
  minus `lookbackMinutes` (config, default 60): an intent that succeeds later
  than that after creation, as bank debits can, is missed unless the window
  is widened. Dedupe absorbs the re-reads the window causes.
- **Dedupe key:** `id` (`pi_…`).
- **Config:** `lookbackMinutes` (number, optional, default 60).
- **Sample item:**

```json
{
  "externalId": "pi_3MtwBwLkdIwHu7ix28a3tqPa",
  "title": "2000 usd succeeded",
  "url": "https://dashboard.stripe.com/test/payments/pi_3MtwBwLkdIwHu7ix28a3tqPa",
  "status": "succeeded",
  "updatedAt": "2023-04-06T17:41:44.000Z",
  "data": {
    "id": "pi_3MtwBwLkdIwHu7ix28a3tqPa",
    "object": "payment_intent",
    "amount": 2000,
    "amount_received": 2000,
    "currency": "usd",
    "status": "succeeded",
    "created": 1680800504,
    "customer": null,
    "latest_charge": "ch_3MtwBwLkdIwHu7ix0snN0B15",
    "description": null,
    "receipt_email": null,
    "metadata": {},
    "livemode": false
  }
}
```

### `invoicePaid` — an invoice became `paid`

- **Poll:** `GET /v1/invoices?status=paid&created[gte]=<from>&limit=100`.
  `status` is a documented list filter: one of `draft`, `open`, `paid`,
  `uncollectible`, `void`.
- **Cursor:** the largest `status_transitions.paid_at` seen. Invoices are
  created before they are paid, so `from` is the cursor minus
  `lookbackMinutes` (default 60), and an invoice is emitted only when
  `paid_at >= cursor`.
- **Dedupe key:** `${id}:paid`.
- **Config:** `lookbackMinutes` (number, optional, default 60), `customer`
  (string, optional; passed through as the `customer` filter).
- **Sample item:**

```json
{
  "externalId": "in_1MtHbELkdIwHu7ixl4OzzPMv",
  "title": "Invoice F1B2C3D-0001 paid: 4900 usd",
  "url": "https://dashboard.stripe.com/test/invoices/in_1MtHbELkdIwHu7ixl4OzzPMv",
  "status": "paid",
  "updatedAt": "2023-04-04T22:31:07.000Z",
  "data": {
    "id": "in_1MtHbELkdIwHu7ixl4OzzPMv",
    "object": "invoice",
    "number": "F1B2C3D-0001",
    "status": "paid",
    "customer": "cus_NeZwdNtLEOXuvB",
    "customer_email": "jennyrosen@example.com",
    "customer_name": "Jenny Rosen",
    "amount_due": 4900,
    "amount_paid": 4900,
    "amount_remaining": 0,
    "currency": "usd",
    "created": 1680644467,
    "status_transitions": { "finalized_at": 1680644467, "paid_at": 1680644467, "marked_uncollectible_at": null, "voided_at": null },
    "hosted_invoice_url": "https://invoice.stripe.com/i/acct_1/test_…",
    "collection_method": "charge_automatically",
    "billing_reason": "subscription_cycle",
    "livemode": false
  }
}
```

### `invoicePaymentFailed` — a payment attempt on an open invoice failed

There is no `failed` invoice status. The object page: an attempt failing
leaves the invoice `open`; `attempted` is "whether an attempt has been made to
pay the invoice"; `attempt_count` counts attempts "from the perspective of the
payment retry schedule ... subsequently only automatic retries increment the
attempt count"; `next_payment_attempt` is "the time at which payment will next
be attempted", null once retries are exhausted or for `send_invoice`.

- **Poll:** `GET /v1/invoices?status=open&created[gte]=<from>&limit=100`, then
  keep `attempted === true && attempt_count > 0 && amount_remaining > 0`.
- **Cursor:** none Stripe can give; `from` is now minus `lookbackMinutes`
  (default 1440, a day, because retries are days apart) and dedupe carries
  the state.
- **Dedupe key:** `${id}:failed:${attempt_count}`, so each failed retry fires
  once and a succeeding retry stops the series (the invoice leaves `open`).
- **Config:** `lookbackMinutes` (number, optional, default 1440), `customer`
  (string, optional).
- **Sample item:** as `invoicePaid` with `status: "open"`, `amount_paid: 0`,
  `amount_remaining: 4900`, `attempted: true`, `attempt_count: 2`,
  `next_payment_attempt: 1681249267`, `paid_at: null`, and title
  `Invoice F1B2C3D-0001 payment failed (attempt 2): 4900 usd`.

## Actions

Every action sends `Authorization: Bearer <key>` and `Stripe-Version`, and
throws `<type>/<code>: <message> (<Request-Id>)` on a non-2xx answer. Every
`POST` also sends `Idempotency-Key`, see below.

### `createCustomer` — create a customer

`POST /v1/customers`, form-encoded. Not idempotent in Stripe's sense (two calls
with different keys make two customers), made retry-safe by the header.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `email` | string | no | Up to 512 characters, shown in the dashboard |
| `name` | string | no | Full or business name, up to 256 characters |
| `description` | string | no | Free text shown alongside the customer |
| `metadata` | string | no | A JSON object of string values, sent as `metadata[key]=value`; up to 50 keys, 40-character keys, 500-character values, no square brackets in keys |

Outputs: `id`, `email`, `name`, `description`, `created` (ISO), `metadata`,
`livemode`, `url` (dashboard).

### `getCustomer` — get a customer

`GET /v1/customers/:id`. Idempotent. A deleted customer returns "a subset of
the customer's information ... including a `deleted` property that's set to
true"; an unknown id answers 404 `resource_missing`.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `customer` | string | yes | Customer id such as `cus_NffrFeUfNV2Hib` |

Outputs: `id`, `email`, `name`, `description`, `phone`, `currency`, `balance`,
`delinquent`, `created`, `metadata`, `deleted`, `livemode`, `url`.

Live sample: `{ "customer": "$STRIPE_CUSTOMER_ID" }`, a placeholder the live
check fills from the environment.

### `listCharges` — list recent charges

`GET /v1/charges?limit=<n>`, newest first. Idempotent.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | number | no | 1 to 100, default 10 |
| `customer` | string | no | Only this customer's charges |
| `startingAfter` | string | no | A charge id from an earlier page |

Outputs: `charges` (array of `{ id, amount, amountRefunded, currency, status,
paid, refunded, captured, customer, paymentIntent, description, receiptUrl,
failureCode, failureMessage, created, livemode }`), `hasMore`.

Live sample: `{ "limit": 5 }`.

### `createRefund` — refund a payment

`POST /v1/refunds` with `payment_intent` or `charge` ("you must specify a
Charge or a PaymentIntent"), optional `amount` and `reason`. Not idempotent:
a second call on a fully refunded charge answers `charge_already_refunded`,
and refunding more than remains raises an error. The header makes a retry of
the same inputs return the first refund.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `paymentIntent` | string | one of the two | `pi_…` to refund |
| `charge` | string | one of the two | `ch_…` to refund |
| `amount` | number | no | Integer in the smallest currency unit (`1099` is 10.99 USD, `500` is 500 JPY); omitted refunds the remaining amount |
| `reason` | string | no | `duplicate`, `fraudulent` or `requested_by_customer`; `fraudulent` adds the card to the block list |

Outputs: `id`, `amount`, `currency`, `status` (`pending`, `requires_action`,
`succeeded`, `failed`, `canceled`), `charge`, `paymentIntent`, `reason`,
`failureReason`, `created`.

### `getBalance` — retrieve the account balance

`GET /v1/balance`. Idempotent, no inputs. "Retrieves the current account
balance, based on the authentication that was used to make the request."

Outputs: `available` and `pending` (arrays of `{ amount, currency,
sourceTypes }`), `connectReserved` (array of `{ amount, currency }`),
`livemode`. Amounts are smallest-unit integers.

Live sample: `{}`.

### `listCustomers` — list customers

`GET /v1/customers?limit=<n>[&email=<email>]`, newest first. `email` is "a
case-sensitive filter ... with only that exact email address". Idempotent.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | number | no | 1 to 100, default 10 |
| `email` | string | no | Exact, case-sensitive match |
| `startingAfter` | string | no | A customer id from an earlier page |

Outputs: `customers` (array of `{ id, email, name, description, phone,
currency, balance, delinquent, created, metadata, livemode }`), `hasMore`.

Live sample: `{ "limit": 5 }`.

## Idempotency keys

"All `POST` requests accept idempotency keys"; they are "up to 255 characters
long"; Stripe "saves the resulting status code and body of the first request
made for any given idempotency key" and replays it for the same key, errors
with `idempotency_error` (HTTP 409 ... "using the same idempotent key") when
the parameters differ, and prunes keys "after they're at least 24 hours old".
"Avoid using sensitive data (for example, email addresses ...) as idempotency
keys."

The connector derives the key as the SHA-256 hex (64 characters) of the action
name and the canonical JSON of the step's inputs, keys sorted. Nothing
sensitive appears in the header; identical inputs within 24 hours get the
first answer back instead of a second customer or refund, and after 24 hours
they create again, which the README states. Never sent on `GET`.

## Checks

From the repository root, with the package built:

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/stripe/dist/index.js --mock --receipt packages/stripe/verified.json
```

`scripts/check.sh` runs exactly this, calling the CLI by its real path
because a linked `node_modules` defeats its entry-point guard. Tests make no
network calls and never spawn `stripe`; the token source takes an injected
runner.

## Live checks

`scripts/check-live.sh` exits 0 with a note when `STRIPE_API_KEY` is unset
and no `stripe` CLI profile can lend a test key. It refuses a live key
(`sk_live_`, `rk_live_`) outright. With a test key it calls `GET /v1/balance`,
`GET /v1/customers?limit=5`, `GET /v1/charges?limit=5`,
`GET /v1/customers/$STRIPE_CUSTOMER_ID` when that is set, then
`vorn-connector check --live`.

| Env | Required | Used by |
| --- | --- | --- |
| `STRIPE_API_KEY` | yes, or a `stripe login` profile | every call |
| `STRIPE_CUSTOMER_ID` | no | `getCustomer`; skipped when unset |

Nothing is created or refunded: the live check touches only idempotent,
read-only endpoints. `stripe sandbox create --email <you>` yields a sandbox
with a key for exactly this.

## Dependencies

None at runtime. `fetch`, `URLSearchParams` and `node:crypto` cover the
client, the form encoding and the idempotency hash; TOML parsing for the
borrow is one table and a handful of `key = "value"` lines, not worth a
library. The official `stripe` npm package is a full SDK of every resource
and is not inlined.

## Icon

Stripe's mark is a bold, slightly italic capital **S** in white on a
blurple (`#635BFF`) rounded square. A single-colour SVG carries the S alone:
in a 24-unit viewBox, a stroke about 4.5 units thick that starts at the top
right as a tail curving left across the top, sweeps down the left side into
a tight lower-left bowl, crosses the middle diagonally from lower-left to
upper-right, and ends at the bottom left as a tail after a matching bowl on
the right. The top and bottom terminals are cut nearly horizontal, the two
counters are asymmetric (the lower one larger), and the whole glyph fills the
box from roughly x 3.7 to 20.6 and y 0 to 24. Fill only, `fill-rule: nonzero`,
one path.

## Docs

The only source.

- API reference index: https://docs.stripe.com/api
- Authentication: https://docs.stripe.com/api/authentication
- Errors: https://docs.stripe.com/api/errors
- Error codes: https://docs.stripe.com/error-codes
- Error handling: https://docs.stripe.com/error-handling
- Rate limits: https://docs.stripe.com/rate-limits
- Pagination: https://docs.stripe.com/api/pagination
- Idempotent requests: https://docs.stripe.com/api/idempotent_requests
- Request IDs: https://docs.stripe.com/api/request_ids
- Versioning: https://docs.stripe.com/api/versioning
- Metadata: https://docs.stripe.com/api/metadata
- Currencies and smallest units: https://docs.stripe.com/currencies
- Customers: https://docs.stripe.com/api/customers (create, retrieve, list)
- Charges: https://docs.stripe.com/api/charges (object, list)
- PaymentIntents: https://docs.stripe.com/api/payment_intents (object, list, search)
- Invoices: https://docs.stripe.com/api/invoices (object, list, retrieve)
- Refunds: https://docs.stripe.com/api/refunds (object, create)
- Balance: https://docs.stripe.com/api/balance/balance_retrieve
- Event types (what "paid" and "payment failed" mean): https://docs.stripe.com/api/events/types
- API keys: https://docs.stripe.com/keys
- Restricted API keys: https://docs.stripe.com/keys/restricted-api-keys
- Stripe CLI: https://docs.stripe.com/stripe-cli and the reference https://docs.stripe.com/cli
- CLI login: https://docs.stripe.com/cli/login
- CLI login list: https://docs.stripe.com/cli/login/list
- CLI config: https://docs.stripe.com/cli/config
- CLI API keys and env variables: https://docs.stripe.com/cli/api_keys
- CLI sandbox: https://docs.stripe.com/cli/sandbox
