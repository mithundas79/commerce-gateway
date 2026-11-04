# Linux installation

Prerequisites: Docker Engine with Compose v2 supporting `up --wait`, Bash, OpenSSL, curl, tar, and sha256sum. Use either the portable prebuilt Linux bundle for your Docker host architecture (AMD64 or ARM64) or a complete source checkout including `package-lock.json`. The runtime is Node 26 LTS, pinned to 26.13.0; PostgreSQL is pinned to 18.6. Schedule patch updates and rebuilds as part of operating the service.

Before installation, configure DNS and a trusted HTTPS reverse proxy on the same host to forward your gateway origin to `127.0.0.1:3000`. Preserve request bodies and headers; do not log authorization, OAuth codes, or webhook bodies. The gateway binds only to loopback. PostgreSQL has no host port and is reachable only over the internal Compose database network. API and worker have a separate network for outbound provider requests.

For example, with an existing Caddy installation:

```caddyfile
gateway.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

## Install a prebuilt bundle

Download the archive and matching `.sha256` asset for your release and architecture from a trusted release page. No public release has been published by this change. Replace `vX.Y.Z` below with the downloaded version; use `linux-arm64` for an ARM64 Docker host:

```bash
archive=commerce-gateway-vX.Y.Z-linux-amd64.tar.gz
sha256sum --check "$archive.sha256"
tar -xzf "$archive"
cd commerce-gateway
bash release/install.sh https://gateway.example.com
```

The archive includes application and PostgreSQL images; installation loads them locally and requires no compiler, npm installation, or registry pull. The installer verifies the internal checksums and refuses an architecture mismatch. Checksums detect corruption; obtain the archive and checksum from a trusted release source. The service still needs internet access for Shopify and notification providers. A release bundle is platform-specific, and its application image runs through Docker rather than as a native host executable.

To upgrade a prebuilt installation, back up first, stop its API and worker, then replace the bundle files in the existing installation directory while retaining `.env` and `.secrets`. Run the installer again. Keep the previous bundle and a database backup for recovery; database downgrades require restoring the matching backup.

## Install from a source checkout

Run from the checkout (registry access is required during the build):

```bash
bash release/install.sh https://gateway.example.com
```

Source mode builds the local image with `compose.build.yaml`; bundle mode loads the supplied images. Both modes create random durable secrets with owner-only permissions, wait for PostgreSQL, apply migrations, bootstrap one tenant and its scoped API key, and check API/worker health plus the public HTTPS readiness URL. The installer exits unsuccessfully if the ingress check fails; the running containers remain available for diagnosis. Resolve the reported issue and rerun the same command. A successful container check does not configure provider OAuth credentials, webhooks, merchant accounts, or commerce provider permissions; complete the application configuration documented in the main README before processing live traffic.

Run `bash release/install.sh` again for an idempotent reinstall or upgrade. It retains the database volume, tenant, key, and origin and retries migrations/bootstrap. Never delete `.env`, `.secrets`, or the volume to retry an install. If `install.lock` remains after a killed process, verify no installer is running before removing `.secrets/install.lock`.

The API key is in `.secrets/bootstrap-api-key`; it is never printed. `.env` contains `POSTGRES_PASSWORD`, `MASTER_KEY` (64 hexadecimal characters), `TENANT_ID`, `PUBLIC_BASE_URL` (HTTPS origin without a trailing slash), and `HOST_PORT`. Keep these files outside source control and restrict host access. Changing `MASTER_KEY` without reencrypting stored credentials makes those credentials unreadable; changing the database password in `.env` does not change an existing PostgreSQL role password. Reinstall deliberately rejects changed origin arguments; edit `PUBLIC_BASE_URL` in `.env` and update provider redirect/webhook settings together when moving domains.

The Compose project name is fixed at `commerce-gateway` to keep its volume stable if the checkout moves. Run one instance per Docker host unless you deliberately override the project name and port. `docker compose down` preserves data; `docker compose down --volumes` deletes it.

## Health and diagnostics

```bash
docker compose ps
docker compose logs --tail 100 api worker
curl --fail http://127.0.0.1:3000/readyz
```

`/healthz` is process liveness; `/readyz` checks application readiness including the database. The worker writes a heartbeat file each loop; Docker fails its health check if it is missing or more than two minutes old. Container restart policy recovers exited processes; Docker does not automatically restart a process solely because its health check fails. Monitor unhealthy states and delivery failures.

## Backup and restore

```bash
bash release/backup.sh /secure/encrypted/backup-location
```

This takes a transaction-consistent `pg_dump` and copies the matching durable encryption/API secrets. Backups contain plaintext secrets and customer/provider data: keep them on encrypted storage with restricted access. Verify restore in an isolated environment regularly; a dump without the matching master key cannot recover encrypted provider credentials.

To restore into a clean checkout with the same application version, copy the backup's `env` to `.env` and `bootstrap-api-key` to `.secrets/bootstrap-api-key` (`mkdir -m 700 .secrets`; `chmod 600` both files). Start only PostgreSQL and restore before running the installer:

```bash
if [ -f images.tar.gz ]; then docker load --input images.tar.gz; fi
docker compose up -d --wait db
docker compose exec -T db pg_restore --username=gateway --dbname=gateway --exit-on-error < /secure/backup/database.dump
bash release/install.sh
```

Use a new empty database volume for that restore. Restore to a database containing existing application tables fails; do not drop production data to work around it. The installer then validates the restored schema and existing scoped bootstrap key before starting the API and worker. Keep an encrypted off-host backup before any upgrade.

## Build and acceptance checks

On a Linux Docker build host with Buildx, produce a portable bundle from a complete checkout:

```bash
bash release/build-bundle.sh linux/amd64 dev
```

Build ARM64 on an ARM64 host, or configure Docker QEMU emulation before using `linux/arm64`. The build checks the pinned registry manifests, builds the application, pulls PostgreSQL for the chosen platform, records image metadata, and packages both images. No image is pushed. The `Portable release` workflow builds bundles on pull requests and the main branch using native AMD64 and ARM64 runners. Each runs the installer against a local HTTPS ingress with its certificate explicitly trusted, verifies authentication, checks repeated installation preserves secrets and the single tenant/API key, and restores a database backup into a fresh volume before decrypting an application credential. Runtime execution is pending until that workflow succeeds on the branch; local Compose configuration validation alone does not establish a passing installation.

The CI acceptance script requires `CI=true` and refuses existing project containers or volumes because it deletes its own test volume. Run it only on an isolated test Docker host:

```bash
CI=true bash release/smoke-install.sh release-artifacts/commerce-gateway-dev-linux-amd64.tar.gz
```

Only a `v*` Git tag can trigger the publishing job, after both architecture checks succeed. PR and main-branch runs produce downloadable CI artifacts without creating a public release.
