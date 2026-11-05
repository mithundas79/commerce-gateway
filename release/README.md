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

## Operator and client onboarding

Run these commands from the installation directory after the installer succeeds. The host operator owns Docker/database access and provisions tenants. Each SaaS backend receives its own tenant API key and keeps it in its server-side secret manager. Merchants use their Shopify account to approve store permissions in the browser. Never put a gateway API key or Shopify client secret in browser code.

| Account or credential | Authority and storage |
| --- | --- |
| Host operator | Runs migrations and administration for all tenants; Docker access is administrative access. |
| SaaS service account | A tenant API key authorizes all supported API actions for that tenant. There are no per-key read/write roles or expiry settings. Use separate tenants for independently administered clients. |
| API and worker processes | Run as the container's `node` user and share the Compose `gateway` PostgreSQL account. This release does not provision separate database roles per process or tenant. |
| Merchant Shopify account | Must have permission to install/approve the app on that store; approval grants only the app's requested Shopify scopes. |
| `MASTER_KEY` and PostgreSQL password | Plaintext in owner-only `.env`; required with the database backup. |
| Gateway API keys | Raw value in the operator's owner-only secret file and the client's secret manager; PostgreSQL stores a SHA-256 hash. |
| Shopify app secret and merchant access/refresh tokens | Encrypted in PostgreSQL with `MASTER_KEY`; clients receive connection IDs rather than these credentials. |

The installer has already provisioned the default tenant in `.env` and its key in `.secrets/bootstrap-api-key`. To provision a separate SaaS client, this block generates a UUID and a cryptographically random key without printing the key. Change `acme` and `Acme SaaS` for each client. It refuses to overwrite an existing secret file. These examples require Compose's `run --env-from-file` option (`docker compose run --help` lists it).

```bash
bash <<'BASH'
set -Eeuo pipefail
set -o noclobber
umask 077
mkdir -p .secrets/tenants
chmod 700 .secrets/tenants
tenant_file=.secrets/tenants/acme.env
test ! -e "$tenant_file" || { printf '%s\n' 'Tenant file already exists; reuse it instead of generating a new identity.' >&2; exit 1; }
tenant_id=$(docker compose run --rm --no-deps -T api node --input-type=module -e 'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID())')
api_key=$(openssl rand -hex 32)
printf 'TENANT_ID=%s\nAPI_KEY=%s\nTENANT_NAME=Acme SaaS\n' "$tenant_id" "$api_key" > "$tenant_file"
unset api_key
docker compose run --rm --no-deps -T --env-from-file "$tenant_file" api node dist/admin.js bootstrap
BASH
```

If provisioning fails after the file is written, retry only the final `docker compose run ... bootstrap` command with that file. It is idempotent for the same tenant/key. Securely transfer its `API_KEY` value to the client's secret manager; never send `.env` or `MASTER_KEY` to a client. `release/backup.sh` includes `.secrets/tenants` when present. A lost raw client key cannot be recovered from its database hash.

To rotate a client's API key, create an additional key for the same tenant, install it in the client's secret manager, and confirm authenticated requests succeed. Then revoke the old key. Both keys work during this handover; bootstrap never reactivates a revoked key.

```bash
bash <<'BASH'
set -Eeuo pipefail
set -o noclobber
umask 077
old=.secrets/tenants/acme.env
next=.secrets/tenants/acme-next.env
test ! -e "$next" || { printf '%s\n' 'Next key file already exists; reuse it.' >&2; exit 1; }
tenant_id=$(sed -n 's/^TENANT_ID=//p' "$old")
api_key=$(openssl rand -hex 32)
printf 'TENANT_ID=%s\nAPI_KEY=%s\n' "$tenant_id" "$api_key" > "$next"
unset api_key
docker compose run --rm --no-deps -T --env-from-file "$next" api node dist/admin.js bootstrap
BASH
# After the client has switched and tested the new key:
docker compose run --rm --no-deps -T --env-from-file .secrets/tenants/acme.env \
  api node dist/admin.js revoke-api-key
```

`revoke-api-key` requires the key and its matching tenant; repeated revocation is safe. It blocks subsequent API requests and does not cancel operations already accepted. For a compromised key, revoke immediately before completing the replacement handover. These examples rotate an additional client key. If rotating the installer's default key, also update `.secrets/bootstrap-api-key` to the new active raw value with mode `600`; otherwise the next reinstall correctly rejects the revoked saved key.

## Configure the client's Shopify app

