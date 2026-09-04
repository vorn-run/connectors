id: postgres

# PostgreSQL connector

PostgreSQL databases reached over the frontend/backend wire protocol on a TCP
socket, encrypted with TLS when the connection string asks for it. There is no
HTTP API: the connector opens its own socket, so the SDK's `fetch` stub never
sees it (consequences under **Checks**).

## Auth

Rung: **key**. There is no CLI login to borrow for a database.

| Config field | Env name | Where it comes from |
| --- | --- | --- |
| `connectionString` | `DATABASE_URL` | Your provider's dashboard (the "connection string" or "URI" it shows for the database), or your DBA. libpq URI form: `postgres://user:password@host:5432/database?sslmode=require` |

Marked `secret: true` and declared as `auth: { rung: 'key', keys: ['connectionString'] }`.

The URI follows the manual's `postgresql://[userspec@][hostspec][/dbname][?paramspec]`,
scheme `postgres://` or `postgresql://`. Parts the connector reads:

| Part | Default | Notes |
| --- | --- | --- |
| user | required | The manual defaults it to the OS user; the connector refuses a URI without one, since the startup message needs it |
| password | none | Percent-encode `@`, `/`, `:`, `?`, `#`, `%` in it, as the manual says for any reserved character |
| host | required | Host name or IP; `[2001:db8::1]` for IPv6. A Unix-socket path is not supported |
| port | `5432` | |
| dbname | the user name | Per the manual |
| `sslmode` | `prefer` | See below |
| `sslrootcert` | none | Path to a PEM CA bundle, or `system` for Node's built-in roots |
| `connect_timeout` | `10` | Seconds; the manual's default is "wait indefinitely", which a poller must not do |
| `application_name` | `vorn-connector-postgres` | Sent in the startup message |

Multiple hosts (`host1:p1,host2:p2`) are rejected with a clear message rather
than half-supported. Any other parameter is ignored.

`sslmode`, following the manual's six values:

