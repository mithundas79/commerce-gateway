# Shopify lifecycle subscriptions

Configure lifecycle delivery in two stages: deploy three app-wide compliance subscriptions, then register `APP_UNINSTALLED` for every connected shop through Admin GraphQL. This is the standalone authorization-code workflow that passed live acceptance on `ceb5408d2746392615329a7fa964470daea6d165`. All tenants sharing an app use the same four topic-specific URLs and app secret. The signed shop payload and persisted app/shop owner select the tenant.

## 1. Deploy the compliance subscriptions

After `configure-shopify`, generate configuration using the tenant environment from the installation guide. For the default installer tenant, replace `.secrets/tenants/acme.env` with `.env`; Compose interpolation alone does not pass `TENANT_ID` to the container. Redirect stdout into a protected file. Diagnostics go to stderr; do not merge stderr into this file. Merge the complete generated `[webhooks]` table and its three subscription blocks into the matching linked app's `shopify.app.toml`, retaining one `[webhooks]` table and the app's identity/OAuth settings. No output filtering or subscription removal is required.

```bash
umask 077
docker compose run --rm --no-deps -T --env-from-file .secrets/tenants/acme.env \
  api node dist/admin.js shopify-webhooks > .secrets/shopify-webhooks.toml
```

The generated TOML sets `api_version = "2026-10"` and exactly these `compliance_topics`: `customers/data_request`, `customers/redact`, and `shop/redact`, each with its own absolute HTTPS URI. Keep these capability URLs private, including the linked app configuration: exclude them from Git, proxy access logs, monitoring URLs and support diagnostics. The gateway redacts request URLs in structured logs. The binding uses a separate HMAC domain from webhook body signatures.

