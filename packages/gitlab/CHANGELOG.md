# Changelog

All notable changes to `@vornrun/connector-gitlab`.

## 0.1.1

Read the version from the bundle instead of a package.json the packed connector does not carry.

## 0.1.0

First release.

Trigger a workflow from GitLab issues, merge requests and pipeline results, and
let a workflow step write back. Works against gitlab.com and self-managed
instances.

- **Triggers:** `issueCreated`, `mergeRequestOpened`, `pipelineFinished`.
- **Actions:** `createIssue`, `commentOnIssue`, `commentOnMergeRequest`,
  `getProject`, `listOpenMergeRequests`, `getIssue`.
- **Signing in:** borrows the GitLab CLI's login. `glab auth login` is all it
  needs, and no token is stored here — `glab config get token` supplies it on
  demand. A pasted personal access token is used instead when one is given.

Every action but the merge request list is a declared request the SDK sends,
with the response trimmed to camelCase names; the list is hand-written so it can
answer with a `count` beside its `items`. The three read actions are idempotent
and carry sample arguments (`gitlab-org/gitlab`) so a live check can call them.

The triggers watermark on the field they filter by — `created_at` for issues
and merge requests, `updated_at` for pipelines — and only finished pipelines
are delivered, so one that was running when a poll saw it fires once it ends.
The first poll looks back one minute rather than replaying the project.
Ships a conformance receipt covering the mock run and the dedupe replay.
