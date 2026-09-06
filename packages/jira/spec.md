id: jira

# Jira connector

Jira Cloud's REST API v3 at `https://<site>.atlassian.net/rest/api/3`. Every
request is JSON both ways (`Content-Type: application/json`,
`Accept: application/json`); reads are `GET` with a query string, writes are
`POST` or `PUT` with a JSON body, and successful `PUT`s and transitions answer
`204` with no body. Timestamps are `2023-06-24T19:24:50.000+0000`: ISO 8601
with a numeric offset and no colon, which `Date.parse` accepts. An error body
is the documented error collection, `{ errorMessages: string[], errors:
{ [field]: string }, status? }` (for example
`{"errorMessages":["Field 'priority' is required"],"errors":{}}`). The
connector throws `<http status>: <errorMessages joined with "; ">` followed
by every `errors` entry as `field: message`, and the status text alone when
the body is not JSON.

Package: `@vornrun/connector-jira` in `packages/jira`, shaped exactly like the
existing packages: scoped name, tsup, `vitest.config.ts` re-exporting
`vitest.shared.ts`, `CHANGELOG.md`, `README.md` with the links from the Docs
section, `verified.json` from `vorn-connector check --mock`, category
`Development`, `packs: true`.

## Auth

Rung: **key**. There is no Jira CLI most developers already sign in to
(Atlassian's `acli` is new and rare, and it stores its own session rather
than exposing an API token), so the connection takes three values.

| Config field | Env name | Secret | Where it comes from |
| --- | --- | --- | --- |
| `siteUrl` | `JIRA_SITE_URL` | no | The site's origin, such as `https://example.atlassian.net`; the connector strips a trailing slash and any path and appends `/rest/api/3` |
| `email` | `JIRA_EMAIL` | no | The email address of the Atlassian account the token belongs to |
| `apiToken` | `JIRA_API_TOKEN` | yes | https://id.atlassian.com/manage-profile/security/api-tokens: **Create API token**, name it, copy it once |

Header, exactly as the basic-auth page shows it: "Build a string of the form
`useremail:api_token`. BASE64 encode the string. Supply an `Authorization`
header with content `Basic` followed by the encoded string." So
`Authorization: Basic <base64(email + ":" + apiToken)>` on every request.

How a person gets the token, from the Atlassian account page:

1. Log in to https://id.atlassian.com/manage-profile/security/api-tokens.
2. Select **Create API token** (or **Create API token with scopes**), give
   it a name that describes its purpose and an expiry (1 to 365 days for
   scoped tokens).
3. Select **Create**, then **Copy to clipboard**; "You can't recover the API
   token after you're done with this step."

What the docs say, and what follows from it:

- An API token "will allow you to authenticate even if your Atlassian Cloud
  organization has two-factor authentication or SAML enabled", and can be
  revoked individually.
- Tokens **with scopes** only work against
  `https://api.atlassian.com/ex/jira/{cloudId}`, not the site URL: "You need
  to call the Atlassian API to use API tokens with scopes for Jira". The
  connector talks to `<siteUrl>/rest/api/3`, so the README tells people to
  create a token **without scopes** (the classic kind) and notes that a
  scoped token answers `401` on the site URL. The scopes the equivalent OAuth
  operations need, for anyone reading the reference: `read:jira-work` for
  search, get issue, transitions list, comments and projects,
  `write:jira-work` for create, edit, assign, transition and comment,
  `read:jira-user` for `GET /myself`.
- Permissions are per project, not per token: search returns only issues
  where the user has *Browse projects*, create needs *Create issues*, edit
  needs *Edit issues*, assign needs *Assign issues*, transition needs
  *Transition issues*, comment needs *Add comments*. A 403 or an empty
  search is a project permission, not a token problem.
- 401 "Returned if the authentication credentials are incorrect or missing"
  on every operation; the basic-auth page warns that repeated failures can
  trigger a CAPTCHA that blocks the API until the person logs in through
  the browser, so the connector never retries a 401.
- Basic auth is only recommended for "simple scripts and manual calls"; the
  token acts as the person, and every issue created or comment posted is
  attributed to them.

