import test from 'node:test';
import assert from 'node:assert/strict';

const { hasUsableImage, requestWithImageRetry } = await import('../src/lib/imageResponseRetry.js');

test('正常返回图片时不额外重试', async () => {
  let calls = 0;
  const response = await requestWithImageRetry(async () => {
    calls += 1;
    return usableResponse();
  }, { delayMs: 0 });

  assert.deepEqual(response, usableResponse());
  assert.equal(calls, 1);
});

function usableResponse() {
  return { data: [{ b64_json: 'aGVsbG8=' }] };
}

test('识别现有支持的各种图片字段', () => {
  assert.equal(hasUsableImage({ data: [{ b64_json: 'aGVsbG8=' }] }), true);
  assert.equal(hasUsableImage({ data: [{ url: 'https://example.invalid/image.png' }] }), true);
  assert.equal(hasUsableImage({ images: ['data:image/png;base64,aGVsbG8='] }), true);
  assert.equal(hasUsableImage({ data: [] }), false);
  assert.equal(hasUsableImage({ data: [{ b64_json: '' }] }), false);
});

test('第一次返回空图时重试并返回后续正常响应', async () => {
  let calls = 0;
  const retries = [];
  const response = await requestWithImageRetry(async () => {
    calls += 1;
    return calls === 1 ? { data: [] } : usableResponse();
  }, { retries: 2, delayMs: 0, onRetry: attempt => retries.push(attempt) });

  assert.deepEqual(response, usableResponse());
  assert.equal(calls, 2);
  assert.deepEqual(retries, [1]);
});

test('持续返回空图时在重试上限后保留最后一次响应', async () => {
  let calls = 0;
  const retries = [];
  const response = await requestWithImageRetry(async () => {
    calls += 1;
    return { data: [] };
  }, { retries: 2, delayMs: 0, onRetry: attempt => retries.push(attempt) });

  assert.deepEqual(response, { data: [] });
  assert.equal(calls, 3);
  assert.deepEqual(retries, [1, 2]);
});
