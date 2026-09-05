# @vornrun/connector-airtable

Trigger Vorn workflows from records created or updated in an Airtable table,
and create, update, upsert, delete or read records and base schemas from a
workflow step. Talks to the Web API at `https://api.airtable.com/v0`.

## Signing in

Paste a personal access token into the **Personal access token** field. There
is no Airtable CLI to borrow a login from. Create one at
https://airtable.com/create/tokens with these scopes:

| Scope | Needed by |
| --- | --- |
| `data.records:read` | both triggers, `getRecord`, `listRecords` |
| `data.records:write` | `createRecord`, `updateRecord`, `upsertRecords`, `deleteRecord` |
| `schema.bases:read` | `listBases`, `getBaseSchema` |

Scopes alone are not enough. When the token is created it is granted
**access to specific bases** (or to every base in an enterprise), and the user
who granted it must have editor access to a base to write to it. A token with
the right scopes and no access to a base answers `403`, or `404` on the record
routes: add the base under the token's *Access* list before suspecting the id.
A missing or invalid token answers `401`. The connector surfaces Airtable's
error as `<type>: <message>`, such as
`UNKNOWN_FIELD_NAME: Unknown field name: "Nmae"`, together with the HTTP
status. Personal access tokens act as your user account and should not be
shared with third-party services.

## Settings

| Setting | Environment | Required | What it does |
| --- | --- | --- | --- |
| Personal access token | `AIRTABLE_API_KEY` | yes | Sent as `Authorization: Bearer` on every call |
| Base | `AIRTABLE_BASE_ID` | yes | The `app…` id of the base the triggers watch, from the base URL or `listBases` |
| Table | `AIRTABLE_TABLE` | yes | The table the triggers watch, by `tbl…` id or by name |
| View | `AIRTABLE_VIEW` | no | A view name or id; records the view hides are skipped |
| Filter formula | `AIRTABLE_FILTER_BY_FORMULA` | no | An extra formula a record must satisfy, ANDed with the time clause |
| Last modified field | `AIRTABLE_LAST_MODIFIED_FIELD` | no | A "Last modified time" field the updated-record trigger reads |

The base and table settings are read by the triggers only. Every action takes
its own `baseId` and `table` inputs, so one connection can reach any base the
token was granted.

## Rate limits

Airtable allows 5 requests per second per base and answers `429` beyond that,
after which every request fails for 30 seconds. The connector spaces its own
record calls to at most 5 per second per base with an in-process bucket shared
by every poll and step in the connection, so a poll that walks pages never
trips the limit by itself. On a `429` it waits the `Retry-After` header when
one is present, otherwise the documented 30 seconds, and sends once more; a
second `429` is reported. A `5xx` is retried once after a short wait on reads
and on the idempotent `updateRecord` and `deleteRecord`, never on a create or
upsert, because a create that timed out may have landed.

## Triggers

Both poll the table from the settings with `POST {baseId}/{table}/listRecords`,
walking `offset` up to ten pages of 100 per poll, and deliver oldest first.
Both send a `filterByFormula` built from the watermark. The first poll starts
one hour back. When the table is given by id each item carries
`url: https://airtable.com/{baseId}/{tableId}/{recordId}`; a table name cannot
be turned into an id without a schema call, so the item then has no URL.

The item's `title` is the first text cell of the record, in practice the
primary field, or the record id when no cell is text. `data` carries the
record's `id`, `createdTime` and `fields`. Empty cells are not returned by
Airtable and so are absent from `fields`.

### `newRecord` — a record is created

Filters on `NOT(IS_BEFORE(CREATED_TIME(), DATETIME_PARSE("<watermark>")))`,
which is "at or after" so a record created in the same instant as the
watermark is not dropped, and dedupes on the record id with `createdTime` as
the item's time. `sort` takes field names only, so the records are ordered by
`createdTime` here.

### `updatedRecord` — a record is updated

