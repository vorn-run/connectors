#!/usr/bin/env sh
# The checks spec.md names, for packages/gitlab. Run from the repository root.
set -eu
cd "$(dirname "$0")/.."

PKG=gitlab
NAME=@vornrun/connector-$PKG

if [ ! -d "packages/$PKG" ]; then
  echo "packages/$PKG does not exist yet; nothing to check" >&2
  exit 1
fi

yarn typecheck
yarn test
yarn build

# The conformance receipt the catalog quotes. --mock serves every action from
# an in-process stub, so this never reaches the network. The CLI is called by
# its real path: behind a linked node_modules its entry-point guard otherwise
# fails and it silently does nothing.
CLI="$(node -p "require('fs').realpathSync('node_modules/@vornrun/connector-sdk/dist/cli.js')")"
(cd "packages/$PKG" && node "$CLI" check ./dist/index.js --mock --receipt verified.json)

node scripts/check-packages.mjs
node scripts/check-conformance.mjs
node scripts/build-catalog.mjs --check

echo "checks passed for $NAME"
