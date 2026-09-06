# Changelog

All notable changes to `@vornrun/connector-jira`.

## 0.1.0

First release.

Trigger a workflow when a Jira Cloud issue is created, updated or moved to a
status, and let a workflow step create, edit, transition, comment on, assign,
read or search issues, list an issue's transitions, list projects and read the
account the token belongs to.

- **Triggers:** `newIssue`, `issueUpdated`, `issueTransitioned`.
- **Actions:** `createIssue`, `updateIssue`, `transitionIssue`, `addComment`,
  `assignIssue`, `getIssue`, `searchIssues`, `listTransitions`,
  `listProjects`, `getCurrentUser`.
- **Signing in:** the site URL, the account email and an API token from
  id.atlassian.com, created without scopes, sent as HTTP Basic auth. There is
  no Jira CLI to borrow a login from.

Every action is hand-written against one small client rather than declared as
an SDK `request`, because Basic auth is `base64(email + ":" + token)` and a
header template cannot compute it, and because the documented retry policy
and error shape are shared by every call: a `429` is retried once after
`Retry-After`, else `X-RateLimit-Reset`, else two seconds, with the guide's
0.7 to 1.3 jitter; `500`, `502`, `503` and `504` are retried once on reads and
idempotent writes only; a `401` is never retried; and the thrown message
repeats Jira's `errorMessages` and per-field `errors` with the
`RateLimit-Reason` header when a limit fired. Plain-text descriptions and
comments are converted to Atlassian Document Format, and `transitionIssue`
resolves a transition name against the list the issue offers.

The three triggers are declarative fetches on the SDK's timestamp strategy
over `GET search/jql`, walking `nextPageToken` up to ten pages of 100 and
delivering oldest first. The cursor is formatted to the minute in the
searching user's time zone, read once from `GET myself`, and the window opens
two minutes before the watermark because JQL dates carry no seconds and the
search index lags. Created issues are keyed by id; updates and transitions by
`<id>:<updated>`, since `status CHANGED TO … AFTER` says a change happened
but not when.

Ships as a pack with a conformance receipt covering the mock run of every
action and the dedupe replay of every trigger. No runtime dependencies:
`fetch`, `URL`, `Buffer`, `Intl.DateTimeFormat` and `setTimeout` cover the
client, the auth header, the JQL dates, the pagination and the retry waits.
