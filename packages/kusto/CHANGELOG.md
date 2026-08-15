# Changelog

All notable changes to `@vornrun/connector-kusto`.

## 0.6.0

Trigger a workflow from the rows an Azure Data Explorer (Kusto) query returns.

- **Trigger:** `queryResult`. Every column the query projects is available to
  the workflow as `{{trigger.item.<Column>}}`.
- **Action:** `runQuery`.
- **Signing in:** uses your Azure identity. If `az login` works in your
  terminal, this works.

The poll window is bound as a KQL query parameter, never interpolated into the
query text. The query is user-supplied, so interpolating would be a KQL
injection with the connector's credentials behind it:

```kql
declare query_parameters(vorn_since:datetime, vorn_limit:long);
```

Built on `azure-kusto-data` after a hand-rolled REST client produced three bugs.
