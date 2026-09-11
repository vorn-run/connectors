# @vornrun/connector-substack

Trigger Vorn workflows from new posts on a Substack publication, and read a
feed, search posts, read comments, save a draft, comment, and like or delete
comments from a workflow step. Substack publishes no API for any of this, so
the connector reads the public RSS feed and asks the same web endpoints
Substack's own pages use, from inside a window you signed in to.

## Signing in

Connect, then sign in to Substack in the window Vorn opens. The window runs
on a browser profile kept for this connection alone. Vorn keeps that
profile, not a password and not a copied cookie, and the connection's row
says who is signed in. A sign-in link Substack emails opens in your default
browser; paste it into the connection's sign-in link field instead.

The connector never sees a cookie. Each signed-in call runs inside that
window as a request from Substack's own page, on `substack.com` or a
`*.substack.com` publication, and Vorn refuses any other address.

When Substack signs the window out, a workflow step that needed it waits as
"waiting for sign-in" until you sign in again, then runs again. When Vorn is
closed on the desktop that signed in, the step fails and says to open it.

Reading a feed, searching posts and reading the comments on a public post
need no sign-in.

## Settings

| Setting | Env | What it is |
| --- | --- | --- |
| `publication` | `SUBSTACK_PUBLICATION` | Your publication's substack.com subdomain, such as `novumai`. The `newPost` trigger reads its feed, and a step that names no publication uses it. When it is empty, signed-in actions use the account's primary publication. |

## It never publishes

Publishing a post emails every subscriber, so nothing here publishes or
schedules. `createDraft` saves a draft and returns the address to open it in
the editor, where you publish it yourself. Any request path containing
`publish` or `schedule` is refused before it leaves, and `deleteDraft` reads
the draft first and refuses a published post.

## Substack's terms

Substack's [terms of use](https://substack.com/tos) forbid automated crawling
and unattended processes. Keep the signed-in actions in workflows you start,
and poll the feed no more often than a reader would.

## Triggers

### `newPost` — a post appears in the publication's feed

Reads `https://<publication>/feed` over plain HTTPS without signing in, on the
SDK's `timestamp` dedupe from each item's `pubDate`. The feed holds about the
last twenty posts, so a burst larger than that between polls loses the
oldest. Each item carries `externalId` (the guid, which is the post's
address), `title`, `url`, `description` (the subtitle), `assignee` (the
author) and `updatedAt`, plus `subtitle`, `author`, `publishedAt` and `text`
for templates.

## Actions

| Action | Idempotent | Signed in | What it does |
| --- | --- | --- | --- |
| `readFeed` | yes | no | `GET https://<publication>/feed`, for any publication, a custom domain included. `limit` from 1 to 20, default 10. Returns `publication`, `count` and `posts` (`id`, `title`, `subtitle`, `url`, `author`, `publishedAt`, `html`, `text`). |
| `searchPosts` | yes | no | `GET substack.com/api/v1/post/search` with `query` and `page` (from 0). Returns `count`, `more` and `posts` (`id`, `title`, `subtitle`, `url`, `publishedAt`, `author`, `authorHandle`, `likes`, `comments`, `publicationId`). |
| `readComments` | yes | no | Looks the post up by address or slug (`GET /api/v1/posts/<slug>`) unless given `postId`, then `GET /api/v1/post/<id>/comments?all_comments=true&sort=newest_first`. Returns `postId`, `count` and `comments` (`id`, `body`, `author`, `handle`, `date`, `likes`, `parentId`, `replies`), each reply after the comment it answers. |
| `createDraft` | no | yes | `GET substack.com/api/v1/user/profile/self` for the byline, then `POST /api/v1/drafts` on the publication with the markdown body converted to the editor's document. Returns `id`, `title` and `editUrl`. |
| `deleteDraft` | no | yes | `GET`, then `DELETE /api/v1/drafts/<id>`; a published post is refused. Returns `deleted`. |
| `commentOnPost` | no | yes | `POST /api/v1/post/<id>/comment` with `{ body }`. Returns `id` and `postId`. |
| `setCommentLike` | yes | yes | `POST` to like or `DELETE` to unlike `/api/v1/comment/<id>/reaction`, with `{ reaction: "❤" }`. Returns `liked`. |
| `deleteComment` | no | yes | `DELETE /api/v1/comment/<id>`. Returns `deleted`. |

Writes stay on `*.substack.com`. A publication on a custom domain can be read
at its own address, but a comment on one of its posts is refused; write to it
at its substack.com address instead.

### Markdown in a draft

Headings, paragraphs, bullet and numbered lists, quotes, code blocks, rules,
line breaks, bold, italic, inline code, strikethrough and links carry over,
under the node and mark names Substack's editor saved when each was pasted
into a draft. A picture becomes a link to it, because uploading one is the
editor's job. A table becomes one line per row, and a script or data link
keeps its words without being clickable.

## Checks

```sh
packages/substack/scripts/check.sh   # typecheck, tests, build, conformance receipt
```

Tests make no network calls. Plain and signed-in fetches are separate stubs,
so each test also says which calls went through the window. There is no live
check: every signed-in action needs the Vorn window, which the SDK's live
check skips.

## Built from

Substack publishes no API reference. Every request here was made from a
signed-in browser on 2026-09-10 against the author's own publication, and
each write was undone.

- `GET substack.com/api/v1/user/profile/self` answers 200 with `id`, `name`,
  `handle` and `publicationUsers` when signed in, and 401 when not.
- `/feed` is RSS 2.0 with `guid`, `pubDate`, `dc:creator` and
  `content:encoded`.
- Search, comments and a post by slug answer without a sign-in.
- `POST /api/v1/drafts` answers 400 `draft_bylines Invalid value` without a
  byline and 200 with one. A deleted draft then reads back 404.
- Commenting, liking and deleting a comment are the requests listed above.
