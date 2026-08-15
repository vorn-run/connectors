# @vornrun/connector-linear

Trigger Vorn workflows from Linear issues, and comment on, create or close them
from a workflow step.

## Signing in

Create a personal API key at [linear.app/settings/api](https://linear.app/settings/api)
and paste it into the connection. It is stored encrypted by Vorn, in the OS
keychain, and never printed.

A personal key acts as you and needs nobody's approval to create. There is no
Linear CLI to borrow a login from, which is why this connector asks for a secret
where `ado`, `kusto` and `github` do not.

## Settings

| Field | Required | What it does |
| --- | --- | --- |
| `apiKey` | yes | Personal API key from linear.app/settings/api |
| `teamKey` | no | Upper-case key such as `ENG`. Blank for every team you can see. |
| `stateType` | no | One of `backlog`, `unstarted`, `started`, `completed`, `canceled`. Blank for all. |
| `limit` | no | Upper bound on issues read in one poll |

## Trigger

**An issue is created or changed.** Fires for each issue the query returns that
Vorn has not already seen at that timestamp.

Status is mapped from Linear's state **type**, not its name, so a team can
rename "In Progress" to anything it likes and the mapping still holds:

| Linear state type | Task status |
| --- | --- |
| `backlog`, `unstarted` | `todo` |
| `started` | `in_progress` |
| `completed` | `done` |
| `canceled` | `cancelled` |

## Actions

| Action | What it does |
| --- | --- |
| `commentOnIssue` | Post a comment; takes an identifier such as `ENG-123` |
| `createIssue` | Open an issue; returns its identifier and url |
| `closeIssue` | Move an issue to the first completed state its team defines |

`closeIssue` is idempotent — closing a closed issue leaves it closed. The other
two are not: calling them twice writes twice.

## Built from

Linear's [GraphQL API](https://linear.app/developers/graphql), queried directly
rather than through their SDK.

The SDK is a generated client over the whole schema — megabytes of types for the
four queries and three mutations this needs — and because Vorn launches a
connector with `npx -y`, that download would be paid on every cold start rather
than once at install. The house rule is to prefer the vendor's SDK; this is the
documented exception, and the reason is in `src/client.ts`.

The API key is sent as a raw `Authorization` header with **no `Bearer` prefix**,
which is what Linear expects for personal keys.