| Value | Connector behaviour |
| --- | --- |
| `disable` | Plain TCP, no SSLRequest |
| `allow`, `prefer` | Encrypt when the server offers it, continue in clear when it does not. `allow` is passed to the driver as `prefer`, the only mode it falls back from |
| `require` | SSLRequest; `N` is an error. Certificate not verified (`rejectUnauthorized: false`), which is what the manual says `require` promises: encryption, trusting the network to reach the right server |
| `verify-ca` | As `require`, plus chain verification against `sslrootcert` (or Node's roots). Host name not checked |
| `verify-full` | As `verify-ca`, plus host name matched against the certificate (`servername` = URI host) |

A read-only role is enough for both triggers and for `selectRows`,
`listTables`, `describeTable` and read-only `runQuery`. Only `insertRow`,
`updateRows` and a writing `runQuery` need more.

## Driver: `postgres`, inlined at build time

**What the SDK allows.** `vorn-connector pack` bundles the entry with esbuild
(`bundle: true`, no `external`) and only refuses specifiers *left outside* the
bundle (`runtime-dependencies`, from `bundleDependencyFindings`); `check --mock`
asks the same question of the same bundle. So a driver inlined at build time
passes `no-runtime-deps` and travels inside the pack.

**What is used.** [`postgres`](https://github.com/porsager/postgres) 3.4.9
(Unlicense) is pure JavaScript with no `dependencies` of its own, an ESM entry
and `engines.node >= 12`. It is a devDependency, listed in `tsup.config.ts`
under `noExternal`, so `dist/index.js` carries it and the package declares no
runtime dependency. The packed connector is 222 KB.

**How it is held.** `src/driver.ts` is the only module that knows the driver.
It exports the `SqlClient` surface actually used — `unsafe(text, params)` and
`end()` — so a test hands in its own and no socket is opened, and
`clientFrom` adapts that to the `PgClient` the connector calls. `openConnection`
builds the driver from the parsed connection string; the URI is still parsed by
`src/connection-string.ts`, which names what is wrong in a sentence where the
driver would accept it silently or fail on `new URL`.

Options given to the driver, from the parsed string: `host`, `port`, `user`,
`pass`, `database`, `ssl`, `connect_timeout` in whole seconds, and
`connection.application_name`. Three more are set here:

- `max: 1` and `prepare: false` — one connection per poll or action, opened and
  ended around the work, so a prepared statement would only cost a round trip
  and would break a transaction-pooling proxy.
- `fetch_types: false` — the driver would otherwise query the catalogue on
  connect for array element types. An array column arrives as its text form
  instead, which is what the insert hint already documents.
- `onnotice` — a notice would otherwise be printed to stdout, which is where the
  connector speaks its own protocol to Vorn.

`ssl` per sslmode: `disable` → `false`; `require` and `prefer` → the mode name,
which encrypts without checking the certificate; `allow` → `prefer`, the only
mode the driver falls back from; `verify-ca` and `verify-full` → a
`tls.connect` object with `rejectUnauthorized: true`, `ca` read from
`sslrootcert` unless it is `system`, and for `verify-ca` a
`checkServerIdentity` that returns, which is the manual's definition of
checking the chain but not the name.

Values: parameters go with their type unspecified, so the server casts to the
column's type — `inferType` returns `0` for a string or a number. `undefined`
is sent as NULL and an object or array as JSON text, both in `toParam`, because
the driver would otherwise send `undefined` and `[object Object]`. A `Date`,
a `Buffer` and a `bigint` the driver types itself.

Results are decoded by the driver: `16` bool → boolean; `21`, `23`, `26`,
`700`, `701` → number; `114`, `3802` json/jsonb → parsed; `1082`, `1114`,
`1184` date/timestamp/timestamptz → `Date`; `17` bytea → `Buffer`; `20` int8
and `1700` numeric → the digits as text, so no precision is lost; everything
else the text the server sent; NULL → `null`. A cursor built from a `Date`
column is its ISO 8601 form, which the server casts back on the next poll.

A query resolves to the rows with the command tag alongside; several statements
resolve to an array of those, and `lastResult` takes the last, as libpq
reports a multi-statement query.

Identifiers are always double-quoted with embedded quotes doubled, per the
manual's lexical rules; a `schema.table` is split at the first dot and each
part quoted. Values never enter SQL text.

Layout: `src/connection-string.ts` (URI parsing), `src/driver.ts` (the driver
and everything it is told), `src/sql.ts` (quoting and the statement builders),
`src/connector.ts`, `src/entry.ts`, `src/index.ts`, mirroring `linear`.

## Triggers

Both implement `poll` with their own cursor, because the ordering column may
be an integer and the SDK's `timestamp` strategy compares ISO strings. Every
comparison happens in SQL with the column's own type. Vorn dedupes on
`externalId` on top. Neither trigger declares `sample` (the SDK warns that a
`poll` trigger cannot replay one); the samples below document the shape.

Shared config (all optional at the config level, checked by the trigger that
needs them):

| Field | Env | Used by |
| --- | --- | --- |
| `table` | `PG_TABLE` | `newRows` (required): `table` or `schema.table` |
| `orderingColumn` | `PG_ORDERING_COLUMN` | `newRows` (required): a column that only grows, e.g. `id` or `created_at` |
| `keyColumn` | `PG_KEY_COLUMN` | `newRows` (default: the ordering column), `queryRows` (required): the row's identity |
| `query` | `PG_QUERY` | `queryRows` (required) |
| `cursorColumn` | `PG_CURSOR_COLUMN` | `queryRows` (required): result column the cursor advances from |
| `startFrom` | `PG_START_FROM` | `newRows` (optional), `queryRows` (required): see each trigger |
| `titleColumn` | `PG_TITLE_COLUMN` | both (optional): column used as the item title |
| `limit` | `PG_LIMIT` | both, default `100`; `context.limit` wins when the host sends one |

### `newRows` — new rows in a table

- **Poll, with a cursor:**
  `SELECT * FROM "t" WHERE ("ord", "key") > ($1, $2) ORDER BY "ord", "key" LIMIT $3`
  using the manual's row-wise comparison, so rows that tie on the ordering
  value are separated by the key. When the key is the ordering column it
  collapses to `WHERE "ord" > $1 ORDER BY "ord" LIMIT $2`.
- **First poll:** with `startFrom`, `WHERE "ord" > $1 ORDER BY "ord", "key" LIMIT $2`.
  Without it, `ORDER BY "ord" DESC, "key" DESC LIMIT $1`, reversed: one page,
  newest, and tracking starts there, as the SDK does for its own strategies.
- **Cursor:** `{"v":1,"o":"<ordering value text>","k":"<key text>"}`, the
  server's own text for both, bound back unchanged. `hasMore` when the page
  was full and the query read forward (a cursor or `startFrom`); the newest
  page is where tracking starts, so it never has more.
- **Dedupe key:** `externalId` = the key column's text.
- **Item:** `title` = `titleColumn` value, else `<table> <key>`; `updatedAt` =
  the ordering value when its type OID is timestamp, timestamptz or date,
  else omitted; `data` = the whole row.
- **Sample item:**

```json
{
  "externalId": "1042",
  "title": "orders 1042",
  "updatedAt": "2026-09-04T12:00:00.000Z",
  "data": { "id": 1042, "reference": "A-77", "status": "new", "created_at": "2026-09-04T12:00:00Z" }
}
```

A row the ordering column re-stamps (an `updated_at`) is delivered again with
the same `externalId`, which Vorn drops; this trigger is for inserts.

### `queryRows` — rows matching a query

- **Config:** `query` is a SELECT with `$1` where the cursor goes and,
  optionally, `$2` for the limit, ordered by the cursor column ascending, e.g.
  `SELECT id, title, updated_at FROM tickets WHERE status = 'open' AND updated_at >= $1 ORDER BY updated_at LIMIT $2`.
  `$2` is bound only when the text mentions it (binding a parameter the
  statement has no placeholder for is a server error).
- **Poll:** run the query with `$1` = the cursor value (`startFrom` on the
  first poll), via the extended protocol.
- **Cursor:** `{"v":1,"c":"<cursor value text>","keys":["<key>", ...]}`:
  the largest cursor-column value delivered and the keys delivered at exactly
  that value. Rows at the cursor value whose key is listed are dropped, so a
  query written with `>=` never redelivers a tie and never loses one; the same
  boundary rule as the SDK's timestamp strategy, run by the connector.
- **Dedupe key:** `externalId` = the `keyColumn` value's text. A row with a
  NULL key or NULL cursor column is an error naming the column.
- **Item:** as `newRows`, with `updatedAt` from the cursor column when it is a
  date/time type.
- **Sample item:**

```json
{
  "externalId": "88",
  "title": "Printer on fire",
  "updatedAt": "2026-09-04T09:30:00.000Z",
  "data": { "id": 88, "title": "Printer on fire", "updated_at": "2026-09-04T09:30:00Z" }
}
```

## Actions

Every action opens one connection from `connectionString`, runs, terminates.
`table` arguments accept `table` or `schema.table`. `where` arguments are SQL
placed after `WHERE`, with `$1…` placeholders bound from `params`, a JSON
array; values never go into the text.

### `runQuery` — run a query

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `sql` | string | yes | SQL text; several statements allowed when `params` is empty |
| `params` | json | no | Positional values for `$1…`, as a JSON array |

Outputs: `rows` (array of objects), `rowCount` (number, from the last
CommandComplete tag), `command` (the tag's first word, e.g. `SELECT`,
`INSERT`, `UPDATE`). Not idempotent: the text can write. Uses the simple
protocol without `params`, the extended one with them. Not run live by the
SDK; `scripts/check-live.sh` runs it with `SELECT 1 AS one` itself.

### `selectRows` — select rows

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `table` | string | yes | `table` or `schema.table` |
| `where` | string | no | SQL after `WHERE`, with `$1…` placeholders |
| `params` | json | no | Values for the placeholders, a JSON array |
| `orderBy` | string | no | Column name to order by, ascending |
| `limit` | number | no | Default 100, at most 1000 |

`SELECT * FROM "t" [WHERE …] [ORDER BY "c"] LIMIT $n`. Outputs: `rows`,
`rowCount`. Idempotent.

Live sample: `{ "table": "pg_catalog.pg_tables", "limit": "1" }`, a view every
database has. The brief's `SELECT 1 AS one` is the `runQuery` smoke test in
`scripts/check-live.sh`, since a bare `SELECT 1` has no table.

### `insertRow` — insert a row

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `table` | string | yes | `table` or `schema.table` |
| `values` | json | yes | Object of column → value |

`INSERT INTO "t" ("a", "b") VALUES ($1, $2) RETURNING *`; an empty object
becomes `DEFAULT VALUES`. Outputs: `row` (the inserted row), `rowCount`. Not
idempotent.

### `updateRows` — update rows

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `table` | string | yes | `table` or `schema.table` |
| `set` | json | yes | Object of column → new value, non-empty |
| `where` | string | yes | SQL after `WHERE`; required so a step cannot update every row by omission |
| `params` | json | no | Values for the `where` placeholders |

`UPDATE "t" SET "a" = $k+1, "b" = $k+2 WHERE <where>` where the `where`
params are bound first (`$1…$k`) and the SET values after them, so the text
the user wrote needs no renumbering. Outputs: `rowCount` from the `UPDATE n`
tag. Declared not idempotent: the rows a `where` matches can change between
retries.

### `listTables` — list tables

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `schema` | string | no | Default `public` |

`SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`.
Outputs: `tables` (array of `{ schema, name, type }`, `type` being the view's
`BASE TABLE`, `VIEW`, `FOREIGN` or `LOCAL TEMPORARY`), `count`. Idempotent.
The view only lists what the role can see, which is the manual's rule.

Live sample: `{ "schema": "public" }`.

### `describeTable` — describe a table

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `table` | string | yes | `table` (schema `public`) or `schema.table` |

`SELECT column_name, data_type, udt_name, is_nullable, column_default, ordinal_position FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`.
Outputs: `columns` (array of `{ name, type, udtName, nullable, default, position }`,
`nullable` a boolean from `is_nullable = 'YES'`, `type` the view's
`data_type` with `udtName` naming the concrete type when it says `ARRAY` or
`USER-DEFINED`), `count`. Zero columns is an error ("no such table, or no
privilege on it"), because the view hides both the same way. Idempotent.

Live sample: `{ "table": "pg_catalog.pg_tables" }`, a catalog view whose
columns are the same on every server.

## Checks

From the repository root, with the package built:

```sh
yarn typecheck && yarn test && yarn build
node scripts/check-packages.mjs
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/postgres/dist/index.js --mock --receipt packages/postgres/verified.json
```

`scripts/check.sh` runs exactly this. Tests make no network calls: the
connector takes an `open` function returning a client, and `src/driver.ts`
exports the `SqlClient` surface the driver satisfies, so tests hand in a fake
that records the query text and its parameters and answers from a script. What
the driver is told is checked from the parsed connection string, and the query
builders against their literal SQL.

What the receipt says: `manifest`, `auth`, `secrets`, `actions`,
`no-lifecycle-scripts`, `keywords`, `no-runtime-deps`. The six every connector
here carries, plus `manifest`, which the SDK grants only when every action
input has a description. `mock` is spoiled by design: under `--mock` every
action gets `connectionString = mock-connectionString`, which the URI parser
refuses before any socket opens (the JSON inputs refuse the placeholder even
earlier), so the SDK reports `mock-action-failed` at warn level and nothing
reaches the network. `dedupe` is absent because both triggers implement `poll`.

## Live checks

`scripts/check-live.sh` exits 0 with a note when `DATABASE_URL` is unset. No
database is available on this machine, so that is the path it takes here.

| Env | Required | Used by |
| --- | --- | --- |
| `DATABASE_URL` | yes | every connection |
| `PG_TABLE`, `PG_ORDERING_COLUMN` | no | one `vorn-connector poll … newRows`; skipped when unset |
| `PG_QUERY`, `PG_CURSOR_COLUMN`, `PG_KEY_COLUMN`, `PG_START_FROM` | no | one `vorn-connector poll … queryRows`; skipped when unset |

With it set the script runs `runQuery` with `SELECT 1 AS one` through the SDK
harness and expects `one` to be `1`, then `vorn-connector check --live`, which
calls the idempotent actions on their samples. Nothing is written: `insertRow`,
`updateRows` and `runQuery` are not idempotent and the SDK never calls them
live.

## Docs

The only source, all from the PostgreSQL manual (current), plus the driver's
own README for what it is told and what it gives back.

- Protocol chapter, for what the driver speaks on the connector's behalf: https://www.postgresql.org/docs/current/protocol.html
- SQLSTATE codes: https://www.postgresql.org/docs/current/errcodes-appendix.html
- Connection strings and URIs: https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING
- Parameter keywords (`sslmode`, `sslrootcert`, `connect_timeout`, `application_name`): https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-PARAMKEYWORDS
- SSL modes: https://www.postgresql.org/docs/current/libpq-ssl.html
- information_schema: https://www.postgresql.org/docs/current/information-schema.html
- `information_schema.tables`: https://www.postgresql.org/docs/current/infoschema-tables.html
- `information_schema.columns`: https://www.postgresql.org/docs/current/infoschema-columns.html
- Row-wise comparison: https://www.postgresql.org/docs/current/functions-comparisons.html#ROW-WISE-COMPARISON
- Quoted identifiers: https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS
- Date/time output (`DateStyle`, `TimeZone`): https://www.postgresql.org/docs/current/datatype-datetime.html#DATATYPE-DATETIME-OUTPUT
- Password authentication (MD5, SCRAM): https://www.postgresql.org/docs/current/auth-password.html
- The `postgres` driver, inlined at build time: https://github.com/porsager/postgres
