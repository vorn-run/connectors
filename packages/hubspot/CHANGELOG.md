# Changelog

All notable changes to `@vornrun/connector-hubspot`.

## 0.1.0

First release.

Trigger a workflow from contacts, companies and deals created in HubSpot or
from deals moving to a stage, and let a workflow step create, update, search,
annotate or associate CRM records, list the deal pipelines and list the owners.

- **Triggers:** `newContact`, `newDeal`, `newCompany`, `dealStageChanged`.
- **Actions:** `createContact`, `updateContact`, `createDeal`, `updateDeal`,
  `createCompany`, `createNote`, `associate`, `getContact`, `searchContacts`,
  `listDealPipelines`, `listOwners`.
- **Signing in:** a private app access token from Settings, Integrations,
  Private Apps with the contacts, companies and deals read and write scopes,
  `crm.objects.owners.read` and `crm.schemas.deals.read`. There is no HubSpot
  CLI to borrow a CRM login from.

The record actions and every poll go through one small client rather than
declared SDK requests, because HubSpot's rate limits and errors need behaviour
a declared request cannot express: `X-HubSpot-RateLimit-Remaining` at 0 waits
out the window before the next call, a `429` is retried once after
`Retry-After` in milliseconds or one second and never for the `DAILY` policy,
a `5xx` is retried once on reads and idempotent writes only, and a failure is
thrown as `<category>: <message> (<correlationId>)` with the HTTP status.
`listDealPipelines` is a declared request reshaped with `postReceive`; the
SDK's own retry honours `Retry-After` on it.

The three created-record triggers are declarative polls on the SDK's timestamp
strategy, searching with `createdate GTE <watermark>` as epoch milliseconds so
a record stamped on the watermark is kept and dedupe absorbs the repeat. The
stage trigger keys each item on `<dealId>:<dealstage>` and gives it no time
of its own, so the SDK keeps the ids it delivered: a deal edited without a
stage change is read again and dropped. Every poll leaves records stamped in
the last 30 seconds for the next one, since search indexes with a delay.

Ships as a pack with a conformance receipt covering the dedupe replay of all
four triggers and the mock run of every action. No runtime dependencies:
`fetch` and `JSON` cover the client and the pager is a loop on
`paging.next.after`.
