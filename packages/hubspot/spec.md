id: hubspot

# HubSpot connector

HubSpot's CRM API at `https://api.hubapi.com`. Every request is HTTPS with a
JSON body and a JSON answer. A CRM record is
`{ id, properties, createdAt, updatedAt, archived }`: `id` is a numeric string
(the `hs_object_id` property), `properties` is a flat map of string values
(numbers, dates and enumerations are all strings, `amount` is `"1500.00"`,
dates are ISO 8601 instants such as `2019-12-07T16:50:06.678Z`), and
`createdAt`/`updatedAt` are ISO instants. Object types in paths are the plural
names `contacts`, `companies`, `deals`, `notes`, whose object type ids are
`0-1`, `0-2`, `0-3` and `0-46`; the associations API also accepts the singular
`contact`, `company`, `deal`, `note`. Lists are `{ results: [...], paging?: {
next: { after, link } } }`.

An error body is `{ status: "error", message, category, correlationId,
errors?: [{ message, code?, in?, context? }], context?, links? }`; every
field "should be treated as optional". Categories worth naming: `VALIDATION_ERROR`
(400), `MISSING_SCOPES` (403), `OBJECT_NOT_FOUND` (404), `CONFLICT` (409),
`RATE_LIMITS` (429). Creating a contact whose email exists answers 409 with
`message: "Contact already exists. Existing ID: <id>"`. The connector throws
`<category>: <message> (<correlationId>)` on every non-2xx answer, and adds the
HTTP status. A 429 body from the usage-details page also carries `errorType:
"RATE_LIMIT"` and `policyName` (`DAILY` or `SECONDLY`), which the thrown
message keeps when present.

**Paths and versions.** HubSpot introduced date-based versioning in 2026: the
search and associations pages now document `/crm/objects/2026-03/{object}/search`
and `/crm/objects/2026-03/{from}/{id}/associations/default/{to}/{toId}`, "based
on the latest v3 or v4 APIs", with the same bodies and answers. "Current v4
APIs will be supported until March 2027" and "current v1-v3 APIs will continue
to work as well, with the support timeline to be announced at a later date".
The contacts, deals, companies, notes, pipelines and owners pages still show
`/crm/v3/...`. This connector uses the v3 object, search, pipelines and owners
paths and the v4 default-association path exactly as the workflow spec names
them, holds the three prefixes (`/crm/v3/objects`, `/crm/v3`, `/crm/v4/objects`)
in one constant each so develop can move to the dated form in one place, and
the README says which paths are sent.

Package: `@vornrun/connector-hubspot` in `packages/hubspot`, shaped like the
existing packages: scoped name, tsup, `vitest.config.ts` re-exporting
`vitest.shared.ts`, `CHANGELOG.md`, `README.md` with the links from the Docs
section, `verified.json` from `vorn-connector check --mock`, category
`Productivity` (the closest existing category; there is no Sales one yet),
`packs: true`.

## Auth

Rung: **`key`**. HubSpot has a CLI (`hs`, for CMS and developer projects) but
it is not one most developers sign in to, and it does not lend a CRM token.
The connection takes a private app access token, as the airtable connector
takes a personal access token.

| Config field | Env name | Where it comes from |
| --- | --- | --- |
| `accessToken` (secret, required) | `HUBSPOT_ACCESS_TOKEN` | The account's Settings, Integrations, Private Apps (the docs now call this Development, then Legacy apps: "Create legacy app", then "Private"); on the app's Auth tab, "click Show token to reveal your access token" |

Sent as `Authorization: Bearer <token>` on every request: "set the value of
the Authorization field to Bearer [YOUR_TOKEN]". Declare
`auth: { rung: 'key', keys: ['accessToken'] }`. An account holds "up to 20
private apps". A revoked or wrong token answers 401; a token missing a scope
answers 403 `MISSING_SCOPES`, and the connector surfaces the message verbatim.
If the user who created the app is removed, "some API calls ... will fail with
a result of USER_DOES_NOT_HAVE_PERMISSIONS": the README says to recreate the
app under a lasting user.

Scopes the private app needs, with the doc text for each, added under the
app's Scopes tab ("click Add new scope"):

