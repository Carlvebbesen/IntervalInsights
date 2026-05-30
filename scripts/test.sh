#!/usr/bin/env bash
#
# Runs the test suite against a disposable Postgres container that is created
# fresh for this run and destroyed afterwards — it never touches the developer's
# local dev database. The schema is loaded from `drizzle-kit export` (the
# Drizzle schema as DDL), NOT from `db push` and NOT from the migration history.
#
# Usage: bun run test [-- <bun test args>]   e.g. `bun run test src/services`
set -euo pipefail

CONTAINER="ii_test_db_$$"
DB_USER="test_user"
DB_PASS="test_pw"
DB_NAME="interval_test"
IMAGE="postgres:18"

cleanup() {
  docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if ! docker info >/dev/null 2>&1; then
  echo "✗ Docker is required to run the tests (it provisions a throwaway Postgres)." >&2
  exit 1
fi

echo "▸ Starting disposable Postgres ($CONTAINER)…"
docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER="$DB_USER" \
  -e POSTGRES_PASSWORD="$DB_PASS" \
  -e POSTGRES_DB="$DB_NAME" \
  --tmpfs /var/lib/postgresql \
  -p 127.0.0.1::5432 \
  "$IMAGE" >/dev/null

# Docker-assigned host port → no collision with the dev DB on 5432.
HOST_PORT="$(docker port "$CONTAINER" 5432/tcp | head -1 | sed 's/.*://')"

echo "▸ Waiting for Postgres to accept connections…"
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "▸ Loading schema (drizzle-kit export → psql)…"
bunx drizzle-kit export \
  | docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q

# DATABASE_URL is what config.ts validates at import time; TEST_DATABASE_URL is
# what the test DB helper prefers. Set both to the throwaway instance.
export DATABASE_URL="postgres://$DB_USER:$DB_PASS@localhost:$HOST_PORT/$DB_NAME"
export TEST_DATABASE_URL="$DATABASE_URL"
echo "▸ Running tests against $DATABASE_URL"
bun test "$@"
