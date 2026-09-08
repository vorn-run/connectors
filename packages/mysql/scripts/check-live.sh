#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

if [ -z "${MYSQL_URL:-}" ]; then
  echo "MYSQL_URL is not set; skipping live checks"
  exit 0
fi

CLI=node_modules/@vornrun/connector-sdk/dist/cli.js
MODULE=packages/mysql/dist/index.js

if [ ! -f "$MODULE" ]; then
  yarn workspace @vornrun/connector-mysql build
fi

# The SDK never runs runQuery live because it is not idempotent, so the smoke query runs here.
node --input-type=module -e '
import { createConnectorHarness } from "@vornrun/connector-sdk"
const { default: connector } = await import(process.argv[1])
const config = { connectionString: process.env.MYSQL_URL, ssl: process.env.MYSQL_SSL, sslCa: process.env.MYSQL_SSL_CA }
const harness = createConnectorHarness(connector, { config })
const result = await harness.execute("runQuery", { sql: "SELECT 1 AS ok" })
if (result.rows?.[0]?.ok !== 1) throw new Error(`SELECT 1 AS ok returned ${JSON.stringify(result)}`)
console.log("runQuery ok")
' "./$MODULE"

if [ -n "${MYSQL_TABLE:-}" ] && [ -n "${MYSQL_ORDERING_COLUMN:-}" ]; then
  node "$CLI" poll "$MODULE" newRows --limit 5
else
  echo "MYSQL_TABLE or MYSQL_ORDERING_COLUMN is not set; skipping the newRows poll"
fi

if [ -n "${MYSQL_TABLE:-}" ] && [ -n "${MYSQL_UPDATED_AT_COLUMN:-}" ] && [ -n "${MYSQL_KEY_COLUMN:-}" ]; then
  node "$CLI" poll "$MODULE" updatedRows --limit 5
else
  echo "MYSQL_TABLE, MYSQL_UPDATED_AT_COLUMN or MYSQL_KEY_COLUMN is not set; skipping the updatedRows poll"
fi

node "$CLI" check "$MODULE" --live
