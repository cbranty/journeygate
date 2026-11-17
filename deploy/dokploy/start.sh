#!/bin/sh
# Entry point of the guard service in the Dokploy stack
# (deploy/docker-compose.dokploy.yml): `start.sh serve --repo /repo`.
#
# guard serve only warns about a missing or invalid agents.toml and then runs
# with the agent lane off. This stack exists for the agent lane, so the start
# is refused instead: the files repo-init wrote (deploy/dokploy/init.sh) must
# be there, and guard must accept the agents file. A container restart
# without a deploy takes this path too.
set -eu

guard=${GUARD_BIN:-guard}

for name in GUARD_AGENTS_TOML GUARD_THRESHOLDS; do
  eval "path=\${$name:-}"
  if [ -z "$path" ] || [ ! -s "$path" ]; then
    printf 'error: %s: names no file. repo-init writes it on every deploy: redeploy the stack\n' "$name" >&2
    exit 2
  fi
done

if ! "$guard" agents check >/dev/null; then
  echo "error: guard agents check rejected $GUARD_AGENTS_TOML: redeploy the stack after fixing the variables or the committed agents.toml" >&2
  exit 2
fi

exec "$guard" "$@"
