import test from 'node:test';
import assert from 'node:assert/strict';
import { createSafeRemoteImageFetcher, isPublicAddress } from '../src/lib/safeRemoteImage.js';

const blocked = [
  '0.0.0.0', '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
  '100.64.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1',
  'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254',
  '::ffff:7f00:1', '::ffff:a00:1', '::ffff:a9fe:a9fe'
];
for (const address of blocked) test(`SSRF policy rejects ${address}`, () => assert.equal(isPublicAddress(address), false));
for (const address of ['1.1.1.1', '8.8.8.8', '2001:4860:4860::8888']) test(`SSRF policy permits public ${address}`, () => assert.equal(isPublicAddress(address), true));

test('safe fetch rejects credentials, non-http protocols, and private literal hosts', async () => {
  const safeFetch = createSafeRemoteImageFetcher({ lookup: async () => { throw new Error('must not resolve'); }, fetchImpl: async () => { throw new Error('must not fetch'); } });
  for (const url of ['http://user:pass@example.com/x', 'file:///secret', 'http://127.0.0.1/x', 'http://[::1]/x']) {
    await assert.rejects(() => safeFetch(url), { message: 'remote_image_not_allowed' });
  }
});

test('safe fetch resolves every redirect hop and blocks redirect to private DNS', async () => {
  const lookups = [];
  let fetches = 0;
  const safeFetch = createSafeRemoteImageFetcher({
    lookup: async hostname => { lookups.push(hostname); return [{ address: hostname === 'public.test' ? '8.8.4.4' : '10.0.0.7', family: 4 }]; },
    fetchImpl: async () => {
      fetches++;
      return { status: 302, headers: new Headers({ location: 'http://private.test/secret' }), body: { cancel: async () => {} } };
    }
  });
  await assert.rejects(() => safeFetch('https://public.test/image'), { message: 'remote_image_not_allowed' });
  assert.deepEqual(lookups, ['public.test', 'private.test']);
  assert.equal(fetches, 1);
});

test('safe fetch bounds redirects and uses manual redirect mode', async () => {
  const options = [];
  const safeFetch = createSafeRemoteImageFetcher({
    maxRedirects: 1,
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async (url, init) => { options.push(init); return { status: 302, headers: new Headers({ location: '/again' }), body: { cancel: async () => {} } }; }
  });
  await assert.rejects(() => safeFetch('https://public.test/image'), { message: 'remote_image_not_allowed' });
  assert.equal(options.every(item => item.redirect === 'manual'), true);
});
