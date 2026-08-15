# Changelog

All notable changes to `@vornrun/connector-linear`.

## 0.1.0

First release.

Trigger a workflow from Linear issues, and let a workflow step write back.

- **Trigger:** `issueCreated`.
- **Actions:** `commentOnIssue`, `createIssue`, `closeIssue`.
- **Signing in:** a Linear personal API key, created at
  linear.app/settings/api.

Status is mapped from Linear's state *type* rather than its name, so a team can
rename "In Progress" to whatever it likes without breaking the mapping.

Built against Linear's GraphQL API directly rather than on their SDK. The SDK is
a generated client over the whole schema — megabytes of types for the four
queries and three mutations this needs — and `npx` pays that download on every
launch.
