#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
if (( $# > 1 )); then printf '%s\n' 'Usage: bash release/backup.sh [backup-directory]' >&2; exit 2; fi
command -v docker >/dev/null
[[ -f .env && -f .secrets/bootstrap-api-key ]] || { printf '%s\n' 'Run the installer before backing up.' >&2; exit 1; }
unset POSTGRES_PASSWORD MASTER_KEY TENANT_ID PUBLIC_BASE_URL HOST_PORT API_KEY COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES
destination=${1:-"$ROOT/backups"}
mkdir -p "$destination"
chmod 700 "$destination"
backup_dir=$(mktemp -d "$destination/commerce-gateway-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
# Keep database dump and durable encryption/API secrets together. The directory is sensitive.
docker compose --project-name commerce-gateway --env-file .env -f compose.yaml exec -T db \
  pg_dump --username=gateway --dbname=gateway --format=custom > "$backup_dir/database.dump.pending"
mv "$backup_dir/database.dump.pending" "$backup_dir/database.dump"
cp .env "$backup_dir/env"
cp .secrets/bootstrap-api-key "$backup_dir/bootstrap-api-key"
chmod 600 "$backup_dir/"*
printf '%s\n' 'commerce-gateway backup v1; PostgreSQL 18 custom-format dump; secrets are plaintext, store on encrypted backup media.' > "$backup_dir/README.txt"
printf 'Backup saved: %s\n' "$backup_dir"
