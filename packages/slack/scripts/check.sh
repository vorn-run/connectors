#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
yarn typecheck && yarn test && yarn build
node node_modules/@vornrun/connector-sdk/dist/cli.js check packages/slack/dist/index.js --mock --receipt packages/slack/verified.json