| Scope | Doc text | Needed by |
| --- | --- | --- |
| `crm.objects.contacts.read` | "View properties and other details about contacts." | `newContact`, `getContact`, `searchContacts`, `createNote`, `associate` |
| `crm.objects.contacts.write` | "View properties and create, delete, and make changes to contacts." | `createContact`, `updateContact`, `createNote` (the notes page lists the contacts scopes) |
| `crm.objects.companies.read` | "View properties and other details about companies." | `newCompany`, `associate` |
| `crm.objects.companies.write` | "View properties and create, delete, or make changes to companies." | `createCompany` |
| `crm.objects.deals.read` | "View properties and other details about deals." | `newDeal`, `dealStageChanged`, `associate` |
| `crm.objects.deals.write` | "View properties and create, delete, or make changes to deals." | `createDeal`, `updateDeal` |
| `crm.objects.owners.read` | "View details about users assigned to a CRM record." | `listOwners` |
| `crm.schemas.deals.read` | "View details about property settings for deals." | `listDealPipelines` (the pipelines page accepts this one among many; `crm.objects.deals.read` is also on its list) |

The write scopes imply the reads for the same object in practice, but the
README lists all eight so the app is created once.

## Rate limits

Private apps, per the usage-details page: **100 requests per 10 seconds per
app** on Free and Starter, 190 on Professional and Enterprise (250 with the
API Limit Increase add-on), and 250,000 / 625,000 / 1,000,000 requests per
day per account by tier. Response headers:

| Header | Meaning |
| --- | --- |
| `X-HubSpot-RateLimit-Max` | "The number of requests allowed in the window" |
| `X-HubSpot-RateLimit-Remaining` | Remaining requests in the current window |
| `X-HubSpot-RateLimit-Interval-Milliseconds` | "The window of time that the X-HubSpot-RateLimit-Max and X-HubSpot-RateLimit-Remaining headers apply to" |
| `X-HubSpot-RateLimit-Daily`, `-Daily-Remaining` | The daily allowance and what is left |

`X-HubSpot-RateLimit-Secondly` and `-Secondly-Remaining` "should be
considered deprecated". "Responses from the search API endpoints will not
include any of the rate limit headers", and the search endpoints are "rate
limited to five requests per second per account".

Over a limit HubSpot answers 429 with `category: RATE_LIMITS`; "the message
and policyName will indicate which limit you hit (either daily or secondly)".
The error-handling page: "respect the Retry-After header if present. Note
that the Retry-After value is in milliseconds." The connector reads
`X-HubSpot-RateLimit-Remaining` on every answer and, when it reaches 0, waits
the remainder of `X-HubSpot-RateLimit-Interval-Milliseconds` before the next
call; on a 429 it retries once after `Retry-After` milliseconds (capped at 30
seconds) or one second when the header is absent, and throws a second 429 with
`policyName` in the message. A `DAILY` 429 is thrown without retry. 5xx answers
are retried once after a short jittered wait.

## Search and pagination

`POST /crm/v3/objects/{object}/search` with body `{ query?, filterGroups?,
sorts?, properties?, limit?, after? }`.

- `filterGroups` is at most 5 groups of at most 6 filters (18 filters in
  all); filters in a group are ANDed, groups are ORed. A filter is
  `{ propertyName, operator, value?, highValue?, values? }` with operators
  `LT, LTE, GT, GTE, EQ, NEQ, BETWEEN, IN, NOT_IN, HAS_PROPERTY,
  NOT_HAS_PROPERTY, CONTAINS_TOKEN, NOT_CONTAINS_TOKEN`; `highValue` is for
  `BETWEEN`, `values` for `IN`/`NOT_IN`.
- Date and datetime values are **epoch milliseconds as strings**, the docs'
  example being `"value": "1579514400000"` on `hs_lastmodifieddate`.
- `sorts` takes one rule: "Only one sorting rule can be applied to any
  search", `[{ propertyName, direction: "ASCENDING" | "DESCENDING" }]`.
  Without a sort, results come back by creation date, oldest first.
- `limit` defaults to 10, at most 200; `after` "must format the value ... as
  an integer" and comes back as `paging.next.after`, a numeric string. "The
  search endpoints are limited to 10,000 total results for any given query.
  Attempting to page beyond 10,000 will result in a 400 error." The answer is
  `{ total, results, paging? }`.