Keep `embedded = false`, `[access_scopes] scopes = "write_products"`, `use_legacy_install_flow = true`, and the exact HTTPS callback in `[auth] redirect_urls`, as in the [installation guide](README.md#configure-the-clients-shopify-app). Run `shopify app deploy` from that linked private app project. Confirm the released version has those settings and all three compliance endpoints. Fetch the released configuration with `shopify app config link` into a separate protected directory to compare it with the submitted configuration. The Dev Dashboard's callback/version fields alone do not register these subscriptions. Do not add `app/uninstalled` to the app TOML: app-specific non-compliance topics conflict with this legacy OAuth installation mode. [App configuration](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration) and [subscription configuration](https://shopify.dev/docs/apps/build/webhooks/subscribe).

## 2. Connect the shop, then register and verify uninstall

Complete merchant OAuth through `POST /v1/shopify/connect` and verify the requested shop appears in `GET /v1/connections`. Keep the HTTPS ingress reachable. Run this command for that exact canonical shop and tenant before accepting product writes:

```bash
docker compose run --rm --no-deps -T --env-from-file .secrets/tenants/acme.env \
  -e SHOPIFY_SHOP=example-store.myshopify.com \
  api node dist/admin.js shopify-uninstall-webhook
```

For the default tenant, replace `.secrets/tenants/acme.env` with `.env`. The command uses that tenant's encrypted OAuth credentials, refreshes them if needed, rejects absent/revoked/held connections, and calls `https://<shop>/admin/api/2026-10/graphql.json`. It lists existing shop-specific `APP_UNINSTALLED` subscriptions, creates one only when absent, then independently reads back the exact capability URI, topic, JSON format and API version. A repeat invocation verifies the existing subscription without creating a duplicate. Successful stdout is JSON with `verified: true`, the shop, topic, subscription ID and API version; it contains no credential or capability URL. Keep this receipt as setup evidence.

The Admin GraphQL operations are:

```graphql
query GatewayUninstallWebhooks {
  webhookSubscriptions(first: 100, topics: [APP_UNINSTALLED]) {
    nodes { id topic uri format apiVersion { handle } }
    pageInfo { hasNextPage }
  }
}
mutation GatewayUninstallWebhook($subscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: APP_UNINSTALLED, webhookSubscription: $subscription) {
    webhookSubscription { id }
    userErrors { field message }
  }
}
```

The command supplies `subscription = {uri: <private app-uninstalled capability URL>, format: "JSON"}` without exposing it. The endpoint is derived from the same app secret as the compliance URLs. App-wide subscriptions are not enumerated by this shop-specific query; verify the three compliance subscriptions in the released app configuration separately. See [webhookSubscriptionCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/webhookSubscriptionCreate) and [webhookSubscriptions](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/webhookSubscriptions).

Run registration after every reinstall. Reconfigure, regenerate and redeploy compliance settings after an origin or app-secret change, then reconcile the connected shops' uninstall subscriptions. `SUBSCRIPTION_CONFLICT` means an old/different endpoint, format/version, duplicate subscription, or an incomplete listing (more than 100 results). Review the exact app/shop subscriptions privately through Admin GraphQL and explicitly update/remove only the obsolete registrations before rerunning; this command never deletes another subscription. `ACTIVE_CONNECTION_REQUIRED` requires a connected shop without a lifecycle hold. Resolve held events through the recovery procedure below. Transport or version errors fail closed; a timed-out creation is reconciled by read, never blindly replayed. Secret rotation can delay new webhook signatures; coordinate the gateway and Shopify settings. [Signature verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries).

## Delivery verification

On an authorized disposable shop, restore any test product before uninstalling. Verify an authentic `app/uninstalled` receipt is processed, tokens are cleared and the connection is revoked, former Shopify credentials return 401, and gateway reads/writes return `CONNECTION_NOT_FOUND`. Subscription readback proves configuration; only an actual provider delivery proves live processing. Compliance events require their own authorized privacy workflow and must not be inferred from an uninstall pass.

The public POST route verifies the HMAC against the original bytes before parsing JSON. An indexed hash of the supplied secret URL binding selects at most one app secret, so unsolicited packets cannot fan out across tenants sharing a public client ID. Configuration stores these hashes when the app is configured, and the TOML generator primes them for pre-upgrade app rows. The actual shop owner's app secret is verified again before processing. The secret URL binds the topic because Shopify's body signature excludes headers. The topic header must match that URL. The shop header must match the signed canonical shop domain or the domain mapped from a previously authenticated numeric shop ID. Authorization never comes from a header, a tenant ID supplied by a sender, or a delivery ID. A different delivery ID cannot bypass a stored body receipt. The route accepts JSON bodies up to 1 MiB and acknowledges only after the database stores the receipt and any protective hold. Provider HTTP runs in the durable worker after acknowledgement. [HTTPS verification requirements](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries).

New merchant authorizations query Shopify's authenticated shop identity and persist its ID with a fresh installation generation. Refresh preserves that generation. This supports `app/uninstalled` payloads whose `myshopify_domain` is null. A legacy connection without the persisted ID can accept a signed canonical domain. An id-only event for such a legacy connection returns 400 and requires reconnection or operator reconciliation of its authenticated shop identity. The gateway never guesses using the unsigned header. [Shopify webhook payload reference](https://shopify.dev/docs/api/webhooks/latest).

## Stable identity and domain changes

A verified numeric Shopify shop ID has one retained tenant and canonical domain for each app client ID. Ownership survives uninstall and reinstall. A second tenant or domain alias cannot claim that ID. An exact-domain reinstall by the existing owner remains supported. Verified `shop/redact` removes the shop's stable-ID registry entry together with its domain owner mapping.

Automatic domain rename and tenant ownership transfer require operator reconciliation. A callback rejected with HTTP 409 and `SHOP_IDENTITY_RECONCILIATION_REQUIRED` preserves the gateway's saved credentials, operations and owner. Shopify token exchange precedes numeric-ID verification, so verify whether the original owner's authorization requires renewal after a rejected alias attempt. Preserve the installation backup and pause affected API/worker traffic. Verify the numeric shop ID, original owner tenant, app client ID and current canonical domain directly with the merchant and Shopify app administration. Do not retry consent under a second tenant or delete owner rows to force a claim. This version has no automated alias migration command. Resume the affected installation only after a reviewed migration has reconciled its credentials, connections, queued operations, lifecycle receipts and ownership records together.

Before upgrading a populated deployment, create and verify its backup using the [existing installation and recovery guide](README.md). From that deployment's existing installation directory, stop the old API and worker before replacing application or bundle files.

```bash
docker compose stop api worker
```

Apply the verified update in that same directory using its existing `.env`, `.secrets`, tenant/API/encryption keys and PostgreSQL volume. Then run the installer with the saved origin and database configuration.

```bash
bash release/install.sh
```

The installer applies migrations against that existing database before starting the updated services. Migration 008 rejects duplicate or inconsistent preexisting app/shop-ID associations with the same reconciliation error and rolls back without choosing a tenant or changing merchant rows. Keep the previous installation stopped if migration fails. Inspect the affected records through a restricted administrative database session, retain the backup, and resolve ownership with the merchant before applying a reviewed data migration. Never erase an ambiguous row as an automatic repair. Legacy rows without an authenticated numeric ID retain the exact-domain path until a successful authorization captures that ID.

Lifecycle handling checks the stable owner before creating a protective hold and again before destructive reconciliation. A renamed alias or inconsistent registry returns 409 without acknowledging a receipt as completed. A queued receipt whose ownership became inconsistent moves to `action_required` with `IDENTITY_RECONCILIATION_REQUIRED`, preserving credentials and merchant data for operator review.

## Processing and recovery

An uninstall or shop erasure receipt puts its connection on a lifecycle hold immediately. The hold blocks product reads, new operations and worker dispatch while the worker verifies the current installation. A bounded access-token refresh handles expired access credentials. A successful authenticated shop query indicates a current installation, so the worker ignores the stale delivery and releases its hold. A fresh access token rejected with HTTP 401 confirms the installation has ended. HTTP 403, malformed identity responses, throttling and provider outages preserve data and retry. A failed refresh or fully expired credential pair requires operator action because it cannot distinguish an expired reinstallation from an uninstall.

Completed uninstall processing clears the encrypted access and refresh tokens, revokes the connection, removes pending OAuth sessions and fences outstanding operation leases. Undispatched operations fail with `SHOPIFY_UNINSTALLED`. Operations that began dispatch become uncertain. A provider request already in flight can complete remotely, and an operator must reconcile that outcome before retrying a write.

Workers capture the connection's authorization generation when claiming an operation. Credential acquisition checks that generation, then rechecks the live operation lease, fence and connection hold after any token refresh wait. A new merchant authorization superseding a held generation fails or marks uncertain its outstanding work before releasing the hold. These checks occur before calling Shopify. A revocation after the final check can race the outbound request, and Shopify controls requests already on the wire. Database fencing protects subsequent state changes while reconciliation handles the remote outcome.

`shop/redact` deletes the owning shop's operations, outgoing notification snapshots, connection credentials, OAuth sessions and shop-owner mapping. It also removes shop and tenant linkage from lifecycle receipts. App configuration, tenant API keys, notification endpoint configuration and other shops belong to their respective tenant and remain available. The gateway currently stores product operations and has no customer/order records or customer associations. `customers/data_request` and `customers/redact` validate the required payload, record completion and discard customer emails, phone numbers, IDs and order IDs without persisting the body. The SaaS client remains responsible for data it holds independently. Shopify requires public apps to handle these topics even when they collect no customer data. [Privacy webhook requirements and payloads](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance).

Body receipts are scoped to the installation generation. Successful deletion receipts survive reconnects. A delivery ignored while a token remains active is rechecked if delivered again, allowing a later genuine uninstall with identical shop details to take effect. The worker compares the generation again under the same database lock used by OAuth before revocation or erasure, so a concurrent successful reinstall supersedes the old request.

The worker attempts unresolved provider checks at most eight times, at one-minute intervals. A restart resumes pending work. Terminal uncertainty becomes `action_required` and keeps the connection on hold. Monitor this command for each tenant and alert on nonempty output, especially before Shopify's 30-day completion deadline.

```bash
docker compose run --rm --no-deps -T --env-from-file .secrets/tenants/acme.env \
  api node dist/admin.js shopify-lifecycle
```

The output contains event IDs, topic keys, status, attempts, sanitized error codes and timestamps. Reauthorize a genuinely installed shop through the normal merchant flow to establish its fresh generation. After resolving temporary authorization/provider problems, schedule the retained events for another bounded reconciliation using this command.

```bash
docker compose run --rm --no-deps -T --env-from-file .secrets/tenants/acme.env \
  api node dist/admin.js retry-shopify-lifecycle
```

If both credential types are permanently expired and the merchant has uninstalled, verify that installation state directly in the app/store administration and complete the shop erasure operationally within the required deadline. The automatic worker preserves the held data until that proof is available. Backups and notification data already delivered to SaaS clients require their own deletion/retention procedures. Rotate encrypted backups within your privacy retention period and reapply completed deletion requests after any restore before serving restored data.

## Acceptance evidence

`npm test` exercises the registered raw-byte route, topic capability separation, malformed HMACs and spoofed headers. `npm run test:integration` uses isolated schemas in real PostgreSQL to check token invalidation, queued/in-flight work fencing, privacy erasure, body replay handling, id-only routing, reinstall preservation, bounded retries and expired refresh handling. These tests use synthetic credentials and mocked Shopify transport. Live store delivery and dashboard subscription deployment require an authorized development store and app configuration.
