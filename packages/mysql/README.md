# @vornrun/connector-mysql

Trigger Vorn workflows from new or updated rows in a MySQL or MariaDB
database, and read from or write to it from a workflow step.

## Signing in

The connector takes a **connection URL** in the form the MySQL manual gives:

```
mysql://user:password@host:3306/database
```

Your provider shows it on the database's page (look for "connection string" or
"URI"); otherwise your DBA has it. It goes into `MYSQL_URL`, is stored
encrypted by Vorn, and is never printed. There is no MySQL CLI login to borrow,
which is why this connector asks for a secret where `github` and `gitlab` do
not.

The database user needs `SELECT` on the tables a trigger watches, and
`SELECT`, `INSERT`, `UPDATE` or `DELETE` on the tables the actions touch. A
`SELECT`-only user is enough for both triggers and for `selectRows`,
`countRows`, `listTables`, `describeTable` and a reading `runQuery`.

Parts of the URL the connector reads:

| Part | Default | Notes |
| --- | --- | --- |
| scheme | required | `mysql://`. `mysqlx://` is the X Protocol, which the driver does not speak |
| user | required | |
| password | none | Percent-encode `@`, `/`, `:`, `?`, `#` and `%` in it (`@` → `%40`, `/` → `%2F`) |
| host | required | Name or IPv4; `[2001:db8::1]` for IPv6. A socket path is not supported |
| port | `3306` | |
| database | none | The connection's default schema; `listTables` and `describeTable` need it or a `db.` prefix |
| `ssl-mode` | none | Honoured when the `ssl` setting is blank: `DISABLED`, `PREFERRED`/`REQUIRED` → `required`, `VERIFY_CA`/`VERIFY_IDENTITY` → `verify-full` |
| `ssl-ca` | none | Path to a CA bundle, honoured when `sslCa` is blank |

The connector parses the URL itself and hands the driver its parts, never the
string. Any other attribute is ignored.

## Settings

| Field | Env | Used by |
| --- | --- | --- |
| `connectionString` | `MYSQL_URL` | everything |
| `ssl` | `MYSQL_SSL` | everything, optional: `disabled` (default), `required`, `verify-full` |
| `sslCa` | `MYSQL_SSL_CA` | `verify-full` against a private CA: path to a PEM bundle; Node's roots otherwise |
| `table` | `MYSQL_TABLE` | both triggers (required): `table` or `db.table` |
| `orderingColumn` | `MYSQL_ORDERING_COLUMN` | **New rows** (required): a column that only grows, such as an `AUTO_INCREMENT` id or `created_at` |
| `keyColumn` | `MYSQL_KEY_COLUMN` | **New rows** (defaults to the ordering column), **Updated rows** (required): the primary key |
| `updatedAtColumn` | `MYSQL_UPDATED_AT_COLUMN` | **Updated rows** (required): a `DATETIME` or `TIMESTAMP` column, ideally `ON UPDATE CURRENT_TIMESTAMP` |
| `where` | `MYSQL_WHERE` | both, optional: SQL after `WHERE` narrowing the rows watched; no placeholders |
| `startFrom` | `MYSQL_START_FROM` | both, optional: the value to start after (new rows) or at (updated rows) |
| `titleColumn` | `MYSQL_TITLE_COLUMN` | both, optional: the column used as the item title |
| `limit` | `MYSQL_LIMIT` | both, default `100`, at most `1000` |

`required` encrypts without checking the certificate, which the driver's
documentation strongly discourages; `verify-full` checks the chain against
`sslCa` or Node's roots and matches the host name.

## Triggers

**New rows in a table** (`newRows`). Each poll reads
``SELECT * FROM `t` WHERE (`ord` > ? OR (`ord` = ? AND `key` > ?)) ORDER BY `ord`, `key` LIMIT ?``
from the last seen values, the row-wise comparison spelled out so rows that tie
on the ordering value are separated by the key. The first poll, without
`startFrom`, takes the newest page and starts tracking there; with `startFrom`
it reads everything after that value. Items carry the whole row as
`{{trigger.item.<column>}}`, the key column's value as their id, and the
ordering column as `updatedAt` when it is date text. Every comparison happens
in SQL, in the column's own type, so an integer id and a timestamp both work.

