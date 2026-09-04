# Changelog

All notable changes to `@vornrun/connector-notion`.

## 0.1.1

Declares how it signs in: it asks for an integration token, so the app can say
so before anyone installs it. Ships a conformance receipt.

## 0.1.0

First release.

Trigger a workflow when a Notion database page changes, and let a workflow step
create and update pages.

- **Trigger:** `pageChanged`.
- **Actions:** `createPage`, `updatePage`, `findPages`.
- **Signing in:** paste a Notion integration token, then share the pages you
  want it to see with the connection in Notion. There is no Notion CLI to sign
  in with, which is why this one asks for a secret when most others do not.

Retries are jittered, because Notion's rate limit is shared across everyone
using the workspace — an unjittered retry from several connections lines them
up rather than spreading them out.
