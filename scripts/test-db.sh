#!/usr/bin/env bash
#
# Apply the migrations to a throwaway Postgres cluster and run the SQL tests.
#
# The pricing rules — cheapest landed cost, the staleness window, the
# repricing trigger, and the column grants that keep distributor cost away
# from anon — live in the database, so this is where they get tested. The
# Playwright suite covers the browser; this covers the guarantees.
#
# Needs a local PostgreSQL 14+ (`initdb`, `pg_ctl`, `psql`) and nothing else.
# Never points at the live project: it builds its own cluster and deletes it.
#
#   ./scripts/test-db.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Short path on purpose: a Unix socket path is capped at ~107 bytes.
WORKDIR="${TH_PGTMP:-/tmp/th-pgtest-$$}"
PORT="${TH_PGPORT:-5433}"
PGBIN="${TH_PGBIN:-}"

if [[ -z "$PGBIN" ]]; then
  if command -v initdb >/dev/null 2>&1; then
    PGBIN="$(dirname "$(command -v initdb)")"
  else
    PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1 || true)"
  fi
fi
if [[ -z "$PGBIN" || ! -x "$PGBIN/initdb" ]]; then
  echo "Could not find initdb. Install PostgreSQL, or set TH_PGBIN." >&2
  exit 1
fi

# initdb refuses to run as root, so borrow the postgres system user when we are.
AS_PG=()
OWNER="$(id -un)"
if [[ "$(id -u)" -eq 0 ]] && id postgres >/dev/null 2>&1; then
  AS_PG=(su postgres -c)
  OWNER=postgres
fi

run() {
  if [[ ${#AS_PG[@]} -gt 0 ]]; then
    su postgres -c "$1"
  else
    bash -c "$1"
  fi
}

cleanup() {
  run "$PGBIN/pg_ctl -D $WORKDIR/data -m immediate stop" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"
chown "$OWNER" "$WORKDIR"
chmod 700 "$WORKDIR"

run "$PGBIN/initdb -D $WORKDIR/data -U postgres --auth=trust" >/dev/null
run "$PGBIN/pg_ctl -D $WORKDIR/data -l $WORKDIR/pg.log \
  -o '-k $WORKDIR -p $PORT -c listen_addresses=' -w start" >/dev/null

PSQL="psql -h $WORKDIR -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -q"

echo "→ bootstrap"
run "$PSQL -f $ROOT/supabase/tests/00_bootstrap.sql"

for migration in "$ROOT"/supabase/migrations/*.sql; do
  echo "→ $(basename "$migration")"
  run "$PSQL -f $migration"
done

status=0
for suite in "$ROOT"/supabase/tests/[1-9]*.sql; do
  echo "→ $(basename "$suite")"
  if ! run "$PSQL -f $suite"; then
    status=1
  fi
done

if [[ $status -eq 0 ]]; then
  echo "database tests passed"
else
  echo "database tests FAILED" >&2
fi
exit $status
