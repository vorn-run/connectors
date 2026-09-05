id: airtable

# Airtable connector

Airtable's Web API at `https://api.airtable.com/v0`. Every request is HTTPS
with a JSON body and a JSON answer; the API "closely follows REST semantics"
and "relies on standard HTTP codes to signal operation outcomes". Ids carry a
prefix: bases `app…`, tables `tbl…`, records `rec…`, fields `fld…`, views
`viw…`. Record paths take `{baseId}/{tableIdOrName}`, so a table can be named
by id or by its display name (URL-encoded). Every record is
`{ id, createdTime, fields }` with `createdTime` an ISO 8601 instant such as
`2022-09-12T21:03:48.000Z`, and `fields` keyed by field name (or id when
`returnFieldsByFieldId` is true). "Any 'empty' fields (e.g. "", [], or false)
in the record will not be returned."

Errors: `401` for a missing or invalid token, `403` for a token that lacks
access to the resource, `404` for an unknown route or record, `422` for
"most of the base-specific validations" (unknown field, wrong cell type),
`429` for the rate limit, `413` for a body over the size limit, `500`, `502`
and `503` on Airtable's side. The body is `{ "error": "CODE" }` or
`{ "error": { "type": "TYPE", "message": "…" } }`; the connector throws
`<type>: <message>` and the HTTP status.

Package: `@vornrun/connector-airtable` in `packages/airtable`, shaped like the
existing packages: scoped name, tsup, `vitest.config.ts` re-exporting
`vitest.shared.ts`, `CHANGELOG.md`, `README.md` with the links from the Docs
section, `verified.json` from `vorn-connector check --mock`, category
`Productivity`, `packs: true`.

## Auth

Rung: **`key`**. There is no Airtable CLI a developer signs in to, so a
personal access token is pasted, as the notion connector does.

| Config field | Env name | Where it comes from |
| --- | --- | --- |
| `apiKey` (secret, required) | `AIRTABLE_API_KEY` | https://airtable.com/create/tokens |

Sent as `Authorization: Bearer <token>` on every request. Declare
`auth: { rung: 'key', keys: ['apiKey'] }`.

Scopes the token needs, from the scopes page:

| Scope | Doc text | Needed by |
| --- | --- | --- |
| `data.records:read` | "See the data in records" | both triggers, `getRecord`, `listRecords` |
| `data.records:write` | "Create, edit, and delete records" | `createRecord`, `updateRecord`, `upsertRecords`, `deleteRecord` |
| `schema.bases:read` | "See the structure of a base, like table names or field types" | `listBases`, `getBaseSchema` |

Scopes alone are not enough. A token is granted **access to specific bases**
when created (or to all bases in an enterprise), and "the user who granted
the token must have editor access to the base" to write. A token with the
right scopes and no access to a base answers `403`, or `404` on the record
routes, and the README says to add the base under the token's *Access* list
before suspecting the id. "Personal access tokens act as your user account,
and should not be shared with third-party services." OAuth is not
implemented; it needs a registered integration and a hosted redirect.

## Rate limits

"The API is limited to 5 requests per second per base", and to 50 requests
per second across all personal-access-token traffic from one user. Over the
limit Airtable answers `429` and "you will need to wait 30 seconds before
subsequent requests will succeed"; the docs ask integrations to "back-off
and wait before retrying". No `Retry-After` header is documented, but the
connector honours one when present: on a 429 it waits `Retry-After` seconds
if the header is there, otherwise 30 seconds, and retries once; a second 429
is thrown. The client also spaces its own calls to at most 5 per second per
base with a small in-process token bucket keyed by base id, so a poll that
walks pages never trips the limit by itself. 5xx answers are retried once
after a short jittered wait.

## Pagination

`GET {baseId}/{tableIdOrName}` returns "one page of records at a time",
`pageSize` at most 100 (the default). "If there are more records, the
response will contain an offset"; the caller passes it back as `offset`
until it is absent or `maxRecords` is reached. A URL longer than 16,000
characters is refused, so a long `filterByFormula` goes through
`POST {baseId}/{tableIdOrName}/listRecords` with the same parameters in the
JSON body; the connector always uses the POST form for its own polls and
`listRecords`, which sidesteps encoding the formula in a query string.
`meta/bases` pages the same way, 1000 bases at a time.

## Formulas for the polls

`filterByFormula` is any Airtable formula that evaluates truthy per record.
From the formula reference: `CREATED_TIME()` "returns the date and time a
given record was created"; `LAST_MODIFIED_TIME()` returns "the date and time
of the most recent modification made by a user in a non-computed field in the
table"; `IS_AFTER(date1, date2)` "determines if date1 is later than date2";
`IS_BEFORE` is its mirror; `DATETIME_PARSE(text)` "interprets a text string
as a structured date". Field names with spaces are written `{Field Name}`.
The polls therefore send

