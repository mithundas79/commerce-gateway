#!/usr/bin/env bash
# Produces self-contained Linux bundles: application image, PostgreSQL image, and installer.
set -Eeuo pipefail
umask 022
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
platform=${1:-linux/amd64}
version=${2:-dev}
output=${3:-"$ROOT/release-artifacts"}
[[ $platform == linux/amd64 || $platform == linux/arm64 ]] || { printf '%s\n' 'Supported platforms: linux/amd64, linux/arm64' >&2; exit 2; }
[[ $version =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$ ]] || { printf '%s\n' 'Invalid version label.' >&2; exit 2; }
[[ -f package-lock.json ]] || { printf '%s\n' 'A complete checkout with package-lock.json is required.' >&2; exit 1; }
for command in docker tar gzip sha256sum; do command -v "$command" >/dev/null; done
mkdir -p "$output"
output=$(cd "$output" && pwd)
staging=$(mktemp -d)
cleanup() { rm -rf -- "$staging"; }
trap cleanup EXIT
bundle="$staging/commerce-gateway"
mkdir -p "$bundle/release"

# These steps prove the pinned tags exist and support this platform before packaging.
docker buildx imagetools inspect node:26.13.0-bookworm-slim > "$staging/node-manifest.txt"
docker buildx imagetools inspect postgres:18.6-bookworm > "$staging/postgres-manifest.txt"
docker buildx build --pull --platform "$platform" --target runtime --tag commerce-gateway:local --load .
docker pull --platform "$platform" postgres:18.6-bookworm
[[ $(docker image inspect commerce-gateway:local --format '{{.Os}}/{{.Architecture}}') == "$platform" ]]
[[ $(docker image inspect postgres:18.6-bookworm --format '{{.Os}}/{{.Architecture}}') == "$platform" ]]
docker save commerce-gateway:local postgres:18.6-bookworm | gzip -1 > "$bundle/images.tar.gz"
cp compose.yaml "$bundle/compose.yaml"
cp release/install.sh release/backup.sh release/README.md "$bundle/release/"
for file in README.md LICENSE; do [[ ! -f $file ]] || cp "$file" "$bundle/"; done
cp "$staging/node-manifest.txt" "$staging/postgres-manifest.txt" "$bundle/"
printf '%s\n' "$platform" > "$bundle/BUNDLE_PLATFORM"
printf '%s\n' "$version" > "$bundle/BUNDLE_VERSION"
docker image inspect commerce-gateway:local postgres:18.6-bookworm --format '{{json .}}' > "$bundle/IMAGE_METADATA.jsonl"
(
  cd "$bundle"
  sha256sum images.tar.gz compose.yaml release/install.sh release/backup.sh BUNDLE_PLATFORM BUNDLE_VERSION > SHA256SUMS
)
archive="commerce-gateway-${version}-${platform//\//-}.tar.gz"
tar -C "$staging" -czf "$output/$archive" commerce-gateway
(cd "$output" && sha256sum "$archive" > "$archive.sha256")
printf 'Bundle saved: %s/%s\n' "$output" "$archive"
