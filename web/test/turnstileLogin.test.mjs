import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnstileLoginFlow } from '../src/lib/turnstileLogin.js';

test('Turnstile two-stage login keeps a fresh challenge token in memory only', () => {
  const flow = createTurnstileLoginFlow();

  assert.equal(flow.stage('/'), 'challenge');
  assert.equal(flow.stage('/login'), 'challenge', 'direct /login access stays on the challenge');
  assert.equal(flow.token(), null);

  flow.completeChallenge('fresh-token');
  assert.equal(flow.token(), 'fresh-token');
  assert.equal(flow.stage('/login'), 'login');
  assert.equal(flow.stage('/'), 'challenge', 'a token does not unlock arbitrary paths');
  assert.equal(flow.stage('/anything'), 'challenge');

  flow.invalidate();
  assert.equal(flow.token(), null);
  assert.equal(flow.stage('/login'), 'challenge', 'invalidated tokens cannot be reused');
});

test('Turnstile two-stage login rejects non-string and whitespace challenge values', () => {
  const flow = createTurnstileLoginFlow();

  for (const value of [undefined, null, 0, {}, '', '   ']) {
    flow.completeChallenge(value);
    assert.equal(flow.token(), null);
    assert.equal(flow.stage('/login'), 'challenge');
  }
});

test('Turnstile two-stage login does not call browser persistent storage', () => {
  const originalDescriptors = new Map();
  for (const name of ['localStorage', 'sessionStorage']) {
    originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() { throw new Error(`${name} must not be accessed`); }
    });
  }

  try {
    const flow = createTurnstileLoginFlow();
    flow.completeChallenge('memory-only-token');
    assert.equal(flow.stage('/login'), 'login');
    assert.equal(flow.token(), 'memory-only-token');
    flow.invalidate();
    assert.equal(flow.stage('/login'), 'challenge');
  } finally {
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