Preflight is `GET /myself`, the cheapest authenticated read: a wrong token,
email or site answers 401 (or an HTML login page on a mistyped site, which
the connector reports as a non-JSON answer). Its `timeZone` is also what the
triggers need (below).

## Rate limits and retries

Jira Cloud rate limits are points-based per app and tenant, with a burst
limit and per-issue write limits. "When any limit is exceeded, Jira returns
an HTTP `429 Too Many Requests` response."

| Header | Meaning (quoted) |
| --- | --- |
| `Retry-After` | "Only returned with 429 responses. Indicates how many seconds to wait before retrying." |
| `X-RateLimit-Limit` | "The maximum request rate enforced for the current rate-limit scope." |
| `X-RateLimit-Remaining` | "The remaining request capacity within the current rate-limit window." |
| `X-RateLimit-Reset` | "Only returned with 429 responses. ISO 8601 timestamp when the current window resets." |
| `RateLimit-Reason` | Which limit fired: `jira-quota-global-based`, `jira-quota-tenant-based`, `jira-burst-based`, `jira-per-issue-on-write` |

The guide: "Check the `Retry-After` header for guidance on an appropriate
retry delay", "Start with a base delay (e.g., 2 seconds)", "Add jitter:
Multiply the delay by a random factor (e.g; between 0.7 and 1.3)", and "Some
transient 5xx responses (such as 503) may also include a `Retry-After`
header. While these are not rate limit responses, you can handle them with
similar retry logic."

The connector's policy, per the brief:

- On `429`: wait `Retry-After` seconds when present, else until
  `X-RateLimit-Reset`, else 2 seconds, times a random factor between 0.7
  and 1.3, and retry **once**.
- On `500`, `502`, `503`, `504`: wait `Retry-After` or 1 second with the
  same jitter and retry **once**. A write that is not idempotent
  (`createIssue`, `addComment`) is retried on 5xx only when the request
  never reached a response (a network error), never after a 5xx body, so a
  timeout cannot duplicate an issue.
- Every thrown error carries the status, `errorMessages`, `errors` and the
  `RateLimit-Reason` header when set.

## JQL and the search endpoint

Every trigger and `searchIssues` use `GET /rest/api/3/search/jql`, the
enhanced search the reference points to; the old `GET /search` is marked
"Currently being removed" (changelog CHANGE-2046). Parameters, quoted:

- `jql`: "For performance reasons, this parameter requires a bounded query.
  A bounded query is a query with a search restriction." `order by key desc`
  alone is unbounded and answers 400, so `searchIssues` with a bare
  `order by` clause is bounded by the connector with `created >= "1970-01-01"`
  in front of it.
- `nextPageToken`: "The first page has a `nextPageToken` of `null`. Use the
  `nextPageToken` to fetch the next page of issues. Note: The
  `nextPageToken` field is not included in the response for the last page."
- `maxResults`: default 50; "It returns max 5000 issues", fewer when many
  fields are requested. The connector asks for 100 per page.
- `fields`: comma-separated, "The default is `id`", so the connector always
  names the fields it wants: `summary,status,issuetype,priority,assignee,
  reporter,project,labels,created,updated,resolution` for triggers, the
  caller's list or `*navigable` for `searchIssues`.
- The response is `{ issues: [...], isLast, nextPageToken? }`.
- "Recent updates might not be immediately visible in the returned search
  results": the index is eventually consistent, which is why the window
  below overlaps and dedupe absorbs repeats.

JQL date facts from the fields page, which shape the cursor:

- `created` and `updated` accept `"yyyy/MM/dd HH:mm"`, `"yyyy-MM-dd HH:mm"`,
  `"yyyy/MM/dd"`, `"yyyy-MM-dd"` or a relative `"-15m"`; **minute
  resolution, no seconds**. "Be sure to use quote-marks; if you omit the
  quote-marks, the number you supply will be interpreted as milliseconds
  after epoch."
