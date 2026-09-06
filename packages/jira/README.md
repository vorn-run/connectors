# @vornrun/connector-jira

Trigger Vorn workflows when a Jira Cloud issue is created, updated or moved
to a status, and create, edit, transition, comment on, assign, read or search
issues from a workflow step. Talks to the REST API v3 at
`https://<site>.atlassian.net/rest/api/3`.

## Signing in

There is no Jira CLI most developers are already signed in to, so the
connection takes three values: the site URL, the account email and an API
token. Every call sends `Authorization: Basic base64(email:token)`, exactly
as Atlassian's basic-auth page describes.

To get the token:

1. Log in to https://id.atlassian.com/manage-profile/security/api-tokens.
2. Select **Create API token**, give it a name that says what it is for, and
   select **Create**. Choose the plain kind, **not** "Create API token with
   scopes": a scoped token only works against
   `https://api.atlassian.com/ex/jira/{cloudId}` and answers `401` on the
   site URL this connector calls.
3. Select **Copy to clipboard**. The token cannot be shown again; paste it into
   the **API token** field or set `JIRA_API_TOKEN`.

The token acts as your account: every issue created and comment posted is
attributed to you, and it works even when the organisation enforces two-factor
authentication or SAML. Revoke it from the same page when it is no longer
needed.

Permissions are per project, not per token. Search returns only issues where
the account has *Browse projects*; creating needs *Create issues*, editing
*Edit issues*, assigning *Assign issues*, transitioning *Transition issues*
and commenting *Add comments*. A `403`, or a search that returns nothing, is a
project permission, not a token problem. A wrong token, email or site answers
`401`, which the connector never retries: Atlassian warns that repeated
failures can trip a CAPTCHA that blocks the API until you log in through the
browser. A mistyped site often answers `200` with an HTML login page, which
the connector reports as a non-JSON answer.

Errors carry Jira's error collection as
`<status>: <errorMessages joined with "; ">; <field>: <message>`, for example
`400: Field 'priority' is required`, and the `RateLimit-Reason` header when a
limit fired.

## Settings

| Setting | Environment | Required | What it does |
| --- | --- | --- | --- |
| Site URL | `JIRA_SITE_URL` | yes | `https://example.atlassian.net`; a trailing slash or path is dropped |
| Account email | `JIRA_EMAIL` | yes | The user half of Basic auth |
| API token | `JIRA_API_TOKEN` | yes | The password half; created without scopes |
| Project key | `JIRA_PROJECT_KEY` | no | Adds `project = <KEY>` to every trigger's JQL |
| Extra JQL | `JIRA_JQL` | no | ANDed in parentheses after the time clause, such as `issuetype = Bug AND priority in (High, Highest)` |
| Status | `JIRA_STATUS` | for `issueTransitioned` | The status name that trigger watches for, such as `Done` |

The last three are read by the triggers only. Every action takes its own
inputs, so one connection reaches any project the account can browse.

## Rate limits

Jira Cloud rate limits are points-based per tenant, with a burst limit and
per-issue write limits, and answer `429 Too Many Requests` when one is
exceeded. On a `429` the connector waits the `Retry-After` header when
present, otherwise until `X-RateLimit-Reset`, otherwise two seconds, each
multiplied by a random factor between 0.7 and 1.3 as the guide recommends,
and sends once more; a second `429` is reported with the `RateLimit-Reason`.
A `500`, `502`, `503` or `504` is retried once after `Retry-After` or one
second on reads and on the idempotent writes (`updateIssue`, `assignIssue`),
never on `createIssue`, `addComment` or `transitionIssue` once an answer
arrived, because a create that timed out may have landed. A call that got no
answer at all is retried once for every action.

## Triggers

All three poll `GET search/jql`, the enhanced search the v3 reference points
to, walking `nextPageToken` up to ten pages of 100 per poll and delivering
oldest first. JQL dates resolve to the minute and are read in the searching
user's time zone, so each poll reads `timeZone` from `GET myself` once and
formats the cursor in that zone. The window starts two minutes before the
watermark to cover the minute resolution and the search index's lag; the
SDK's timestamp dedupe absorbs the repeats. The first poll looks 24 hours back
for `newIssue` and one hour back for the other two.

Each item's `title` starts with the issue key, `url` is
`<site>/browse/<key>`, `status` is the status name, and `data` carries the
issue's `id`, `key`, `self` and the requested `fields`: `summary`, `status`,
`issuetype`, `priority`, `assignee`, `reporter`, `project`, `labels`,
`created`, `updated` and `resolution`.

### `newIssue` — an issue is created

JQL `created >= "<cursor>" ORDER BY created ASC`, plus the project and extra
clauses. Dedupes on the issue id with `created` as the item's time.

### `issueUpdated` — an issue is updated

JQL `updated >= "<cursor>" ORDER BY updated ASC`. Dedupes on
`<id>:<updated>`, so each edit fires once and an issue edited twice fires
twice.

