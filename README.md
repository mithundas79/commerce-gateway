# commerce-gateway

A self-hosted JSON API that connects a client backend to merchant stores. Each client keeps its existing database. The gateway stores connection credentials and the state needed to deliver merchant operations. It serves one tenant per installation or multiple tenants with separate API keys and shop connections.

## Development status

The first connector targets Shopify Admin GraphQL **2026-10**. It supports merchant authorization, paginated product reads and durable product title changes. This is a development build. The installation, latency, recovery and live-store release gates are tracked in [GitHub issues](https://github.com/mithundas79/commerce-gateway/issues). WooCommerce and Amazon are planned.

The [OpenAPI 3.1 contract](openapi.json) describes tenant authentication, requests, responses, asynchronous operation polling, browser authorization, and signed completion notifications. `GET /v1/health` checks the API and PostgreSQL with a tenant bearer key. Worker heartbeat is measured separately by Docker health checks.

## Install and connect a store

Follow the [installation and recovery instructions](release/README.md) to start the API, worker and PostgreSQL. A publicly reachable HTTPS origin is required for merchant authorization. Register the exact URL `https://YOUR-GATEWAY/oauth/shopify/callback` in the Shopify app. Use the `write_products` scope for the product workflow and select webhooks API version `2026-10`. Provision a tenant for each independently administered client. Each tenant can authorize multiple stores.

From the installation directory, securely supply the app credentials in your shell, then run:

```sh
docker compose run --rm -e TENANT_ID -e SHOPIFY_CLIENT_ID -e SHOPIFY_CLIENT_SECRET \
  -e SHOPIFY_SCOPES -e SHOPIFY_RETURN_URLS api node dist/admin.js configure-shopify
```

Set `TENANT_ID` to the provisioned tenant UUID and `SHOPIFY_SCOPES` to the comma-separated scope list. `SHOPIFY_RETURN_URLS` is an optional comma-separated list of HTTPS URLs the gateway may redirect the browser to after authorization. Store the gateway bearer key in the client backend's secret store.

### Merchant authorization

```sh
curl -sS -X POST "$GATEWAY/v1/shopify/connect" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"shop":"example-dev-store.myshopify.com"}'
```

Send the merchant's browser to the returned `browserStartUrl` within 120 seconds. The gateway binds the Shopify callback to that browser, encrypts the credentials, and makes the resulting connection available to the originating tenant. Read its ID with `GET /v1/connections`.

### Product reads and writes

```sh
curl -sS "$GATEWAY/v1/connections/$CONNECTION_ID/products?first=25" \
  -H "Authorization: Bearer $GATEWAY_API_KEY"

curl -sS -i -X POST "$GATEWAY/v1/connections/$CONNECTION_ID/product-title-updates" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: title-edit-0001" \
  -d '{"productId":"gid://shopify/Product/123","title":"Updated sample title"}'
```

Reads accept `first` (1-100) and the previous page's opaque `after` cursor. A write returns HTTP 202 after PostgreSQL records the operation. Poll the response's `Location` using the same bearer key. Retry a lost response with the same idempotency key and payload. Reusing a key with a changed payload returns HTTP 409.

The worker honors provider throttling and applies bounded backoff. After an ambiguous write, it reads the product to determine whether the requested title is present. A terminal `uncertain` result requires reconciliation. Provider response time is separate from gateway admission latency.

### Receive completion events

A tenant can register a public HTTPS endpoint using the `configure-notification` admin command. When an operation first reaches `succeeded`, `failed` or `uncertain`, its status and notification are committed together. Delivery is at least once. Use `x-commerce-event-id` as the deduplication key and send a 2xx response after recording the event durably.

Verify `x-commerce-signature` before processing the JSON. The expected value is `sha256=` followed by the hex HMAC-SHA256 of the timestamp, event ID and raw UTF-8 request body, separated by periods. Use the tenant's notification signing secret, compare signatures in constant time, and check the Unix-seconds `x-commerce-timestamp` against a short clock-skew allowance. Retries reuse the event ID and body with a fresh delivery timestamp.

Registration affects future terminal transitions. Rotating or disabling an endpoint invalidates pending deliveries to its previous configuration. The operation remains retrievable through the authenticated polling endpoint.

## Develop

Use Node.js 26 and PostgreSQL 18. Run the integration tests and benchmarks against a disposable database.

```sh
npm ci
npm run typecheck
npm test
npm run build
DATABASE_URL="$TEST_DATABASE_URL" npm run test:integration
```

The runtime uses TypeScript, Fastify and PostgreSQL. The queue lives in PostgreSQL so a write and its idempotency record become durable together. The same container image runs either the HTTP API or the worker. The project is licensed under [Apache-2.0](LICENSE).