- "The search results will be relative to your configured time zone (which
  is by default the Jira server's time zone)." The connector reads
  `timeZone` from `GET /myself` once per poll (cached for the process) and
  formats the cursor in that zone with `Intl.DateTimeFormat`, floored to the
  minute, so `created >= "2026-09-06 10:30"` means what the cursor means.
- `status` supports `CHANGED` with the predicates `AFTER "date"`,
  `BEFORE "date"`, `TO "newvalue"`, `FROM "oldvalue"`; "This operator can be
  used with the Assignee, Fix Version, Priority, Reporter, Resolution, and
  Status fields only."
- Values with spaces are double-quoted; a double quote inside a value is
  escaped as `\"`. Project keys go unquoted after `project =`.

## Triggers

All poll, all `dedupe: 'timestamp'`. Items carry the issue key as the title
prefix, `url` = `<siteUrl>/browse/<key>`, and the raw issue (id, key, self,
fields) in `data`. Shared config:

| Config field | Env name | Required | What it does |
| --- | --- | --- | --- |
| `projectKey` | `JIRA_PROJECT_KEY` | no | Adds `project = <KEY>` to every trigger's JQL |
| `jql` | `JIRA_JQL` | no | Extra JQL ANDed in parentheses after the time clause, such as `issuetype = Bug AND priority in (High, Highest)` |

Each poll walks `nextPageToken` up to 10 pages of 100, then stops. The
window starts at the cursor minus 2 minutes (minute resolution plus index
lag), and with no cursor at 24 hours back for `newIssue` and 1 hour back for
the other two.

### `newIssue` — an issue is created

- **Poll:** `GET /search/jql?jql=<project> AND created >= "<cursor>"
  <extra> ORDER BY created ASC&fields=…&maxResults=100`.
- **Dedupe key:** issue `id` (`"10002"`), with `updatedAt` = `fields.created`.
- **Cursor:** the newest `created` seen; the SDK's timestamp strategy keeps
  the ids sitting on it so the 2-minute overlap redelivers nothing.
- **Sample item** (`data` is the issue as the search returns it, trimmed to
  the requested fields):

```json
{
  "externalId": "10002",
  "title": "EX-1: Main order flow broken",
  "url": "https://example.atlassian.net/browse/EX-1",
  "status": "To Do",
  "updatedAt": "2023-06-24T19:24:50.000Z",
  "data": {
    "id": "10002",
    "key": "EX-1",
    "self": "https://example.atlassian.net/rest/api/3/issue/10002",
    "fields": {
      "summary": "Main order flow broken",
      "status": { "id": "10000", "name": "To Do", "statusCategory": { "key": "new", "name": "To Do" } },
      "issuetype": { "id": "10001", "name": "Bug", "subtask": false },
      "priority": { "id": "3", "name": "Medium" },
      "assignee": null,
      "reporter": { "accountId": "5b10a2844c20165700ede21g", "displayName": "Mia Krystof" },
      "project": { "id": "10000", "key": "EX", "name": "Example" },
      "labels": ["bugfix"],
      "created": "2023-06-24T19:24:50.000+0000",
      "updated": "2023-06-24T19:24:50.000+0000",
      "resolution": null
    }
  }
}
```

### `issueUpdated` — an issue is updated

- **Poll:** the same search with `updated >= "<cursor>" ORDER BY updated
  ASC`.
- **Dedupe key:** `${id}:${fields.updated}`, so each edit fires once and an
  issue edited twice fires twice. `updatedAt` = `fields.updated`.
- **Cursor:** the newest `updated` seen.
- **Sample item:** as `newIssue` with `externalId`
  `"10002:2023-06-25T08:10:00.000+0000"`, `title` `"EX-1 updated: Main
  order flow broken"`, `updatedAt` `"2023-06-25T08:10:00.000Z"` and
  `fields.updated` `"2023-06-25T08:10:00.000+0000"`.

### `issueTransitioned` — an issue moved to a status

- **Config:** `status` (`JIRA_STATUS`, required for this trigger only; the
  status name, such as `Done`).
