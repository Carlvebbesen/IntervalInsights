#!/usr/bin/env bash
#
# Runs the REAL intervals_wellness_service tests
# (tests/wellness_service_computed.test.ts) against a disposable Postgres, using
# the dedicated bun config (tests/bunfig.fitness.toml) that leaves
# intervals_wellness_service UNMOCKED. Mirrors scripts/test-pace.sh.
#
# Usage: bun run test:fitness
set -euo pipefail

CONTAINER="ii_fitness_test_db_$$"
DB_USER="test_user"
DB_PASS="test_pw"
DB_NAME="interval_test"
IMAGE="postgres:18"
CONFIG="tests/bunfig.fitness.toml"
TARGET="tests/wellness_service_computed.test.ts"

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

export DATABASE_URL="postgres://$DB_USER:$DB_PASS@localhost:$HOST_PORT/$DB_NAME"
export TEST_DATABASE_URL="$DATABASE_URL"
echo "▸ Running fitness-service tests against $DATABASE_URL (config: $CONFIG)"
bun --config="$CONFIG" test "$TARGET" "$@"
