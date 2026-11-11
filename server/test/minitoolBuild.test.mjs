import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ReadableStream } from 'node:stream/web';
import { createSourceImageBudget, janitorMiniToolArtifacts, readImageBuffer } from '../src/lib/minitoolBuild.js';
import { paths } from '../src/paths.js';

function response(chunks, headers = {}) {
  let cancelled = false;
  return {
    ok: true, status: 200, headers: new Headers(headers),
    body: new ReadableStream({
      pull(controller) { const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close(); },
      cancel() { cancelled = true; }
    }),
    get cancelled() { return cancelled; }
  };
}

function janitorRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minitool-janitor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('startup janitor selects the bounded oldest candidates fairly in an isolated root', (t) => {
  const root = janitorRoot(t);
  const names = Array.from({ length: 105 }, (_, index) => `janitor-${index}`);
  const now = Date.now();
  for (let index = 0; index < names.length; index++) {
    const target = path.join(root, names[index]);
    fs.writeFileSync(target, 'x');
    const age = index >= 100 ? now - 48 * 60 * 60 * 1000 : now;
    fs.utimesSync(target, age / 1000, age / 1000);
  }
  janitorMiniToolArtifacts({ root, maxEntries: 100, maxAgeMs: 24 * 60 * 60 * 1000, now: () => now });
  assert.equal(names.slice(100).every(name => !fs.existsSync(path.join(root, name))), true);
  assert.equal(names.slice(0, 100).every(name => fs.existsSync(path.join(root, name))), true);
});

test('janitor removes every genuinely expired entry in one run beyond the first 100', (t) => {
  const root = janitorRoot(t);
  const now = Date.now();
  const expired = Array.from({ length: 130 }, (_, index) => `expired-${index}`);
  for (const name of expired) {
    const target = path.join(root, name);
    fs.writeFileSync(target, 'x');
    const age = (now - 48 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(target, age, age);
  }
  fs.writeFileSync(path.join(root, 'fresh'), 'x');
  janitorMiniToolArtifacts({ root, maxAgeMs: 24 * 60 * 60 * 1000, now: () => now });
  assert.equal(expired.every(name => !fs.existsSync(path.join(root, name))), true);
  assert.equal(fs.existsSync(path.join(root, 'fresh')), true);
});

test('janitor never traverses or removes symlinks even when expired', (t) => {
  const root = janitorRoot(t);
  const now = Date.now();
  const outside = path.join(root, '..', `outside-${Date.now()}`);
  fs.mkdirSync(outside, { recursive: true });
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const link = path.join(root, 'expired-link');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch {
    return; // 平台不支持软链时跳过断言
  }
  const age = (now - 48 * 60 * 60 * 1000) / 1000;
  try { fs.utimesSync(link, age, age); } catch {}
  janitorMiniToolArtifacts({ root, maxAgeMs: 24 * 60 * 60 * 1000, now: () => now });
  assert.equal(fs.existsSync(link), true);
  assert.equal(fs.existsSync(outside), true);
});

test('remote image rejects oversized Content-Length before reading', async () => {
  const res = response([new Uint8Array([1])], { 'content-length': '11' });
  await assert.rejects(() => readImageBuffer('https://public.test/a', 0, undefined, { maxBytes: 10, fetchRemote: async () => res }), { message: 'source_image_too_large' });
  assert.equal(res.cancelled, true);
});

test('remote image streaming rejects chunked overflow and cancels reader', async () => {
  let cancelled = false; let offset = 0;
  const chunks = [new Uint8Array(6), new Uint8Array(6)];
  const res = { ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({ read: async () => ({ done: false, value: chunks[offset++] }), cancel: async () => { cancelled = true; }, releaseLock() {} }) } };
  await assert.rejects(() => readImageBuffer('https://public.test/a', 0, undefined, { maxBytes: 10, fetchRemote: async () => res }), { message: 'source_image_too_large' });
  assert.equal(cancelled, true);
});

test('remote image abort cancels response body', async () => {
  const controller = new AbortController();
  let reads = 0; let cancelled = false;
  const res = {
    ok: true, status: 200, headers: new Headers(),
    body: new ReadableStream({ pull(stream) { reads++; stream.enqueue(new Uint8Array(3)); if (reads === 1) controller.abort(new Error('stop')); }, cancel() { cancelled = true; } })
  };
  await assert.rejects(() => readImageBuffer('https://public.test/a', 0, controller.signal, { maxBytes: 10, fetchRemote: async () => res }), { message: 'stop' });
  assert.equal(cancelled, true);
});

test('aggregate source image budget rejects the image that exceeds remaining bytes', () => {
  const budget = createSourceImageBudget(10);
  assert.equal(budget.remaining(), 10);
  budget.consume(6);
  assert.equal(budget.remaining(), 4);
  assert.throws(() => budget.consume(5), { message: 'source_images_total_too_large' });
});

test('local image fstat rejects oversized file', async () => {
  const file = path.join(paths.uploadsDir, `oversized-${Date.now()}.bin`);
  fs.mkdirSync(paths.uploadsDir, { recursive: true }); fs.writeFileSync(file, Buffer.alloc(11));
  try { await assert.rejects(() => readImageBuffer(`/uploads/${path.basename(file)}`, 0, undefined, { maxBytes: 10 }), { message: 'source_image_too_large' }); }
  finally { fs.rmSync(file, { force: true }); }
});