- `query` matches the object's default searchable text properties (contacts:
  `firstname`, `lastname`, `email`, `phone`, `mobilephone`, `company`,
  `hs_additional_emails`, `fax`; companies: `name`, `domain`, `website`,
  `phone`; deals: `dealname`, `pipeline`, `dealstage`), at most 3,000
  characters. Archived objects are excluded.
- "It may take a few moments for newly created or updated CRM objects to
  appear in search results", so a poll uses `GTE` on the cursor and dedupe
  absorbs the repeat, and the cursor is never advanced past `now` minus a
  short indexing margin (30 seconds).

Default properties returned when none are requested: contacts `createdate`,
`email`, `firstname`, `lastname`, `hs_object_id`, `lastmodifieddate`; deals
`dealname`, `amount`, `closedate`, `pipeline`, `dealstage`, `createdate`,
`hs_lastmodifieddate`, `hubspot_owner_id`; companies `name`, `domain`,
`createdate`, `hs_lastmodifieddate`, `hs_object_id`. Every trigger and read
asks for those explicitly plus `hs_object_id`, and `phone`, `company`,
`lifecyclestage` on contacts, and lets config add more.

## Triggers

All poll the search endpoint, sorted `ASCENDING` on the cursor property,
`limit` 100, following `paging.next.after` for at most 10 pages per poll. Each
trigger has an optional `properties` config (comma-separated extra property
names to fetch). With no cursor yet, the first poll starts one hour back. The
record URL is `https://app.hubspot.com/contacts/{portalId}/record/{objectTypeId}/{id}`;
`portalId` is not in any answer the connector makes, so an optional `portalId`
config (the number in the account's URL) fills it, and the item has no `url`
when it is unset.

### `newContact` — a contact was created

- **Poll:** `POST /crm/v3/objects/contacts/search` with
  `filterGroups: [{ filters: [{ propertyName: "createdate", operator: "GTE", value: "<cursor ms>" }] }]`,
  `sorts: [{ propertyName: "createdate", direction: "ASCENDING" }]`.
- **Cursor:** the newest `createdate` seen, as epoch milliseconds.
- **Dedupe key:** `id`.
- **Sample item** (`data` is the record as returned):

```json
{
  "externalId": "33451",
  "title": "Lorelai Gilmore <lorelai@thedragonfly.com>",
  "url": "https://app.hubspot.com/contacts/<portalId>/record/0-1/33451",
  "updatedAt": "2022-06-01T14:31:48.469Z",
  "data": {
    "id": "33451",
    "properties": {
      "createdate": "2022-06-01T14:31:48.469Z",
      "email": "lorelai@thedragonfly.com",
      "firstname": "Lorelai",
      "lastname": "Gilmore",
      "phone": null,
      "company": null,
      "lifecyclestage": "lead",
      "hs_object_id": "33451",
      "lastmodifieddate": "2025-07-07T20:27:17.947Z"
    },
    "createdAt": "2022-06-01T14:31:48.469Z",
    "updatedAt": "2025-07-07T20:27:17.947Z",
    "archived": false
  }
}
```

### `newDeal` — a deal was created

- **Poll:** the same on `/crm/v3/objects/deals/search`, `createdate GTE`
  cursor, ascending. Optional config `pipeline` adds
  `{ propertyName: "pipeline", operator: "EQ", value }` to the group.
- **Cursor:** the newest `createdate` seen. **Dedupe key:** `id`.
- **Sample item:**

```json
{
  "externalId": "21678228008",
  "title": "New deal (contractsent, 1500.00)",
  "url": "https://app.hubspot.com/contacts/<portalId>/record/0-3/21678228008",
  "updatedAt": "2019-12-07T16:50:06.678Z",
  "data": {
    "id": "21678228008",
    "properties": {
      "dealname": "New deal",
      "amount": "1500.00",
      "closedate": "2019-12-07T16:50:06.678Z",
      "pipeline": "default",
      "dealstage": "contractsent",
      "hubspot_owner_id": "910901",
      "createdate": "2019-12-07T16:50:06.678Z",
      "hs_lastmodifieddate": "2019-12-07T16:50:06.678Z",
      "hs_object_id": "21678228008"
    },
    "createdAt": "2019-12-07T16:50:06.678Z",
    "updatedAt": "2019-12-07T16:50:06.678Z",
    "archived": false
  }
}
```

### `newCompany` — a company was created

- **Poll:** the same on `/crm/v3/objects/companies/search`.
- **Cursor:** the newest `createdate` seen. **Dedupe key:** `id`.
- **Sample item:** as above with `"title": "HubSpot (hubspot.com)"`, url
  `.../record/0-2/<id>` and properties `name`, `domain`, `createdate`,
  `hs_lastmodifieddate`, `hs_object_id`.

### `dealStageChanged` — a deal moved to a stage

- **Poll:** `/crm/v3/objects/deals/search` with `hs_lastmodifieddate GTE`
  cursor, sorted ascending on `hs_lastmodifieddate`. Config `pipeline`
  (string, optional) and `dealstage` (string, optional, a stage id such as
  `closedwon` or a numeric custom stage id) add `EQ` filters to the same
  group. Any edit bumps `hs_lastmodifieddate`, so the dedupe key carries the
  stage: a deal edited without a stage change is read again and dropped.
- **Cursor:** the newest `hs_lastmodifieddate` seen.
- **Dedupe key:** `${id}:${dealstage}`. A deal that returns to an earlier
  stage it already fired for does not fire again; the README says so.
- **Sample item:** the `newDeal` sample with `"title": "New deal moved to
  contractsent"`, `status: "contractsent"` and `updatedAt` from
  `hs_lastmodifieddate`.

## Actions

Every action sends `Authorization: Bearer <token>` and
`Content-Type: application/json`, and throws `<category>: <message>
(<correlationId>)` on a non-2xx answer. "Properties as JSON" inputs are a
JSON object string of property name to value; values are sent as strings
(numbers and booleans stringified), because HubSpot stores every property as
a string. Every create and update answers the full record, and the outputs
below are `id`, `properties`, `createdAt`, `updatedAt`, `archived` unless
noted.

### `createContact` — create a contact

`POST /crm/v3/objects/contacts` with `{ properties }`. Not idempotent: a
repeat answers 409 `Contact already exists. Existing ID: <id>`, which the
thrown message carries so a workflow can pick the id out.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `email` | string | yes | "the primary unique identifier to avoid duplicate contacts" |
| `firstname` | string | no | First name |
| `lastname` | string | no | Last name |
| `phone` | string | no | Phone number |
| `company` | string | no | Company name property on the contact (not an association) |
| `properties` | string | no | JSON object of extra properties, merged under the named ones |

### `updateContact` — update a contact

`PATCH /crm/v3/objects/contacts/{contactId}` with `{ properties }`. Setting
the same values twice is harmless, but the mock check sends placeholders, so
it is declared not idempotent and excluded from the live check.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `contactId` | string | yes | Record id such as `33451` |
| `properties` | string | yes | JSON object of properties to set |

### `createDeal` — create a deal

`POST /crm/v3/objects/deals`. "You should include ... dealname, dealstage,
and if you have multiple pipelines, pipeline. If a pipeline isn't specified,
the default pipeline will be used." Not idempotent: deals have no unique
property, every call makes one.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `dealname` | string | yes | Deal name |
| `dealstage` | string | yes | Stage id from `listDealPipelines` (`appointmentscheduled`, `contractsent`, `closedwon` in the default pipeline; custom stages are numeric) |
| `pipeline` | string | no | Pipeline id, default `default` |
| `amount` | number | no | Sent as a decimal string such as `1500.00` |
| `closedate` | string | no | ISO 8601 instant, `2019-12-07T16:50:06.678Z` |
| `ownerId` | string | no | `hubspot_owner_id`, the `id` (not `userId`) from `listOwners` |
| `properties` | string | no | JSON object of extra properties |

### `updateDeal` — update a deal

`PATCH /crm/v3/objects/deals/{dealId}` with `{ properties }`. Not idempotent
for the same reason as `updateContact`.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `dealId` | string | yes | Record id |
| `properties` | string | yes | JSON object of properties to set, such as `{"dealstage":"closedwon"}` |

### `createCompany` — create a company

`POST /crm/v3/objects/companies`; "at least one of the following properties
... name or domain", and "domain names are the primary unique identifier to
avoid duplicate companies". Not idempotent.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Company name |
| `domain` | string | no | Website domain such as `hubspot.com` |
| `properties` | string | no | JSON object of extra properties |

### `createNote` — add a note to a record

`POST /crm/v3/objects/notes` with `{ properties: { hs_timestamp, hs_note_body,
hubspot_owner_id? }, associations: [{ to: { id }, types: [{
associationCategory: "HUBSPOT_DEFINED", associationTypeId }] }] }`.
`hs_timestamp` is "Required. This field marks the note's time of creation",
"either a Unix timestamp in milliseconds or UTC format"; the connector sends
the current instant. `hs_note_body` is "limited to 65,536 characters". Not
idempotent.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `objectType` | string | yes | `contact`, `company` or `deal` |
| `objectId` | string | yes | Record id to attach the note to |
| `body` | string | yes | Note text, up to 65,536 characters |
| `ownerId` | string | no | `hubspot_owner_id` |

The association type id comes from the object type: note to contact `202`,
note to company `190`, note to deal `214`. Outputs: `id`, `properties`
(`hs_note_body`, `hs_timestamp`, `hs_object_id`, `hs_lastmodifieddate`),
`createdAt`, `updatedAt`, `archived`.

### `associate` — associate two records

`PUT /crm/v4/objects/{fromObjectType}/{fromObjectId}/associations/default/{toObjectType}/{toObjectId}`
with no body sets "an individual default association between two records";
the object types are `contact`, `company`, `deal` or `note` (or a type id).
When `associationTypeId` is given the labelled form is used instead:
`PUT /crm/v4/objects/{from}/{id}/associations/{to}/{toId}` with body
`[{ associationCategory: "HUBSPOT_DEFINED", associationTypeId }]`. Idempotent:
a PUT states the association; the docs do not say a repeat errors, and the
develop step confirms it on a sandbox. Default type ids, from the associations
page: contact→company `279` (primary `1`), company→contact `280` (primary
`2`), contact→deal `4`, deal→contact `3`, deal→company `341`, company→deal
`342`, contact→note `201`, company→note `189`, deal→note `213`.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `fromObjectType` | string | yes | `contact`, `company`, `deal` or `note` |
| `fromObjectId` | string | yes | Record id |
| `toObjectType` | string | yes | `contact`, `company`, `deal` or `note` |
| `toObjectId` | string | yes | Record id |
| `associationTypeId` | number | no | A labelled type id; omitted uses the default label |

Outputs: `fromObjectTypeId`, `fromObjectId`, `toObjectTypeId`, `toObjectId`,
`labels`, as in the documented answer
`{ "fromObjectTypeId": "0-1", "fromObjectId": 29851, "toObjectTypeId": "0-3",
"toObjectId": 21678228008, "labels": ["Point of contact"] }`.

Live sample: `{ "fromObjectType": "contact", "fromObjectId":
"$HUBSPOT_CONTACT_ID", "toObjectType": "company", "toObjectId":
"$HUBSPOT_COMPANY_ID" }`, run only when both are set; declared idempotent
with a placeholder sample the mock check accepts.

### `getContact` — get a contact

`GET /crm/v3/objects/contacts/{contactId}?properties=...` or, when the input
looks like an email, `GET /crm/v3/objects/contacts/{email}?idProperty=email`.
Idempotent. An unknown id answers 404 `OBJECT_NOT_FOUND`.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `contactId` | string | yes | Record id, or an email address (looked up with `idProperty=email`) |
| `properties` | string | no | Comma-separated property names; defaults to the standard set |

Live sample: `{ "contactId": "$HUBSPOT_CONTACT_ID" }`, a placeholder the live
check fills; the mock check sends `"1"`.

### `searchContacts` — search contacts

`POST /crm/v3/objects/contacts/search`. Idempotent.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | no | Text matched against the default searchable properties |
| `filterGroups` | string | no | JSON array of filter groups exactly as the search API takes them |
| `properties` | string | no | Comma-separated property names to return |
| `limit` | number | no | 1 to 200, default 10 |
| `after` | string | no | `paging.next.after` from an earlier page |

Outputs: `total`, `contacts` (array of records), `nextAfter`.

Live sample: `{ "query": "test" }`.

### `listDealPipelines` — list deal pipelines and stages

`GET /crm/v3/pipelines/deals`. Idempotent, no inputs. Outputs: `pipelines`,
an array of `{ id, label, displayOrder, archived, createdAt, updatedAt,
stages: [{ id, label, displayOrder, archived, metadata: { probability } }] }`;
the default pipeline has id `default`, and `metadata.probability` is a string
between `0.0` and `1.0`. "Deal ... pipelines can have up to 100 stages."

Live sample: `{}`.

### `listOwners` — list owners

`GET /crm/v3/owners?limit=<n>[&email=<email>][&after=<cursor>][&archived=true]`.
Idempotent. `id` "should be used ... when assigning an owner to a record";
`userId` is for the settings API and "will produce an error" as an owner.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `email` | string | no | Only the owner with this email |
| `limit` | number | no | Page size, default 100 |
| `after` | string | no | `paging.next.after` from an earlier page |
| `archived` | boolean | no | Deactivated users instead of active ones |

Outputs: `owners` (array of `{ id, email, firstName, lastName, userId,
userIdIncludingInactive, type, archived, createdAt, updatedAt, teams: [{ id,
name, primary }] }`), `nextAfter`.

Live sample: `{}`.

## Checks

From the repository root, with the package built:

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/hubspot/dist/index.js --mock --receipt packages/hubspot/verified.json
```

`scripts/check.sh` runs exactly this, calling the CLI by its real path
because a linked `node_modules` defeats its entry-point guard. Tests make no
network calls: the client takes an injected `fetch`. Every action must
survive the mock's `{}` reply and placeholder arguments, so no output is
read without a fallback.

## Live checks

`scripts/check-live.sh` exits 0 with a note when `HUBSPOT_ACCESS_TOKEN` is
unset. With it, the script calls `GET /crm/v3/owners?limit=5`,
`GET /crm/v3/pipelines/deals`, `POST /crm/v3/objects/contacts/search` with
`{ "query": "test", "limit": 5 }`, `GET /crm/v3/objects/contacts/$HUBSPOT_CONTACT_ID`
when that is set, then `vorn-connector check --live`. Nothing is created or
changed.

| Env | Required | Used by |
| --- | --- | --- |
| `HUBSPOT_ACCESS_TOKEN` | yes | every call |
| `HUBSPOT_CONTACT_ID` | no | `getContact`; skipped when unset |
| `HUBSPOT_COMPANY_ID` | no | `associate` together with the contact id; skipped when either is unset |

A free HubSpot account with a private app holding the eight scopes is enough.

## Dependencies

None at runtime. `fetch` and `URLSearchParams` cover the client; the search
bodies are plain JSON. The official `@hubspot/api-client` wraps every product
API and is not inlined.

## Icon

HubSpot's mark is the "sprocket": an orange (`#FF7A59`) hub-and-spoke glyph.
A single-colour SVG in a 24-unit viewBox carries: a ring centred at about
(15, 14) with outer radius 5.2 and inner radius 2.6 (the hub, drawn with
`fill-rule: evenodd` so its centre is open); a straight stroke about 1.8
units wide from the hub's upper-left edge up-left to a small filled circle of
radius 1.6 at about (5.5, 4) (the spoke and its terminal node); a short
stroke of the same width from the hub's lower-left edge down-left to a
filled circle of radius 1.3 at about (7, 21); and a straight stroke from the
hub's left edge to a filled circle of radius 1.3 at about (3, 13.5). One
`<path>`, fill only, `currentColor`.

## Docs

The only source.

- Understanding the CRM: https://developers.hubspot.com/docs/api/crm/understanding-the-crm
- Private apps: https://developers.hubspot.com/docs/api/private-apps
- Scopes: https://developers.hubspot.com/docs/api/scopes
- Usage details and rate limits: https://developers.hubspot.com/docs/api/usage-details
- Error handling: https://developers.hubspot.com/docs/api/error-handling
- Contacts: https://developers.hubspot.com/docs/api/crm/contacts
- Deals: https://developers.hubspot.com/docs/api/crm/deals
- Companies: https://developers.hubspot.com/docs/api/crm/companies
- Search: https://developers.hubspot.com/docs/api/crm/search
- Associations v4: https://developers.hubspot.com/docs/api/crm/associations
- Notes: https://developers.hubspot.com/docs/api/crm/notes
- Pipelines: https://developers.hubspot.com/docs/api/crm/pipelines
- Owners: https://developers.hubspot.com/docs/api/crm/owners
- Date-based API versioning: https://developers.hubspot.com/changelog/introducing-date-based-api-versioning
