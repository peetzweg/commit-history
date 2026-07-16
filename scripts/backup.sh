#!/usr/bin/env bash
#
# Dump the production database (whatever DATABASE_URL points at) to a plain-SQL file under backups/.
#
#   pnpm backup            # -> backups/db-backup-YYYYMMDD-HHMMSS.sql
#
# Reads DATABASE_URL from .env. The backups/ dir is gitignored — dumps never leave
# your machine. Requires pg_dump; on macOS this ships with Homebrew's libpq
# (`brew install libpq`), which need not be on PATH — we discover it below.
set -euo pipefail

cd "$(dirname "$0")/.."

# --- locate pg_dump (PATH first, then Homebrew libpq which is keg-only) --------
PG_DUMP="$(command -v pg_dump || true)"
if [[ -z "$PG_DUMP" ]]; then
	for cand in /opt/homebrew/opt/libpq/bin/pg_dump /opt/homebrew/Cellar/libpq/*/bin/pg_dump /usr/local/opt/libpq/bin/pg_dump; do
		[[ -x "$cand" ]] && PG_DUMP="$cand" && break
	done
fi
if [[ -z "$PG_DUMP" ]]; then
	echo "error: pg_dump not found. Install it with: brew install libpq" >&2
	exit 1
fi

# --- read DATABASE_URL from .env (last non-empty assignment wins) --------------
if [[ ! -f .env ]]; then
	echo "error: .env not found" >&2
	exit 1
fi
DATABASE_URL="$(grep -E '^DATABASE_URL=.+' .env | tail -n1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/')"
if [[ -z "${DATABASE_URL:-}" ]]; then
	echo "error: DATABASE_URL is empty in .env" >&2
	exit 1
fi

mkdir -p backups
OUT="backups/db-backup-$(date +%Y%m%d-%H%M%S).sql"

echo "Dumping with $("$PG_DUMP" --version) -> $OUT"
"$PG_DUMP" "$DATABASE_URL" --no-owner --no-privileges --file "$OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "Done: $OUT ($SIZE)"
