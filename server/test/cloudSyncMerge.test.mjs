import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeProviders, mergeUsers } from '../src/lib/cloudSyncMerge.js';

// ---- mergeProviders：按 updated_at 新者胜（LWW），并集，不删行 ----

test('云端独有的供应商补进本地', () => {
  const local = [{ id: 'a', updated_at: '2026-01-01 00:00:00' }];
  const cloud = [{ id: 'a', updated_at: '2026-01-01 00:00:00' }, { id: 'b', updated_at: '2026-01-02 00:00:00' }];
  const merged = mergeProviders(local, cloud);
  assert.deepEqual(merged.map(r => r.id).sort(), ['a', 'b']);
});

test('云端更新时覆盖本地（新者胜）', () => {
  const local = [{ id: 'a', name: 'old', updated_at: '2026-01-01 00:00:00' }];
  const cloud = [{ id: 'a', name: 'new', updated_at: '2026-01-02 00:00:00' }];
  assert.equal(mergeProviders(local, cloud)[0].name, 'new');
});

test('本地更新时保留本地（云端旧记录不回滚）', () => {
  const local = [{ id: 'a', name: 'new', updated_at: '2026-01-03 00:00:00' }];
  const cloud = [{ id: 'a', name: 'old', updated_at: '2026-01-02 00:00:00' }];
  assert.equal(mergeProviders(local, cloud)[0].name, 'new');
});

test('本地独有的行保留，不会被云端删除（删除不向下传播）', () => {
  const local = [{ id: 'a', updated_at: '2026-01-01 00:00:00' }];
  assert.deepEqual(mergeProviders(local, []).map(r => r.id), ['a']);
});

test('时间戳缺失/非法时不覆盖有时间的本地行', () => {
  const local = [{ id: 'a', name: 'local', updated_at: '2026-01-01 00:00:00' }];
  const cloud = [{ id: 'a', name: 'cloud' }];
  assert.equal(mergeProviders(local, cloud)[0].name, 'local');
});

test('空输入安全', () => {
  assert.deepEqual(mergeProviders([], []), []);
  assert.deepEqual(mergeProviders(null, [{ id: 'x' }]), [{ id: 'x' }]);
});

// ---- mergeUsers：并集，冲突保本地（用户行没有 updated_at，密码不能被云端回滚） ----

test('云端独有的用户补进本地', () => {
  const local = [{ id: 'u1', username: 'admin', password_hash: 'h1' }];
  const cloud = [{ id: 'u1', username: 'admin', password_hash: 'h1' }, { id: 'u2', username: 'second', password_hash: 'h2' }];
  const merged = mergeUsers(local, cloud);
  assert.deepEqual(merged.map(r => r.id).sort(), ['u1', 'u2']);
});

test('同 id 冲突时保留本地版本（密码哈希不被云端旧值覆盖）', () => {
  const local = [{ id: 'u1', username: 'admin', password_hash: 'new-hash' }];
  const cloud = [{ id: 'u1', username: 'admin', password_hash: 'old-hash' }];
  assert.equal(mergeUsers(local, cloud)[0].password_hash, 'new-hash');
});

// ---- mergeUsers：不同 id 撞同名 username（本地表有 UNIQUE(username)）----

test('云端残留的同名用户被丢弃（不同 id 撞 admin，保本地）', () => {
  const local = [{ id: 'u1', username: 'admin', password_hash: 'h1' }];
  const cloud = [{ id: 'u1', username: 'admin', password_hash: 'h1' }, { id: 'u2', username: 'admin', password_hash: 'h2' }];
  const merged = mergeUsers(local, cloud);
  assert.deepEqual(merged.map(r => r.id), ['u1']); // 云端 u2/admin 不混入
  assert.equal(merged[0].password_hash, 'h1');
});

test('云端独有的非冲突用户仍补进本地', () => {
  const local = [{ id: 'u1', username: 'admin', password_hash: 'h1' }];
  const cloud = [{ id: 'u1', username: 'admin', password_hash: 'h1' }, { id: 'u2', username: 'second', password_hash: 'h2' }];
  assert.deepEqual(mergeUsers(local, cloud).map(r => r.id).sort(), ['u1', 'u2']);
});

test('同 id 改用户名时仍保本地且只保留一行', () => {
  const local = [{ id: 'u1', username: 'admin', password_hash: 'h1' }];
  const cloud = [{ id: 'u1', username: 'renamed', password_hash: 'h2' }];
  const merged = mergeUsers(local, cloud);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].username, 'admin');
});
