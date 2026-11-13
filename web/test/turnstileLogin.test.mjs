import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTurnstileLoginFlow,
  LOGIN_REQUEST_TIMEOUT_MS,
  loadTurnstileScript,
  persistCurrentLogin,
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

test('Turnstile two-stage login ignores repeated challenge callbacks while a login is active', () => {
  const flow = createTurnstileLoginFlow();
  flow.completeChallenge('original-token');
  const request = flow.beginLogin();

  assert.equal(flow.completeChallenge('replacement-token'), false);
  assert.equal(request.signal.aborted, false, 'the active login is not superseded');
  assert.equal(flow.isCurrentLogin(request), true);
  assert.equal(flow.token(), 'original-token', 'the original request keeps its challenge');
});

test('Turnstile two-stage login keeps a callback ignored when the active request settles in the same tick', () => {
  const flow = createTurnstileLoginFlow();
  flow.completeChallenge('original-token');
  const request = flow.beginLogin();

  const accepted = flow.completeChallenge('same-tick-token');
  flow.finishLogin(request);

  assert.equal(accepted, false);
  assert.equal(flow.token(), 'original-token');
  assert.equal(flow.isCurrentLogin(request), false);
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

test('Turnstile two-stage login accepts a replacement challenge after invalidation', () => {
  const flow = createTurnstileLoginFlow();
  flow.completeChallenge('old-token');
  const oldRequest = flow.beginLogin();

  flow.invalidate();
  assert.equal(flow.completeChallenge('replacement-token'), true);

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

test('Turnstile script retry replaces a failed node but reuses a healthy loading node', () => {
  const appended = [];
  const scriptNode = dataset => ({
    dataset,
    addEventListener() {},
    removeEventListener() {}
  });
  const failed = {
    ...scriptNode({ turnstileState: 'failed' }),
    remove() { this.removed = true; }
  };
  const healthy = scriptNode({});
  const documentWith = existing => ({
    head: { appendChild(node) { appended.push(node); } },
    querySelector() { return existing; },
    createElement(tag) {
      assert.equal(tag, 'script');
      return scriptNode({});
    }
  });

  const replacementLoad = loadTurnstileScript(documentWith(failed), () => {}, () => {});
  assert.equal(failed.removed, true);
  assert.equal(appended.length, 1);
  assert.equal(replacementLoad.script, appended[0]);
  assert.equal(replacementLoad.script.dataset.turnstileState, 'loading');

  appended.length = 0;
  const healthyLoad = loadTurnstileScript(documentWith(healthy), () => {}, () => {});
  assert.equal(healthyLoad.script, healthy);
  assert.equal(appended.length, 0, 'an in-flight healthy request is not duplicated');
  replacementLoad.cleanup();
  healthyLoad.cleanup();
});

test('Turnstile script pending load times out, marks failed, and exposes retry', () => {
  const listeners = new Map();
  const timers = [];
  const script = {
    dataset: {},
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    }
  };
  const document = {
    head: { appendChild() {} },
    querySelector() { return null; },
    createElement() { return script; }
  };
  let errors = 0;

  const loading = loadTurnstileScript(document, () => assert.fail('pending script must not load'), () => { errors += 1; }, {
    timeoutMs: 250,
    setTimeout(callback, ms) { timers.push({ callback, ms, cleared: false }); return timers.length - 1; },
    clearTimeout(id) { timers[id].cleared = true; }
  });

  assert.equal(timers[0].ms, 250);
  timers[0].callback();
  assert.equal(script.dataset.turnstileState, 'failed');
  assert.equal(errors, 1);
  assert.equal(listeners.size, 0, 'timeout settles and detaches both event listeners');
  loading.cleanup();
});

test('Turnstile script loaded without API fails immediately so retry can replace it', () => {
  const script = {
    dataset: { turnstileState: 'loaded' },
    addEventListener() { assert.fail('a settled loaded node must not wait for another event'); },
    removeEventListener() {}
  };
  const document = {
    head: { appendChild() { assert.fail('known loaded state is settled before retry'); } },
    querySelector() { return script; },
    createElement() { assert.fail('known loaded state is settled before retry'); }
  };
  let errors = 0;

  const loading = loadTurnstileScript(document, () => assert.fail('API is absent'), () => { errors += 1; });

  assert.equal(script.dataset.turnstileState, 'failed');
  assert.equal(errors, 1);
  loading.cleanup();
});

test('Turnstile script late events cannot settle twice or remove a newer node', () => {
  const listeners = new Map();
  const timers = [];
  let currentScript;
  const oldScript = {
    dataset: {},
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    remove() {
      if (currentScript === this) currentScript = null;
    }
  };
  const document = {
    head: { appendChild(node) { currentScript = node; } },
    querySelector() { return currentScript; },
    createElement() { return oldScript; }
  };
  let loads = 0;
  let errors = 0;

  loadTurnstileScript(document, () => { loads += 1; }, () => { errors += 1; }, {
    timeoutMs: 250,
    setTimeout(callback) { timers.push(callback); return timers.length - 1; },
    clearTimeout() {}
  });
  const lateLoad = listeners.get('load');
  const newerScript = { dataset: { turnstileState: 'loading' } };
  currentScript = newerScript;

  timers[0]();
  lateLoad();

  assert.equal(errors, 1);
  assert.equal(loads, 0, 'late load is ignored after timeout');
  assert.equal(currentScript, newerScript, 'timeout does not remove a newer script node');
});

test('Turnstile login request timeout is explicit and allows backend siteverify budget', () => {
  assert.equal(LOGIN_REQUEST_TIMEOUT_MS, 15_000);
});

test('Turnstile script errors are marked failed and listeners are detached by cleanup', () => {
  const listeners = new Map();
  const script = {
    dataset: {},
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    }
  };
  const document = {
    head: { appendChild() {} },
    querySelector() { return null; },
    createElement() { return script; }
  };
  let errors = 0;

  const loaded = loadTurnstileScript(document, () => {}, () => { errors += 1; });
  listeners.get('error')();
  assert.equal(loaded.script.dataset.turnstileState, 'failed');
  assert.equal(errors, 1);

  loaded.cleanup();
  assert.equal(listeners.size, 0);
});

test('Turnstile login persistence finishes only after storage succeeds', () => {
  const flow = createTurnstileLoginFlow();
  flow.completeChallenge('token');
  const request = flow.beginLogin();
  const storageError = new Error('storage blocked');

  assert.throws(() => persistCurrentLogin({
    flow,
    request,
    token: 'jwt',
    persist() { throw storageError; }
  }), storageError);
  assert.equal(flow.isCurrentLogin(request), true, 'failure cleanup can still invalidate the request');

  let persisted = '';
  persistCurrentLogin({ flow, request, token: 'jwt', persist(token) { persisted = token; } });
  assert.equal(persisted, 'jwt');
  assert.equal(flow.isCurrentLogin(request), false);
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
