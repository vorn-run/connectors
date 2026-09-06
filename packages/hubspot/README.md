# @vornrun/connector-hubspot

Trigger Vorn workflows from contacts, companies and deals created in HubSpot
or from deals moving to a stage, and create, update, search, annotate or
associate CRM records from a workflow step. Talks to the CRM API at
`https://api.hubapi.com`.

## Signing in

Paste a private app access token into the **Private app access token** field.
There is no HubSpot CLI to borrow a CRM login from. Create the app in the
account under Settings, Integrations, Private Apps (newer accounts show it
under Development, Legacy apps, "Create legacy app", then "Private"), add the
scopes below on its Scopes tab, and copy the token from the Auth tab with
"Show token". An account holds up to 20 private apps.

| Scope | Needed by |
| --- | --- |
| `crm.objects.contacts.read` | `newContact`, `getContact`, `searchContacts`, `createNote`, `associate` |
| `crm.objects.contacts.write` | `createContact`, `updateContact`, `createNote` |
| `crm.objects.companies.read` | `newCompany`, `associate` |
| `crm.objects.companies.write` | `createCompany` |
| `crm.objects.deals.read` | `newDeal`, `dealStageChanged`, `associate` |
| `crm.objects.deals.write` | `createDeal`, `updateDeal` |
| `crm.objects.owners.read` | `listOwners` |
| `crm.schemas.deals.read` | `listDealPipelines` |

