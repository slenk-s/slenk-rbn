import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTER_BASE,
  deriveFormState,
  updateTabFieldMap,
  setFieldValue,
  seedDefaultPromptMap,
  appendFileToTabMap,
} from '../src/lib/tabFormState.js';

const PROMPTS = { 'ai-image': '默认AI图', 'live-video': '默认视频' };

test('deriveFormState returns all defaults when tab unset', () => {
  const s = deriveFormState({}, 'ai-image', PROMPTS);
  assert.equal(s.text, '');
  assert.equal(s.defaultPrompt, '默认AI图');
  assert.equal(s.secondaryPrompt, '');
  assert.deepEqual(s.files, []);
  assert.equal(s.canvasSize, '1080x1440');
  assert.equal(s.outputCount, '1');
  assert.equal(s.perReference, true);
  assert.equal(s.motionEffect, '手持轻晃');
  assert.equal(s.durationMode, 'fixed');
  assert.equal(s.customDuration, '3');
  assert.equal(s.shakeStrength, 35);
  assert.equal(s.shakeFrequency, 45);
});

test('deriveFormState falls back to prompts[active] || "" for unknown tab', () => {
  const s = deriveFormState({}, 'no-such-tab', PROMPTS);
  assert.equal(s.defaultPrompt, '');
});

test('deriveFormState preserves explicit values', () => {
  const s = deriveFormState({
    text: { 'live-video': '用户输入' },
    defaultPrompt: { 'live-video': '已存默认' },
    secondaryPrompt: { 'live-video': '二级' },
    files: { 'live-video': [{ url: '/a.png' }] },
    canvasSize: { 'live-video': '1080x1080' },
    outputCount: { 'live-video': '2' },
    perReference: { 'live-video': false },
    motionEffect: { 'live-video': '缓慢推近' },
    durationMode: { 'live-video': 'random' },
    customDuration: { 'live-video': '5' },
    shakeStrength: { 'live-video': 0 },
    shakeFrequency: { 'live-video': 0 },
  }, 'live-video', PROMPTS);
  assert.equal(s.text, '用户输入');
  assert.equal(s.defaultPrompt, '已存默认');
  assert.equal(s.secondaryPrompt, '二级');
  assert.deepEqual(s.files, [{ url: '/a.png' }]);
  assert.equal(s.canvasSize, '1080x1080');
  assert.equal(s.outputCount, '2');
  assert.equal(s.perReference, false);
  assert.equal(s.motionEffect, '缓慢推近');
  assert.equal(s.durationMode, 'random');
  assert.equal(s.customDuration, '5');
  // ?? 语义：显式 0 保留（静止画面）
  assert.equal(s.shakeStrength, 0);
  assert.equal(s.shakeFrequency, 0);
});

test('deriveFormState ignores other tabs', () => {
  const s = deriveFormState({ text: { 'ai-image': '别的页签' } }, 'live-video', PROMPTS);
  assert.equal(s.text, '');
});

test('updateTabFieldMap stores a plain value', () => {
  const next = updateTabFieldMap({}, 'live-video', 'hello', SETTER_BASE.text);
  assert.equal(next['live-video'], 'hello');
});

test('updateTabFieldMap applies a function updater to existing value', () => {
  const map = { 'live-video': 'old' };
  const next = updateTabFieldMap(map, 'live-video', (v) => v + '!', SETTER_BASE.text);
  assert.equal(next['live-video'], 'old!');
});

test('updateTabFieldMap falls back to base for a function updater on unset tab', () => {
  const next = updateTabFieldMap({}, 'live-video', (v) => v.concat([{ url: '/b.png' }]), SETTER_BASE.files);
  assert.deepEqual(next['live-video'], [{ url: '/b.png' }]);
});

test('updateTabFieldMap is immutable and preserves other tabs', () => {
  const map = { 'ai-image': 'keep' };
  const next = updateTabFieldMap(map, 'live-video', 'new', SETTER_BASE.text);
  assert.equal(next['ai-image'], 'keep');
  assert.equal(map['live-video'], undefined);
});

test('setFieldValue stores a raw value with no updater branch', () => {
  const next = setFieldValue({}, 'ai-image', false);
  assert.equal(next['ai-image'], false);
});

test('seedDefaultPromptMap seeds only when tab absent', () => {
  const seeded = seedDefaultPromptMap({}, 'ai-image', PROMPTS);
  assert.equal(seeded['ai-image'], '默认AI图');
  const kept = seedDefaultPromptMap({ 'ai-image': '既有' }, 'ai-image', PROMPTS);
  assert.equal(kept['ai-image'], '既有');
});

test('seedDefaultPromptMap keeps map identity when already set', () => {
  const map = { 'ai-image': '既有' };
  assert.equal(seedDefaultPromptMap(map, 'ai-image', PROMPTS), map);
});

test('appendFileToTabMap appends a file', () => {
  const { files, added } = appendFileToTabMap({}, 'live-video', { url: '/a.png' });
  assert.equal(added, true);
  assert.deepEqual(files['live-video'], [{ url: '/a.png' }]);
});

test('appendFileToTabMap dedups by url', () => {
  const map = { 'live-video': [{ url: '/a.png' }] };
  const { files, added } = appendFileToTabMap(map, 'live-video', { url: '/a.png' });
  assert.equal(added, false);
  assert.equal(files, map);
});

test('appendFileToTabMap caps at 9 files (drops the 10th, matching original append-then-slice)', () => {
  // 原实现 [...prev, file].slice(0,9)：满 9 张时新文件被丢弃，保留前 9 张。
  const existing = Array.from({ length: 9 }, (_, i) => ({ url: `/f${i}.png` }));
  const { files, added } = appendFileToTabMap({ 'live-video': existing }, 'live-video', { url: '/new.png' });
  assert.equal(added, true);
  assert.equal(files['live-video'].length, 9);
  assert.equal(files['live-video'][0].url, '/f0.png');
  assert.equal(files['live-video'][8].url, '/f8.png');
});

test('appendFileToTabMap keeps newest when below cap', () => {
  const existing = Array.from({ length: 8 }, (_, i) => ({ url: `/f${i}.png` }));
  const { files, added } = appendFileToTabMap({ 'live-video': existing }, 'live-video', { url: '/new.png' });
  assert.equal(added, true);
  assert.equal(files['live-video'].length, 9);
  assert.equal(files['live-video'][8].url, '/new.png');
});

test('preserved asymmetry: shake setter base is 0 while derived fallback is 35', () => {
  assert.equal(SETTER_BASE.shakeStrength, 0);
  const s = deriveFormState({}, 'live-video', PROMPTS);
  assert.equal(s.shakeStrength, 35);
});
