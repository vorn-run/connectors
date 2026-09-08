# Changelog

All notable changes to `@vornrun/connector-mysql`.

## 0.1.0

First release.

Trigger a workflow from rows arriving in a MySQL or MariaDB table, or from
rows changing in one, and let a workflow step read or write the database.

- **Triggers:** `newRows`, `updatedRows`.
- **Actions:** `runQuery`, `selectRows`, `insertRow`, `updateRows`,
  `deleteRows`, `listTables`, `describeTable`, `countRows`.
- **Signing in:** a `mysql://` connection URL in `MYSQL_URL`, with an optional
  `ssl` setting of `disabled`, `required` or `verify-full` and a CA bundle path
  in `sslCa`. A `SELECT`-only user is enough for the triggers.

Speaks the client/server protocol through the `mysql2` driver, which is a
devDependency inlined into the build with a `createRequire` banner for the
Node builtins it requires, so the package declares no runtime dependency and
`vorn-connector pack` carries the driver inside the connector. The bundle is
about 1.4 MB, most of it the driver's encoding tables and CA bundles.

One pool of two connections per connection URL, kept for the life of the
process and ended when Vorn hangs up stdin or the process is told to stop.
Each pooled socket is unref'd while idle and ref'd while a statement is in
flight, so a one-shot `vorn-connector poll` exits when its work is done and
not before. A stop signal closes the pools and then exits. `maxIdle` stays
equal to the connection limit on purpose: below it the driver arms a sweep
timer every second that would hold the process open.

Every value is bound through a server-side prepared statement, a `LIMIT`
as a typed BIGINT so servers that do not report parameter types accept it.
Dates arrive as the server's own text and a BIGINT beyond a JavaScript
number keeps its digits. Identifiers are validated against the manual's
alphabet and backticked; values never enter the SQL text.
