# @vornrun/connector-substack

Trigger Vorn workflows from new posts on a Substack publication, and read a
feed or the whole archive, search and read posts, read comments, save and
update drafts, comment, like and restack posts, and post and read Notes from a
workflow step. Substack publishes no API for any of this, so
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

Reading a feed or the archive, searching posts, reading one post and reading
the comments on a public post need no sign-in.

## Settings

| Setting | Env | What it is |
| --- | --- | --- |
| `publication` | `SUBSTACK_PUBLICATION` | Your publication's substack.com subdomain, such as `exampleletter`. The `newPost` trigger reads its feed, and a step that names no publication uses it. When it is empty, signed-in actions use the account's primary publication. |

## It never publishes

Publishing a post emails every subscriber, so nothing here publishes or
schedules. `createDraft` and `saveDraft` save a draft and return the address
to open it in the editor, where you publish it yourself. Any request path containing
`publish` or `schedule` is refused before it leaves, and `deleteDraft` and
`updateDraft` read the draft first and refuse a published post; `saveDraft`
saves a new draft instead of touching one. The one
exception to the guard is a `GET` to `/api/v1/publish-dashboard/`, the
dashboard's read-only figures that `readSubscriberCount` reads.

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
| `listPosts` | yes | no | `GET /api/v1/archive?sort=new&limit=25&offset=<n>` on the publication, a page at a time until a page comes back short or `limit` is reached (1 to 500, default 50). Returns `publication`, `count` and `posts` (`id`, `title`, `subtitle`, `slug`, `url`, `publishedAt`, `audience`). |
| `getPost` | yes | no | `GET /api/v1/posts/<slug>` for the post given by address, or by slug on the publication. Returns the fields `listPosts` gives plus `wordcount`, `html`, `text`, `likes` and `restacks`. |
| `createDraft` | no | yes | `GET substack.com/api/v1/user/profile/self` for the byline, then `POST /api/v1/drafts` on the publication with the markdown body converted to the editor's document. Returns `id`, `title` and `editUrl`. |
| `updateDraft` | no | yes | `GET substack.com/api/v1/user/profile/self` for the byline, `GET /api/v1/drafts/<id>` to refuse a published post, then `PUT /api/v1/drafts/<id>` with the new title, subtitle and markdown body. Returns `updated`, `id`, `title` and `editUrl`. |
| `saveDraft` | no | yes | `GET substack.com/api/v1/user/profile/self` for the byline. With a `draftId` that is not empty or 0, `GET /api/v1/drafts/<id>`: when it is still an unpublished draft, `PUT /api/v1/drafts/<id>` with the new title, subtitle and markdown body. Otherwise, a 404 or a published post included, `POST /api/v1/drafts` saves a new one. `coverImage`, when given, is sent as the draft's `cover_image`; when empty the cover is left as it is. Returns `id`, `title`, `editUrl` and `created`. |
| `deleteDraft` | no | yes | `GET`, then `DELETE /api/v1/drafts/<id>`; a published post is refused. Returns `deleted`. |
| `uploadImage` | no | yes | Reads `file` (a JPEG or PNG, absolute or starting `~/`), then `POST /api/v1/image` on the publication with `{ image: "data:<type>;base64,…" }`. A file whose body would pass 1,000,000 bytes, about 730 KB, is refused before it is read, since the signed-in window carries at most 1 MiB. Returns `url`, `width`, `height`, `bytes` and `contentType`. |
| `commentOnPost` | no | yes | `POST /api/v1/post/<id>/comment` with `{ body }`. Returns `id` and `postId`. |
| `setCommentLike` | yes | yes | `POST` to like or `DELETE` to unlike `/api/v1/comment/<id>/reaction`, with `{ reaction: "❤" }`. Returns `liked`. |
| `deleteComment` | no | yes | `DELETE /api/v1/comment/<id>`. Returns `deleted`. |
| `setPostLike` | no | yes | `POST` to like or `DELETE` to unlike `/api/v1/post/<id>/reaction`, with `{ reaction: "❤" }`. Returns `postId` and `liked`. |
| `setPostRestack` | no | yes | `POST` to restack or `DELETE` to undo `/api/v1/restack/feed`, with `{ postId, commentId: null }`. Posts only. Returns `postId` and `restacked`. |
| `postNote` | no | yes | `GET substack.com/api/v1/user/profile/self` for the handle, then `POST substack.com/api/v1/comment/feed` with the markdown as the editor's document under `attrs.schemaVersion: "v1"`, plus `tabId: "for-you"`, `surface: "feed"` and `replyMinimumRole: "everyone"`. Returns `id` and `url`. |
| `readNotes` | yes | yes | Resolves a handle with `GET substack.com/api/v1/user/<handle>/public_profile`, or takes the signed-in account, then follows `nextCursor` through `GET substack.com/api/v1/reader/feed/profile/<userId>` for up to ten pages, keeping the items that are Notes. `limit` from 1 to 100, default 20. Returns `profile`, `count` and `notes` (`id`, `body`, `url`, `date`, `likes`, `restacks`). |
| `deleteNote` | no | yes | `DELETE substack.com/api/v1/comment/<id>`. Returns `deleted`. |
| `readSubscriberCount` | yes | yes | `GET /api/v1/publish-dashboard/summary` on your publication. Returns `subscribers` (every subscriber, free and paid, from the summary's `totalEmail`, the count the dashboard shows), `paidSubscribers` (from the summary's `subscribers`, which counts paid ones only), `appSubscribers`, `views` and `openRate`, as the summary reports them. |

