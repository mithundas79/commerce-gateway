import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

type Result = { row: Record<string, any> | undefined; replayed: boolean };
type Entry = {
  values: [string, string, string, string, string, number];
  resolve: (result: Result) => void;
  reject: (error: unknown) => void;
};
type Group = { pending: Entry[] };
const batchLimit = 16;
const groupLimit = 64;

/** Coalesce arrivals behind an active enqueue, retaining the database ordering protocol. */
export function createEnqueue(pool: Pool, operationColumns: string, ttlMs: number) {
  const groups = new Map<string, Group>();
  const insertSql = `INSERT INTO operations (id, tenant_id, connection_id, kind, idempotency_key, payload, deadline_at)
    SELECT $1, $2, id, 'product_title_update', $4, $5::jsonb, now() + ($6::double precision * interval '1 millisecond')
    FROM connections WHERE tenant_id = $2 AND id = $3 AND revoked_at IS NULL AND NOT lifecycle_hold FOR SHARE
    ON CONFLICT (tenant_id, connection_id, kind, idempotency_key) DO NOTHING
    RETURNING ${operationColumns}`;

  async function existing(db: Pick<Pool, 'query'>, values: Entry['values']) {
    return (await db.query(`SELECT ${operationColumns} FROM operations WHERE tenant_id = $1 AND connection_id = $2 AND kind = 'product_title_update' AND idempotency_key = $3`,
      [values[1], values[2], values[3]])).rows[0];
  }

  async function insert(db: Pick<Pool, 'query'>, entry: Entry): Promise<Result> {
    const row = (await db.query(insertSql, entry.values)).rows[0];
    return { row: row ?? await existing(db, entry.values), replayed: !row };
  }

  async function batch(entries: Entry[]): Promise<Result[]> {
    if (entries.length === 1) return [await insert(pool, entries[0])];
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const [, tenant, connection] = entries[0].values;
      await client.query('SELECT id FROM connections WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL AND NOT lifecycle_hold FOR SHARE', [tenant, connection]);
      // Acquire the complete idempotency set before the first trigger takes a product lock.
      // Otherwise a single writer can hold a later row's key while waiting for our product.
      const locks = await client.query<{ lock_key: string }>(`SELECT DISTINCT hashtextextended('operation-idempotency:' ||
        jsonb_build_array($1::uuid,$2::uuid,'product_title_update',entry.key)::text,0) AS lock_key
        FROM unnest($3::text[]) AS entry(key) ORDER BY lock_key`, [tenant, connection, entries.map(entry => entry.values[3])]);
      for (const lock of locks.rows) await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lock.lock_key]);
      const results: Result[] = [];
      for (const entry of entries) results.push(await insert(client, entry));
      await client.query('COMMIT');
      return results;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  }

  async function drain(key: string, group: Group) {
    while (group.pending.length) {
      const entries = group.pending.splice(0, batchLimit);
      try {
        const results = await batch(entries);
        entries.forEach((entry, index) => entry.resolve(results[index]));
      } catch (error) { entries.forEach(entry => entry.reject(error)); }
    }
    groups.delete(key);
  }

  return async (tenant: string, connection: string, idempotencyKey: string, payload: { productId: string; title: string }): Promise<Result> => {
    const values: Entry['values'] = [randomUUID(), tenant, connection, idempotencyKey, JSON.stringify(payload), ttlMs];
    const key = JSON.stringify([tenant, connection, 'product_title_update', payload.productId]);
    // A committed replay must remain independent of a blocked product enqueue.
    if (groups.has(key)) {
      const row = await existing(pool, values);
      if (row) return { row, replayed: true };
    }
    return new Promise<Result>((resolve, reject) => {
      const entry = { values, resolve, reject };
      const active = groups.get(key);
      if (active) {
        // Bound retained batching state. Excess arrivals keep the original single-insert path.
        if (active.pending.length < batchLimit) active.pending.push(entry);
        else void insert(pool, entry).then(resolve, reject);
        return;
      }
      if (groups.size >= groupLimit) {
        void insert(pool, entry).then(resolve, reject);
        return;
      }
      const group = { pending: [entry] };
      groups.set(key, group);
      void drain(key, group);
    });
  };
}
