# Windows disposable Shopify lab

Use a separate source checkout on a disposable Docker Desktop Linux-container host with Node 26, Git for Windows (including Git Bash), and Docker Compose v2. The helper runs this repository's Docker application installer. Install Docker Desktop itself before invoking it.

Keep one verified HTTPS reverse proxy or tunnel forwarding to `127.0.0.1:3000` alive for the entire command, merchant approval, smoke run, and restoration. Configure the matching Shopify development app's redirect as `<your-origin>/oauth/shopify/callback` and its standalone OAuth settings as described in [release installation](README.md#configure-the-clients-shopify-app). Use an origin you control with a trusted TLS certificate. An expired quick tunnel needs its replacement callback approved in Shopify and a deliberate origin update before retrying. Failed ingress readiness prevents app configuration and browser launch.

Create or select a private local settings file outside the lab checkout. Pass its path with `-ShopifyEnvPath`. The helper reads only `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, and optional `SHOPIFY_SCOPES` (default `write_products`). These must be the app client credentials. Other settings are ignored. Literal single-line bare or quoted values and an optional `export` prefix are supported. Duplicate selected keys, multiline values, quoted escapes, and unquoted whitespace are rejected. Values are never evaluated, expanded, printed, or copied into the generated installation `.env`. The app secret goes to `configure-shopify` through child-process environment variables and is encrypted by the gateway in PostgreSQL.

For a new app or a changed tunnel, first run `-PrepareOnly` as shown below, deploy the three compliance subscriptions and matching OAuth callback, then run the following nonmutation command. Replace the placeholders with your verified gateway origin, exact canonical development shop, and settings file path.

```powershell
.\release\windows-lab.ps1 -ShopifyEnvPath 'C:\private\shopify.env' -PublicOrigin 'https://gateway.your-domain.tld' -Shop 'your-disposable-store.myshopify.com'
```

The command installs the service, repeats migration/bootstrap with the same tenant and key, verifies HTTPS readiness, configures the default tenant's Shopify app, and opens only the returned gateway browser start URL. Approve that exact shop in your browser. It waits up to 15 minutes for a new or updated connection for the requested shop and then verifies a product read. This invocation performs no product mutation. It exits with fixed error codes and keeps bearer/app credentials out of console output and command arguments. Browser authorization tickets stay in the browser handoff. Authenticated helper requests go exclusively to literal `127.0.0.1` on the saved installation port. The public origin receives unauthenticated readiness requests and the user's browser OAuth flow.

The installer uses the fixed Docker project `commerce-gateway`, its durable PostgreSQL volume, and loopback port 3000. The helper refuses containers whose Compose working directory differs from this checkout and refuses existing project volumes when this checkout has no installation `.env`. Use one lab per Docker host and keep this checkout for recovery. Resolve a host-port conflict or stop another installation deliberately before retrying. Repeated invocation retains the installation's master key, tenant, database, and bearer. The helper runs no Docker volume deletion or database reset.

## Prepare the service for a handoff

Use `-PrepareOnly` when the Docker operator will hand the configured service to someone who can complete Shopify app-version configuration, browser approval, and acceptance through the local gateway.

```powershell
.\release\windows-lab.ps1 -ShopifyEnvPath 'C:\private\shopify.env' -PublicOrigin 'https://gateway.your-domain.tld' -Shop 'your-disposable-store.myshopify.com' -PrepareOnly
```

The command completes installation, repeated migration/bootstrap, public HTTPS readiness, and secure tenant Shopify configuration, then exits with a fixed setup report and the exact callback URL. It creates no OAuth/browser ticket, opens no browser, performs no connection polling, and submits no product write. Keep the HTTPS ingress running for the subsequent browser callback. `-PrepareOnly` rejects mutation acknowledgement/target arguments, `-AllowMutation`, `-Resume`, and `-NewRun`. An existing incomplete mutation run retains its recovery guards.

## Deploy lifecycle settings and verify the connected shop

After `-PrepareOnly`, generate the default tenant's compliance TOML. Keep `.secrets` restricted to the operating account. Windows PowerShell 5.1's native `>` redirection uses UTF-16; this example writes UTF-8 without a BOM for Shopify CLI. Stdout contains only TOML, so no diagnostic-line filtering is needed.

```powershell
$toml = & docker compose run --rm --no-deps -T --env-from-file .env api node dist/admin.js shopify-webhooks
if ($LASTEXITCODE -ne 0) { throw 'Compliance configuration generation failed' }
[IO.File]::WriteAllLines((Join-Path $PWD '.secrets/shopify-webhooks.toml'), [string[]]$toml, [Text.UTF8Encoding]::new($false))
Remove-Variable toml
```

Merge the complete generated table and three compliance subscription blocks into the matching linked private app project's `shopify.app.toml`; retain `embedded = false`, `write_products`, `use_legacy_install_flow = true` and the exact callback. Deploy with `shopify app deploy` and verify the released configuration as in [lifecycle setup](shopify-lifecycle.md). Keep the linked app project private because it contains capability URLs. No `app/uninstalled` block belongs in this app TOML.

Run the nonmutation lab command above and approve that exact shop in the browser. Once it reports a verified connection/product read, register and independently verify the uninstall subscription:

```powershell
docker compose run --rm --no-deps -T --env-from-file .env -e SHOPIFY_SHOP=your-disposable-store.myshopify.com api node dist/admin.js shopify-uninstall-webhook
if ($LASTEXITCODE -ne 0) { throw 'Uninstall subscription registration or verification failed' }
```

Require a JSON receipt with `verified: true`, `topic: "APP_UNINSTALLED"` and `apiVersion: "2026-10"`. Repeating this command verifies the same subscription without a duplicate. The command reads encrypted credentials internally; no token extraction or private GraphQL script is required. Run it again after a reinstall. Resolve any stale endpoint conflict using the lifecycle guide before continuing. Only then run the guarded product test below; restore the title before uninstalling and verifying the genuine webhook receipt, cleared credentials and denied subsequent access.

## Explicit disposable product test

Independently confirm that the exact shop is a disposable development store, reserve one disposable product, and stop other writers to it through verified restoration. Shopify's development-store billing status cannot be established by this gateway. Add every mutation argument to the same command only when you intend the real temporary title write and restoration.

```powershell
.\release\windows-lab.ps1 -ShopifyEnvPath 'C:\private\shopify.env' -PublicOrigin 'https://gateway.your-domain.tld' -Shop 'your-disposable-store.myshopify.com' -AllowMutation -DisposableStoreAck 'your-disposable-store.myshopify.com' -ProductGid 'gid://shopify/Product/123456789' -OriginalTitle 'Exact current disposable product title'
```

The helper calls the existing [guarded Shopify smoke command](shopify-smoke.md). All shop, scope, product GID, exact original title, idempotency, operation settlement, uncertain-write ordering hold, and restoration guards remain enforced. It keeps the configured HTTPS origin validation and injects a transport that confines authenticated smoke requests to the local gateway, rejecting foreign request origins and HTTP redirects. A successful JSON report requires temporary title readback and verified restoration. Reports omit credentials, browser tickets, URLs, and titles.

Before the first enqueue, `.secrets/windows-lab-run.json` records the run UUID, exact shop/product/title, origin, and connection ID. It contains recovery inputs and reports, without bearer or Shopify secrets. Restrict Windows ACLs on the checkout and source settings file to the operating account, since Git Bash mode bits alone do not establish Windows access restrictions. Keep `.env`, `.secrets`, and the database together and out of source control.

An interrupted or failed mutation run blocks a fresh run. Read the saved report and follow the reconciliation procedure in the smoke document, then rerun the identical command with `-Resume`. It keeps the same run UUID, connection, and idempotency keys and skips reconfiguration/OAuth. It never releases an uncertain operation hold automatically. If a run completed successfully, repeating its command prints a status marked `historical: true` and `freshAcceptance: false`, with no new `passed` assertion. For a fresh acceptance run after verified restoration, repeat the full mutation command with `-NewRun`. This archives the completed state with its run UUID and begins a new OAuth approval and smoke run. `-NewRun` cannot replace an incomplete run.

If a forcibly terminated helper leaves `.secrets/windows-lab.lock`, verify that no lab command is active before removing that file. The installer's `.secrets/install.lock` has its own recovery guidance. Preserve the run state and database while resolving failed prerequisites, lost ingress, pending operations, or uncertain provider outcomes. Cleanup after forced termination requires explicit recovery.

The helper's parser, opt-in guards, loopback transport, historical-status distinction, and browser URL validation have offline tests. `powershell.exe -NoProfile -NonInteractive -File tests/windows-lab-wrapper.test.ps1` validates Windows PowerShell 5.1 handoff with spaced paths and a quoted title using a fake Node command. The wrapper transfers options as JSON in the child environment to preserve exact title characters.

Live acceptance on 2026-11-05 at `ceb5408d2746392615329a7fa964470daea6d165` verified Docker, local/public readiness, OAuth, 18 paginated product reads, guarded title change/restoration on draft product `10279219986688` in `commerce-gateway-lab.myshopify.com`, and genuine uninstall delivery/token revocation. Its original report is retained in `release-artifacts/windows-lab-acceptance-2026-11-05.json`. That historical run required removing a stdout diagnostic and moving uninstall registration out of app TOML; the corrected commands above address those setup defects. Compliance configuration was deployed and read back; live privacy events were not exercised. Reuse this evidence only with an explicit assessment of changes since that commit.
