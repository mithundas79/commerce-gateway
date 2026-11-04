#!/usr/bin/env bash
# Clean Docker host acceptance fixture. Only synthetic backup data may be supplied.
set -Eeuo pipefail
umask 077
[[ ${CI:-} == true ]] || { printf '%s\n' 'This test requires CI=true and an isolated Docker host.' >&2; exit 2; }
[[ $# == 3 && -f $1 && -d $2 && -f $3 ]] || { printf '%s\n' 'Usage: CI=true bash release/smoke-clean-host.sh bundle backup-directory original-secret-checksums' >&2; exit 2; }
archive=$(realpath "$1")
backup=$(realpath "$2")
checksums=$(realpath "$3")
outer=(docker --host "${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}")
temporary=$(mktemp -d)
daemon=
cleanup() {
  result=$?
  if [[ -n $daemon ]]; then "${outer[@]}" rm --force --volumes "$daemon" >/dev/null 2>&1 || true; fi
  rm -rf -- "$temporary"
  exit "$result"
}
trap cleanup EXIT
trap 'printf "Clean-host qualification failed at line %s\\n" "$LINENO" >&2' ERR
mkdir -p "$temporary/destination" "$temporary/socket"
destination="$temporary/destination"
# The source host retains the transport key. Only authenticated ciphertext enters
# the destination staging area, and the key is delivered separately on stdin.
openssl rand 32 > "$temporary/transport.key"
cat > "$destination/transport.mjs" <<'JS'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const [mode, output] = process.argv.slice(2);
if (mode === 'encrypt') {
  const key = readFileSync(process.env.TRANSPORT_KEY_FILE);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(readFileSync(0)), cipher.final()]);
  writeFileSync(output, Buffer.concat([nonce, cipher.getAuthTag(), encrypted]), { mode: 0o600 });
} else if (mode === 'decrypt') {
  const encrypted = readFileSync('/transfer/backup.enc');
  const decipher = createDecipheriv('aes-256-gcm', readFileSync(0), encrypted.subarray(0, 12));
  decipher.setAuthTag(encrypted.subarray(12, 28));
  const plaintext = Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
  writeFileSync(output, plaintext, { mode: 0o600 });
} else {
  throw new Error('Unsupported transport mode');
}
JS
tar -cz -C "$backup" . | TRANSPORT_KEY_FILE="$temporary/transport.key" node "$destination/transport.mjs" encrypt "$destination/backup.enc"

