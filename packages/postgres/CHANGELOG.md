# Changelog

All notable changes to `@vornrun/connector-postgres`.

## 0.1.1

Read the version from the bundle instead of a package.json the packed connector does not carry.

## 0.1.0

First release.

Trigger a workflow from rows arriving in a PostgreSQL table, or from the rows a
query returns, and let a workflow step read or write the database.

- **Triggers:** `newRows`, `queryRows`.
- **Actions:** `runQuery`, `selectRows`, `insertRow`, `updateRows`,
  `listTables`, `describeTable`.
- **Signing in:** a libpq connection string in `DATABASE_URL`. A read-only role
  is enough for the triggers.

Speaks the frontend/backend protocol through the `postgres` driver, which is a
devDependency inlined into the build, so the package declares no runtime
dependency and `vorn-connector pack` carries the driver inside the connector.
Every `sslmode` is honoured, including `verify-ca` and `verify-full` against
`sslrootcert`. One connection per poll or action, ended after it.

`int8` and `numeric` columns arrive as text, so a value beyond a JavaScript
number keeps its digits; timestamps arrive as dates.

Identifiers are always quoted and values only ever travel as parameters.
