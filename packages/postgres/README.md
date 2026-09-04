# @vornrun/connector-postgres

Trigger Vorn workflows from new rows in a PostgreSQL database, and read from or
write to it from a workflow step.

## Signing in

The connector takes a **connection string**, in the libpq URI form:

```
postgres://user:password@host:5432/database?sslmode=require
```

Your provider shows it on the database's page (look for "connection string" or
"URI"); otherwise your DBA has it. It goes into `DATABASE_URL`, is stored
encrypted by Vorn, and is never printed. There is no PostgreSQL CLI login to
borrow, which is why this connector asks for a secret where `ado`, `kusto` and
`github` do not.

A **read-only role** is enough for both triggers and for `selectRows`,
`listTables`, `describeTable` and a read-only `runQuery`. Only `insertRow`,
`updateRows` and a writing `runQuery` need more.

Parts of the URI the connector reads:

| Part | Default | Notes |
| --- | --- | --- |
| user | required | |
| password | none | Percent-encode `@`, `/`, `:`, `?`, `#` and `%` in it |
| host | required | Name or IP; `[2001:db8::1]` for IPv6. One host only |
| port | `5432` | |
| database | the user name | |
| `sslmode` | `prefer` | `disable`, `allow`, `prefer`, `require`, `verify-ca`, `verify-full` |
| `sslrootcert` | none | Path to a PEM CA bundle, or `system` for Node's roots; used by `verify-ca` and `verify-full` |
| `connect_timeout` | `10` | Seconds; `0` waits indefinitely |
| `application_name` | `vorn-connector-postgres` | |

`require` encrypts without checking the certificate, as the manual defines it.
`verify-ca` checks the chain, `verify-full` also the host name. `allow` is
treated as `prefer`.

## Settings

| Field | Env | Used by |
| --- | --- | --- |
| `connectionString` | `DATABASE_URL` | everything |
| `table` | `PG_TABLE` | **New rows** (required): `table` or `schema.table` |
| `orderingColumn` | `PG_ORDERING_COLUMN` | **New rows** (required): a column that only grows, such as `id` or `created_at` |
| `keyColumn` | `PG_KEY_COLUMN` | **New rows** (defaults to the ordering column), **Rows matching a query** (required): the row's identity |
| `query` | `PG_QUERY` | **Rows matching a query** (required) |
| `cursorColumn` | `PG_CURSOR_COLUMN` | **Rows matching a query** (required): the result column the cursor advances from |
| `startFrom` | `PG_START_FROM` | **Rows matching a query** (required), **New rows** (optional): the value to start after |
| `titleColumn` | `PG_TITLE_COLUMN` | both, optional: the column used as the item title |
| `limit` | `PG_LIMIT` | both, default `100` |

## Triggers

**New rows in a table** (`newRows`). Each poll reads
`SELECT * FROM "t" WHERE ("ord", "key") > ($1, $2) ORDER BY "ord", "key" LIMIT $3`
from the last seen values. The first poll, without `startFrom`, takes the newest
page and starts tracking there; with `startFrom` it reads everything after that
value. Items carry the whole row as `{{trigger.item.<column>}}`, the key
column's value as their id, and the ordering column as `updatedAt` when it is a
date or time. Every comparison happens in SQL, in the column's own type, so an
integer id and a timestamp both work.

**Rows matching a query** (`queryRows`). Give a SELECT with `$1` where the cursor
goes and, optionally, `$2` for the limit, ordered by the cursor column
ascending:

```sql
SELECT id, title, updated_at FROM tickets
WHERE status = 'open' AND updated_at >= $1
ORDER BY updated_at LIMIT $2
```

`startFrom` is the first `$1`. After each poll the cursor holds the largest
cursor-column value delivered and the keys delivered at exactly that value, so
a query written with `>=` never redelivers a tie and never loses one.

Neither trigger delivers a row twice: Vorn dedupes on the key column on top of
the cursor.

## Actions

| Action | What it does | Idempotent |
| --- | --- | --- |
| `runQuery` | Run SQL text with positional `params`; returns `rows`, `rowCount`, `command` | no |
| `selectRows` | `SELECT * FROM table [WHERE …] [ORDER BY …] LIMIT n` | yes |
| `insertRow` | Insert a JSON object of columns; returns the row from `RETURNING *` | no |
| `updateRows` | `UPDATE table SET … WHERE …`; returns `rowCount`. `where` is required | no |
| `listTables` | Tables and views in a schema, from `information_schema.tables` | yes |
| `describeTable` | Columns with type and nullability, from `information_schema.columns` | yes |

Identifiers are always double-quoted. Values only ever travel as parameters:
`where` takes SQL with `$1…` placeholders and `params` a JSON array, and
nothing a step passes is ever interpolated into the text. In `updateRows` the
`where` params bind first, so the text you write needs no renumbering.

Results are decoded from the server's text: booleans, integers and floats
become numbers, `json`/`jsonb` are parsed, timestamps become ISO 8601 in UTC,
`numeric` and `bigint` beyond 2^53 stay strings.

## Checks

```sh
packages/postgres/scripts/check.sh        # typecheck, tests, build, package gate, conformance receipt
packages/postgres/scripts/check-live.sh   # needs DATABASE_URL; exits 0 with a note without it
```

Tests open no sockets: the driver sits behind a small surface the tests
satisfy with a fake that records the query text and its parameters and answers
from a script.

## Built from

There is no HTTP API. The connector speaks the frontend/backend protocol
through the [`postgres`](https://github.com/porsager/postgres) driver, which is
a devDependency inlined into `dist/index.js` at build time, so the package
declares no runtime dependency and the packed connector carries the driver with
it. One connection is opened per poll or action and ended after it.

The rest comes from the PostgreSQL manual:

- [Frontend/Backend Protocol](https://www.postgresql.org/docs/current/protocol.html),
  for what the driver speaks on the connector's behalf
- [Connection URIs](https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING)
  and [parameter keywords](https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-PARAMKEYWORDS)
- [SSL support](https://www.postgresql.org/docs/current/libpq-ssl.html)
- [`information_schema.tables`](https://www.postgresql.org/docs/current/infoschema-tables.html)
  and [`information_schema.columns`](https://www.postgresql.org/docs/current/infoschema-columns.html)
- [Row-wise comparison](https://www.postgresql.org/docs/current/functions-comparisons.html#ROW-WISE-COMPARISON)
  and [quoted identifiers](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS)
