# Changelog

All notable changes to `@vornrun/connector-github`.

## 0.3.0

Code review from a workflow step.

- **Read:** `getPullRequest` (with each reviewer's latest verdict), `listPullRequestFiles` (with diffs), `listPullRequestComments` (line comments and conversation).
- **Say:** `commentOnPullRequest` (conversation, a line or a whole file, or a reply), `reviewPullRequest` (approve, request changes or comment, with line comments, as one review), `requestReviewers`.
- **Merge:** `mergePullRequest` — squash, merge or rebase, refused if anything was pushed after the reviewed `sha`, deleting the branch unless told to keep it. Branch protection's refusal comes back in GitHub's words.

## 0.2.1

Speaks Vorn's own connector protocol instead of MCP, so it needs Vorn 0.7.1-beta.3 or later. Action arguments arrive as typed values.

## 0.2.0

Add the **Open a pull request** action: head branch, base (default `main`), title, description and draft; returns the number and URL.

## 0.1.2

Read the version from the bundle instead of a package.json the packed connector does not carry.

## 0.1.1

Declares how it signs in: it borrows the GitHub CLI's login, so the app can say
so before anyone installs it. Ships a conformance receipt.

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
