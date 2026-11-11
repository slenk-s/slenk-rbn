import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ReadableStream } from 'node:stream/web';
import { createSourceImageBudget, readImageBuffer } from '../src/lib/minitoolBuild.js';
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
