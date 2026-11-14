import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/App.css', import.meta.url), 'utf8');

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

test('auth flip CSS provides perspective, backface isolation, and a left 700ms turn', () => {
  assert.match(css, /\.auth-flip-scene[\s\S]*?perspective\s*:/);
  assert.match(css, /\.auth-flip-card[\s\S]*?transform-style\s*:\s*preserve-3d/);
  assert.match(css, /\.auth-face[\s\S]*?backface-visibility\s*:\s*hidden/);
  assert.match(css, /\.auth-face-back[\s\S]*?rotateY\(180deg\)/);
  assert.match(css, /\.auth-flip-card\.is-flipped[\s\S]*?rotateY\(-180deg\)/);
  assert.match(css, /transition\s*:\s*transform\s+700ms/);
  assert.match(css, /transform-origin\s*:\s*center\s+center/);
});

test('auth flip CSS uses the selected glass surface and success treatment', () => {
  assert.match(css, /\.auth-face[\s\S]*?linear-gradient/);
  assert.match(css, /\.auth-face[\s\S]*?backdrop-filter\s*:\s*blur\(18px\)/);
  assert.match(css, /\.auth-face[\s\S]*?border\s*:/);
  assert.match(css, /\.auth-success[\s\S]*?background/);
  assert.match(css, /\.auth-success-check[\s\S]*?border-radius\s*:\s*50%/);
  assert.match(css, /\.auth-face\[aria-hidden="true"\][\s\S]*?pointer-events\s*:\s*none/);
});

test('auth flip CSS supports reduced motion and narrow screens without overflow', () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /prefers-reduced-motion:[\s\S]*?\.auth-flip-card[\s\S]*?transition-duration/);
  assert.match(css, /@media\s*\(max-width:\s*600px\)/);
  assert.match(css, /max-width\s*:\s*calc\(100vw\s*-\s*32px\)/);
  assert.match(css, /overflow-x\s*:\s*clip/);
});
