id: mysql

# MySQL connector

MySQL and MariaDB databases reached over the MySQL client/server protocol on
a TCP socket, encrypted with TLS when the `ssl` setting asks for it. There is
no HTTP API: the connector opens its own sockets through the `mysql2` driver,
so the SDK's `fetch` stub never sees them (consequences under **Checks**).

Package: `@vornrun/connector-mysql` in `packages/mysql`, shaped exactly like
`postgres`: scoped name, `tsup` with the driver under `noExternal`,
`vitest.config.ts` re-exporting `vitest.shared.ts`, `CHANGELOG.md`, `README.md`
with the docs links from the **Docs** section, `verified.json` from
`vorn-connector check --mock`, and a `"vorn"` block in `package.json` with
category `Data & observability`, keywords, and one sentence on how it signs in.

## Auth

Rung: **key**. There is no CLI login to borrow for a database.

| Config field | Env name | Required | Where it comes from |
| --- | --- | --- | --- |
| `connectionString` | `MYSQL_URL` | yes | Your provider's dashboard (the "connection string" or "URI" it shows for the database), or your DBA. Form: `mysql://user:password@host:3306/database` |
| `ssl` | `MYSQL_SSL` | no | One of `disabled`, `required`, `verify-full`. Default `disabled` |
| `sslCa` | `MYSQL_SSL_CA` | no | Path to a PEM CA bundle for `verify-full` against a private CA; Node's roots otherwise |

`connectionString` is `secret: true` and the connector declares
`auth: { rung: 'key', keys: ['connectionString'] }`. The SDK's config field
has no select type, so `ssl` is a string field whose description lists the
three values and whose parser refuses any other with a message naming them.

**Composing the URL**, following the manual's
`[scheme://][user[:[password]]@]host[:port][/schema][?attribute=value…]`:

| Part | Default | Notes |
| --- | --- | --- |
| scheme | required | `mysql://` only. `mysqlx://` is the X Protocol, which the driver does not speak, and is refused by name |
| user | required | The connector refuses a URL without one |
| password | none | Percent-encode `@`, `/`, `:`, `?`, `#` and `%` in it, as the manual says for reserved characters (`@` → `%40`, `/` → `%2F`) |
| host | required | Name or IPv4; `[2001:db8::1]` for IPv6. A socket path in parentheses is not supported |
| port | `3306` | The manual's classic-protocol default |
| database | none | The path after the host; the connection's default schema. `listTables` needs it or its own `database` argument |
| `ssl-mode` | none | Honoured when the `ssl` setting is unset: `DISABLED` → `disabled`, `REQUIRED` and `PREFERRED` → `required`, `VERIFY_CA` and `VERIFY_IDENTITY` → `verify-full`; `ssl-ca=(path)` → `sslCa`. Any other attribute is ignored, and the `ssl` setting always wins |

The connector parses the URL itself with `new URL` and hands the driver the
parts (`host`, `port`, `user`, `password`, `database`), never the string:
the driver's own URL parser JSON-parses every query attribute into an option
and warns on stderr about each one it does not know, and it does not read
`ssl-mode`.

**Privileges.** The database user needs `SELECT` on the tables a trigger
watches and on `information_schema` (readable by every user for the tables it
can see), `SELECT` for `selectRows`, `countRows`, `listTables`,
`describeTable` and a reading `runQuery`, `INSERT` for `insertRow`, `UPDATE`
for `updateRows`, `DELETE` for `deleteRows`, and whatever a writing `runQuery`
does. A `SELECT`-only user is enough for both triggers.

`ssl` per value, given to the driver's `ssl` option:

