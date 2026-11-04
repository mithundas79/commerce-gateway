# Linux installation

Prerequisites: Docker Engine with Compose v2 supporting `up --wait`, Bash, OpenSSL, curl, and a complete checkout including `package-lock.json`. The images are built from this checkout; no prepublished gateway image is assumed. The runtime is Node 26 LTS, pinned to 26.13.0; PostgreSQL is pinned to 18.6. Schedule patch updates and rebuilds as part of operating the service.

Before installation, configure DNS and a trusted HTTPS reverse proxy on the same host to forward your gateway origin to `127.0.0.1:3000`. Preserve request bodies and headers; do not log authorization, OAuth codes, or webhook bodies. The gateway binds only to loopback. PostgreSQL has no host port and is reachable only over the internal Compose database network. API and worker have a separate network for outbound provider requests.

For example, with an existing Caddy installation:

```caddyfile
gateway.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Run from the checkout:

```bash
bash release/install.sh https://gateway.example.com
```

The installer creates random durable secrets with owner-only permissions, builds the local image, waits for PostgreSQL, applies migrations, bootstraps one tenant and its scoped API key, and checks API/worker health plus the public HTTPS readiness URL. It exits unsuccessfully if the ingress check fails; the running containers remain available for diagnosis. Resolve the reported issue and rerun the same command. A successful container check does not configure provider OAuth credentials, webhooks, merchant accounts, or commerce provider permissions; complete the application configuration documented in the main README before processing live traffic.

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
docker compose up -d --wait db
docker compose exec -T db pg_restore --username=gateway --dbname=gateway --exit-on-error < /secure/backup/database.dump
bash release/install.sh
```

Use a new empty database volume for that restore. Restore to a database containing existing application tables fails; do not drop production data to work around it. The installer then validates the restored schema and existing scoped bootstrap key before starting the API and worker. Keep an encrypted off-host backup before any upgrade.
