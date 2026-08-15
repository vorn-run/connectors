# @vornrun/connector-ado

Trigger Vorn workflows from the work items an Azure DevOps WIQL query returns,
and create or update work items from a workflow step.

## Signing in

There is no token to paste. This connector uses whatever Azure identity you
already have — if `az login` works in your terminal, this works:

```sh
brew install azure-cli   # or see https://learn.microsoft.com/cli/azure
az login
```

The credential is resolved on demand through `@azure/identity`, so it lives
wherever the Azure CLI keeps it and renews on its own. Nothing long-lived is
stored in the connection.

## Settings

| Field | Required | What it does |
| --- | --- | --- |
| `organization` | yes | Name or URL, e.g. `contoso` or `https://dev.azure.com/contoso` |
| `project` | yes | Project name |
| `query` | yes | The WIQL query to poll |
| `top` | no | Upper bound on work items read in one poll |

## Trigger

**Work item matches the query.** Each work item the query newly returns starts
one workflow run, once. For example:

```sql
SELECT [System.Id] FROM WorkItems
WHERE [System.State] = 'New' AND [System.AssignedTo] = @Me
ORDER BY [System.ChangedDate] DESC
```

A workflow step can then read `{{trigger.item.title}}`, `.status`, `.url` and
the rest.

The query is not given a time window. Azure DevOps returns whatever the WIQL
asks for, and the connector's `timestamp` dedupe decides what is new from each
item's changed date — including the items sharing the newest instant, which a
plain `>` comparison would drop forever.

## Actions

| Action | What it does |
| --- | --- |
| `createWorkItem` | Add a work item to the board; returns its id and url |
| `updateWorkItem` | Change title, state, description or assignee |

`updateWorkItem` is idempotent — it sets fields to the values you give it, so
repeating the call lands in the same place. `createWorkItem` is not: calling it
twice creates two work items.

## Built from

Azure DevOps REST API, via the maintained
[`azure-devops-node-api`](https://github.com/microsoft/azure-devops-node-api)
client:

- [Work Item Tracking](https://learn.microsoft.com/rest/api/azure/devops/wit/)
- [WIQL](https://learn.microsoft.com/azure/devops/boards/queries/wiql-syntax)
