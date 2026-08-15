# Changelog

All notable changes to `@vornrun/connector-ado`.

## 0.2.0

Azure DevOps can now write, not just watch.

- **Actions added:** `createWorkItem`, `updateWorkItem`.
- The connector wears its own mark in the catalog rather than borrowing a
  generic one.

## 0.1.0

First release.

Trigger a workflow from the work items a WIQL query returns.

- **Trigger:** `workItem`. Each work item the query returns starts one run, once.
- **Signing in:** uses your Azure identity. If `az login` works in your
  terminal, this works — there is no token to create or paste.
