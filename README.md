# Vorn connectors

A connector is how a [Vorn](https://github.com/vorn-run/vorn) workflow reaches
outside itself. It watches a system for something happening — a work item moving
into a state, a query starting to return rows — and starts a workflow run when it
does. Some connectors also expose actions a workflow step can call back out to.

Each connector is a separate npm package. Vorn launches one on demand with
`npx -y <package>`, so a connector is never bundled into the app and ships on its
own schedule: a fix to a query reaches you without waiting for an app release.

## Available connectors

| Connector | Package | Fires when |
| --- | --- | --- |
| Azure DevOps | `@vornrun/connector-ado` | a work item matches your WIQL query |
| Azure Data Explorer | `@vornrun/connector-kusto` | a row comes back from your KQL query |

## Using one

In Vorn, open **Connections → Add**, pick a connector, and fill in the fields it
asks for. Nothing to install by hand.

Both Azure connectors use whatever Azure credential you already have — if
`az login` works in your terminal, the connector works. There is no token to
create or paste, and nothing long-lived is stored.

**Azure DevOps** asks for an organization (`contoso`, or the URL from your
browser), a project, and a WIQL query. For example:

```sql
SELECT [System.Id] FROM WorkItems
WHERE [System.State] = 'New' AND [System.AssignedTo] = @Me
ORDER BY [System.ChangedDate] DESC
```

Each work item the query returns starts one workflow run, once. A workflow step
can then read `{{trigger.item.title}}`, `.status`, `.url` and the rest.

**Azure Data Explorer** asks for a cluster (`help`, or a full URL), a database,
and a KQL query. Your query is handed two parameters:

```kql
Alerts
| where FiredAt >= vorn_since
| project Id, Timestamp = FiredAt, Title, Severity
| take vorn_limit
```

`vorn_since` is the watermark — the newest row already seen — so the query only
returns what is new. Every column you project is available to the workflow as
`{{trigger.item.<Column>}}`. Tell the connector which columns carry the row's id
and timestamp if they are not called `Id` and `Timestamp`.

## Layout

```
packages/<name>/     one npm package per connector
catalog.json         the list the app offers under Connections → Add
scripts/             repository checks run in CI
```

`catalog.json` is generated from the connectors themselves — each one's id,
icon, triggers, actions and the settings it will ask for come out of its own
manifest, so the list cannot advertise a trigger that has since been renamed.
Run `node scripts/build-catalog.mjs` after changing a connector; CI checks the
committed file still matches.

## Developing

```bash
yarn install
yarn workspace @vornrun/connector-<name> test     # unit tests, with coverage
yarn workspace @vornrun/connector-<name> build
```

Connectors are built on
[`@vornrun/connector-sdk`](https://www.npmjs.com/package/@vornrun/connector-sdk),
which is versioned alongside the app because it is the contract between them.
You describe the connector; the SDK runs the server, polls on a timer, and keeps
the cursor that stops an item being delivered twice.

```ts
import { defineConnector } from '@vornrun/connector-sdk'

export const connector = defineConnector({
  id: 'example',
  name: 'Example',
  description: 'Trigger workflows from things that happened.',
  config: [{ key: 'token', env: 'EXAMPLE_TOKEN', label: 'API token', required: true }],
  triggers: [
    {
      type: 'thing',
      label: 'A thing happened',
      dedupe: 'timestamp',
      async fetch({ config, since }) {
        return [{ externalId: '1', title: 'A thing', updatedAt: new Date().toISOString() }]
      }
    }
  ]
})
```

`createConnectorHarness` from the same package runs a connector in-process, so a
test can poll it and assert on real items without spawning anything.

## Adding a connector

Add `packages/<id>/`, then run `yarn build && node scripts/build-catalog.mjs` to
put it in the catalog. Anything the manifest has no opinion about — the category
it lists under, the words people will search for, one line on how it signs in —
goes in that package's `package.json` under `"vorn"`.

Tests run with coverage thresholds, and `node scripts/check-packages.mjs` checks
the package is wired into the build the same way the others are. CI runs both.

Write the implementation from the service's own published API documentation, and
link to it in the package README so the next person can check it. Existing
implementations elsewhere are not a source: licences vary, and the vendor's
reference gets you to the same place without the question.
