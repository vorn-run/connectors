# Changelog

All notable changes to `@vornrun/connector-github`.

## 0.1.0

First release.

Trigger a workflow from GitHub issues and pull requests, and let a workflow
step write back.

- **Triggers:** `issueCreated`, `prOpened`.
- **Actions:** `createIssue`, `closeIssue`, `commentOnIssue`.
- **Signing in:** borrows the GitHub CLI's login. `gh auth login` is all it
  needs, and no token is stored here — `gh` owns it, and it renews on its own.

Paging resumes across restarts: GitHub's search API caps a query at 1,000
results and pages by an opaque cursor, so the connector keeps its own
`{since, page}` position rather than asking for everything since a timestamp.
