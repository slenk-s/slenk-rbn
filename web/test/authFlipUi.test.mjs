import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('auth flip UI renders one two-sided scene with shared branding', () => {
  assert.match(source, /className="auth-screen"/);
  assert.match(source, /className="auth-flip-scene"/);
  assert.match(source, /auth-flip-card/);
  assert.match(source, /auth-face-front/);
  assert.match(source, /auth-face-back/);
  assert.equal((source.match(/<AuthBrand\s*\/>/g) || []).length >= 2, true, 'both faces share the same brand component');
  assert.equal((source.match(/className="auth-screen"/g) || []).length, 1, 'authentication uses one shared screen wrapper');
});

test('auth flip UI isolates inactive faces and exposes success feedback', () => {
  assert.match(source, /aria-hidden=\{!frontActive\}/);
  assert.match(source, /aria-hidden=\{!backActive\}/);
  assert.match(source, /inert=\{!frontActive/);
  assert.match(source, /inert=\{!backActive/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /验证成功/);
  assert.match(source, /auth-success-check[^\n]*✓/);
  assert.match(source, /onTransitionEnd=\{handleFlipTransitionEnd\}/);
});

test('auth flip UI transfers focus after the back face becomes active', () => {
  assert.match(source, /usernameRef\s*=\s*useRef/);
  assert.match(source, /ref=\{usernameRef\}/);
  assert.match(source, /usernameRef\.current\?\.focus\(\)/);
  assert.match(source, /disabled=\{submitting\s*\|\|\s*!backActive\}/);
});
