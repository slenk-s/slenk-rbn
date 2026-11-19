import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runJanitor } from '../scripts/media-janitor.mjs';

test('runJanitor 报告孤儿文件与缺失文件，--apply 删除孤儿', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-'));
  try {
    fs.writeFileSync(path.join(dir, 'keep'), 'x');
    fs.writeFileSync(path.join(dir, 'orphan'), 'x');
    fs.writeFileSync(path.join(dir, 'in-progress.tmp'), 'x');
    const dbIds = ['keep'];
    const dry = await runJanitor({ list: async () => dbIds, root: () => dir, apply: false });
    assert.deepEqual(dry.orphanFiles, ['orphan']);
    assert.deepEqual(dry.missingFiles, []);
    assert.equal(dry.removed, 0);
    const wet = await runJanitor({ list: async () => dbIds, root: () => dir, apply: true });
    assert.equal(wet.removed, 1);
    assert.equal(fs.existsSync(path.join(dir, 'orphan')), false);
    assert.equal(fs.existsSync(path.join(dir, 'keep')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runJanitor 报告数据库有而文件缺失的 id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-'));
  try {
    fs.writeFileSync(path.join(dir, 'keep'), 'x');
    const result = await runJanitor({ list: async () => ['keep', 'gone'], root: () => dir, apply: false });
    assert.deepEqual(result.missingFiles, ['gone']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