- **Poll:** `status CHANGED TO "<status>" AFTER "<cursor>"` plus the project
  and extra clauses, `ORDER BY updated ASC`. `CHANGED … AFTER` is the only
  history predicate JQL offers; it does not say when the change happened,
  so `fields.updated` stands in as the change time (a transition is an
  update).
- **Dedupe key:** `${id}:${fields.updated}`; `updatedAt` = `fields.updated`.
- **Cursor:** the newest `updated` seen. An issue transitioned into the
  status and then edited again inside the window fires twice, once per
  `updated` value; the README says so.
- **Sample item:** as `newIssue` with `externalId`
  `"10002:2023-06-26T14:00:00.000+0000"`, `title` `"EX-1 is now Done: Main
  order flow broken"`, `status` `"Done"`, `fields.status.name` `"Done"`,
  `fields.resolution` `{ "name": "Done" }`.

## Plain text to ADF

`description` on create and update, and the comment body, "take Atlassian
Document Format content". The root is `{ "version": 1, "type": "doc",
"content": [...] }`; `paragraph` is a top-level block node, `text` and
`hardBreak` are inline nodes. The connector's `toAdf(text)` splits on blank
lines into paragraphs and on single newlines into `hardBreak` nodes:

```json
{ "version": 1, "type": "doc", "content": [
  { "type": "paragraph", "content": [
    { "type": "text", "text": "First line" },
    { "type": "hardBreak" },
    { "type": "text", "text": "second line" } ] } ] }
