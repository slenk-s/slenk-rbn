import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleSyncProvidersUsers, fetchCloudProvidersUsers, pushProvidersUsers } from '../src/syncTiDB.js';

test('未配置 TIDB_PG_URL 时同步静默跳过', async () => {
  delete process.env.TIDB_PG_URL;
  const push = await pushProvidersUsers([], []);
  assert.equal(push.skipped, true);
  assert.equal(push.reason, 'TIDB_PG_URL not set');
  const fetch = await fetchCloudProvidersUsers();
  assert.equal(fetch.skipped, true);
  assert.doesNotThrow(() => scheduleSyncProvidersUsers(10, async () => ({ providers: [], users: [] })));
});

test('loadRows 为 null 时调度为 no-op', () => {
  delete process.env.TIDB_PG_URL;
  assert.doesNotThrow(() => scheduleSyncProvidersUsers(10, null));
});
