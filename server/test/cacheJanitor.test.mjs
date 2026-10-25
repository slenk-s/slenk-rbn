import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closePool } from '../src/db.js';
import { saveNote, addTask } from '../src/store.js';
import { cleanOrphanedNotesImages } from '../src/cacheJanitor.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

after(() => closePool());

const OLD = Date.now() - 48 * 3600 * 1000; // 超过 24h 宽限期

function touch(filePath, mtimeMs) {
  fs.writeFileSync(filePath, 'x');
  const sec = mtimeMs / 1000;
  fs.utimesSync(filePath, sec, sec);
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-images-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('cleanOrphanedNotesImages deletes only stale unreferenced cache files', async (t) => {
  const userId = await createTestUser();
  t.after(() => dropTestUser(userId));
  const dir = tempDir(t);

  const noteRef = 'a'.repeat(32) + '.jpg';
  const taskRef = 'f'.repeat(32) + '.jpg';
  const orphan = 'b'.repeat(32) + '.jpg';
  const young = 'c'.repeat(32) + '.jpg';
  const foreign = 'manually-placed.jpg';
  const tmpLeftover = 'd'.repeat(32) + '.jpg.tmp-1-2';

  touch(path.join(dir, noteRef), OLD);
  touch(path.join(dir, taskRef), OLD);
  touch(path.join(dir, orphan), OLD);
  touch(path.join(dir, young), Date.now());
  touch(path.join(dir, foreign), OLD);
  touch(path.join(dir, tmpLeftover), OLD);

  await saveNote(userId, { title: 't', images: [{ url: '/notes-images/' + noteRef }] });
  await addTask({
    id: 'janitor_task_a', userId, type: 'image', label: 'AI生图1', status: 'succeeded',
    payload: { imageUrls: ['/notes-images/' + taskRef] }
  });

  const r = await cleanOrphanedNotesImages({ dir });

  assert.ok(fs.existsSync(path.join(dir, noteRef)), 'note-referenced file kept');
  assert.ok(fs.existsSync(path.join(dir, taskRef)), 'task-referenced file kept');
  assert.ok(!fs.existsSync(path.join(dir, orphan)), 'stale orphan deleted');
  assert.ok(fs.existsSync(path.join(dir, young)), 'file within grace period kept');
  assert.ok(fs.existsSync(path.join(dir, foreign)), 'non-cache-named file kept');
  assert.ok(!fs.existsSync(path.join(dir, tmpLeftover)), 'stale tmp leftover deleted');
  assert.equal(r.scanned, 5);
  assert.equal(r.removed, 2);
  assert.equal(r.kept, 3);
});

test('cleanOrphanedNotesImages dryRun reports without deleting', async (t) => {
  const userId = await createTestUser();
  t.after(() => dropTestUser(userId));
  const dir = tempDir(t);

  const orphan = 'e'.repeat(32) + '.png';
  touch(path.join(dir, orphan), OLD);

  const r = await cleanOrphanedNotesImages({ dir, dryRun: true });

  assert.equal(r.removed, 1);
  assert.deepEqual(r.removedNames, [orphan]);
  assert.ok(fs.existsSync(path.join(dir, orphan)), 'dryRun keeps the file');
});