```

Empty text yields `content: []`. A value that already parses as a JSON
object with `type: "doc"` is sent as-is.

## Actions

Every action sends the auth header above, throws on a non-2xx answer as
described, and retries as described. Inputs the host passes as strings but
the API wants as JSON (`fields`, `update`) are parsed by the action; a value
that is not a JSON object is refused before any call.

### `createIssue` — create an issue

`POST /issue`. Not idempotent: every call creates an issue. Answers 201
`{ id, key, self }`.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `projectKey` | string | yes | Sent as `fields.project.key` |
| `issueType` | string | yes | Issue type name, sent as `fields.issuetype.name` (`Bug`, `Task`, `Story`) |
| `summary` | string | yes | `fields.summary` |
| `description` | string | no | Plain text converted to ADF, or an ADF document as JSON |
| `assigneeAccountId` | string | no | `fields.assignee.id` |
| `labels` | string | no | Comma-separated, sent as `fields.labels` (labels cannot contain spaces) |
| `priority` | string | no | Priority name, `fields.priority.name` |
| `parentKey` | string | no | `fields.parent.key`, for subtasks and children |
| `fields` | string | no | JSON object merged over the fields above, for custom fields such as `customfield_10000` |

Outputs: `id`, `key`, `url` (`<siteUrl>/browse/<key>`), `self`. 400 carries
`errors` per field (`{"errorMessages":["Field 'priority' is required"]}`
in the reference), which the thrown message repeats.

### `updateIssue` — edit an issue

`PUT /issue/{issueIdOrKey}`. Idempotent in effect (the same fields set
twice leave the same issue) but changes data, so no live sample. Answers
204; the connector sends `returnIssue=true` and returns the issue instead.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `issueKey` | string | yes | Key or id |
| `summary` | string | no | `fields.summary` |
| `description` | string | no | Plain text to ADF, or ADF JSON |
| `fields` | string | no | JSON object of fields to set, merged over the two above |
| `update` | string | no | JSON object of `update` operations, such as `{"labels":[{"add":"triaged"}]}` |
| `notifyUsers` | boolean | no | Default true; false needs administer permission or "the request is ignored" |

At least one of `summary`, `description`, `fields`, `update` is required.
"Issue transition is not supported and is ignored here." Outputs: `id`,
`key`, `url`, `issue` (the returned issue).

### `transitionIssue` — move an issue through a workflow transition

`POST /issue/{issueIdOrKey}/transitions` with `{ transition: { id } }`.
Answers 204. Not idempotent in the sense that the transition is gone once
taken (a second call answers 400), so no live sample.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `issueKey` | string | yes | Key or id |
| `transition` | string | yes | A transition id (`"31"`) or name (`"Done"`); a value that is not all digits is resolved case-insensitively against `GET /issue/{key}/transitions`, and against each transition's `to.name` when no transition name matches |
| `comment` | string | no | Plain text, sent as `update.comment[0].add.body` ADF, the documented way to comment on a transition |
| `fields` | string | no | JSON object for fields on the transition screen (`resolution`) |

Outputs: `id` and `name` of the transition taken, `to` (the target status
name), `key`. When a name matches nothing the error lists the names the
issue currently offers.

### `addComment` — add a comment

`POST /issue/{issueIdOrKey}/comment` with `{ body: <ADF> }`. Not
idempotent. Answers 201 with the comment.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `issueKey` | string | yes | Key or id |
| `body` | string | yes | Plain text converted to ADF, or ADF JSON |

Outputs: `id`, `created`, `updated` (ISO), `author` (`{ accountId,
displayName }`), `self`, `url` (`<siteUrl>/browse/<key>?focusedCommentId=<id>`).

### `assignIssue` — assign or unassign an issue

`PUT /issue/{issueIdOrKey}/assignee` with `{ accountId }`. Answers 204.
Idempotent in effect but changes data, so no live sample.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `issueKey` | string | yes | Key or id |
| `accountId` | string | no | The assignee's account id; empty or `null` sends `{ "accountId": null }` ("the issue is set to unassigned"); `-1` assigns "the default assignee for the project" |

Outputs: `key`, `accountId` (or null).

### `getIssue` — get an issue

`GET /issue/{issueIdOrKey}?fields=…`. Idempotent. "If the identifier
doesn't match an issue, a case-insensitive search and check for moved
issues is performed."

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `issueKey` | string | yes | Key or id |
| `fields` | string | no | Comma-separated field list; default `*navigable` |

Outputs: `id`, `key`, `url`, `summary`, `status`, `statusCategory`,
`issueType`, `priority`, `assignee` (`{ accountId, displayName }` or null),
`reporter`, `project` (`{ id, key, name }`), `labels`, `created`, `updated`,
`resolution`, `descriptionText` (the ADF flattened to plain text), `issue`
(raw).

Live sample: `{ "issueKey": "$JIRA_ISSUE_KEY" }`, a placeholder the live
check fills from the environment and skips when unset.

### `searchIssues` — search issues with JQL

`GET /search/jql`. Idempotent.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `jql` | string | yes | A JQL expression; a bare `ORDER BY` is bounded with `created >= "1970-01-01"` |
| `fields` | string | no | Comma-separated, default `summary,status,issuetype,priority,assignee,reporter,project,labels,created,updated,resolution` |
| `maxResults` | number | no | 1 to 5000, default 50; the connector pages with `nextPageToken` until it has that many |

Outputs: `issues` (array of the `getIssue` shape without `issue`),
`count`, `isLast`, `nextPageToken`.

Live sample: `{ "jql": "order by created DESC", "maxResults": 5 }`.

### `listTransitions` — list the transitions an issue offers

`GET /issue/{issueIdOrKey}/transitions`. Idempotent. "If a request is made
for a transition that does not exist or cannot be performed on the issue,
given its status, the response will return any empty transitions list."

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `issueKey` | string | yes | Key or id |

Outputs: `transitions` (array of `{ id, name, to: { id, name,
statusCategory }, hasScreen, isAvailable }`), `count`.

Live sample: `{ "issueKey": "$JIRA_ISSUE_KEY" }`, skipped when unset.

### `listProjects` — list projects

`GET /project/search?maxResults=100&orderBy=key`. Idempotent; the unpaged
`GET /project` is deprecated. Pages on `startAt` while `isLast` is false,
`maxResults` "Must be less than or equal to 100".

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | no | "Projects with a matching `key` or `name` are returned (case insensitive)" |
| `typeKey` | string | no | `business`, `service_desk` or `software` |

Outputs: `projects` (array of `{ id, key, name, projectTypeKey,
simplified, style, url }`), `count`.

Live sample: `{}`.

### `getCurrentUser` — get the account the token belongs to

`GET /myself`. Idempotent, no inputs.

Outputs: `accountId`, `accountType`, `displayName`, `emailAddress` (absent
when the person hides it), `active`, `timeZone`, `locale`, `self`.

Live sample: `{}`.

## Checks

From the repository root, with the package built:

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/jira/dist/index.js --mock --receipt packages/jira/verified.json
```

