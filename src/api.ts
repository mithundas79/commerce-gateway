import { createHash, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { ConnectorError } from './shopify.js';

export interface Connection {
  id: string;
  tenant_id: string;
  shop: string;
  scopes: string[];
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ProductPage {
  products: Array<{ id: string; title: string; updatedAt: string }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

export interface ApiOptions {
  pool: Pool;
  readProducts: (connection: Connection, options: { first: number; after?: string }) => Promise<ProductPage>;
  logger?: boolean;
  /** Optional structured-log destination, useful for observability and redaction checks. */
  loggerStream?: { write: (line: string) => void };
  operationTtlMs?: number;
  /** Exact paths whose handlers do not require a gateway API key (e.g. OAuth callback). */
  publicRoutes?: string[];
}

const principals = new WeakMap<FastifyRequest, string>();

/** Available to additional authenticated routes registered on the returned server. */
export function getTenantId(request: FastifyRequest): string {
  const tenantId = principals.get(request);
  if (!tenantId) throw new Error('Authenticated tenant required');
  return tenantId;
}

const connectionParams = {
  type: 'object', additionalProperties: false, required: ['connectionId'],
  properties: { connectionId: { type: 'string', format: 'uuid' } },
} as const;

function publicOperation(row: Record<string, any>) {
  // The worker's internal lease and dispatch metadata are intentionally private.
  return {
    id: row.id, connectionId: row.connection_id, kind: row.kind,
    status: row.status, attemptCount: row.attempt_count,
    result: row.result ?? null,
    error: row.error ? { code: typeof row.error.code === 'string' && /^[A-Z0-9_]{1,80}$/i.test(row.error.code) ? row.error.code : 'OPERATION_FAILED' } : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
    orderingReleasedAt: row.ordering_released_at ?? null,
    ...(Object.hasOwn(row, 'blocked_by') ? { blockedBy: row.blocked_by ?? null } : {}),
  };
}

const operationColumns = 'id, connection_id, kind, status, attempt_count, payload, result, error, created_at, updated_at, completed_at, ordering_released_at';

export function buildApi(options: ApiOptions): FastifyInstance {
  const { pool } = options;
  const operationTtlMs = options.operationTtlMs ?? 15 * 60 * 1000;
  if (!Number.isSafeInteger(operationTtlMs) || operationTtlMs < 1000 || operationTtlMs > 24 * 60 * 60 * 1000) {
    throw new Error('operationTtlMs must be between one second and one day');
  }
  const app = Fastify({
    bodyLimit: 16 * 1024,
    logger: options.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'req.url'],
      ...(options.loggerStream ? { stream: options.loggerStream } : {}) } : false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  const publicRoutes = new Set(['/healthz', '/readyz', ...(options.publicRoutes ?? [])]);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const path = request.url.split('?', 1)[0];
    if (publicRoutes.has(path)) return;
    const authorization = request.headers.authorization;
    const match = typeof authorization === 'string' ? /^Bearer ([A-Za-z0-9._~+\/-]{1,512}=*)$/i.exec(authorization) : null;
    if (!match || match[1].length > 512) {
      return reply.header('www-authenticate', 'Bearer').code(401).send({ error: 'UNAUTHORIZED' });
    }
    const tokenHash = createHash('sha256').update(match[1]).digest('hex');
    const result = await pool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM api_keys WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash],
    );
    if (!result.rows[0]) return reply.header('www-authenticate', 'Bearer').code(401).send({ error: 'UNAUTHORIZED' });
    principals.set(request, result.rows[0].tenant_id);
  });

  app.setErrorHandler((error, request, reply) => {
    const failure = error instanceof Error ? error as Error & { validation?: unknown; statusCode?: unknown; code?: unknown } : undefined;
    if (failure?.validation) return reply.code(400).send({ error: 'INVALID_REQUEST' });
    const statusCode = typeof failure?.statusCode === 'number' ? failure.statusCode : 500;
    if (statusCode === 413) return reply.code(413).send({ error: 'REQUEST_TOO_LARGE' });
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: 'INVALID_REQUEST' });
    }
    const code = typeof failure?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(failure.code) ? failure.code : 'INTERNAL_ERROR';
    request.log.error({ code }, 'Gateway request failed');
    return reply.code(500).send({ error: 'INTERNAL_ERROR' });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.get<{ Querystring: { first?: string; after?: string } }>('/v1/connections', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      first: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
      after: { type: 'string', format: 'uuid' },
    } } },
  }, async (request) => {
    const first = request.query.first ? Number(request.query.first) : 100;
    const result = await pool.query(
      'SELECT id, shop, scopes, created_at, updated_at FROM connections WHERE tenant_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id < $2::uuid) ORDER BY id DESC LIMIT $3',
      [getTenantId(request), request.query.after ?? null, first + 1],
    );
    const rows = result.rows.slice(0, first);
    return { connections: rows.map((row) => ({ id: row.id, shop: row.shop, scopes: row.scopes, createdAt: row.created_at, updatedAt: row.updated_at })),
      pageInfo: { hasNextPage: result.rows.length > first, endCursor: rows.at(-1)?.id ?? null } };
  });

  async function findConnection(request: FastifyRequest, connectionId: string): Promise<Connection | undefined> {
    const result = await pool.query<Connection>(
      'SELECT id, tenant_id, shop, scopes, created_at, updated_at FROM connections WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL',
      [getTenantId(request), connectionId],
    );
    return result.rows[0];
  }

  app.get<{ Params: { connectionId: string }; Querystring: { first?: string; after?: string } }>(
    '/v1/connections/:connectionId/products',
    {
      schema: {
        params: connectionParams,
        querystring: {
          type: 'object', additionalProperties: false,
          properties: { first: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' }, after: { type: 'string', minLength: 1, maxLength: 2048 } },
        },
      },
    },
    async (request, reply) => {
      const connection = await findConnection(request, request.params.connectionId);
      if (!connection) return reply.code(404).send({ error: 'CONNECTION_NOT_FOUND' });
      try {
        return await options.readProducts(connection, { first: request.query.first ? Number(request.query.first) : 25, ...(request.query.after ? { after: request.query.after } : {}) });
      } catch (error) {
        if (error instanceof ConnectorError) {
          if (error.code === 'AUTHENTICATION') return reply.code(409).send({ error: 'CONNECTION_REAUTHORIZATION_REQUIRED', retryable: false });
          if (error.code === 'PERMISSION') return reply.code(403).send({ error: 'CONNECTION_PERMISSION_REQUIRED', retryable: false });
          if (error.code === 'RATE_LIMITED' || error.code === 'TRANSIENT') {
            const retryAfterMs = typeof error.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs)
              ? Math.min(300_000, Math.max(1000, error.retryAfterMs)) : 1000;
            return reply.header('retry-after', String(Math.ceil(retryAfterMs / 1000)))
              .code(error.code === 'RATE_LIMITED' ? 429 : 503)
              .send({ error: error.code === 'RATE_LIMITED' ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_UNAVAILABLE', retryable: true, retryAfterMs });
          }
          return reply.code(502).send({ error: error.code === 'API_VERSION_MISMATCH' ? 'PROVIDER_API_VERSION_MISMATCH' : 'PROVIDER_REJECTED', retryable: false });
        }
        return reply.code(502).send({ error: 'PROVIDER_UNAVAILABLE', retryable: true });
      }
    },
  );

  app.post<{ Params: { connectionId: string }; Body: { productId: string; title: string } }>(
    '/v1/connections/:connectionId/product-title-updates',
    {
      schema: {
        params: connectionParams,
        body: {
          type: 'object', additionalProperties: false, required: ['productId', 'title'],
          properties: {
            productId: { type: 'string', maxLength: 64, pattern: '^gid://shopify/Product/[1-9][0-9]{0,19}$' },
            title: { type: 'string', minLength: 1, maxLength: 255 },
          },
        },
      },
    },
    async (request, reply) => {
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)
        || !request.body.title.trim() || request.body.title.length > 255) {
        return reply.code(400).send({ error: 'INVALID_REQUEST' });
      }
      const tenantId = getTenantId(request);
      const connectionId = request.params.connectionId;
      const connection = await findConnection(request, connectionId);
      if (!connection) return reply.code(404).send({ error: 'CONNECTION_NOT_FOUND' });
      const payload = { productId: request.body.productId, title: request.body.title };
      // The SELECT also checks revocation atomically at enqueue time. The unique
      // constraint serializes concurrent requests sharing an idempotency key.
      const inserted = await pool.query(
        `INSERT INTO operations (id, tenant_id, connection_id, kind, idempotency_key, payload, deadline_at)
         SELECT $1, $2, id, 'product_title_update', $4, $5::jsonb, now() + ($6::double precision * interval '1 millisecond')
         FROM connections WHERE tenant_id = $2 AND id = $3 AND revoked_at IS NULL
         ON CONFLICT (tenant_id, connection_id, kind, idempotency_key) DO NOTHING
         RETURNING ${operationColumns}`,
        [randomUUID(), tenantId, connectionId, idempotencyKey, JSON.stringify(payload), operationTtlMs],
      );
      let row = inserted.rows[0];
      const replayed = !row;
      if (!row) {
        const existing = await pool.query(
          `SELECT ${operationColumns} FROM operations WHERE tenant_id = $1 AND connection_id = $2 AND kind = 'product_title_update' AND idempotency_key = $3`,
          [tenantId, connectionId, idempotencyKey],
        );
        row = existing.rows[0];
        if (!row) return reply.code(404).send({ error: 'CONNECTION_NOT_FOUND' });
        if (row.payload.productId !== payload.productId || row.payload.title !== payload.title) {
          return reply.code(409).send({ error: 'IDEMPOTENCY_CONFLICT' });
        }
      }
      return reply.code(202).header('location', `/v1/operations/${row.id}`).send({ operation: publicOperation(row), replayed });
    },
  );

  app.get<{ Params: { operationId: string } }>(
    '/v1/operations/:operationId',
    { schema: { params: { type: 'object', additionalProperties: false, required: ['operationId'], properties: { operationId: { type: 'string', format: 'uuid' } } } } },
    async (request, reply) => {
      const result = await pool.query(
        `SELECT ${operationColumns}, (
          SELECT jsonb_build_object('operationId', blocker.id, 'status', blocker.status)
          FROM operations blocker WHERE blocker.tenant_id = operations.tenant_id
            AND blocker.connection_id = operations.connection_id AND blocker.kind = operations.kind
            AND blocker.payload->>'productId' = operations.payload->>'productId'
            AND blocker.queue_sequence < operations.queue_sequence
            AND (blocker.status IN ('queued','running','retry','recovering')
              OR (blocker.status = 'uncertain' AND blocker.ordering_released_at IS NULL))
          ORDER BY blocker.queue_sequence LIMIT 1
        ) AS blocked_by FROM operations WHERE tenant_id = $1 AND id = $2`,
        [getTenantId(request), request.params.operationId],
      );
      if (!result.rows[0]) return reply.code(404).send({ error: 'OPERATION_NOT_FOUND' });
      return { operation: publicOperation(result.rows[0]) };
    },
  );
  return app;
}