# A separate privileged DinD container is the destination Docker host. Its image
# store, networks and volumes start empty and disappear with this fixture.
daemon=$("${outer[@]}" run --detach --privileged --env DOCKER_TLS_CERTDIR= \
  --publish 127.0.0.1:3000:3001 --publish 127.0.0.1:3443:3443 \
  --mount "type=bind,src=$temporary/socket,dst=/var/run/qualification" \
  --mount "type=bind,src=$destination,dst=/qualification" \
  docker:28-dind dockerd --host=unix:///var/run/qualification/docker.sock --group "$(id -g)")
export DOCKER_HOST="unix://$temporary/socket/docker.sock"
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
for attempt in {1..60}; do
  if docker info >/dev/null 2>&1; then break; fi
  sleep 1
done
"${outer[@]}" exec "$daemon" test -f /qualification/backup.enc
docker info >/dev/null
[[ -z $(docker ps -aq) && -z $(docker volume ls -q) && -z $(docker image ls -aq) ]]
source_id=$("${outer[@]}" info --format '{{.ID}}')
destination_id=$(docker info --format '{{.ID}}')
[[ $source_id != "$destination_id" ]]
printf 'PASS: destination Docker host has a distinct daemon ID and empty containers, volumes and image store.\n'
tar -xzf "$archive" -C "$destination"
cd "$destination/commerce-gateway"
[[ ! -e .env && ! -e .secrets ]]
sha256sum --check --strict SHA256SUMS
docker load --input images.tar.gz
cat "$temporary/transport.key" | docker run --rm --interactive \
  --user "$(id -u):$(id -g)" --mount "type=bind,src=/qualification,dst=/transfer" \
  commerce-gateway:local node /transfer/transport.mjs decrypt /transfer/backup.tar.gz
mkdir "$destination/recovered"
tar -xzf "$destination/backup.tar.gz" -C "$destination/recovered"
rm "$destination/backup.tar.gz"
cp "$destination/recovered/env" .env
mkdir -m 700 .secrets
cp "$destination/recovered/bootstrap-api-key" .secrets/bootstrap-api-key
cp -R "$destination/recovered/tenants" .secrets/tenants
chmod 600 .env .secrets/bootstrap-api-key
chmod -R go-rwx .secrets
sha256sum --check --status "$checksums"
cmp .secrets/tenants/restore-probe.env "$destination/recovered/tenants/restore-probe.env"

# Both readiness endpoints pass through the destination host's loopback service.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -addext subjectAltName=DNS:localhost -keyout "$destination/server.key" -out "$destination/server.crt" >/dev/null 2>&1
export CURL_CA_BUNDLE="$destination/server.crt"
cat > "$destination/proxy.mjs" <<'JS'
import { readFileSync } from 'node:fs';
import { createServer as https } from 'node:https';
import { createServer as http, request } from 'node:http';
function proxy(incoming, outgoing) {
  if (incoming.url === '/proxy-ready') { outgoing.end('ready'); return; }
  const upstream = request({ hostname: '127.0.0.1', port: 3000, path: incoming.url, method: incoming.method, headers: incoming.headers }, response => {
    outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
  });
  upstream.on('error', () => { outgoing.writeHead(502); outgoing.end(); });
  incoming.pipe(upstream);
}
https({ key: readFileSync('/transfer/server.key'), cert: readFileSync('/transfer/server.crt') }, proxy).listen(3443, '0.0.0.0');
http(proxy).listen(3001, '0.0.0.0');
JS
docker run --detach --name recovery-ingress --network host --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=/qualification,dst=/transfer,readonly" \
  commerce-gateway:local node /transfer/proxy.mjs >/dev/null
for attempt in {1..30}; do
  if curl --fail --silent https://localhost:3443/proxy-ready >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent --show-error https://localhost:3443/proxy-ready >/dev/null
unset POSTGRES_PASSWORD MASTER_KEY TENANT_ID PUBLIC_BASE_URL HOST_PORT API_KEY COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES
compose=(docker compose --project-name commerce-gateway --env-file .env -f compose.yaml)
"${compose[@]}" up -d --wait --wait-timeout 120 db
[[ $("${compose[@]}" exec -T db psql -U gateway -d gateway -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'") == 0 ]]
"${compose[@]}" exec -T db pg_restore --username=gateway --dbname=gateway --exit-on-error < "$destination/recovered/database.dump"
bash release/install.sh
sha256sum --check --status "$checksums"
tenant_id=$(sed -n 's/^TENANT_ID=//p' .env)
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
api_key=$(cat .secrets/bootstrap-api-key)
curl --fail --silent --show-error -H "Authorization: Bearer $api_key" https://localhost:3443/v1/connections >/dev/null
curl --fail --silent --show-error -H "Authorization: Bearer $api_key" https://localhost:3443/v1/health >/dev/null
[[ $(curl --silent --output /dev/null --write-out '%{http_code}' https://localhost:3443/v1/health) == 401 ]]
[[ $(curl --silent --output /dev/null --write-out '%{http_code}' https://localhost:3443/v1/connections) == 401 ]]
unset api_key
[[ $(docker inspect --format '{{.State.Health.Status}}' "$("${compose[@]}" ps -q api)") == healthy ]]
[[ $(docker inspect --format '{{.State.Health.Status}}' "$("${compose[@]}" ps -q worker)") == healthy ]]
db_id=$("${compose[@]}" ps -q db)
[[ -z $(docker port "$db_id") ]]
[[ $(docker inspect --format '{{len .NetworkSettings.Networks}}' "$db_id") == 1 ]]
db_network=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.NetworkID}}{{end}}' "$db_id")
[[ $(docker network inspect --format '{{.Internal}}' "$db_network") == true ]]
printf '%s\n' 'PASS: clean Docker host restore, persistent tenant/API keys, private database, authenticated HTTPS smoke, healthy API/worker, and encrypted credential recovery.'