Airtable's list response carries no modification time: `createdTime` is the
only timestamp on a record, even though `LAST_MODIFIED_TIME()` can filter
server-side. Name a **Last modified field** to get real times:

- **With the field:** the poll filters on
  `AND({Field}, NOT(IS_BEFORE({Field}, DATETIME_PARSE("<watermark>"))))`,
  sorts by the field ascending on the server, and reads the cell as the
  item's `updatedAt`. An edit that moves the time fires the record again.
- **Without it:** the poll filters on `LAST_MODIFIED_TIME()`, so Airtable still
  returns only records touched since the watermark, but the connector cannot
  read when. Every record in the page is stamped with the poll time and the
  watermark becomes the poll time. A record edited twice between polls fires
  once; a record edited in two different polls fires twice.

A newly created record counts as modified in both modes.

## Actions

Every record action takes `baseId` (`app…`) and `table` (`tbl…` id or name).
Inputs typed JSON are checked before any call is made.

| Action | Idempotent | What it does |
| --- | --- | --- |
| `createRecord` | no | `POST {baseId}/{table}` with `fields`, optional `typecast` and `returnFieldsByFieldId`. Returns `id`, `createdTime`, `fields`, `url`. |
| `updateRecord` | yes | `PATCH {baseId}/{table}/{recordId}`; only the given fields change. Same outputs. |
| `upsertRecords` | no | `PATCH {baseId}/{table}` with `performUpsert.fieldsToMergeOn` (1 to 3 names, comma-separated or a JSON array) and up to 10 `records`. No match creates, one match updates, several fail the call. Returns `records`, `createdRecords`, `updatedRecords`. |
| `deleteRecord` | no | `DELETE {baseId}/{table}/{recordId}`. Returns `id`, `deleted`. A second call answers 404. |
| `getRecord` | yes | `GET {baseId}/{table}/{recordId}`. Returns `id`, `createdTime`, `fields`, `url`. |
| `listRecords` | yes | `POST {baseId}/{table}/listRecords` with optional `filterByFormula`, `view`, `maxRecords` (default 100), `pageSize` (1 to 100), `fields`, `sort`, `returnFieldsByFieldId`; walks `offset` up to ten pages. Returns `records`, `count`. |
| `listBases` | yes | `GET meta/bases`, 1000 at a time. Returns `bases` (`id`, `name`, `permissionLevel`) and `offset` when another page exists; pass it back as the `offset` input. |
| `getBaseSchema` | yes | `GET meta/bases/{baseId}/tables`. Returns `tables` with their `fields` and `views`. |

`typecast` lets Airtable convert strings to the field's type; it is off by
default "to ensure data integrity". More than ten records in one upsert are
refused rather than split, because a failure mid-batch is not reported per
record. `listRecords` always uses the POST form, so a long formula is not
bound by the 16,000 character URL limit.

## Formulas

`filterByFormula`, in the settings and on `listRecords`, is any Airtable
formula that is truthy for the records to keep. Field names with spaces go in
braces: `{Status} = "Open"`, `AND({Visited}, IS_AFTER({Due}, TODAY()))`. The
formula reference linked below lists every function.

## Checks

From the repository root:

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/airtable/dist/index.js --mock --receipt packages/airtable/verified.json
```

`packages/airtable/scripts/check.sh` runs exactly this. Tests make no network
calls: the client takes an injected `fetch`, clock and sleep.

`packages/airtable/scripts/check-live.sh` exits 0 with a note when
`AIRTABLE_API_KEY` is unset. With a token it reads `meta/bases`, then the base
schema when `AIRTABLE_BASE_ID` is set, the first five records when
`AIRTABLE_TABLE` is also set, one record when `AIRTABLE_RECORD_ID` is also set,
and finally `vorn-connector check --live` against the built package. The same
three variables fill the live samples of `getBaseSchema`, `listRecords` and
`getRecord`. Nothing is created, changed or deleted.

## Built from

The Web API reference was the only source.

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
