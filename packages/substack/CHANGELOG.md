# Changelog

All notable changes to `@vornrun/connector-substack`.

## 0.1.0

First release.

Trigger a workflow from new posts on a Substack publication, and let a
workflow step read any publication's feed, search posts, read a post's
comments, save a draft from markdown, comment on a post, like or unlike a
comment, and delete a draft or a comment.

- **Trigger:** `newPost`, from the publication's RSS feed.
- **Actions:** `readFeed`, `searchPosts`, `readComments`, `createDraft`,
  `deleteDraft`, `commentOnPost`, `setCommentLike`, `deleteComment`.
- **Signing in:** the first connector on the `browser` rung. Vorn opens a
  window on a browser profile kept for the connection alone, and every
  signed-in call runs inside that window as a request from Substack's own
  page. No cookie or password reaches the connector.

Substack publishes no API, so the connector reads the public RSS feed and
asks the web endpoints Substack's pages use, each one checked from a
signed-in browser on 2026-09-10 against the author's own publication.
Reading the feed, searching and reading comments on a public post need no
sign-in. Writes stay on `*.substack.com`.

It never publishes or schedules, because publishing emails every
subscriber: any request path containing `publish` or `schedule` is refused
before it leaves, and `deleteDraft` refuses a published post. Draft bodies
are markdown converted to the editor's own document, using only the node and
mark names Substack's editor saved.

Needs the Vorn release that adds browser sign-in; an older Vorn does not
list the connector. Ships as a pack with a conformance receipt covering the
dedupe replay of the trigger and the mock run of every action. `marked`
travels inside the bundle; no runtime dependencies.
