# Changelog

All notable changes to `@vornrun/connector-airtable`.

## 0.1.0

First release.

Trigger a workflow from records created or updated in an Airtable table, and
let a workflow step create, update, upsert, delete or read records, list the
bases a token can reach and read a base's schema.

- **Triggers:** `newRecord`, `updatedRecord`.
- **Actions:** `createRecord`, `updateRecord`, `upsertRecords`, `deleteRecord`,
  `getRecord`, `listRecords`, `listBases`, `getBaseSchema`.
- **Signing in:** a personal access token from airtable.com/create/tokens with
  `data.records:read`, `data.records:write` and `schema.bases:read`, granted
  access to each base it should reach. There is no Airtable CLI to borrow a
  login from.

The record actions and both polls go through one small client rather than
declared SDK requests, because Airtable's rate limit needs behaviour a
declared request cannot express: calls are spaced to five per second per base
with an in-process bucket shared by every poll and step, a `429` is retried
once after `Retry-After` or the documented 30 second lockout, and a `5xx` is
retried once on reads and idempotent writes only. `listBases` and
`getBaseSchema` are declared requests reshaped with `postReceive`; the SDK's
own retry honours `Retry-After` on them. Every list goes through
`POST listRecords` so a long formula never meets the 16,000 character URL
limit, and `offset` is walked up to ten pages of 100.

Both triggers are declarative polls on the SDK's timestamp strategy, filtering
with `NOT(IS_BEFORE(…, DATETIME_PARSE("<watermark>")))` so a record stamped on
the watermark is kept and dedupe absorbs the repeat. New records carry
`createdTime`. Updated records carry the value of a named "Last modified time"
field when the connection names one; without it the poll filters on
`LAST_MODIFIED_TIME()` and stamps every record with the poll time, since the
list response has no modification time to read.

Ships as a pack with a conformance receipt covering the dedupe replay of both
triggers and the mock run of every action. No runtime dependencies: `fetch`
and `JSON` cover the client and the pager is a loop on `offset`.
