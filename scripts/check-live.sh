#!/usr/bin/env sh
# Live checks for packages/gitlab against a real GitLab instance.
#
# Needs GITLAB_TOKEN: a personal access token with read_api (api to also
# exercise the write actions). Optional: GITLAB_PROJECT (default
# gitlab-org/gitlab) and GITLAB_BASE_URL (default https://gitlab.com).
# No sandbox credentials exist yet, so a missing token is a note, not a failure.
set -eu
cd "$(dirname "$0")/.."

PKG=gitlab
NAME=@vornrun/connector-$PKG

if [ -z "${GITLAB_TOKEN:-}" ]; then
  echo "GITLAB_TOKEN is not set; skipping live checks for $NAME (set it to a read_api token to run them)"
  exit 0
fi

if [ ! -d "packages/$PKG" ]; then
  echo "packages/$PKG does not exist yet; nothing to check" >&2
  exit 1
fi

export GITLAB_PROJECT="${GITLAB_PROJECT:-gitlab-org/gitlab}"
export GITLAB_BASE_URL="${GITLAB_BASE_URL:-https://gitlab.com}"

yarn workspace "$NAME" build
CLI="$(node -p "require('fs').realpathSync('node_modules/@vornrun/connector-sdk/dist/cli.js')")"
(cd "packages/$PKG" && node "$CLI" check ./dist/index.js --live)