```
NOT(IS_BEFORE(CREATED_TIME(), DATETIME_PARSE("2024-05-01T12:00:00.000Z")))
NOT(IS_BEFORE(LAST_MODIFIED_TIME(), DATETIME_PARSE("2024-05-01T12:00:00.000Z")))
```

with the cursor as the ISO instant: `NOT(IS_BEFORE(…))` is "at or after", so a
record stamped in the same instant as the cursor is not dropped, and dedupe
absorbs the repeat. A user-supplied `filterByFormula` on a trigger is ANDed:
`AND(<time clause>, <user formula>)`.

## Triggers

Both poll, both scoped by config `baseId` (string, required, `app…`) and
`table` (string, required, table id or name), optional `view` (string, a
view name or id, "records will be returned in the order they appear in the
view" and hidden records are filtered), optional `filterByFormula` (string,
extra condition). Pages are walked with `offset`, at most 10 pages of 100
per poll, sorted `createdTime` ascending (`newRecord`) or by the
last-modified field ascending (`updatedRecord`) so the oldest fires first.
The record URL is `https://airtable.com/{baseId}/{tableId}/{recordId}` when
`table` is an id; with a table name the URL is
`https://airtable.com/{baseId}` plus nothing, because a name cannot be
turned into a `tbl…` id without a schema call, and the item omits `url`.

### `newRecord` — a record was created

- **Poll:** `POST {baseId}/{table}/listRecords` with
  `filterByFormula: NOT(IS_BEFORE(CREATED_TIME(), DATETIME_PARSE("<cursor>")))`
  and `pageSize: 100`. `sort` takes only field names and `CREATED_TIME()` is
  not a field, so the collected records are sorted client-side by
  `createdTime`.
- **Cursor:** the newest `createdTime` seen. With no cursor yet, the first
  poll starts one hour back.
- **Dedupe key:** the record `id`; `dedupe: 'timestamp'` with
  `updatedAt = createdTime`.
- **Sample item:**

```json
{
  "externalId": "rec560UJdUtocSouk",
  "title": "Union Square",
  "url": "https://airtable.com/appLkNDICXNqxSDhG/tbltp8DGLhqbUmjK1/rec560UJdUtocSouk",
  "updatedAt": "2022-09-12T21:03:48.000Z",
  "data": {
    "id": "rec560UJdUtocSouk",
    "createdTime": "2022-09-12T21:03:48.000Z",
    "fields": { "Name": "Union Square", "Address": "333 Post St", "Visited": true }
  }
}
```

The title is the value of the first field in `fields` that is a string,
which in practice is the primary field, or the record id when no field is a
string.

### `updatedRecord` — a record was modified

`LAST_MODIFIED_TIME()` can filter server-side, but the list response carries
no modification time: `createdTime` is the only timestamp on a record. To know
*when* a record changed, and to dedupe on it, the table needs a field of
type **last modified time** and the trigger needs its name.

- **Config:** `lastModifiedField` (string, optional): the name of a "Last
  modified time" field in the table. When set, the poll filters on
  `NOT(IS_BEFORE({<lastModifiedField>}, DATETIME_PARSE("<cursor>")))`, sorts
  by it ascending server-side (`sort: [{ field, direction: "asc" }]`), and
  reads the field's value as the item's `updatedAt`.
