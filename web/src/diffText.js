// 文本改动对比：行级 diffLines + 字级 diffWordPairs。
//
// 两条降级规则（高亮数超过上限、上下文带句读标点）只负责取消高亮。
// 每个分支都必须把行或字写进结果——少写一条，DiffCell 就会少渲染一段内容。

const SENTENCE_PUNCTUATION = new Set(['，', '。', '？', '！']);

export function hasSentencePunctuation(text) {
  return [...String(text)].some(ch => SENTENCE_PUNCTUATION.has(ch));
}

export function diffWordPairs(a, b) {
  const tokens = [...String(a || '')];
  const words = [...String(b || '')];
  let maxChanges = Math.min(24, Math.floor(tokens.length * 0.45));
  const pairs = [];
  for (let i = 0; i < Math.min(tokens.length, words.length); i++) {
    const oldC = tokens[i];
    const newC = words[i];
    if (oldC === newC) { pairs.push({ type: 'same', old: oldC, new: newC }); continue; }
    if (pairs.some(x => x.type === 'changed' && x.old === oldC && x.new === newC)) { pairs.push({ type: 'same', old: oldC, new: newC }); continue; }
    if (maxChanges <= 0) { pairs.push({ type: 'same', old: oldC, new: newC }); continue; }
    const oldContext = tokens.slice(Math.max(0, i - 1), i + 2).join('');
    const newContext = words.slice(Math.max(0, i - 1), i + 2).join('');
    if (hasSentencePunctuation(oldContext) || hasSentencePunctuation(newContext) || oldC === '\n' || newC === '\n') {
      pairs.push({ type: 'same', old: oldC, new: newC });
      continue;
    }
    pairs.push({ type: 'changed', old: oldC, new: newC });
    maxChanges -= 1;
  }
  return pairs;
}

export function diffLines(oldText, newText) {
  const oldLines = String(oldText || '').split('\n');
  const newLines = String(newText || '').split('\n');
  const maxChanges = Math.min(12, Math.max(4, Math.floor(oldLines.length * 0.35)));
  const rows = [];
  let highlighted = 0;
  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
    const oldLine = oldLines[i] ?? '';
    const newLine = newLines[i] ?? '';
    if (oldLine === newLine) {
      rows.push({ type: 'same', old: oldLine, new: newLine, pairs: null });
      continue;
    }
    const oldContext = oldLines.slice(Math.max(0, i - 1), i + 2).join('');
    const newContext = newLines.slice(Math.max(0, i - 1), i + 2).join('');
    if (highlighted >= maxChanges || hasSentencePunctuation(oldContext) || hasSentencePunctuation(newContext)) {
      rows.push({ type: 'same', old: oldLine, new: newLine, pairs: null });
      continue;
    }
    rows.push({ type: 'changed', old: oldLine, new: newLine, pairs: diffWordPairs(oldLine, newLine) });
    highlighted += 1;
  }
  return rows;
}
