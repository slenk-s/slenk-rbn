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
