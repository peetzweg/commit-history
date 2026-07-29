#!/usr/bin/env bash
#
# Reset the dev database to a fresh copy of prod — the poor-man's Neon branch
# (peetzweg/devops#4 Phase 3). Previews and local dev point at commit_history_dev,
# so run this whenever dev data has drifted too far or got dirtied by experiments.
#
#   pnpm db:refresh-dev
#
# The dump|restore runs entirely inside the Postgres container on the Coolify box —
# nothing is transferred to this machine. Requires the `coolify` SSH host alias.
set -euo pipefail

# Coolify's Postgres service container is named after the service UUID — update it
# here if the database service is ever recreated in Coolify.
PG_CONTAINER="x4w09a1ffuh4onvwgetr1yvx"
PROD_DB="commit_history"
DEV_DB="commit_history_dev"

echo "Refreshing $DEV_DB from $PROD_DB (in-container on the Coolify box)…"
ssh coolify "docker exec $PG_CONTAINER sh -c 'pg_dump -U postgres --clean --if-exists $PROD_DB | psql -q -U postgres $DEV_DB'"

ROWS=$(ssh coolify "docker exec $PG_CONTAINER psql -tA -U postgres -d $DEV_DB -c 'select count(*) from lookups'")
echo "Done — $DEV_DB now holds $ROWS lookups."
