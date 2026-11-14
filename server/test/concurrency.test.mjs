import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapConcurrent } from '../src/lib/concurrency.js';

test('mapConcurrent preserves input order and maps every item', async () => {
  const items = [1, 2, 3, 4, 5];
  const results = await mapConcurrent(items, 2, async (v, i) => ({ v, i }));
  assert.deepEqual(results.map(r => r.v), items);
  assert.deepEqual(results.map(r => r.i), [0, 1, 2, 3, 4]);
});

test('mapConcurrent never exceeds the concurrency cap', async () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  let active = 0;
  let peak = 0;
  const results = await mapConcurrent(items, 3, async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5));
    active--;
    return true;
  });
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded cap 3`);
  assert.equal(results.length, 10);
});

test('mapConcurrent with concurrency 1 is strictly sequential', async () => {
  const order = [];
  await mapConcurrent([1, 2, 3], 1, async v => { order.push(v); await new Promise(r => setTimeout(r, 2)); });
  assert.deepEqual(order, [1, 2, 3]);
});

test('mapConcurrent rejects when a worker throws and does not hang', async () => {
  let ran = 0;
  await assert.rejects(
    mapConcurrent([1, 2, 3, 4], 2, async v => {
      ran++;
      if (v === 2) throw new Error('boom');
      await new Promise(r => setTimeout(r, 1));
    }),
    /boom/
  );
});

test('mapConcurrent stops starting new items after an error', async () => {
  const started = [];
  await assert.rejects(
    mapConcurrent([1, 2, 3, 4, 5], 2, async v => {
      started.push(v);
      if (v === 2) throw new Error('boom');
      await new Promise(r => setTimeout(r, 5));
    }),
    /boom/
  );
  // 错误发生后不得再领取新 item（并发 2：仅 1、2 可能已启动，3/4/5 不应启动）。
  assert.ok(!started.includes(3), `item 3 started after error: ${started}`);
});

test('mapConcurrent handles empty input and over-large concurrency', async () => {
  assert.deepEqual(await mapConcurrent([], 4, async () => 1), []);
  const results = await mapConcurrent(['a', 'b'], 10, async (v, i) => v + i);
  assert.deepEqual(results, ['a0', 'b1']);
});