| Value | Driver option | Behaviour |
| --- | --- | --- |
| `disabled` | `false` | Plain TCP. The driver's default |
| `required` | `{ rejectUnauthorized: false }` | TLS, certificate not verified: encryption while trusting the network to reach the right server, which is what the manual's `REQUIRED` promises. The driver docs call this "strongly discouraged", which the field description repeats |
| `verify-full` | `{ rejectUnauthorized: true, verifyIdentity: true, ca? }` | Chain checked against `sslCa` or Node's roots, and the host name matched against the certificate. `verifyIdentity` is what the driver's `startTLS` reads to run `tls.checkServerIdentity`; it is set explicitly because the driver skips the check when it is falsy. `servername` is the host unless it is an IP, set by the driver itself |

## Driver: `mysql2`, inlined at build time

**What the SDK allows.** As `postgres` records: `vorn-connector pack`
bundles the entry and only refuses specifiers left outside the bundle, so a
driver inlined at build time passes `no-runtime-deps` and travels inside the
pack.

**What is used.** [`mysql2`](https://sidorares.github.io/node-mysql2/docs)
`^3` (3.24.3 today, MIT, `engines.node >= 8`), imported from `mysql2/promise`,
which the promise-wrapper page names as the promise API. It is a devDependency
added with `~/dev/vorn-planning/factory/add-dep.sh @vornrun/connector-mysql
mysql2@^3 --dev`, listed in `tsup.config.ts` under `noExternal: ['mysql2']`,
so `dist/index.js` carries it and the package declares no runtime dependency.
`mysql2` has seven dependencies of its own (`aws-ssl-profiles`,
`generate-function`, `iconv-lite`, `long`, `lru.min`, `named-placeholders`,
`sql-escaper`); tsup externalises only what the package's own `package.json`
lists, so all of them are bundled too. `iconv-lite` carries its encoding
tables and `aws-ssl-profiles` its CA bundles, so expect the packed connector
to be several times the 222 KB of `postgres`; the build step records the size
in the changelog. `named-placeholders` is required lazily inside a method, but
by a static string, so esbuild resolves it; the option stays off.

**How it is held.** `src/driver.ts` is the only module that names the driver.
It exports the `SqlPool` surface actually used — `query(sql, params?)`,
`execute(sql, params?)`, `end()` and `on('connection', …)` — so a test hands in
its own and no socket is opened, and `openPool` builds the real one from the
parsed connection string. `src/connection-string.ts` parses the URL and names
what is wrong in a sentence.

**Pool lifetime.** One pool per distinct connection string, kept in a map in
the connector module and created on first use; every poll and action runs
`pool.execute` or `pool.query`, which acquire and release a connection
themselves (the pool source). Options: `connectionLimit: 2`,
`waitForConnections: true`, `queueLimit: 0`, `maxIdle: 2`, `connectTimeout:
10000` (the driver's default, restated so a poller never waits indefinitely),
`multipleStatements: false` (the default; one statement per `runQuery`).
`maxIdle` equals the limit on purpose and `idleTimeout` is not set: the
driver only runs its idle sweep when `maxIdle < connectionLimit`, and it runs
it as a `setTimeout` re-armed every second for the life of the pool, never
`unref`'d, which would hold a one-shot process such as `vorn-connector poll`
open. A pooled connection the server drops after its `wait_timeout` removes
itself from the pool on its `end` or `error` event, so the next statement
gets a fresh one. The SDK has no stop hook, so the connector module registers
`closePools()` — `pool.end()` on every pool, tolerant of errors — on
`process.stdin` `end` and `close` (how the MCP server learns Vorn has gone),
and on `SIGTERM` and `SIGINT`; a signal listener replaces Node's default of
exiting, so those two exit the process themselves (143 and 130) once the
pools are closed. So that an idle pooled socket does not keep a one-shot
process alive while a busy one still keeps it from exiting mid-statement, the
pool's `acquire` event `ref`s the connection's socket and its `release` event
`unref`s it (`connection.stream`; the promise wrapper forwards both events
from the core pool, and the typings do not name the stream, so it is felt
for).

**Values.** Every value is bound with `execute`, the server-side prepared
statement path; `query`, whose placeholders are substituted client-side, is
used only for a statement with no parameters at all (a parameter-less
`runQuery`), so nothing is ever escaped into text. The prepared-statements
page's mapping: `null` → NULL, `number` → DOUBLE, `boolean` → TINY, `Date` →
DATETIME, `Buffer` → VAR_STRING, an object → JSON; `undefined` and functions
are errors ("Bind parameters must not contain undefined"). `toParam`
therefore sends `undefined` as `null` and stringifies an object or array, so
a JSON column receives text and never `[object Object]`. A `LIMIT ?` bound as
a plain number is refused by servers that do not report parameter types
(MySQL 5.7, MariaDB: the typed-parameters page), so every LIMIT the connector
writes is bound as `T.BIGINT(n)` from `const { TypedParameter: T } = mysql`,
after `Number.isSafeInteger` and a range check.

**Results.** `[rows, fields]` from a SELECT or SHOW, `[header]` from a write;
`Array.isArray(result)` tells them apart. The header is a `ResultSetHeader`
with `affectedRows`, `insertId`, `warningStatus`, `info`, `fieldCount`
(`changedRows` is deprecated and not exposed). Driver options for the row
shape: `dateStrings: true`, so DATE, DATETIME and TIMESTAMP arrive as the
server's own text (`2026-09-04 12:00:00`) and a cursor built from one binds
back unchanged, with no time-zone conversion in the process; `supportBigNumbers:
true` with `bigNumberStrings: false`, so a BIGINT arrives as a number when it
fits a JavaScript number and as its digits otherwise; DECIMAL is text by the
driver's documented default. JSON columns are parsed by the driver on both
MySQL and MariaDB (`jsonStrings` left off). `rowsAsArray`, `nestTables` and
`namedPlaceholders` stay off.

**Identifiers.** Validated against `^[0-9a-zA-Z_$\u0080-\uFFFF]+$` (the
manual's unquoted-identifier alphabet, which also excludes the trailing space
and the NUL the manual forbids) and at most 64 characters (the manual's
column, table and database limit), then wrapped in backticks with any embedded
backtick doubled, per the identifier rules; `db.table` splits at the first dot
and each part is validated and quoted alone. A name that fails is an error
naming the rule, never a query. `ANSI_QUOTES` does not change backticks, which
is why they are used.

Layout: `src/connection-string.ts`, `src/driver.ts`, `src/sql.ts` (quoting
and the statement builders), `src/connector.ts`, `src/entry.ts`,
`src/index.ts`, mirroring `postgres`.

## Triggers

Both implement `poll` with their own cursor, because the ordering column may
be an integer and the SDK's `timestamp` strategy compares ISO strings. Every
comparison happens in SQL with the column's own type. Vorn dedupes on
`externalId` on top. Neither declares `sample` (the SDK warns that a `poll`
trigger cannot replay one); the samples below document the shape.

Shared config, all optional at the config level and checked by the trigger
that needs them:

| Field | Env | Used by |
| --- | --- | --- |
| `table` | `MYSQL_TABLE` | both (required): `table` or `db.table` |
| `orderingColumn` | `MYSQL_ORDERING_COLUMN` | `newRows` (required): a column that only grows, e.g. an AUTO_INCREMENT `id` or `created_at` |
| `keyColumn` | `MYSQL_KEY_COLUMN` | `newRows` (default: the ordering column), `updatedRows` (required): the primary key column |
| `updatedAtColumn` | `MYSQL_UPDATED_AT_COLUMN` | `updatedRows` (required): a DATETIME or TIMESTAMP column, ideally `ON UPDATE CURRENT_TIMESTAMP` |
| `where` | `MYSQL_WHERE` | both (optional): SQL placed after `WHERE … AND (`, no placeholders |
| `startFrom` | `MYSQL_START_FROM` | both (optional): the value to start after (`newRows`) or at (`updatedRows`) |
| `titleColumn` | `MYSQL_TITLE_COLUMN` | both (optional): column used as the item title |
| `limit` | `MYSQL_LIMIT` | both, default `100`, at most `1000`; `context.limit` wins when the host sends one |

### `newRows` — new rows in a table

- **Poll, with a cursor:**
  ``SELECT * FROM `t` WHERE (`ord` > ? OR (`ord` = ? AND `key` > ?)) [AND (<where>)] ORDER BY `ord`, `key` LIMIT ?``,
  the row-wise comparison spelled out so rows that tie on the ordering value
  are separated by the key. When the key is the ordering column it collapses
  to ``WHERE `ord` > ? … ORDER BY `ord` LIMIT ?``.
- **First poll:** with `startFrom`, ``WHERE `ord` > ? … ORDER BY `ord`, `key` LIMIT ?``.
  Without it, ``ORDER BY `ord` DESC, `key` DESC LIMIT ?``, reversed: one
  page, newest, and tracking starts there, as the SDK does for its own
  strategies.
- **Cursor:** `{"v":1,"o":<ordering value>,"k":<key value>}`, each the value
  as the driver returned it (a number, or the server's text for a date, a
  DECIMAL or an out-of-range BIGINT), bound back unchanged. `hasMore` when
  the page was full and the query read forward.
- **Dedupe key:** `externalId` = the key column's value as text.
- **Item:** `title` = `titleColumn` value, else `<table> <key>`; `updatedAt` =
  the ordering value when it is date text (`YYYY-MM-DD[ HH:MM:SS[.fff]]`),
  rewritten with `T` between date and time, else omitted; `data` = the row.
- **Sample item:**

```json
{
  "externalId": "1042",
  "title": "orders 1042",
  "data": { "id": 1042, "reference": "A-77", "status": "new", "created_at": "2026-09-04 12:00:00" }
}
```

A NULL in the ordering or key column is an error naming the column.

### `updatedRows` — updated rows in a table

- **Poll, with a cursor:**
  ``SELECT * FROM `t` WHERE `upd` >= ? AND NOT (`upd` = ? AND `key` IN (?, …)) [AND (<where>)] ORDER BY `upd`, `key` LIMIT ?``,
  the `IN` list being the cursor's `keys`, so the rows already delivered at
  the cursor value are left out by the server and a page of ties still
  advances.
- **First poll:** with `startFrom`, ``WHERE `upd` >= ? … ORDER BY `upd`, `key` LIMIT ?``
  bound to it, with no keys to exclude. Without it,
  ``ORDER BY `upd` DESC, `key` DESC LIMIT ?``, reversed, as `newRows`.
- **Cursor:** `{"v":1,"c":"<newest updated_at text>","keys":["<key>", ...]}`:
  the newest `updatedAtColumn` value delivered and the keys delivered at
  exactly that value. The next query excludes those keys at that value, so
  the `>=` never redelivers a tie and never loses one, even when a bulk
  `UPDATE` stamps more rows than a page with the same second; the SDK's
  timestamp boundary rule, run by the connector in SQL. `hasMore` when the
  page was full and the query read forward. The list only grows while the
  newest value stands still, one placeholder per key, far inside the
  server's 65,535.
- **Dedupe key:** `externalId` = `<key>@<updated_at text>`, so a row changed
  again is a new item while the same change seen twice is not.
- **Item:** `title` as `newRows`; `updatedAt` = the `updatedAtColumn` text
  with `T` in place of the space; `data` = the row. A NULL in either column
  is an error naming the column.
- **Sample item:**

```json
{
  "externalId": "88@2026-09-04 09:30:00",
  "title": "Printer on fire",
  "updatedAt": "2026-09-04T09:30:00",
  "data": { "id": 88, "title": "Printer on fire", "updated_at": "2026-09-04 09:30:00" }
}
```

A second-resolution `updated_at` makes ties common, which is what the `keys`
list is for. `TIMESTAMP` text is in the session time zone, which the connector
does not set, so no zone suffix is appended.

## Actions

Every action runs on the pool for `connectionString`. `table` arguments accept
`table` or `db.table`. `where` arguments are SQL placed after `WHERE`, with
`?` placeholders bound in order from `params`, a JSON array; values never go
into the text. Sample argument sets are what `vorn-connector check --live`
calls, and read only `information_schema`, which every user can see.

### `runQuery` — run a query

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `sql` | string | yes | One SQL statement, with `?` placeholders |
| `params` | json | no | Positional values for the placeholders, a JSON array |

`execute` with params, `query` without. Outputs: `rows` (array of objects,
empty for a write), `rowCount` (number: rows returned, or `affectedRows` for a
write), `affectedRows` (number, `0` for a read), `insertId` (number, `0` when
nothing was inserted), `warningStatus` (number). Not idempotent: the text can
write. Not run live by the SDK; `scripts/check-live.sh` runs it with
`SELECT 1 AS ok` itself.

### `selectRows` — select rows

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `table` | string | yes | `table` or `db.table` |
| `columns` | json | no | JSON array of column names; all columns when omitted |
| `where` | string | no | SQL after `WHERE`, with `?` placeholders, e.g. `status = ?` |
| `params` | json | no | Values for the placeholders, a JSON array |
| `orderBy` | string | no | Column name to order by |
| `descending` | boolean | no | Order descending; default ascending |
| `limit` | number | no | Default 100, at most 1000 |

``SELECT `a`, `b` | * FROM `t` [WHERE …] [ORDER BY `c` [DESC]] LIMIT ?``,
the limit bound as `T.BIGINT`. Outputs: `rows`, `rowCount`. Idempotent.

Live sample: `{ "table": "information_schema.TABLES", "limit": "1" }`, a view
every server has. The brief's `SELECT 1 AS ok` needs no table and so cannot be
this action's sample; it is the `runQuery` smoke test in
`scripts/check-live.sh`.

### `insertRow` — insert a row

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `table` | string | yes | `table` or `db.table` |
| `values` | json | yes | Object of column → value, non-empty |

``INSERT INTO `t` (`a`, `b`) VALUES (?, ?)``. Outputs: `insertId` (number,
the AUTO_INCREMENT value or `0`), `affectedRows` (number). Not idempotent. An
object or array value is sent as JSON text.

### `updateRows` — update rows

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `table` | string | yes | `table` or `db.table` |
| `values` | json | yes | Object of column → new value, non-empty |
| `where` | string | yes | SQL after `WHERE`; required so a step cannot update every row by omission |
| `params` | json | no | Values for the `where` placeholders |

``UPDATE `t` SET `a` = ?, `b` = ? WHERE <where>``; MySQL binds `?` in text
order, so the SET values are bound first and the `where` params after them,
in the order the user wrote them. Outputs: `affectedRows` (number, rows
matched; the driver reports matched rows here and changed rows only in
`info`), `info` (string, the server's `Rows matched: … Changed: … Warnings:
…`). Declared not idempotent: the rows a `where` matches can change between
retries.

### `deleteRows` — delete rows

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `table` | string | yes | `table` or `db.table` |
| `where` | string | yes | SQL after `WHERE`; required for the same reason as `updateRows` |
| `params` | json | no | Values for the placeholders |

``DELETE FROM `t` WHERE <where>``. Outputs: `affectedRows` (number). Not
idempotent.

### `listTables` — list tables

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `database` | string | no | Default: the URL's database; an error names the argument when neither is set |

`SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
the `SHOW FULL TABLES` equivalent the manual gives, chosen over `SHOW` because
its result is a plain row set with fixed column names rather than a column
named `Tables_in_<db>`. Outputs: `tables` (array of `{ name, type, engine,
rows }`, `type` being `BASE TABLE`, `VIEW` or `SYSTEM VIEW`, `rows` the
engine's estimate, which the manual says can be far off for InnoDB), `count`.
Idempotent. Only tables the user has some privilege on are listed, which is
the manual's rule for both `SHOW TABLES` and the view.

Live sample: `{}`.

### `describeTable` — describe a table

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `table` | string | yes | `table` (the URL's database) or `db.table` |

`SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, ORDINAL_POSITION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
ordered explicitly because the manual says a SELECT from `COLUMNS` is not.
Outputs: `columns` (array of `{ name, type, dataType, nullable, key, default,
extra, position }`: `type` is `COLUMN_TYPE` with its length, `dataType` the
bare `DATA_TYPE`, `nullable` a boolean from `IS_NULLABLE = 'YES'`, `key` one
of `PRI`, `UNI`, `MUL` or `''`, `default` the `COLUMN_DEFAULT` or `null`,
`extra` e.g. `auto_increment` or `on update CURRENT_TIMESTAMP`, `position` a
number), `count`. Zero columns is an error ("no such table, or no privilege
on it"), because the view hides both the same way. Idempotent.

Live sample: `{ "table": "information_schema.TABLES" }`, whose columns are
the same on every server.

### `countRows` — count rows

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `table` | string | yes | `table` or `db.table` |
| `where` | string | no | SQL after `WHERE`, with `?` placeholders |
| `params` | json | no | Values for the placeholders |

``SELECT COUNT(*) AS count FROM `t` [WHERE …]``. Outputs: `count` (number;
`COUNT(*)` is a BIGINT, which `supportBigNumbers` returns as a number).
Idempotent.

Live sample: `{ "table": "information_schema.TABLES" }`.

## Checks

From the repository root, with the package built:

```sh
yarn typecheck && yarn test && yarn build
node scripts/check-packages.mjs
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/mysql/dist/index.js --mock --receipt packages/mysql/verified.json
```

`scripts/check.sh` runs exactly this. Tests make no network or database
calls: the connector takes an `openPool` function returning a `SqlPool`, and
tests hand in a fake that records the SQL text and its parameters and answers
from a script, both the `[rows, fields]` and the `[header]` shapes. What the
driver is told is checked from the parsed connection string and `ssl`
setting, the query builders against their literal SQL, and the identifier
validator against the manual's alphabet and the 64-character limit.

What the receipt says: `manifest`, `auth`, `secrets`, `actions`,
`no-lifecycle-scripts`, `keywords`, `no-runtime-deps`, `launch`; `manifest`
needs every action input described. `mock` is spoiled by design, as for
`postgres`: under `--mock` every action gets `connectionString =
mock-connectionString`, which the URL parser refuses before any socket opens
(the JSON inputs refuse the placeholder even earlier), so the SDK reports
`mock-action-failed` at warn level and nothing reaches the network. `dedupe`
is absent because both triggers implement `poll`.

## Live checks

`scripts/check-live.sh` exits 0 with a note when `MYSQL_URL` is unset. No
database is available on this machine, so that is the path it takes here.

| Env | Required | Used by |
| --- | --- | --- |
| `MYSQL_URL` | yes | every connection |
| `MYSQL_SSL`, `MYSQL_SSL_CA` | no | TLS, as the sandbox's server demands |
| `MYSQL_TABLE`, `MYSQL_ORDERING_COLUMN` | no | one `vorn-connector poll … newRows`; skipped when unset |
| `MYSQL_TABLE`, `MYSQL_UPDATED_AT_COLUMN`, `MYSQL_KEY_COLUMN` | no | one `vorn-connector poll … updatedRows`; skipped when unset |

With `MYSQL_URL` set the script runs `runQuery` with `SELECT 1 AS ok` through
the SDK harness and expects `ok` to be `1`, then `vorn-connector check
--live`, which calls the idempotent actions on their samples. Nothing is
written: `insertRow`, `updateRows`, `deleteRows` and `runQuery` are not
idempotent and the SDK never calls them live. A sandbox is any MySQL 8.x or
MariaDB 10.5+ the user can `SELECT` from `information_schema` on.

## Dependencies

| Package | Range | Why | How |
| --- | --- | --- | --- |
| `mysql2` | `^3` | The wire protocol, authentication plugins (`caching_sha2_password`, `mysql_native_password`), TLS upgrade, prepared statements and result decoding; smaller and safer than writing them | devDependency via `add-dep.sh`, inlined by tsup `noExternal`; do not run `yarn install`, CI resolves the lockfile |

No runtime dependency. `@vornrun/connector-sdk` at the range the other
packages use.

## Icon

The MySQL dolphin is a trademark, so the mark is a plain database cylinder
with a stylised M. In a `0 0 24 24` box, `fill="currentColor"`, three paths:

1. The lid: a solid ellipse centred at (12, 6), 9 wide by 3 tall, the same
   path `postgres` uses for its lid
   (`M12 3c-4.97 0-9 1.34-9 3s4.03 3 9 3 9-1.34 9-3-4.03-3-9-3z`).
2. The body as an outline ring: the outer wall from (3, 8) down to a curved
   bottom at y 20 and up to (21, 8), then the inner wall traced in the
   opposite direction 2 units inside, so the nonzero fill leaves the middle
   open (`M3 8v9c0 1.66 4.03 3 9 3s9-1.34 9-3V8h-2v9c0 .35-2.6 1-7 1s-7-.65-7-1V8z`).
3. The M, a solid glyph of 1.6-unit strokes inside the body: stems at x 7.5
   and 14.9 from y 10.5 to 16.5, the two diagonals meeting at (12, 15.6)
   (`M7.5 16.5v-6h1.6l2.9 3.6 2.9-3.6h1.6v6h-1.6v-3.6L12 15.6l-2.9-2.7v3.6z`).

## Docs

The only source: the `mysql2` documentation for what the driver is told and
what it gives back, and the MySQL 8.4 reference manual for the SQL.

- mysql2 quickstart: https://sidorares.github.io/node-mysql2/docs
- Promise wrapper (`mysql2/promise`, `[rows, fields]`, `pool.end()`): https://sidorares.github.io/node-mysql2/docs/documentation/promise-wrapper
- Prepared statements (`execute`, the parameter type mapping, statement cache): https://sidorares.github.io/node-mysql2/docs/documentation/prepared-statements
- Typed parameters (`TypedParameter`, `LIMIT ?` on servers that do not report parameter types): https://sidorares.github.io/node-mysql2/docs/documentation/typed-parameters
- SSL options: https://sidorares.github.io/node-mysql2/docs/documentation/ssl
- TypeScript types (`RowDataPacket`, `ResultSetHeader`): https://sidorares.github.io/node-mysql2/docs/documentation/typescript-examples
- MariaDB data types (JSON as LONGTEXT, `jsonStrings`): https://sidorares.github.io/node-mysql2/docs/documentation/mariadb-data-types
- API compatibility note (DECIMAL as strings): https://sidorares.github.io/node-mysql2/docs/api-and-configurations
- Pool examples (`createPool`, URL form): https://sidorares.github.io/node-mysql2/docs/examples/connections/create-pool
- `information_schema.COLUMNS`: https://dev.mysql.com/doc/refman/8.4/en/information-schema-columns-table.html
- `information_schema.TABLES`: https://dev.mysql.com/doc/refman/8.4/en/information-schema-tables-table.html
- `SHOW TABLES`: https://dev.mysql.com/doc/refman/8.4/en/show-tables.html
- Identifier rules: https://dev.mysql.com/doc/refman/8.4/en/identifiers.html
- Identifier length limits: https://dev.mysql.com/doc/refman/8.4/en/identifier-length.html
- Connection URIs: https://dev.mysql.com/doc/refman/8.4/en/connecting-using-uri-or-key-value-pairs.html
