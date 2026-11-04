# Disposable Shopify product acceptance

This developer-operated command performs a real title change through a deployed gateway and restores the original title. Run it only on a disposable development store and one draft product dedicated to testing. Stop other writers to that product for the whole run. The gateway cannot establish the store's development-store billing status; the operator must confirm that independently.

No live-store run has been performed by the implementation agent. Mock tests exercise the command locally.

Use a pre-authorized connection belonging to the gateway bearer key's tenant. Its exact canonical shop domain must match both acknowledgements below. Set the exact product GID and its current title. Supply a fresh UUID for a new run, retain it until restoration has been verified, and never paste the bearer into a command argument or issue report.

```powershell
$env:SHOPIFY_SMOKE_GATEWAY_ORIGIN = 'https://gateway.your-domain.tld'
$env:SHOPIFY_SMOKE_BEARER = '<read from your local secret manager>'
$env:SHOPIFY_SMOKE_EXPECTED_DEV_STORE = 'your-disposable-store.myshopify.com'
$env:SHOPIFY_SMOKE_DISPOSABLE_ACK = $env:SHOPIFY_SMOKE_EXPECTED_DEV_STORE
$env:SHOPIFY_SMOKE_ALLOW_MUTATION = '1'
$env:SHOPIFY_SMOKE_CONNECTION_ID = '<pre-authorized connection UUID>'
$env:SHOPIFY_SMOKE_PRODUCT_GID = 'gid://shopify/Product/123456789'
$env:SHOPIFY_SMOKE_ORIGINAL_TITLE = 'Exact original disposable product title'
$env:SHOPIFY_SMOKE_RUN_ID = [guid]::NewGuid().ToString()
node scripts/shopify-smoke.mjs
```

The command verifies the authenticated connection's shop and write scope, finds only the specified product as the mutation target, and checks its exact original title and Shopify `DRAFT` status before the first write, including resumed runs. Product catalog responses expose the upstream `status` field. Every later product read also requires `DRAFT`, so a missing status or a status change stops further writes and requires reconciliation when a temporary write has already been submitted. Catalog reads may paginate over other products; mutations always contain the specified GID. It submits a unique temporary run marker twice using the same idempotency key, verifies the same operation ID and replay flag, polls terminal status, reads the marker back, submits restoration, and verifies the original title. Every request keeps the bearer on the configured HTTPS origin and refuses redirects.

Cleanup runs after errors when the temporary operation is known and terminal. An uncertain terminal write requires both observing this run's unique temporary marker and an administrator reconciling the operation and releasing its product-ordering hold with `release-uncertain`. The API must then report `orderingReleasedAt`. The command does not release that hold itself. A pending operation, unknown operation ID, or uncertain operation whose marker has not appeared prevents automatic restoration, because a delayed write could overwrite a restore. An unexpected third-party title also prevents restoration. The JSON report then sets `manualReconciliationRequired: true`; do not start a new run or edit the product until the original operation is resolved. Inspect its operation status and Shopify product, retain the same run UUID and original title, and use `SHOPIFY_SMOKE_RESUME=1` to resume after reconciliation/release if the unique marker is now present. A rerun uses the same idempotency keys. Use a new UUID only for a separate, fully restored acceptance run.

Exit status is zero only when the idempotency check, temporary readback, and verified restore all succeed. Reports include fixed error codes and operation/run IDs; they omit bearer keys, URLs, product titles, raw responses, and exception messages. If the command is forcibly terminated, cleanup cannot run; retain its environment/run UUID and reconcile before continuing. Clear the bearer and mutation opt-in environment variables when finished.

Defaults: 10-second request timeout, three attempts per request using the same mutation key, up to 120 seconds of operation polling at one-second intervals, and at most 100 pages of 100 connections/products. Set `SHOPIFY_SMOKE_HTTP_TIMEOUT_MS` (1,000–30,000), `SHOPIFY_SMOKE_WAIT_MS` (1,000–900,000), or `SHOPIFY_SMOKE_POLL_MS` (100–5,000) if the disposable deployment needs different bounds. Time spent on bounded HTTP retries is additional to the polling interval budget.
