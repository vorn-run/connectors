#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set; skipping live checks"
  exit 0
fi

CLI=node_modules/@vornrun/connector-sdk/dist/cli.js
MODULE=packages/postgres/dist/index.js

if [ ! -f "$MODULE" ]; then
  yarn workspace @vornrun/connector-postgres build
fi

# The SDK never runs runQuery live because it is not idempotent, so the smoke query runs here.
node --input-type=module -e '
import { createConnectorHarness } from "@vornrun/connector-sdk"
const { default: connector } = await import(process.argv[1])
const harness = createConnectorHarness(connector, { config: { connectionString: process.env.DATABASE_URL } })
const result = await harness.execute("runQuery", { sql: "SELECT 1 AS one" })
if (result.rows?.[0]?.one !== 1) throw new Error(`SELECT 1 AS one returned ${JSON.stringify(result)}`)
console.log("runQuery ok")
' "./$MODULE"

if [ -n "${PG_TABLE:-}" ] && [ -n "${PG_ORDERING_COLUMN:-}" ]; then
  node "$CLI" poll "$MODULE" newRows --limit 5
else
  echo "PG_TABLE or PG_ORDERING_COLUMN is not set; skipping the newRows poll"
fi

if [ -n "${PG_QUERY:-}" ] && [ -n "${PG_CURSOR_COLUMN:-}" ] && [ -n "${PG_KEY_COLUMN:-}" ] && [ -n "${PG_START_FROM:-}" ]; then
  node "$CLI" poll "$MODULE" queryRows --limit 5
else
  echo "PG_QUERY, PG_CURSOR_COLUMN, PG_KEY_COLUMN or PG_START_FROM is not set; skipping the queryRows poll"
fi

node "$CLI" check "$MODULE" --live
