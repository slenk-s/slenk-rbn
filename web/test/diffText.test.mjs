import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, diffWordPairs } from '../src/diffText.js';

test('每行都有输出，渲染内容不会缺行', () => {
  const rows = diffLines('第一行\n第二行\n第三行', '甲\n乙\n丙');
  assert.equal(rows.length, 3);
  assert.equal(rows.map(r => r.new).join('\n'), '甲\n乙\n丙');
});

test('多行差异可以各自高亮', () => {
  const oldText = ['第一行', '第二行', '第三行', '第四行', '第五行', '第六行'].join('\n');
  const newText = ['甲行', '乙行', '丙行', '丁行', '戊行', '己行'].join('\n');
  const rows = diffLines(oldText, newText);
  assert.equal(rows.length, 6);
  // maxChanges = Math.min(12, Math.max(4, 6 * 0.35)) = 4
  assert.equal(rows.filter(r => r.type === 'changed').length, 4);
  assert.ok(rows.every(r => r.pairs === null || Array.isArray(r.pairs)));
});

test('上下文带标点时不高亮，但行内容仍然输出', () => {
  const rows = diffLines('你好，世界\n第二行', '你好，地带\n第二行');
  assert.equal(rows[0].type, 'same');
  assert.equal(rows[0].new, '你好，地带');
});

test('新增与删除的行都不会丢', () => {
  assert.equal(diffLines('a', 'a\nb\nc').map(r => r.new).join('\n'), 'a\nb\nc');
  assert.equal(diffLines('a\nb\nc', 'a').length, 3);
});

test('字级对比不丢字，标点上下文只取消高亮', () => {
  const pairs = diffWordPairs('你好，世界', '你好，地带');
  assert.equal(pairs.length, 5);
  assert.equal(pairs.map(p => p.new).join(''), '你好，地带');
  assert.deepEqual(pairs.map(p => p.type), ['same', 'same', 'same', 'same', 'changed']);
});

test('相同文本全部标记为 same', () => {
  assert.deepEqual(diffLines('a\nb', 'a\nb').map(r => r.type), ['same', 'same']);
  assert.deepEqual(diffWordPairs('同一段', '同一段').map(p => p.type), ['same', 'same', 'same']);
});
