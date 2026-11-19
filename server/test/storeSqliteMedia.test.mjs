import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  initStore, closeStore, createUser, deleteUser, deleteProvider,
  saveNote, getNote, insertMedia, getMedia, listMediaIds,
  getAllNotesImagesForJanitor, getAllTasksPayloadForJanitor,
  createXhsAccountPending, bindXhsAccountOpenId, findXhsAccountByOpenId,
  updateXhsAccountNickname, listXhsAccounts, getXhsAccount, deleteXhsAccount
} from '../src/store.sqlite.js';
import { mediaPath } from '../src/lib/mediaFiles.js';

after(async () => { await closeStore(); });

test('saveNote/getNote 保留 tags/images 数组', async () => {
  await initStore();
  const user = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  const note = await saveNote(user.id, { title: '标题', tags: ['旅行'], images: ['/api/media/a'] });
  const loaded = await getNote(note.id);
  assert.equal(loaded.title, '标题');
  assert.deepEqual(loaded.tags, ['旅行']);
  assert.deepEqual(loaded.images, ['/api/media/a']);
  await deleteUser(user.id);
});

test('insertMedia 写文件并读回字节，listMediaIds 返回全部', async () => {
  const user = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  const id = 'media_' + Math.random().toString(36).slice(2);
  const data = Buffer.from([1, 2, 3, 4, 5]);
  await insertMedia({ id, userId: user.id, filename: 'a.png', mimeType: 'image/png', data });
  assert.deepEqual((await getMedia(id)).data, data);
  assert.ok(fs.existsSync(mediaPath(id)));
  assert.ok((await listMediaIds()).includes(id));
  assert.equal((await getAllNotesImagesForJanitor()).length >= 0, true);
  assert.equal((await getAllTasksPayloadForJanitor()).length >= 0, true);
  await deleteUser(user.id);
});

test('XHS 账号完整生命周期与重复绑定错误', async () => {
  const user = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  const id = 'xhs_' + Math.random().toString(36).slice(2);
  const pending = await createXhsAccountPending(user.id, { id, credentialDir: 'cred_a' });
  assert.equal(pending.openId, null);
  await bindXhsAccountOpenId(user.id, id, { openId: 'o1', nickname: '阿明' });
  const byOpen = await findXhsAccountByOpenId(user.id, 'o1');
  assert.equal(byOpen.id, id);
  await updateXhsAccountNickname(user.id, id, '小明');
  assert.equal((await getXhsAccount(user.id, id)).nickname, '小明');
  assert.equal((await listXhsAccounts(user.id)).length, 1);
  // 第二个账号绑定同一 openId 触发 unique(user_id, open_id)。
  const second = 'xhs_' + Math.random().toString(36).slice(2);
  await createXhsAccountPending(user.id, { id: second, credentialDir: 'cred_b' });
  await assert.rejects(
    () => bindXhsAccountOpenId(user.id, second, { openId: 'o1' }),
    (e) => e.code === 'XHS_ACCOUNT_DUPLICATE'
  );
  await deleteXhsAccount(user.id, second);
  const removed = await deleteXhsAccount(user.id, id);
  assert.equal(removed.credentialDir, 'cred_a');
  assert.equal(await getXhsAccount(user.id, id), null);
  await deleteUser(user.id);
});

test('deleteUser 删除该用户全部媒体文件', async () => {
  const user = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  const id = 'media_' + Math.random().toString(36).slice(2);
  await insertMedia({ id, userId: user.id, filename: 'a.png', mimeType: 'image/png', data: Buffer.from('x') });
  assert.ok(fs.existsSync(mediaPath(id)));
  await deleteUser(user.id);
  assert.equal(fs.existsSync(mediaPath(id)), false);
});
