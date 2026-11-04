#!/usr/bin/env bash
# Destructive acceptance test for an isolated CI Docker host only.
set -Eeuo pipefail
umask 077
[[ ${CI:-} == true ]] || { printf '%s\n' 'This test requires CI=true and an isolated Docker host; it deletes its test volume.' >&2; exit 2; }
[[ $# == 1 && -f $1 ]] || { printf '%s\n' 'Usage: CI=true bash release/smoke-install.sh path/to/bundle.tar.gz' >&2; exit 2; }
archive=$(realpath "$1")
[[ -z $(docker ps -a --filter label=com.docker.compose.project=commerce-gateway --quiet) ]] || { printf '%s\n' 'Refusing to use an existing commerce-gateway project.' >&2; exit 1; }
[[ -z $(docker volume ls --filter label=com.docker.compose.project=commerce-gateway --quiet) ]] || { printf '%s\n' 'Refusing to use an existing commerce-gateway volume.' >&2; exit 1; }
temporary=$(mktemp -d)
proxy_pid=
cleanup() {
  result=$?
  if [[ -f "$temporary/commerce-gateway/.env" ]]; then
    (
      cd "$temporary/commerce-gateway"
      if (( result != 0 )); then docker compose ps; docker compose logs --tail 80 api worker; fi
      docker compose down --volumes --remove-orphans
    ) || true
  fi
  [[ -z $proxy_pid ]] || kill "$proxy_pid" 2>/dev/null || true
  rm -rf -- "$temporary"
  exit "$result"
}
trap cleanup EXIT
tar -xzf "$archive" -C "$temporary"
cd "$temporary/commerce-gateway"
[[ -f BUNDLE_PLATFORM && ! -e package.json && ! -d src && ! -f compose.build.yaml ]]
sha256sum --check --strict SHA256SUMS
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -addext subjectAltName=DNS:localhost -keyout "$temporary/server.key" -out "$temporary/server.crt" >/dev/null 2>&1
export CURL_CA_BUNDLE="$temporary/server.crt"
node --input-type=module - "$temporary/server.key" "$temporary/server.crt" <<'JS' &
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { request } from 'node:http';
const [key, cert] = process.argv.slice(2);
createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (incoming, outgoing) => {
  if (incoming.url === '/proxy-ready') { outgoing.end('ready'); return; }
  const upstream = request({ hostname: '127.0.0.1', port: 3000, path: incoming.url, method: incoming.method, headers: incoming.headers }, response => {
    outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
  });
  upstream.on('error', () => { outgoing.writeHead(502); outgoing.end(); });
  incoming.pipe(upstream);
}).listen(3443, '127.0.0.1');
JS
proxy_pid=$!
for attempt in {1..30}; do
  if curl --fail --silent https://localhost:3443/proxy-ready >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent --show-error https://localhost:3443/proxy-ready >/dev/null

bash release/install.sh https://localhost:3443
sha256sum .env .secrets/bootstrap-api-key > "$temporary/secrets.before"
[[ $(stat -c %a .env) == 600 && $(stat -c %a .secrets/bootstrap-api-key) == 600 ]]
bash release/install.sh
sha256sum --check "$temporary/secrets.before"
compose=(docker compose --project-name commerce-gateway --env-file .env -f compose.yaml)
tenant_id=$(sed -n 's/^TENANT_ID=//p' .env)
[[ $("${compose[@]}" exec -T db psql -U gateway -d gateway -Atc 'SELECT count(*) FROM tenants') == 1 ]]
[[ $("${compose[@]}" exec -T db psql -U gateway -d gateway -Atc 'SELECT count(*) FROM api_keys') == 1 ]]
api_key=$(cat .secrets/bootstrap-api-key)
curl --fail --silent --show-error -H "Authorization: Bearer $api_key" https://localhost:3443/v1/connections >/dev/null
[[ $(curl --silent --output /dev/null --write-out '%{http_code}' https://localhost:3443/v1/connections) == 401 ]]
unset api_key

# Exercise encryption in the real application, then prove the matching key survives restore.
"${compose[@]}" run --rm --no-deps -T -e "TENANT_ID=$tenant_id" -e SHOPIFY_CLIENT_ID=ci-client \
  -e SHOPIFY_CLIENT_SECRET=ci-encrypted-restore-probe -e SHOPIFY_SCOPES=write_products api node dist/admin.js configure-shopify
bash release/backup.sh "$temporary/backups"
backup_dir=$(find "$temporary/backups" -mindepth 1 -maxdepth 1 -type d)
[[ -s "$backup_dir/database.dump" && -f "$backup_dir/env" && -f "$backup_dir/bootstrap-api-key" ]]
"${compose[@]}" down --volumes
# A fresh database plus recovered files models loss of the installation volume.
cp "$backup_dir/env" .env
cp "$backup_dir/bootstrap-api-key" .secrets/bootstrap-api-key
"${compose[@]}" up -d --wait --wait-timeout 120 db
"${compose[@]}" exec -T db pg_restore --username=gateway --dbname=gateway --exit-on-error < "$backup_dir/database.dump"
bash release/install.sh
sha256sum --check "$temporary/secrets.before"
"${compose[@]}" run --rm --no-deps -T -e "TENANT_ID=$tenant_id" api node --input-type=module -e '
  import assert from "node:assert/strict";
  import { Pool } from "pg";
  import { PostgresStore } from "./dist/store.js";
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const app = await new PostgresStore(pool, process.env.MASTER_KEY).getApp(process.env.TENANT_ID);
    assert.equal(app.clientSecret, "ci-encrypted-restore-probe");
    const counts = await pool.query("SELECT (SELECT count(*) FROM tenants)::int AS tenants, (SELECT count(*) FROM api_keys)::int AS keys");
    assert.deepEqual(counts.rows[0], { tenants: 1, keys: 1 });
  } finally { await pool.end(); }
'
printf '%s\n' 'PASS: prebuilt install, trusted HTTPS, worker/API health, scoped key, idempotent reinstall, backup/restore, and encrypted credential recovery.'