Writes stay on `*.substack.com`. A publication on a custom domain can be read
at its own address, but a comment on one of its posts is refused; write to it
at its substack.com address instead.

### Markdown in a draft

Headings, paragraphs, bullet and numbered lists, quotes, code blocks, rules,
line breaks, bold, italic, inline code, strikethrough and links carry over,
under the node and mark names Substack's editor saved when each was pasted
into a draft. A paragraph holding nothing but a picture on
`substack-post-media.s3.amazonaws.com` or `substackcdn.com`, which is where
`uploadImage` puts one, becomes the editor's picture block (`captionedImage`
holding `image2`), its width and height read from the size Substack writes
into the file name. Any other picture becomes a link to it. A table becomes one line per row, and a script or data link
keeps its words without being clickable.

## Checks

```sh
packages/substack/scripts/check.sh   # typecheck, tests, build, conformance receipt
```

Tests make no network calls. Plain and signed-in fetches are separate stubs,
so each test also says which calls went through the window. There is no live
check: every signed-in action needs the Vorn window, which the SDK's live
check skips. The receipt leaves out `mock`, because the check hands every
input a placeholder and `uploadImage` refuses a placeholder `file` that is not
absolute before it reads anything; its tests upload from a scratch folder.

## Built from

Substack publishes no API reference. Every request here was made from a
signed-in browser against the author's own publication, and each write was
undone. On 2026-09-10:

- `GET substack.com/api/v1/user/profile/self` answers 200 with `id`, `name`,
  `handle` and `publicationUsers` when signed in, and 401 when not.
- `/feed` is RSS 2.0 with `guid`, `pubDate`, `dc:creator` and
  `content:encoded`.
- Search, comments and a post by slug answer without a sign-in.
- `POST /api/v1/drafts` answers 400 `draft_bylines Invalid value` without a
  byline and 200 with one. A deleted draft then reads back 404.
- Commenting, liking and deleting a comment are the requests listed above.

On 2026-09-12:

- The archive pages with `offset`, and `/api/v1/posts/<slug>` carries the
  whole `body_html`, `reactions` and `restacks`.
- A Note posted with `POST /api/v1/comment/feed` showed on the profile feed as
  a `comment` item whose `context.type` is `note`, and
  `DELETE substack.com/api/v1/comment/<id>` removed it.
- Liking a post and restacking it, then taking both back, are the requests
  listed above; the post read back unliked and unrestacked.
- The dashboard reads its figures with `GET /api/v1/publish-dashboard/summary`.
  Its `subscribers` is the paid count (0 on the author's publication) and its
  `totalEmail` the total (29, the dashboard's "29 subscribers").
- Then all nine new actions ran through the built package against the same
  publication, and everything was put back. `updateDraft`'s `PUT` changed the
  draft's title, subtitle and body as sent.