Create or select the intended Shopify app in the [Shopify Dev Dashboard](https://dev.shopify.com/dashboard). Use the app's client ID and client secret, not a store Admin API access token. Configure its exact OAuth redirect URL as `https://gateway.example.com/oauth/shopify/callback`, replacing the origin with this installation's `PUBLIC_BASE_URL`. Set the matching product permission to `write_products`. The gateway's `SHOPIFY_SCOPES` must match the scopes approved for the app; adding a scope requires merchant authorization again.

This gateway implements standalone authorization-code OAuth. In the matching app's existing `shopify.app.toml`, merge these settings while retaining that app's `client_id`, name, and application URL. `use_legacy_install_flow = true` selects the URL-based scope/authorization flow implemented here; Shopify managed installation uses a different flow. Deploy from your linked Shopify app project with `shopify app deploy`, or release equivalent app-version settings in the Dev Dashboard. See Shopify's [app configuration reference](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration).

```toml
embedded = false

[access_scopes]
scopes = "write_products"
use_legacy_install_flow = true

[auth]
redirect_urls = ["https://gateway.example.com/oauth/shopify/callback"]
```

This block prompts for credentials without echoing the secret or placing its value in command history. It configures the `acme` tenant created above; for the default tenant, read `TENANT_ID` from `.env` instead. Set `SHOPIFY_RETURN_URLS` to your client's exact HTTPS completion URL, or leave it empty to return the gateway's completion JSON.

```bash
export TENANT_ID=$(sed -n 's/^TENANT_ID=//p' .secrets/tenants/acme.env)
read -r -p 'Shopify client ID: ' SHOPIFY_CLIENT_ID
read -r -s -p 'Shopify client secret: ' SHOPIFY_CLIENT_SECRET; printf '\n'
export SHOPIFY_CLIENT_ID SHOPIFY_CLIENT_SECRET
export SHOPIFY_SCOPES=write_products
export SHOPIFY_RETURN_URLS=https://app.example.com/integrations/shopify/complete
docker compose run --rm --no-deps -T -e TENANT_ID -e SHOPIFY_CLIENT_ID \
  -e SHOPIFY_CLIENT_SECRET -e SHOPIFY_SCOPES -e SHOPIFY_RETURN_URLS \
  api node dist/admin.js configure-shopify
unset SHOPIFY_CLIENT_ID SHOPIFY_CLIENT_SECRET SHOPIFY_SCOPES SHOPIFY_RETURN_URLS TENANT_ID
```

The app secret is encrypted in `shopify_apps`; the raw value is not written to a host credential file by this command. Rerun it to update the same app's credentials. Changing the app client ID while its tenant has active store connections is rejected; revoke/reconnect those stores before changing app identity. Keep the same app identity for a connected store and do not treat two tenants as interchangeable merchant identities.

Before connecting the first shop, generate and deploy the three compliance subscriptions using [lifecycle setup, stage 1](shopify-lifecycle.md#1-deploy-the-compliance-subscriptions). Keep the standalone OAuth settings above; do not add `app/uninstalled` to the app TOML.

The client's backend then calls `POST /v1/shopify/connect` with its tenant bearer key and a `shop` such as `example-store.myshopify.com`. Send the merchant's browser to the returned `browserStartUrl` within 120 seconds; it is single use. The callback is public but validates Shopify's signature, state, and browser binding. After confirming the connection, run `admin shopify-uninstall-webhook` for that exact tenant/shop as documented in [lifecycle setup, stage 2](shopify-lifecycle.md#2-connect-the-shop-then-register-and-verify-uninstall). Require its verified receipt before accepting product writes. See the [request examples](../README.md#merchant-authorization) for the connect/read/write flow.

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

This takes a transaction-consistent `pg_dump` and copies the matching durable encryption/API secrets, including additional `.secrets/tenants` files when present. Backups contain plaintext secrets and customer/provider data. Keep them on encrypted storage with restricted access and transfer them between hosts over an authenticated encrypted channel such as SSH. Transfer decryption material through a separate secret channel when encrypting an archive, and keep both backups and keys out of CI artifacts and logs. Verify restore in an isolated environment regularly; a dump without the matching master key cannot recover encrypted provider credentials.

To restore into a clean checkout with the same application version, copy the backup's `env` to `.env` and `bootstrap-api-key` to `.secrets/bootstrap-api-key` (`mkdir -m 700 .secrets`; `chmod 600` both files). Copy the backup's `tenants` directory to `.secrets/tenants` if present and restrict its directories to mode `700` and files to `600`. Start only PostgreSQL and restore before running the installer:

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

Build ARM64 on an ARM64 host, or configure Docker QEMU emulation before using `linux/arm64`. The build checks the pinned registry manifests, builds the application, pulls PostgreSQL for the chosen platform, records image metadata, and packages both images. No image is pushed. The `Portable release` workflow builds bundles on pull requests and the main branch using native AMD64 and ARM64 runners. Each runs the installer twice against a local HTTPS ingress with its certificate explicitly trusted and checks authenticated health plus preservation of the single tenant/API key. The fixture then stops the source installation and restores its synthetic backup into a separate Docker-in-Docker host with an empty image store, no containers, and no volumes. The destination receives a fresh extraction of the packaged bundle and an AES-256-GCM encrypted backup. Its random transport key travels separately on stdin and all temporary key/backup files are removed after the test. The fixture checks distinct daemon IDs, an empty destination database before restore, credential decryption, recovered key authentication, healthy API/worker containers, and a PostgreSQL network marked internal with no published database port. Both Docker hosts share the CI runner's Linux kernel. Runtime execution is established by the workflow evidence for the tested commit.

The CI acceptance script requires `CI=true`, Node.js, and an isolated Linux Docker host capable of starting privileged `docker:28-dind` containers. It refuses existing project containers or volumes and deletes only its fixture resources. Run it only with synthetic data on an isolated test Docker host:

```bash
CI=true bash release/smoke-install.sh release-artifacts/commerce-gateway-dev-linux-amd64.tar.gz
```

Only a `v*` Git tag can trigger the publishing job, after both architecture checks succeed. PR and main-branch runs produce downloadable CI artifacts without creating a public release.

## Shopify lifecycle subscriptions

Deploy the three app-wide compliance subscriptions for each configured app, register and verify the shop-specific `APP_UNINSTALLED` subscription after each merchant installation, and enable recovery monitoring before accepting merchant traffic. [Shopify lifecycle configuration](shopify-lifecycle.md) gives the protected TOML generator, Admin GraphQL registration/readback command, raw-byte signature handling, uninstall and privacy erasure behavior, replay protection and operator recovery.