The token is sent as `Authorization: Bearer` on every call. A wrong or
revoked token answers `401`; a token missing a scope answers `403
MISSING_SCOPES` and the message names the scope. If the user who created the
app is removed from the account, calls start failing with
`USER_DOES_NOT_HAVE_PERMISSIONS`: recreate the app under a lasting user. The
connector surfaces HubSpot's error as `<category>: <message>
(<correlationId>)`, such as `CONFLICT: Contact already exists. Existing ID:
33451 (…)`, together with the HTTP status.

## Settings

| Setting | Environment | Required | What it does |
| --- | --- | --- | --- |
| Private app access token | `HUBSPOT_ACCESS_TOKEN` | yes | Sent as `Authorization: Bearer` on every call |
| Portal id | `HUBSPOT_PORTAL_ID` | no | The account number in the app.hubspot.com URL; with it each item links to its record |
| Extra properties | `HUBSPOT_PROPERTIES` | no | Comma-separated property names every trigger fetches on top of the standard set |
| Deal pipeline | `HUBSPOT_PIPELINE` | no | A pipeline id; `newDeal` and `dealStageChanged` then watch only that pipeline |
| Deal stage | `HUBSPOT_DEAL_STAGE` | no | A stage id; `dealStageChanged` then fires only for deals reaching it |

No API answer carries the portal id, so without it items have no `url`.

## Rate limits

Private apps get 100 requests per 10 seconds on Free and Starter, 190 on
Professional and Enterprise, and a daily allowance by tier. The connector reads
`X-HubSpot-RateLimit-Remaining` on every answer and, when it reaches 0, waits
out `X-HubSpot-RateLimit-Interval-Milliseconds` before the next call. On a
`429` it waits `Retry-After` (milliseconds, capped at 30 seconds) or one second
and sends once more; a second `429` is reported with the `policyName`. A
`429` for the `DAILY` policy is reported at once, since it does not come back
in a second. A `5xx` is retried once after a short wait on reads and on the
`PUT` and `PATCH` calls, never on a create, because a create that timed out
may have landed.

The search endpoints carry no rate-limit headers and are limited to five
requests per second per account; each poll makes at most ten of them.

## Paths

HubSpot introduced date-based versioning in 2026. This connector sends the
current paths: `/crm/v3/objects/{object}` and `.../search`,
`/crm/v3/pipelines/deals`, `/crm/v3/owners`, and
`/crm/v4/objects/{from}/{id}/associations/...`. The three prefixes are held in
one constant each in `src/client.ts`, so a move to the dated form is one edit.

## Triggers

All four poll `POST /crm/v3/objects/{object}/search`, sorted ascending on the
cursor property, 100 per page, following `paging.next.after` for at most ten
pages per poll, and deliver oldest first. Date filters are sent as epoch
milliseconds, as the search API takes them. The first poll starts one hour
back. Because "it may take a few moments for newly created or updated CRM
objects to appear in search results", a record stamped within the last 30
seconds is left for the next poll, so the watermark never passes what search
has not shown yet.

Each item's `data` carries the record as returned: `id`, `properties`,
`createdAt`, `updatedAt`, `archived`. The properties fetched are HubSpot's
defaults for the object plus `hs_object_id`, and on contacts `phone`,
`company` and `lifecyclestage`; **Extra properties** adds more.

### `newContact` — a contact is created

Filters on `createdate GTE <watermark>` and dedupes on the record id with
`createdate` as the item's time. The title is `First Last <email>`.

### `newDeal` — a deal is created

The same on deals, with `pipeline EQ` added when **Deal pipeline** is set.
The title is `Deal name (stage, amount)`.

### `newCompany` — a company is created

The same on companies. The title is `Name (domain)`.

### `dealStageChanged` — a deal moves to a stage

Searches deals by `hs_lastmodifieddate` over the last hour, with `pipeline EQ`
and `dealstage EQ` added from the settings. Any edit bumps
`hs_lastmodifieddate`, so the item id is `<dealId>:<dealstage>` and carries no
time of its own: the SDK remembers the ids it delivered, a deal edited without
a stage change is read again and dropped, and a deal reaching a new stage fires
once for it. A deal that returns to a stage it already fired for does not fire
again. The id set is capped at 500; in an account with more stage changes than
that per hour an old stage can fire a second time.

## Actions

"Properties as JSON" inputs are a JSON object of internal property name to
value; values are sent as strings, because HubSpot stores every property as
one. Every create and update answers the full record: `id`, `properties`,
`createdAt`, `updatedAt`, `archived`.

| Action | Idempotent | What it does |
| --- | --- | --- |
| `createContact` | no | `POST /crm/v3/objects/contacts` with `email` and optional `firstname`, `lastname`, `phone`, `company` and extra `properties`. A duplicate email answers `409` with the existing id in the message. |
| `updateContact` | no | `PATCH /crm/v3/objects/contacts/{contactId}` with `properties`. |
| `createDeal` | no | `POST /crm/v3/objects/deals` with `dealname`, `dealstage` and optional `pipeline`, `amount`, `closedate`, `ownerId` and extra `properties`. Every call makes a deal. |
| `updateDeal` | no | `PATCH /crm/v3/objects/deals/{dealId}` with `properties`, such as `{"dealstage":"closedwon"}`. |
| `createCompany` | no | `POST /crm/v3/objects/companies` with `name` and optional `domain` and extra `properties`. |
| `createNote` | no | `POST /crm/v3/objects/notes` with `body` as `hs_note_body`, the current instant as `hs_timestamp`, optional `ownerId`, and the association to the `objectType` (`contact`, `company` or `deal`) and `objectId`. |
| `associate` | yes | `PUT /crm/v4/objects/{from}/{id}/associations/default/{to}/{toId}`, or the labelled form with `associationTypeId`. Returns `fromObjectTypeId`, `fromObjectId`, `toObjectTypeId`, `toObjectId`, `labels`. |
| `getContact` | yes | `GET /crm/v3/objects/contacts/{contactId}`, or `?idProperty=email` when the input holds an `@`. Optional `properties` names what to return. |
| `searchContacts` | yes | `POST /crm/v3/objects/contacts/search` with optional `query`, `filterGroups`, `properties`, `limit` (1 to 200) and `after`, one page. Returns `total`, `contacts`, `nextAfter`. |
| `listDealPipelines` | yes | `GET /crm/v3/pipelines/deals`. Returns `pipelines` with their `stages`. |
| `listOwners` | yes | `GET /crm/v3/owners` with optional `email`, `limit`, `after`, `archived`. Returns `owners` and `paging`; assign records by an owner's `id`, never its `userId`. |

The note association type ids are 202 to a contact, 190 to a company and 214
to a deal. The default association labels are contact→company 279,
company→contact 280, contact→deal 4, deal→contact 3, deal→company 341 and
company→deal 342; pass 1 as `associationTypeId` for a contact's primary
company. `updateContact` and `updateDeal` are harmless to repeat with the same
values but are declared not idempotent so the mock check's placeholders never
reach a live account.

`listDealPipelines` and `listOwners` are declared requests the SDK sends
itself; a failure on those reads as `Request failed with <status>` followed by
HubSpot's error body, and the SDK's own retry honours `Retry-After` on them.

## Checks

From the repository root:

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/hubspot/dist/index.js --mock --receipt packages/hubspot/verified.json
```

`packages/hubspot/scripts/check.sh` runs exactly this. Tests make no network
calls: the client takes an injected `fetch`, clock and sleep.

`packages/hubspot/scripts/check-live.sh` exits 0 with a note when
`HUBSPOT_ACCESS_TOKEN` is unset. With a token it reads
`GET /crm/v3/owners?limit=5`, `GET /crm/v3/pipelines/deals`,
`POST /crm/v3/objects/contacts/search` with `{"query":"test","limit":5}`, one
contact when `HUBSPOT_CONTACT_ID` is set, and finally
`vorn-connector check --live` against the built package. `HUBSPOT_CONTACT_ID`
fills the live sample of `getContact`, and together with `HUBSPOT_COMPANY_ID`
the sample of `associate`. Nothing is created or changed except that
association.

## Built from

The developer documentation was the only source.

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
