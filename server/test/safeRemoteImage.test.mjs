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

test('safe fetch pins each validated DNS answer into transport without a second lookup', async () => {
  let resolverCalls = 0;
  const connected = [];
  const safeFetch = createSafeRemoteImageFetcher({
    lookup: async hostname => { resolverCalls++; return [{ address: hostname === 'one.test' ? '8.8.8.8' : '1.1.1.1', family: 4 }]; },
    fetchImpl: async (url, init) => {
      const answer = await new Promise((resolve, reject) => init.lookup(url.hostname, {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
      connected.push({ host: url.hostname, ...answer });
      return connected.length === 1
        ? { status: 302, headers: new Headers({ location: 'https://two.test/image' }), body: { cancel: async () => {} } }
        : { status: 200, headers: new Headers(), body: null };
    }
  });
  assert.equal((await safeFetch('https://one.test/image')).status, 200);
  assert.equal(resolverCalls, 2);
  assert.deepEqual(connected, [
    { host: 'one.test', address: '8.8.8.8', family: 4 },
    { host: 'two.test', address: '1.1.1.1', family: 4 }
  ]);
});

test('safe fetch aborts a stalled DNS lookup and never starts transport from a late answer', async () => {
  let resolveLookup;
  let fetches = 0;
  const controller = new AbortController();
  const safeFetch = createSafeRemoteImageFetcher({
    lookup: () => new Promise(resolve => { resolveLookup = resolve; }),
    fetchImpl: async () => { fetches++; return { status: 200, headers: new Headers(), body: null }; }
  });
  const pending = safeFetch('https://stall.test/image', { signal: controller.signal });
  controller.abort(new Error('deadline'));
  await assert.rejects(() => pending, { message: 'remote_image_not_allowed' });
  resolveLookup([{ address: '8.8.8.8', family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 0);
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
