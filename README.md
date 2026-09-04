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
templates/           workflows a new workflow can start from
catalog.json         the list the app offers under Connections → Add
scripts/             repository checks run in CI
```

`catalog.json` is generated from the connectors themselves — each one's id,
icon, triggers, actions and the settings it will ask for come out of its own
manifest, so the list cannot advertise a trigger that has since been renamed.
Run `node scripts/build-catalog.mjs` after changing a connector; CI checks the
committed file still matches.

## Contribute a template

A template is a starting point for a new workflow: someone picks it instead of
an empty canvas and gets a wired one, with anything it still needs — a
connection, an HTTP profile — named on the step that wants it.

Templates are exported workflows, so building one is building a workflow:

1. Build it in Vorn and run it, so you know it works.
2. **Export as file** from the workflow's menu.
3. Add the file to `templates/` and give it a `meta` block:

```json
{
  "meta": {
    "id": "morning-digest",
    "name": "Morning digest",
    "description": "Every weekday morning, gather what changed overnight and have an agent write it up.",
    "steps": ["Schedule", "Script", "Agent"],
    "category": "Reporting"
  },
  "version": 1,
  "...": "the rest of the exported file, unchanged"
}
```

The filename is `<id>.vorn-workflow.json`, and `meta.steps` is the chain as
someone scanning the list would read it.

4. Run `node scripts/check-templates.mjs`, then
   `node scripts/build-catalog.mjs` to put it in the catalog, and commit both.

Export already replaces your paths with `{{project.path}}` and leaves connection
ids and webhook tokens behind — each install resolves its own. CI checks that
again: a machine path, a published token, or a step type the app cannot draw
fails the build rather than reaching anyone.

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

Every connector declares how it signs in, and the check refuses one that does not:

```ts
auth: { rung: 'cli', probe: { command: 'gh', args: ['auth', 'status'] } }
```

`none` needs nothing, `cli` borrows a login the machine already has, `key` names
the config fields holding it. The app shows the rung on the row, so someone
browsing knows what a connector will ask of them before installing it.

## Conformance

```bash
yarn build
yarn conformance     # runs each connector against the mock, writes verified.json
```

The receipt is committed beside the connector and quoted in the catalog as the
verified badge, so it names checks a reader can see. CI re-runs the same checks
and compares them with the committed receipt rather than writing a new one — a
file rewritten on every run would carry a new timestamp and leave the catalog
disagreeing with the commit it came from.

A connector whose releases carry a packed `.tgz` asset sets `"packs": true` in
its `"vorn"` block; the catalog then addresses the pack directly instead of the
package name. Leave it off until the release actually uploads one, because the
app prefers that address over npm.

Write the implementation from the service's own published API documentation, and
link to it in the package README so the next person can check it. Existing
implementations elsewhere are not a source: licences vary, and the vendor's
reference gets you to the same place without the question.
