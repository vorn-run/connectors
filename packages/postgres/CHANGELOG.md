# Changelog

All notable changes to `@vornrun/connector-postgres`.

## 0.1.0

First release.

Trigger a workflow from rows arriving in a PostgreSQL table, or from the rows a
query returns, and let a workflow step read or write the database.

- **Triggers:** `newRows`, `queryRows`.
- **Actions:** `runQuery`, `selectRows`, `insertRow`, `updateRows`,
  `listTables`, `describeTable`.
- **Signing in:** a libpq connection string in `DATABASE_URL`. A read-only role
  is enough for the triggers.

Speaks the wire protocol itself, with `node:net`, `node:tls` and
`node:crypto`: SSL negotiation for every `sslmode`, cleartext, MD5 and
SCRAM-SHA-256 passwords, the simple and extended query flows. No runtime
dependency, so `vorn-connector pack` carries nothing but the connector.

Identifiers are always quoted and values only ever travel as parameters.