`scripts/check.sh` runs exactly this, calling the CLI by its real path
because a linked `node_modules` defeats its entry-point guard. Tests make no
network calls: the client takes an injected `fetch`, the retry tests use
fake timers, and the JQL builder is tested with a fixed time zone. Every
action must survive the mock harness's `{}` reply and placeholder arguments
(the 204 writes return their inputs, the reads tolerate missing fields), so
the receipt carries no warnings.

## Live checks

`scripts/check-live.sh` exits 0 with a note when `JIRA_SITE_URL`,
`JIRA_EMAIL` or `JIRA_API_TOKEN` is unset. With all three it calls
`GET /myself`, `GET /project/search?maxResults=5`,
`GET /search/jql?jql=created >= "1970-01-01" order by created DESC&maxResults=5`,
`GET /issue/$JIRA_ISSUE_KEY` and `GET /issue/$JIRA_ISSUE_KEY/transitions`
when that is set, then `vorn-connector check --live`.

| Env | Required | Used by |
| --- | --- | --- |
| `JIRA_SITE_URL` | yes | every call, as the base |
| `JIRA_EMAIL` | yes | basic auth user |
| `JIRA_API_TOKEN` | yes | basic auth password |
| `JIRA_ISSUE_KEY` | no | `getIssue`, `listTransitions`; skipped when unset |
| `JIRA_PROJECT_KEY` | no | trigger scope in `check --live` |

Nothing is created, edited, assigned, transitioned or commented: the live
check touches only idempotent reads. No token exists on this machine.

## Dependencies

None at runtime. `fetch`, `URL`, `URLSearchParams`, `Buffer.from(...).
toString('base64')`, `Intl.DateTimeFormat` and `setTimeout` cover the
client, the basic auth header, the JQL date formatting, pagination and the
retry waits. Atlassian's `jira.js` client is a full SDK of every resource
and is not inlined; the ADF conversion needed here is a dozen lines.

## Icon

Jira's mark is a stack of three identical rhombus-like arrow tiles pointing
down-right, each a square rotated 45 degrees with its upper-left corner
notched by the tile above, so the three overlap diagonally from the top-left
down to a large bottom-right tile and read as one arrow lifting off. The
lower-right shape is a full rotated square about 12 units wide with its
upper-left side cut by a rounded notch; the middle and top shapes are the
same square translated up-left by about 4 units each, each showing only its
top-left half. A single-colour SVG carries it in a 24-unit viewBox as three
filled paths, or one path with `fill-rule: evenodd`: the bottom tile
`M12 23.5 22.5 13a1 1 0 0 0 0-1.4L12 1.6 1.5 12.1a1 1 0 0 0 0 1.4z` with an
inner rotated square cut out of its centre, and two chevrons of the same
outline offset to `(8, 8)` and `(4, 4)` clipped where they meet the tile
below. Fill only, no strokes.

## Docs

The only source.

- REST API v3 introduction (pagination, status codes, error collection): https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/
- Basic auth for REST APIs: https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/
- API tokens: https://id.atlassian.com/manage-profile/security/api-tokens (how-to: https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/)
- Rate limiting: https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
- Issue search: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
- Issues (create, get, edit, assign, transitions): https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
- Issue comments: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/
- Projects: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/
- Myself: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/
- Atlassian Document Format: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
- JQL: https://support.atlassian.com/jira-software-cloud/docs/use-advanced-search-with-jira-query-language-jql/ (fields: https://support.atlassian.com/jira-software-cloud/docs/jql-fields/, operators: https://support.atlassian.com/jira-software-cloud/docs/jql-operators/)
- OpenAPI document the reference pages are rendered from: https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json
