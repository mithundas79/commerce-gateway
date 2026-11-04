# Shopify lifecycle subscriptions

Configure these subscriptions separately for every Shopify app client ID used by this gateway. All tenants sharing that app use the same four URLs and app secret. The signed shop payload and the persisted app/shop owner select the tenant. Each app must use its real client secret consistently across those tenants.

After `configure-shopify`, generate the exact configuration using the tenant environment from the installation guide. Redirect output into a protected temporary file and merge its four subscription blocks into the matching Shopify app project's existing `shopify.app.toml`. The output includes `[webhooks]` with `api_version = "2026-10"`. Preserve a single `[webhooks]` table when merging.

```bash
umask 077
docker compose run --rm --no-deps -T --env-from-file .secrets/tenants/acme.env \
  api node dist/admin.js shopify-webhooks > .secrets/shopify-webhooks.toml
```

The generated TOML registers `app/uninstalled` through `topics`, plus separate `compliance_topics` entries for `customers/data_request`, `customers/redact` and `shop/redact`. Each uses an absolute HTTPS URI of the form `/webhooks/shopify/<client-id>/<topic-key>/<secret-binding>`. The topic keys are `app-uninstalled`, `customers-data-request`, `customers-redact` and `shop-redact`. Keep the generated full URLs private. Exclude them from proxy access logs, monitoring URLs, source control and support diagnostics. The gateway redacts request URLs in its structured logs. The binding uses a separate HMAC domain from webhook body signatures.

Deploy the four subscriptions from the linked app project using `shopify app deploy`. The Dev Dashboard app-version form controls OAuth redirect URLs and the webhook API version. The generated TOML plus CLI deployment configures these endpoint/topic subscriptions. Confirm the released subscriptions and successful deliveries in the app's webhook configuration and logs. For every app-secret rotation, reconfigure the gateway tenants, regenerate these URLs and deploy the matching app subscription settings together. Deliveries signed with the previous secret can fail during Shopify's rotation window. Shopify documents a delay of up to an hour before new signatures take effect. Remove existing shop-specific subscriptions for these topics when adopting app-specific subscriptions. [Subscription configuration](https://shopify.dev/docs/apps/build/webhooks/subscribe) and [signature verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries).

The public POST route verifies the HMAC against the original bytes before parsing JSON. An indexed hash of the supplied secret URL binding selects at most one app secret, so unsolicited packets cannot fan out across tenants sharing a public client ID. Configuration stores these hashes when the app is configured, and the TOML generator primes them for pre-upgrade app rows. The actual shop owner's app secret is verified again before processing. The secret URL binds the topic because Shopify's body signature excludes headers. The topic header must match that URL. The shop header must match the signed canonical shop domain or the domain mapped from a previously authenticated numeric shop ID. Authorization never comes from a header, a tenant ID supplied by a sender, or a delivery ID. A different delivery ID cannot bypass a stored body receipt. The route accepts JSON bodies up to 1 MiB and acknowledges only after the database stores the receipt and any protective hold. Provider HTTP runs in the durable worker after acknowledgement. [HTTPS verification requirements](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries).

New merchant authorizations query Shopify's authenticated shop identity and persist its ID with a fresh installation generation. Refresh preserves that generation. This supports `app/uninstalled` payloads whose `myshopify_domain` is null. A legacy connection without the persisted ID can accept a signed canonical domain. An id-only event for such a legacy connection returns 400 and requires reconnection or operator reconciliation of its authenticated shop identity. The gateway never guesses using the unsigned header. [Shopify webhook payload reference](https://shopify.dev/docs/api/webhooks/latest).

## Processing and recovery

An uninstall or shop erasure receipt puts its connection on a lifecycle hold immediately. The hold blocks product reads, new operations and worker dispatch while the worker verifies the current installation. A bounded access-token refresh handles expired access credentials. A successful authenticated shop query indicates a current installation, so the worker ignores the stale delivery and releases its hold. A fresh access token rejected with HTTP 401 confirms the installation has ended. HTTP 403, malformed identity responses, throttling and provider outages preserve data and retry. A failed refresh or fully expired credential pair requires operator action because it cannot distinguish an expired reinstallation from an uninstall.

Completed uninstall processing clears the encrypted access and refresh tokens, revokes the connection, removes pending OAuth sessions and fences outstanding operation leases. Undispatched operations fail with `SHOPIFY_UNINSTALLED`. Operations that began dispatch become uncertain. A provider request already in flight can complete remotely, and an operator must reconcile that outcome before retrying a write.

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