### `issueTransitioned` — an issue moves to a status

JQL `status CHANGED TO "<status>" AFTER "<cursor>" ORDER BY updated ASC`, with
the status from the settings. `CHANGED … AFTER` is the only history predicate
JQL offers; it says that the change happened, not when, so the issue's
`updated` time stands in and the item is keyed `<id>:<updated>`. An issue
transitioned into the status and then edited again inside the window fires
twice, once per `updated` value.

## Actions

Every action takes the issue by key (`EX-12`) or id where it needs one.
Inputs typed JSON (`fields`, `update`) are checked before any call is made.
Plain-text descriptions and comments are converted to Atlassian Document
Format: blank lines start paragraphs, single newlines become `hardBreak`
nodes, and a value that already parses as an ADF document is sent as it is.

| Action | Idempotent | What it does |
| --- | --- | --- |
| `createIssue` | no | `POST issue` with `projectKey`, `issueType`, `summary`, optional `description`, `assigneeAccountId`, `labels` (comma-separated), `priority`, `parentKey` and extra `fields` JSON. Returns `id`, `key`, `url`, `self`. |
| `updateIssue` | yes | `PUT issue/{key}?returnIssue=true` with `summary`, `description`, `fields` JSON and/or `update` operations JSON; `notifyUsers` false needs administer permission. Returns `id`, `key`, `url`, `issue`. |
| `transitionIssue` | no | `POST issue/{key}/transitions` with a transition id or name, resolved against `GET issue/{key}/transitions` by name then by target status; optional `comment` and screen `fields`. Returns `key`, `id`, `name`, `to`. |
| `addComment` | no | `POST issue/{key}/comment` with `body`. Returns `id`, `created`, `updated`, `author`, `self`, `url`. |
| `assignIssue` | yes | `PUT issue/{key}/assignee` with `accountId`; blank or `null` unassigns, `-1` picks the project default. Returns `key`, `accountId`. |
| `getIssue` | yes | `GET issue/{key}` with optional `fields` (default `*navigable`). Returns the issue flattened: `summary`, `status`, `statusCategory`, `issueType`, `priority`, `assignee`, `reporter`, `project`, `labels`, `created`, `updated`, `resolution`, `descriptionText`, plus the raw `issue`. |
| `searchIssues` | yes | `GET search/jql` with `jql`, optional `fields` and `maxResults` (1 to 5000, default 50), paging with `nextPageToken`. A bare `ORDER BY` is bounded with `created >= "1970-01-01"`. Returns `issues`, `count`, `isLast`, `nextPageToken`. |
| `listTransitions` | yes | `GET issue/{key}/transitions`. Returns `transitions` (`id`, `name`, `to`, `hasScreen`, `isAvailable`) and `count`. |
| `listProjects` | yes | `GET project/search?orderBy=key`, paging on `startAt`, with optional `query` and `typeKey`. Returns `projects` (`id`, `key`, `name`, `projectTypeKey`, `simplified`, `style`, `url`) and `count`. |
| `getCurrentUser` | yes | `GET myself`. Returns `accountId`, `accountType`, `displayName`, `emailAddress`, `active`, `timeZone`, `locale`, `self`. |

## Checks

From the repository root, with the package built:

```sh
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/jira/dist/index.js --mock --receipt packages/jira/verified.json
```

`packages/jira/scripts/check.sh` runs exactly this. Tests make no network
calls: the client takes an injected `fetch`, clock, sleep and jitter, and the
JQL date formatter is tested against fixed time zones.

`packages/jira/scripts/check-live.sh` exits 0 with a note when
`JIRA_SITE_URL`, `JIRA_EMAIL` or `JIRA_API_TOKEN` is unset. With all three it
reads `myself`, five projects and five issues, then one issue and its
transitions when `JIRA_ISSUE_KEY` is set, and finally runs
`vorn-connector check --live` against the built package. `JIRA_ISSUE_KEY`
also fills the live samples of `getIssue` and `listTransitions`. Nothing is
created, edited, assigned, transitioned or commented.

## Built from

The REST API v3 reference and Atlassian's support pages were the only sources.

- REST API v3 introduction: https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/
- Basic auth for REST APIs: https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/
- API tokens: https://id.atlassian.com/manage-profile/security/api-tokens (how-to: https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/)
- Rate limiting: https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
- Issue search: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
- Issues: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
- Issue comments: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/
- Projects: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/
- Myself: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/
- Atlassian Document Format: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
- JQL: https://support.atlassian.com/jira-software-cloud/docs/use-advanced-search-with-jira-query-language-jql/ (fields: https://support.atlassian.com/jira-software-cloud/docs/jql-fields/, operators: https://support.atlassian.com/jira-software-cloud/docs/jql-operators/)
- OpenAPI document the reference pages are rendered from: https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json
