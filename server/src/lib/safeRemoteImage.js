import dns from 'node:dns';
import net from 'node:net';

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
    const multicast = (groups[0] & 0xff00) === 0xff00;
    const documentation = groups[0] === 0x2001 && groups[1] === 0x0db8;
    return !allZero && !loopback && !uniqueLocal && !linkLocal && !multicast && !documentation;
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

export function createSafeRemoteImageFetcher({
  lookup = dns.promises.lookup,
  fetchImpl = fetch,
  maxRedirects = 3
} = {}) {
  return async function safeRemoteImageFetch(value, { signal } = {}) {
    let current = parseRemoteUrl(value);
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      const literal = net.isIP(current.hostname.replace(/^\[|\]$/g, ''));
      const addresses = literal
        ? [{ address: current.hostname.replace(/^\[|\]$/g, '') }]
        : await lookup(current.hostname, { all: true, verbatim: true }).catch(() => fail());
      if (!Array.isArray(addresses) || !addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) fail();
      const response = await fetchImpl(current, { signal, redirect: 'manual' });
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
