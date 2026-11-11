import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';

const SAFE_ERROR = 'remote_image_not_allowed';
const fail = () => { throw new Error(SAFE_ERROR); };

function ipv4Number(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return ((parts[0] * 0x1000000) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}
function inV4(value, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (ipv4Number(base) & mask);
}
function normalizeIpv6(address) {
  const lower = address.toLowerCase().split('%')[0];
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return { mapped: mapped[1] };
  const halves = lower.split('::');
  if (halves.length > 2) return null;
  const parse = text => text ? text.split(':').map(part => parseInt(part || '0', 16)) : [];
  const left = parse(halves[0]); const right = parse(halves[1]);
  if ([...left, ...right].some(value => !Number.isInteger(value) || value < 0 || value > 0xffff)) return null;
  const fill = 8 - left.length - right.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  return [...left, ...Array(fill).fill(0), ...right];
}

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    const blocked = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4]
    ];
    return value !== null && !blocked.some(([base, bits]) => inV4(value, base, bits));
  }
  if (family === 6) {
    const groups = normalizeIpv6(address);
    if (!groups) return false;
    if (groups.mapped) return isPublicAddress(groups.mapped);
    if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
      return isPublicAddress(`${groups[6] >>> 8}.${groups[6] & 0xff}.${groups[7] >>> 8}.${groups[7] & 0xff}`);
    }
    const allZero = groups.every(value => value === 0);
    const loopback = groups.slice(0, 7).every(value => value === 0) && groups[7] === 1;
    const uniqueLocal = (groups[0] & 0xfe00) === 0xfc00;
    const linkLocal = (groups[0] & 0xffc0) === 0xfe80;
    const siteLocal = (groups[0] & 0xffc0) === 0xfec0;
    const multicast = (groups[0] & 0xff00) === 0xff00;
    const documentation = groups[0] === 0x2001 && groups[1] === 0x0db8;
    const translated = groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0xffff && groups[5] === 0;
    const nat64WellKnown = groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0;
    const nat64Local = groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 1 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0;
    if (translated || nat64WellKnown || nat64Local) {
      return isPublicAddress(`${groups[6] >>> 8}.${groups[6] & 0xff}.${groups[7] >>> 8}.${groups[7] & 0xff}`);
    }
    const sixToFour = groups[0] === 0x2002;
    if (sixToFour) {
      return isPublicAddress(`${groups[1] >>> 8}.${groups[1] & 0xff}.${groups[2] >>> 8}.${groups[2] & 0xff}`);
    }
    const teredo = groups[0] === 0x2001 && groups[1] === 0;
    if (teredo) {
      return isPublicAddress(`${(~groups[6] >>> 8) & 0xff}.${~groups[6] & 0xff}.${(~groups[7] >>> 8) & 0xff}.${~groups[7] & 0xff}`);
    }
    // 已废弃的 IPv4-compatible ::/96 残余（含 :: 与 ::1）：无论内嵌 IPv4 是否公网一律拒绝，
    // 防止支持该历史语义的协议栈把 ::127.0.0.1 / ::7f00:1 路由到内嵌的私有地址。
    const ipv4CompatibleRemainder = groups[0] === 0 && groups[1] === 0 && groups[2] === 0
      && groups[3] === 0 && groups[4] === 0 && groups[5] === 0;
    // RFC 6666 discard-only 100::/64。
    const discardOnly = groups[0] === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0;
    if (ipv4CompatibleRemainder || discardOnly) return false;
    return !allZero && !loopback && !uniqueLocal && !linkLocal && !siteLocal && !multicast && !documentation;
  }
  return false;
}

function parseRemoteUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail(); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) fail();
  if (!url.hostname || url.port && !/^\d+$/.test(url.port)) fail();
  return url;
}

function abortableLookup(lookup, hostname, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error(SAFE_ERROR));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; signal?.removeEventListener?.('abort', onAbort); fn(value); };
    const onAbort = () => finish(reject, signal.reason || new Error(SAFE_ERROR));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    Promise.resolve().then(() => lookup(hostname, { all: true, verbatim: true, signal })).then(
      value => finish(resolve, value),
      error => finish(reject, error)
    );
  });
}

function defaultPinnedFetch(url, { signal, lookup }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: 'GET', signal, lookup,
      headers: { Host: url.host },
      ...(url.protocol === 'https:' ? { servername: url.hostname } : {})
    }, incoming => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      resolve({
        ok: incoming.statusCode >= 200 && incoming.statusCode < 300,
        status: incoming.statusCode,
        headers,
        body: Readable.toWeb(incoming)
      });
    });
    request.on('error', reject);
    request.end();
  });
}

export function createSafeRemoteImageFetcher({
  lookup = dns.promises.lookup,
  fetchImpl = defaultPinnedFetch,
  isAddressAllowed = isPublicAddress,
  maxRedirects = 3
} = {}) {
  return async function safeRemoteImageFetch(value, { signal } = {}) {
    let current = parseRemoteUrl(value);
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      if (signal?.aborted) fail();
      const hostname = current.hostname.replace(/^\[|\]$/g, '');
      const literal = net.isIP(hostname);
      const addresses = literal
        ? [{ address: hostname, family: literal }]
        : await abortableLookup(lookup, hostname, signal).catch(() => fail());
      if (signal?.aborted || !Array.isArray(addresses) || !addresses.length || addresses.some(entry => !isAddressAllowed(entry.address))) fail();
      const pinnedAddresses = addresses.map(entry => ({ address: entry.address, family: entry.family || net.isIP(entry.address) }));
      let addressIndex = 0;
      const pinnedLookup = (_host, options, callback) => {
        if (options?.all === true) {
          callback(null, pinnedAddresses.map(entry => ({ ...entry })));
          return;
        }
        const entry = pinnedAddresses[addressIndex++ % pinnedAddresses.length];
        callback(null, entry.address, entry.family);
      };
      const response = await fetchImpl(current, { signal, redirect: 'manual', lookup: pinnedLookup });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      if (redirects === maxRedirects) { await response.body?.cancel?.().catch(() => {}); fail(); }
      const location = response.headers?.get?.('location');
      await response.body?.cancel?.().catch(() => {});
      if (!location) fail();
      try { current = parseRemoteUrl(new URL(location, current).href); } catch { fail(); }
    }
    fail();
  };
}

export const safeRemoteImageFetch = createSafeRemoteImageFetcher();
