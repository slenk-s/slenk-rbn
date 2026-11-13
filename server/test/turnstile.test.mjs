import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyTurnstile } from '../src/lib/turnstile.js';

const token = 'turnstile-token';
const secret = 'turnstile-secret';
const expectedAction = 'login';
const expectedHostnames = new Set(['notes.example.com']);

function response(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

function assertRedacted(result) {
  const diagnostics = JSON.stringify(result);
  assert.equal(diagnostics.includes(token), false);
  assert.equal(diagnostics.includes(secret), false);
}

async function verifyWith(fetchImpl) {
  return verifyTurnstile({
    token,
    secret,
    expectedAction,
    expectedHostnames,
    remoteIp: '203.0.113.7',
    fetchImpl,
  });
}

test('Turnstile accepts a valid strict Siteverify response and sends the token', async () => {
  let request;
  const result = await verifyWith(async (url, options) => {
    request = { url, options };
    return response({
      success: true,
      action: expectedAction,
      hostname: 'notes.example.com',
    });
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(request.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(request.options.body.get('response'), token);
  assert.equal(request.options.body.get('secret'), secret);
  assert.equal(request.options.body.get('remoteip'), '203.0.113.7');
  assert.ok(request.options.signal instanceof AbortSignal);
});

test('Turnstile classifies invalid-input-response as a redacted Siteverify rejection', async () => {
  const result = await verifyWith(async () => response({
    success: false,
    'error-codes': ['invalid-input-response'],
  }));

  assert.deepEqual(result, {
    ok: false,
    reason: 'siteverify_rejected',
    details: { errorCodes: ['invalid-input-response'] },
  });
  assertRedacted(result);
});

test('Turnstile classifies an action mismatch with redacted diagnostics', async () => {
  const result = await verifyWith(async () => response({
    success: true,
    action: 'signup',
    hostname: 'notes.example.com',
  }));

  assert.deepEqual(result, {
    ok: false,
    reason: 'action_mismatch',
    details: { action: 'signup' },
  });
  assertRedacted(result);
});

test('Turnstile classifies a hostname mismatch with redacted diagnostics', async () => {
  const result = await verifyWith(async () => response({
    success: true,
    action: expectedAction,
    hostname: 'attacker.example.com',
  }));

  assert.deepEqual(result, {
    ok: false,
    reason: 'hostname_mismatch',
    details: { hostname: 'attacker.example.com' },
  });
  assertRedacted(result);
});

test('Turnstile never returns a token or secret echoed by Siteverify', async () => {
  const result = await verifyWith(async () => response({
    success: false,
    action: token,
    hostname: secret,
    'error-codes': [token, secret],
  }));

  assertRedacted(result);
});

test('Turnstile classifies a thrown fetch as a redacted transport failure', async () => {
  const result = await verifyWith(async () => {
    throw new Error(`request leaked ${token} ${secret}`);
  });

  assert.deepEqual(result, { ok: false, reason: 'siteverify_transport' });
  assertRedacted(result);
});

test('Turnstile rejects a non-login expected action as invalid configuration', async () => {
  for (const invalidAction of [undefined, '', 'signup']) {
    let called = false;
    const result = await verifyTurnstile({
      token,
      secret,
      expectedAction: invalidAction,
      expectedHostnames,
      fetchImpl: async () => {
        called = true;
        return response({ success: true, action: invalidAction, hostname: 'notes.example.com' });
      },
    });

    assert.deepEqual(result, { ok: false, reason: 'invalid_config' });
    assert.equal(called, false);
  }
});

test('Turnstile requires Siteverify to return the login action', async () => {
  const result = await verifyWith(async () => response({
    success: true,
    action: undefined,
    hostname: 'notes.example.com',
  }));

  assert.deepEqual(result, {
    ok: false,
    reason: 'action_mismatch',
    details: { action: undefined },
  });
});

test('Turnstile rejects hostname configuration containing non-strings or empty strings', async () => {
  for (const invalidHostnames of [
    new Set([undefined]),
    new Set(['']),
    new Set(['notes.example.com', 42]),
  ]) {
    let called = false;
    const result = await verifyTurnstile({
      token,
      secret,
      expectedAction,
      expectedHostnames: invalidHostnames,
      fetchImpl: async () => {
        called = true;
        return response({ success: true, action: expectedAction, hostname: undefined });
      },
    });

    assert.deepEqual(result, { ok: false, reason: 'invalid_config' });
    assert.equal(called, false);
  }
});

test('Turnstile rejects a missing or empty Siteverify hostname', async () => {
  for (const invalidHostname of [undefined, '']) {
    const result = await verifyWith(async () => response({
      success: true,
      action: expectedAction,
      hostname: invalidHostname,
    }));

    assert.deepEqual(result, {
      ok: false,
      reason: 'hostname_mismatch',
      details: { hostname: invalidHostname },
    });
  }
});

test('Turnstile redacts credentials embedded in longer diagnostic strings', async () => {
  const rejected = await verifyWith(async () => response({
    success: false,
    'error-codes': [`prefix-${token}-suffix`, `secret=${secret}`],
  }));
  const actionMismatch = await verifyWith(async () => response({
    success: true,
    action: `prefix-${token}-suffix`,
    hostname: 'notes.example.com',
  }));
  const hostnameMismatch = await verifyWith(async () => response({
    success: true,
    action: expectedAction,
    hostname: `secret=${secret}`,
  }));

  assertRedacted(rejected);
  assertRedacted(actionMismatch);
  assertRedacted(hostnameMismatch);
});

test('Turnstile classifies a non-2xx response with status-only diagnostics', async () => {
  const result = await verifyWith(async () => response(
    { leaked: `${token}:${secret}` },
    { ok: false, status: 503 },
  ));

  assert.deepEqual(result, {
    ok: false,
    reason: 'siteverify_transport',
    details: { status: 503 },
  });
  assertRedacted(result);
});

test('Turnstile classifies invalid JSON as a redacted transport failure', async () => {
  const result = await verifyWith(async () => ({
    ok: true,
    status: 200,
    async json() {
      throw new SyntaxError(`invalid JSON ${token} ${secret}`);
    },
  }));

  assert.deepEqual(result, { ok: false, reason: 'siteverify_transport' });
  assertRedacted(result);
});