- **Fallback, documented in the README and the field's `builderHint`:** when
  `lastModifiedField` is empty the poll filters on `LAST_MODIFIED_TIME()`,
  so Airtable still returns only records touched since the cursor, but the
  connector cannot read the modification time. It then sets
  `updatedAt = context.now()` on every record in the page (one shared
  instant, per the SDK's timestamp dedupe) and the cursor is the poll time.
  A record edited twice between polls fires once; a record edited in two
  different polls fires twice, which is the intended behaviour, and dedupe
  still holds because the SDK remembers the ids on the newest instant.
- **Cursor:** the newest last-modified value seen (field set), else the
  poll time. First poll starts one hour back.
- **Dedupe key:** `id` plus the last-modified time, via `dedupe:
  'timestamp'`: the SDK keys on `externalId` and `updatedAt` together, so an
  edit that moves the time re-fires the same record.
- **Sample item:**

```json
{
  "externalId": "rec560UJdUtocSouk",
  "title": "Union Square",
  "url": "https://airtable.com/appLkNDICXNqxSDhG/tbltp8DGLhqbUmjK1/rec560UJdUtocSouk",
  "updatedAt": "2022-09-13T08:15:02.000Z",
  "data": {
    "id": "rec560UJdUtocSouk",
    "createdTime": "2022-09-12T21:03:48.000Z",
    "fields": { "Name": "Union Square", "Address": "333 Post St", "Visited": false, "Last modified": "2022-09-13T08:15:02.000Z" }
  }
}
```

## Actions

Every action sends `Authorization: Bearer` and `Content-Type:
application/json`, and throws on a non-2xx answer with the status and the
error message. Inputs typed `json` are validated by the harness before
`run()`. All record actions take:

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `baseId` | string | yes | The base id, `app…`, from the base URL or `listBases` |
| `table` | string | yes | Table id (`tbl…`) or table name |

### `createRecord` — create a record

`POST {baseId}/{table}` with `{ fields, typecast }`. **Not idempotent**: two
calls make two records. The single-record body form is used.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `fields` | json | yes | An object of cell values keyed by field name or id, e.g. `{"Name":"Union Square","Visited":true}` |
| `typecast` | boolean | no | Let Airtable convert strings to the field's type; "automatic conversion is disabled by default to ensure data integrity" |
| `returnFieldsByFieldId` | boolean | no | Key the returned fields by id instead of name |

Outputs: `id`, `createdTime`, `fields`, `url`.

### `updateRecord` — update a record

`PATCH {baseId}/{table}/{recordId}` with `{ fields, typecast }`. "A PATCH
request will only update the fields you specify, leaving the rest as they
were"; PUT would clear the rest and is not exposed. Idempotent for the same
inputs (the same values land twice), so it is marked idempotent, but no live
sample is given because it writes.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `recordId` | string | yes | The record id, `rec…` |
| `fields` | json | yes | The cell values to change, keyed by field name or id |
| `typecast` | boolean | no | As above |
| `returnFieldsByFieldId` | boolean | no | As above |

Outputs: `id`, `createdTime`, `fields`, `url`.

### `upsertRecords` — create or update records by matching fields

`PATCH {baseId}/{table}` with `{ performUpsert: { fieldsToMergeOn }, records,
typecast }`. `fieldsToMergeOn` is "an array with at least one and at most
three field names or IDs"; they act as external ids and cannot be computed
fields. Zero matches creates, one match updates, "if multiple records match,
the request will fail". At most 10 records per request; the action sends up
to 10 and refuses more with a clear error rather than silently batching,
because a partial failure mid-batch is not reported per record. **Not
idempotent** as an action: a merge field the caller changes between runs
creates a new record.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `records` | json | yes | An array of up to 10 `{ "fields": { … } }` objects |
| `fieldsToMergeOn` | json | yes | An array of 1 to 3 field names or ids that identify a record |
| `typecast` | boolean | no | As above |

Outputs: `records` (array of `{ id, createdTime, fields }`),
`createdRecords` (ids), `updatedRecords` (ids).

### `deleteRecord` — delete a record

`DELETE {baseId}/{table}/{recordId}`. Answers `{ "deleted": true, "id" }`. A
second call answers 404, so not idempotent.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `recordId` | string | yes | The record id, `rec…` |

Outputs: `id`, `deleted`.

### `getRecord` — get a record

`GET {baseId}/{table}/{recordId}`. Idempotent. Empty cells are omitted.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `recordId` | string | yes | The record id, `rec…` |
| `returnFieldsByFieldId` | boolean | no | As above |

Outputs: `id`, `createdTime`, `fields`, `url`.

Live sample: `{ "baseId": "$AIRTABLE_BASE_ID", "table": "$AIRTABLE_TABLE",
"recordId": "$AIRTABLE_RECORD_ID" }`, filled from the environment and
skipped when `AIRTABLE_RECORD_ID` is unset.

### `listRecords` — list records

`POST {baseId}/{table}/listRecords`. Idempotent. Walks `offset` until
`maxRecords` is reached or the pages run out, at most 10 pages.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `filterByFormula` | string | no | An Airtable formula; only records where it is truthy are returned |
| `view` | string | no | A view name or id; records come back in the view's order and hidden ones are filtered |
| `maxRecords` | number | no | Total records to return across pages, default 100 |
| `pageSize` | number | no | Records per request, 1 to 100, default 100 |
| `fields` | json | no | An array of field names or ids to include |
| `sort` | json | no | An array of `{ "field": "Name", "direction": "asc" }` |
| `returnFieldsByFieldId` | boolean | no | As above |

Outputs: `records` (array of `{ id, createdTime, fields }`), `count`.

Live sample: `{ "baseId": "$AIRTABLE_BASE_ID", "table": "$AIRTABLE_TABLE",
"maxRecords": 5 }`; the mock check uses placeholder ids
`{ "baseId": "appXXXXXXXXXXXXXX", "table": "tblXXXXXXXXXXXXXX", "maxRecords": 5 }`.

### `listBases` — list the bases the token can reach

`GET meta/bases`, paging on `offset`. Idempotent, no inputs. "Returns the
list of bases the token can access, 1000 bases at a time."

Outputs: `bases` (array of `{ id, name, permissionLevel }`), where
`permissionLevel` is one of `none`, `read`, `comment`, `edit`, `create`.

Live sample: `{}`.

### `getBaseSchema` — get the tables and fields of a base

`GET meta/bases/{baseId}/tables`. Idempotent.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `baseId` | string | yes | The base id, `app…` |

Outputs: `tables` (array of `{ id, name, primaryFieldId, fields: [{ id, name,
type, options }], views: [{ id, name, type }] }`).

Live sample: `{ "baseId": "$AIRTABLE_BASE_ID" }`; mock sample
`{ "baseId": "appXXXXXXXXXXXXXX" }`.

## Checks

From the repository root:

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/airtable/dist/index.js --mock --receipt packages/airtable/verified.json
```

`scripts/check.sh` runs exactly this, calling the CLI by its real path
because a linked `node_modules` defeats its entry-point guard. Tests make no
network calls: the client takes an injected `fetch`.

## Live checks

`scripts/check-live.sh` exits 0 with a note when `AIRTABLE_API_KEY` is
unset; no token exists on this machine. With a token it calls
`GET meta/bases`, then, when `AIRTABLE_BASE_ID` is set,
`GET meta/bases/$AIRTABLE_BASE_ID/tables`; when `AIRTABLE_TABLE` is also
set, `GET $AIRTABLE_BASE_ID/$AIRTABLE_TABLE?maxRecords=5`; when
`AIRTABLE_RECORD_ID` is also set, the single record; then
`vorn-connector check --live` when the package is built.

| Env | Required | Used by |
| --- | --- | --- |
| `AIRTABLE_API_KEY` | yes | every call |
| `AIRTABLE_BASE_ID` | no | `getBaseSchema`, `listRecords`, `getRecord`, the triggers |
| `AIRTABLE_TABLE` | no | `listRecords`, `getRecord`, the triggers |
| `AIRTABLE_RECORD_ID` | no | `getRecord` |

Nothing is created, changed or deleted: the live check touches only
read-only endpoints.

## Dependencies

None at runtime. `fetch` and `JSON` cover the client, and the pager is a
loop on `offset`. The official `airtable` npm package wraps the same
endpoints with its own retry and is not inlined.

## Icon

Airtable's mark is three stacked, tilted rhombus-like plates seen in
isometric perspective: a top plate (yellow), a lower-left plate (blue) and a
lower-right plate (red), the three forming a cube-like stack. A single-colour
SVG carries the three plates as three paths in a 24-unit viewBox: the top
plate is a rhombus with its corners at about (12, 1.5), (23, 6), (12, 10.5)
and (1, 6); the lower-left plate a parallelogram from (1, 8) down to
(1, 19), across to (11, 23.5) and up to (11, 12.5); the lower-right plate
a mirror of it from (13, 12.5) to (23, 8), down to (23, 18.5) and back to
(13, 23), with a small notch cut from its upper corner so the three plates
do not touch. Fill only, no strokes, `fill-rule: nonzero`.

## Docs

The only source.

- Introduction: https://airtable.com/developers/web/api/introduction
- Authentication: https://airtable.com/developers/web/api/authentication
- Scopes: https://airtable.com/developers/web/api/scopes
- Rate limits: https://airtable.com/developers/web/api/rate-limits
- Errors: https://airtable.com/developers/web/api/errors
- List records: https://airtable.com/developers/web/api/list-records
- Get record: https://airtable.com/developers/web/api/get-record
- Create records: https://airtable.com/developers/web/api/create-records
- Update record: https://airtable.com/developers/web/api/update-record
- Update multiple records (upsert): https://airtable.com/developers/web/api/update-multiple-records
- Delete a record: https://airtable.com/developers/web/api/delete-record
- List bases: https://airtable.com/developers/web/api/list-bases
- Get base schema: https://airtable.com/developers/web/api/get-base-schema
- Formula field reference: https://support.airtable.com/docs/formula-field-reference
- Create a personal access token: https://airtable.com/create/tokens
