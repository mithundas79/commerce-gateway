#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

usage() {
  printf '%s\n' 'Usage: bash release/install.sh [https://gateway.example.com]' \
    'First install requires the HTTPS public origin. Configure a reverse proxy to 127.0.0.1:3000 first.' \
    'Rerun from the same checkout to preserve the database, master key, tenant, and API key.'
}
if [[ ${1:-} == --help || ${1:-} == -h ]]; then usage; exit 0; fi
if (( $# > 1 )); then usage >&2; exit 2; fi
for command in docker openssl curl; do
  command -v "$command" >/dev/null || { printf 'Required command missing: %s\n' "$command" >&2; exit 1; }
done
docker compose version >/dev/null
docker info >/dev/null
if [[ -f BUNDLE_PLATFORM ]]; then
  for command in sha256sum; do command -v "$command" >/dev/null || { printf 'Required command missing: %s\n' "$command" >&2; exit 1; }; done
  [[ -f images.tar.gz && -f SHA256SUMS ]] || { printf '%s\n' 'Incomplete prebuilt bundle.' >&2; exit 1; }
  sha256sum --check --strict SHA256SUMS
  bundle_platform=$(cat BUNDLE_PLATFORM)
  host_platform=$(docker info --format '{{.OSType}}/{{.Architecture}}')
  case "$host_platform" in linux/x86_64) host_platform=linux/amd64 ;; linux/aarch64) host_platform=linux/arm64 ;; esac
  [[ $bundle_platform == "$host_platform" ]] || { printf 'Bundle platform %s does not match Docker platform %s. Download the matching bundle.\n' "$bundle_platform" "$host_platform" >&2; exit 1; }
  install_mode=bundle
else
  [[ -f package-lock.json && -f compose.build.yaml ]] || { printf '%s\n' 'Use a complete source checkout or an extracted prebuilt release bundle.' >&2; exit 1; }
  install_mode=source
fi

mkdir -p .secrets
chmod 700 .secrets
if ! mkdir .secrets/install.lock 2>/dev/null; then
  printf '%s\n' 'Another install is running, or .secrets/install.lock is stale. Verify no install is active before removing it.' >&2
  exit 1
fi
cleanup() { rmdir .secrets/install.lock; }
trap cleanup EXIT

read_setting() {
  local key=$1 count
  count=$(awk -F= -v key="$key" '$1 == key { n++ } END { print n+0 }' .env)
  [[ $count == 1 ]] || { printf 'Expected one %s setting in .env\n' "$key" >&2; return 1; }
  sed -n "s/^${key}=//p" .env
}
valid_origin() { [[ $1 =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$ ]]; }

if [[ -f .env ]]; then
  chmod 600 .env
  [[ -f .secrets/bootstrap-api-key ]] || {
    printf '%s\n' 'Saved API key is missing. Restore .secrets/bootstrap-api-key from the matching backup; reinstall will not rotate it.' >&2; exit 1;
  }
  public_origin=$(read_setting PUBLIC_BASE_URL)
  [[ -z ${1:-} || $1 == "$public_origin" ]] || {
    printf '%s\n' 'Public origin differs from .env. Update PUBLIC_BASE_URL deliberately before rerunning.' >&2; exit 1;
  }
  db_password=$(read_setting POSTGRES_PASSWORD)
  master_key=$(read_setting MASTER_KEY)
  tenant_id=$(read_setting TENANT_ID)
  host_port=$(read_setting HOST_PORT)
else
  public_origin=${1:-}
  valid_origin "$public_origin" || { usage >&2; printf '%s\n' 'Provide a valid HTTPS origin without a path or trailing slash.' >&2; exit 2; }
  if [[ ! -f .secrets/bootstrap-api-key ]]; then
    openssl rand -hex 32 > .secrets/bootstrap-api-key.pending
    mv .secrets/bootstrap-api-key.pending .secrets/bootstrap-api-key
  fi
  db_password=$(openssl rand -hex 32)
  master_key=$(openssl rand -hex 32)
  uuid_hex=$(openssl rand -hex 16)
  # RFC 4122 version 4 UUID, with the variant fixed to binary 10.
  tenant_id="${uuid_hex:0:8}-${uuid_hex:8:4}-4${uuid_hex:13:3}-a${uuid_hex:17:3}-${uuid_hex:20:12}"
  host_port=3000
  {
    printf 'POSTGRES_PASSWORD=%s\n' "$db_password"
    printf 'MASTER_KEY=%s\n' "$master_key"
    printf 'TENANT_ID=%s\n' "$tenant_id"
    printf 'PUBLIC_BASE_URL=%s\n' "$public_origin"
    printf 'HOST_PORT=%s\n' "$host_port"
  } > .secrets/env.pending
  mv .secrets/env.pending .env
fi

valid_origin "$public_origin" || { printf '%s\n' 'Invalid PUBLIC_BASE_URL; expected an HTTPS origin.' >&2; exit 1; }
[[ $db_password =~ ^[0-9a-f]{64}$ && $master_key =~ ^[0-9a-f]{64}$ ]] || {
  printf '%s\n' 'Invalid secret format in .env; never replace the master key for an existing database.' >&2; exit 1;
}
[[ $tenant_id =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  printf '%s\n' 'Invalid TENANT_ID in .env.' >&2; exit 1;
}
[[ $host_port =~ ^[0-9]{1,5}$ ]] && (( 10#$host_port >= 1 && 10#$host_port <= 65535 )) || {
  printf '%s\n' 'Invalid HOST_PORT in .env.' >&2; exit 1;
}

chmod 600 .secrets/bootstrap-api-key
api_key=$(cat .secrets/bootstrap-api-key)
[[ $api_key =~ ^[0-9a-f]{64}$ ]] || { printf '%s\n' 'Invalid saved bootstrap API key.' >&2; exit 1; }

# Never source .env as shell code; Compose reads its data using --env-file.
# An inherited shell variable must not override the persisted installation secrets.
unset POSTGRES_PASSWORD MASTER_KEY TENANT_ID PUBLIC_BASE_URL HOST_PORT API_KEY COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES
compose=(docker compose --project-name commerce-gateway --env-file .env -f compose.yaml)
if [[ $install_mode == source ]]; then compose+=(-f compose.build.yaml); fi
"${compose[@]}" config --quiet
if [[ $install_mode == bundle ]]; then
  docker load --input images.tar.gz
else
  "${compose[@]}" build --pull api
fi
"${compose[@]}" up -d --wait --wait-timeout 120 db
"${compose[@]}" run --rm --no-deps -T api node dist/admin.js migrate
"${compose[@]}" run --rm --no-deps -T -e "TENANT_ID=$tenant_id" -e "API_KEY=$api_key" api node dist/admin.js bootstrap
unset api_key db_password master_key
"${compose[@]}" up -d --no-build --wait --wait-timeout 180 api worker
curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:$host_port/readyz" >/dev/null
if ! curl --fail --silent --show-error --max-time 20 "$public_origin/readyz" >/dev/null; then
  printf '%s\n' 'Containers are running, but HTTPS ingress validation failed. Check DNS, TLS, and proxy routing, then rerun this command.' >&2
  exit 1
fi
printf 'Ready: %s\nTenant: %s\nAPI key: %s/.secrets/bootstrap-api-key (mode 600)\n' "$public_origin" "$tenant_id" "$ROOT"
printf '%s\n' 'Back up .env and .secrets/bootstrap-api-key securely with the database; losing MASTER_KEY makes encrypted credentials unrecoverable.'
