import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTurnstileLoginFlow,
  renderTurnstileWidget,
  subscribeTurnstileScriptLoad
} from '../src/lib/turnstileLogin.js';

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

test('Turnstile two-stage login invalidation aborts and supersedes a pending login', () => {
  const flow = createTurnstileLoginFlow();
  flow.completeChallenge('first-token');

  const pending = flow.beginLogin();
  assert.equal(pending.token, 'first-token');
  assert.equal(pending.signal.aborted, false);
  assert.equal(flow.isCurrentLogin(pending), true);
  assert.equal(flow.beginLogin(), null, 'the same challenge cannot start a duplicate request');

  flow.invalidate();

  assert.equal(pending.signal.aborted, true, 'invalidation aborts the pending fetch');
  assert.equal(flow.isCurrentLogin(pending), false, 'a late completion is stale');
  assert.equal(flow.token(), null);
});

test('Turnstile two-stage login keeps old completions isolated from a newer challenge', () => {
  const flow = createTurnstileLoginFlow();
  flow.completeChallenge('old-token');
  const oldRequest = flow.beginLogin();

  flow.invalidate();
  flow.completeChallenge('new-token');
  const newRequest = flow.beginLogin();

  assert.equal(flow.isCurrentLogin(oldRequest), false);
  assert.equal(flow.isCurrentLogin(newRequest), true);
  assert.equal(newRequest.token, 'new-token');
  assert.equal(flow.token(), 'new-token', 'checking an old completion does not clear newer state');

  flow.finishLogin(oldRequest);
  assert.equal(flow.isCurrentLogin(newRequest), true, 'an old finally path cannot finish the new request');
  assert.equal(flow.token(), 'new-token');

  flow.finishLogin(newRequest);
  assert.equal(flow.isCurrentLogin(newRequest), false);
});

test('Turnstile two-stage login supersedes a pending request when a new challenge completes', () => {
  const flow = createTurnstileLoginFlow();
  flow.completeChallenge('old-token');
  const oldRequest = flow.beginLogin();

  flow.completeChallenge('replacement-token');

  assert.equal(oldRequest.signal.aborted, true);
  assert.equal(flow.isCurrentLogin(oldRequest), false);
  assert.equal(flow.token(), 'replacement-token');
});

test('Turnstile widget rendering converts synchronous exceptions into recoverable failures', () => {
  const failure = new Error('render exploded');
  const errors = [];
  const widgetIdRef = { current: null };

  const rendered = renderTurnstileWidget({
    turnstile: { render() { throw failure; } },
    container: {},
    widgetIdRef,
    options: {},
    onRenderError(error) { errors.push(error); }
  });

  assert.equal(rendered, false);
  assert.equal(widgetIdRef.current, null);
  assert.deepEqual(errors, [failure]);
});

test('Turnstile widget rendering can retry after a synchronous exception', () => {
  const widgetIdRef = { current: null };
  let attempts = 0;
  const turnstile = {
    render() {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary failure');
      return 'widget-2';
    }
  };

  assert.equal(renderTurnstileWidget({ turnstile, container: {}, widgetIdRef, options: {}, onRenderError() {} }), false);
  assert.equal(renderTurnstileWidget({ turnstile, container: {}, widgetIdRef, options: {}, onRenderError() {} }), true);
  assert.equal(widgetIdRef.current, 'widget-2');
});

test('Turnstile script load subscription removes an existing listener on cleanup', () => {
  let listener = null;
  const script = {
    addEventListener(type, callback, options) {
      assert.equal(type, 'load');
      assert.deepEqual(options, { once: true });
      listener = callback;
    },
    removeEventListener(type, callback) {
      assert.equal(type, 'load');
      assert.equal(callback, listener);
      listener = null;
    }
  };
  const render = () => {};

  const cleanup = subscribeTurnstileScriptLoad(script, render);
  assert.equal(listener, render);
  cleanup();
  assert.equal(listener, null);
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
