// 页签表单状态的纯逻辑：把 Workspace 里按 active 页签键控的 13 组 useState
// 抽成可单测的纯函数（无 React）。React hook 在 ../useTabFormState.js 薄包装。
//
// 语义必须逐字复刻 App.jsx 原实现，尤其两处不对称，切勿"顺手修"：
// - setter 基值用 || 0（shakeStrength/shakeFrequency 基值 0），而派生回退用 ?? 35/?? 45；
//   显式 0（静止画面）必须能生效，只有从未设置时才用默认值。
// - perReference 默认 true（!== false），且 setter 无函数更新器分支。

export const SETTER_BASE = {
  text: '',
  defaultPrompt: '',
  secondaryPrompt: '',
  files: [],
  canvasSize: '1080x1440',
  outputCount: '1',
  motionEffect: '手持轻晃',
  durationMode: 'fixed',
  customDuration: '3',
  shakeStrength: 0,
  shakeFrequency: 0,
};

// 由 per-tab 映射扁平对象派生当前页签的表单值（复刻 App.jsx 1629–1644）。
export function deriveFormState(byTab, active, prompts) {
  return {
    text: byTab.text?.[active] || '',
    defaultPrompt: byTab.defaultPrompt?.[active] !== undefined ? byTab.defaultPrompt[active] : (prompts[active] || ''),
    secondaryPrompt: byTab.secondaryPrompt?.[active] || '',
    files: byTab.files?.[active] || [],
    canvasSize: byTab.canvasSize?.[active] || '1080x1440',
    outputCount: byTab.outputCount?.[active] || '1',
    perReference: byTab.perReference?.[active] !== false,
    motionEffect: byTab.motionEffect?.[active] || '手持轻晃',
    durationMode: byTab.durationMode?.[active] || 'fixed',
    customDuration: byTab.customDuration?.[active] || '3',
    shakeStrength: byTab.shakeStrength?.[active] ?? 35,
    shakeFrequency: byTab.shakeFrequency?.[active] ?? 45,
  };
}

// 复刻 App.jsx 1645–1651 / 1655–1659 的通用 setter：支持函数更新器，基值回退用 || base。
export function updateTabFieldMap(fieldMap, tab, value, base) {
  const next = typeof value === 'function' ? value(fieldMap?.[tab] || base) : value;
  return { ...(fieldMap || {}), [tab]: next };
}

// 复刻 App.jsx 1652 的 setPerReference：只存具体值，无函数更新器分支。
export function setFieldValue(fieldMap, tab, value) {
  return { ...(fieldMap || {}), [tab]: value };
}

// 复刻 App.jsx 1625 的播种守卫：仅当该页签尚未设置时写入默认提示词。
export function seedDefaultPromptMap(map, tab, prompts) {
  return map[tab] !== undefined ? map : { ...map, [tab]: prompts[tab] || '' };
}

// 复刻 App.jsx 1716–1718 的跨页签文件写入：按 url 去重，上限 9。
export function appendFileToTabMap(filesMap, tab, file) {
  const current = filesMap?.[tab] || [];
  if (current.some((f) => f.url === file.url)) return { files: filesMap, added: false };
  return { files: { ...(filesMap || {}), [tab]: [...current, file].slice(0, 9) }, added: true };
}
