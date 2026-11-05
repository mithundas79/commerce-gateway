# Product title write ordering

The queue orders active title updates for each tenant, Shopify connection, and product. Different products can run in parallel. PostgreSQL assigns an immutable sequence under a per-product transaction lock during enqueue; committed idempotency replays reuse the original operation and sequence. Retrying or reclaiming a crashed worker preserves that position. A later write cannot pass an earlier queued, running, retrying, or recovering operation.

Deadlines include time spent waiting behind an earlier operation. A waiter whose deadline expires fails without calling Shopify, even if the earlier operation remains blocked. An undispatched head that expires fails and permits its live successor to proceed. An ambiguous dispatched head becomes `uncertain` when its deadline or recovery budget is exhausted and keeps an ordering hold on that product. Other products remain eligible.

Poll a tenant's operation URL to inspect `blockedBy`, which identifies an earlier blocking operation and its status. An `uncertain` operation requires operator reconciliation. The operator must investigate the provider state and any outstanding request before releasing the hold:

```sh
TENANT_ID=<tenant-uuid> OPERATION_ID=<uncertain-operation-uuid> \
ACKNOWLEDGE_DELAYED_WRITE_RISK=true node dist/admin.js release-uncertain
```

This acknowledgement is tenant-scoped and idempotent. It sets `orderingReleasedAt` while preserving the terminal `uncertain` status and its original completion event. Subsequent live operations can then proceed; expired operations still fail without dispatch. It does not resend the uncertain operation.

Database fencing protects local state. Shopify does not accept this queue's fencing token, so an already-sent request might still arrive after a timeout or after operator acknowledgement. Readback observes a value at one point in time and cannot prove that no delayed request remains. The gateway therefore does not promise strict ordering of externally delayed requests, edits made outside the gateway, or an operator's decision to release a hold.

Migration `006.sql` backfills existing operations in `(created_at, id)` order. Run it through the checksummed migration command once, with workers stopped during upgrade. If the runtime uses a different PostgreSQL role from the migration owner, grant it `USAGE, SELECT` on `operation_queue_sequence` in addition to the table privileges.