**Updated rows in a table** (`updatedRows`). Each poll reads
``SELECT * FROM `t` WHERE `upd` >= ? ORDER BY `upd`, `key` LIMIT ?`` from the
newest `updated_at` delivered. The cursor also holds the keys delivered at
exactly that value, so the `>=` never redelivers a tie and never loses one,
which matters when `updated_at` has second resolution. Items are identified
by `<key>@<updated_at>`, so a row changed again is a new item while the same
change seen twice is not.

Neither trigger delivers a row twice: Vorn dedupes on the item id on top of
the cursor. `TIMESTAMP` text is in the session time zone, which the connector
does not set.

## Actions

| Action | What it does | Idempotent |
| --- | --- | --- |
| `runQuery` | One statement with `?` placeholders and `params`; returns `rows`, `rowCount`, `affectedRows`, `insertId`, `warningStatus` | no |
| `selectRows` | ``SELECT [columns] FROM table [WHERE …] [ORDER BY …] LIMIT n`` | yes |
| `insertRow` | Insert a JSON object of columns; returns `insertId` and `affectedRows` | no |
| `updateRows` | ``UPDATE table SET … WHERE …``; returns `affectedRows` (rows matched) and `info`. `where` is required | no |
| `deleteRows` | ``DELETE FROM table WHERE …``; returns `affectedRows`. `where` is required | no |
| `listTables` | Tables and views in a database, from `information_schema.TABLES` | yes |
| `describeTable` | Columns with type, nullability, key, default and extra, from `information_schema.COLUMNS` | yes |
| `countRows` | ``SELECT COUNT(*) FROM table [WHERE …]`` | yes |

Identifiers are validated against the manual's unquoted-identifier alphabet
and 64-character limit, then backticked. Values only ever travel as
parameters: `where` takes SQL with `?` placeholders and `params` a JSON array,
and nothing a step passes is ever interpolated into the text. In `updateRows`
the `SET` values bind first and the `where` params after them, in the order
MySQL reads the text. An object or array value is sent as JSON text.

Dates arrive as the server's own text (`2026-09-04 12:00:00`), a `BIGINT`
as a number when it fits one and as its digits otherwise, `DECIMAL` as text,
and JSON columns parsed.

## Checks

```sh
packages/mysql/scripts/check.sh        # typecheck, tests, build, package gate, conformance receipt
packages/mysql/scripts/check-live.sh   # needs MYSQL_URL; exits 0 with a note without it
```

Tests open no sockets: the driver sits behind a small pool surface the tests
satisfy with a fake that records the statement text and its parameters and
answers from a script.

## Built from

There is no HTTP API. The connector speaks the client/server protocol through
the [`mysql2`](https://sidorares.github.io/node-mysql2/docs) driver, which is
a devDependency inlined into `dist/index.js` at build time, so the package
declares no runtime dependency and the packed connector carries the driver
with it. One small pool is kept per connection URL and ended when Vorn hangs
up.

- [Promise wrapper](https://sidorares.github.io/node-mysql2/docs/documentation/promise-wrapper)
- [Prepared statements](https://sidorares.github.io/node-mysql2/docs/documentation/prepared-statements)
  and [typed parameters](https://sidorares.github.io/node-mysql2/docs/documentation/typed-parameters)
- [SSL options](https://sidorares.github.io/node-mysql2/docs/documentation/ssl)
- [TypeScript types](https://sidorares.github.io/node-mysql2/docs/documentation/typescript-examples),
  [MariaDB data types](https://sidorares.github.io/node-mysql2/docs/documentation/mariadb-data-types)
  and [API notes](https://sidorares.github.io/node-mysql2/docs/api-and-configurations)
- [Pool examples](https://sidorares.github.io/node-mysql2/docs/examples/connections/create-pool)

The rest comes from the MySQL 8.4 reference manual:

- [Connection URIs](https://dev.mysql.com/doc/refman/8.4/en/connecting-using-uri-or-key-value-pairs.html)
- [`information_schema.TABLES`](https://dev.mysql.com/doc/refman/8.4/en/information-schema-tables-table.html),
  [`information_schema.COLUMNS`](https://dev.mysql.com/doc/refman/8.4/en/information-schema-columns-table.html)
  and [`SHOW TABLES`](https://dev.mysql.com/doc/refman/8.4/en/show-tables.html)
- [Identifier rules](https://dev.mysql.com/doc/refman/8.4/en/identifiers.html)
  and [length limits](https://dev.mysql.com/doc/refman/8.4/en/identifier-length.html)
