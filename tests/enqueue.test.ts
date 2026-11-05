import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { createEnqueue } from '../src/enqueue.js';

test('grouped state is bounded across resources and overflow retains the immediate single-insert path', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let inserts = 0;
  let lookups = 0;
  const pool = {
    async query(sql: string, values: unknown[]) {
      if (sql.startsWith('INSERT INTO operations')) {
        inserts++;
        await blocked;
        return { rows: [{ id: values[0], payload: JSON.parse(String(values[4])) }] };
      }
      lookups++;
      return { rows: [] };
    },
    connect() { throw new Error('These requests must use single inserts'); },
  } as unknown as Pool;
  const enqueue = createEnqueue(pool, 'id,payload', 900000);
  const submit = (product: number, key = String(product)) => enqueue('tenant', 'connection', key,
    { productId: `gid://shopify/Product/${product}`, title: key });
  const pending = Array.from({ length: 64 }, (_, index) => submit(index + 1));
  try {
    assert.equal(inserts, 64);
    pending.push(submit(65), submit(65, 'overflow-repeated'));
    assert.equal(inserts, 66);
    assert.equal(lookups, 0);
    pending.push(submit(1, 'retained-waiter'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(inserts, 66);
    assert.equal(lookups, 1);
  } finally { release(); }
  assert.ok((await Promise.all(pending)).every(result => result.row && !result.replayed));
  assert.equal(inserts, 67);
  assert.equal((await submit(65, 'after-drain')).replayed, false);
  assert.equal(lookups, 1);
});
