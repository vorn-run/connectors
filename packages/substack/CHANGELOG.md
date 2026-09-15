# Changelog

All notable changes to `@vornrun/connector-substack`.

## 0.2.3

Likes, restacks and comments reach any post, and a Note can carry a link card.

- **`setPostLike`, `setPostRestack` and `commentOnPost`** send their request to `substack.com` by post id, the way Substack's own reader does, instead of to the post's publication. A post on a publication's own domain now works: it is looked up at its own address without the signed-in window, then liked, restacked or commented on through substack.com. Before, such a post was refused, and its substack.com address failed after redirecting. `publication` now only finds a post given by slug.
- **`postNote`** takes an optional `link`, an https address shown as a preview card under the Note. The card is made first with `POST substack.com/api/v1/comment/attachment` (`{ url, type: "link" }`), as the Note composer does with a pasted link, and its id goes in the Note's `attachmentIds`. When Substack makes no card, nothing is posted. Without `link` the request is unchanged.

The attachment call and its answer (`id`, `type`, `linkMetadata`) and the post actions' substack.com paths were read from Substack's own web app on 2026-09-15; the attachment was then created once on the author's account without posting a Note.

## 0.2.2

Pictures in drafts, and one action a workflow can run every week against the same draft.

- **`uploadImage`** uploads a JPEG or PNG from this computer with `POST /api/v1/image` and returns its `url`, `width`, `height`, `bytes` and `contentType`. The file is sent as a data address inside the request, so one whose body would pass 1,000,000 bytes (about 730 KB) is refused before it is read: the signed-in window carries at most 1 MiB.
- **`saveDraft`** updates the draft its `draftId` names, or saves a new one when the id is empty or 0 (what the SDK reads an empty template as), or names a draft since deleted or published. `coverImage` sets the draft's cover. It returns `id`, `title`, `editUrl` and `created`.
- **Markdown:** a paragraph holding nothing but a picture on Substack's own storage becomes the editor's picture block; any other picture still becomes a link.

The upload route and its answer, the picture block and the `cover_image` field were read from Substack's own editor and from a published post's body on 2026-09-14, then checked on a throwaway draft on the author's publication, which was deleted.

## 0.2.1

Speaks Vorn's own connector protocol instead of MCP, so it needs Vorn 0.7.1-beta.3 or later. Action arguments arrive as typed values.

## 0.2.0

Adds the whole archive and a single post's body, so a workflow can check what
a publication already said, plus Notes, likes and restacks on posts, updating
a draft, and the subscriber count.

- **Actions:** `listPosts` (the archive, newest first, up to 500), `getPost`
  (one post's full body as HTML and text), `updateDraft` (replace a draft's
  title, subtitle and body; a published post is refused), `postNote`,
  `readNotes`, `deleteNote`, `setPostLike`, `setPostRestack` (posts only) and
  `readSubscriberCount`.
- **The publishing guard** still refuses every request path containing
  `publish` or `schedule`, with one exception: a `GET` to
  `/api/v1/publish-dashboard/`, the dashboard's read-only figures. Nothing
  here publishes or schedules.

Each new request was made from a signed-in browser on 2026-09-12 against the
author's own publication, and then every new action ran live through the built
package against it, with every write undone: a draft saved, updated and
deleted, a Note posted and deleted, a like and a restack each made and taken
back. `updateDraft` changed the draft's title, subtitle and body as sent.
`readSubscriberCount` reports the dashboard's total as `subscribers`, from the
summary's `totalEmail`, and the summary's own `subscribers`, which counts paid
subscribers only, as `paidSubscribers`.

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
