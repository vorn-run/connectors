#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
yarn typecheck && yarn test && yarn build
# The CLI is called by its real path: behind a linked node_modules its entry-point guard otherwise does nothing.
CLI="$(node -p "require('fs').realpathSync('node_modules/@vornrun/connector-sdk/dist/cli.js')")"
node "$CLI" check packages/hubspot/dist/index.js --mock --receipt packages/hubspot/verified.json
