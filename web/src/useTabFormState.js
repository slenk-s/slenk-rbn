import { useCallback, useState } from 'react';
import {
  SETTER_BASE,
  appendFileToTabMap,
  deriveFormState,
  seedDefaultPromptMap,
  setFieldValue,
  updateTabFieldMap,
} from './lib/tabFormState.js';

// 页签表单状态 hook：把 Workspace 里按 active 页签键控的 12 组表单状态收进来。
// 纯逻辑在 lib/tabFormState.js，本文件只是薄 React 包装。
//
// 返回派生值 + setter，名字与 App.jsx 原有局部变量完全一致，Workspace 的
// JSX 与 handler 除了播种 effect 和跨页签文件写入外零改动。
//
// 刻意不含 noteDrafts（死代码）与 setNoteDraft；也不在返回里出现 durationMode
// 之外的任何死状态。durationMode/setDurationMode 仍在返回中，但 Workspace
// 不解构它们（它们从未被读取——submitCurrentTask 硬编码 'fixed'）。
export function useTabFormState({ active, prompts }) {
  const [textByTab, setTextByTab] = useState({});
  const [defaultPromptByTab, setDefaultPromptByTab] = useState({});
  const [secondaryPromptByTab, setSecondaryPromptByTab] = useState({});
  const [filesByTab, setFilesByTab] = useState({});
  const [canvasSizeByTab, setCanvasSizeByTab] = useState({});
  const [outputCountByTab, setOutputCountByTab] = useState({});
  const [perReferenceByTab, setPerReferenceByTab] = useState({});
  const [motionEffectByTab, setMotionEffectByTab] = useState({});
  const [durationModeByTab, setDurationModeByTab] = useState({});
  const [customDurationByTab, setCustomDurationByTab] = useState({});
  const [shakeStrengthByTab, setShakeStrengthByTab] = useState({});
  const [shakeFrequencyByTab, setShakeFrequencyByTab] = useState({});

  const byTab = {
    text: textByTab,
    defaultPrompt: defaultPromptByTab,
    secondaryPrompt: secondaryPromptByTab,
    files: filesByTab,
    canvasSize: canvasSizeByTab,
    outputCount: outputCountByTab,
    perReference: perReferenceByTab,
    motionEffect: motionEffectByTab,
    durationMode: durationModeByTab,
    customDuration: customDurationByTab,
    shakeStrength: shakeStrengthByTab,
    shakeFrequency: shakeFrequencyByTab,
  };
  const form = deriveFormState(byTab, active, prompts);

  const setText = useCallback((v) => setTextByTab((prev) => updateTabFieldMap(prev, active, v, SETTER_BASE.text)), [active]);
  const setDefaultPrompt = useCallback((v) => setDefaultPromptByTab((prev) => updateTabFieldMap(prev, active, v, SETTER_BASE.defaultPrompt)), [active]);
  const setSecondaryPrompt = useCallback((v) => setSecondaryPromptByTab((prev) => updateTabFieldMap(prev, active, v, SETTER_BASE.secondaryPrompt)), [active]);
  const setFiles = useCallback((v) => setFilesByTab((prev) => updateTabFieldMap(prev, active, v, SETTER_BASE.files)), [active]);
  const setCanvasSize = useCallback((v) => setCanvasSizeByTab((prev) => updateTabFieldMap(prev, active, v, SETTER_BASE.canvasSize)), [active]);
  const setOutputCount = useCallback((v) => setOutputCountByTab((prev) => updateTabFieldMap(prev, active, v, SETTER_BASE.outputCount)), [active]);
  const setPerReference = useCallback((v) => setPerReferenceByTab((prev) => setFieldValue(prev, active, v)), [active]);
  const setMotionEffect = useCallback((v) => setMotionEffectByTab((prev) => updateTabFieldMap(prev, active, v, SETTER_BASE.motionEffect)), [active]);
  const setDurationMode = useCallback((v) => setDurationModeByTab((prev) => updateTabFieldMap(prev, active, v, SETTER_BASE.durationMode)), [active]);
  const setCustomDuration = useCallback((v) => setCustomDurationByTab((prev) => updateTabFieldMap(prev, active, v, SETTER_BASE.customDuration)), [active]);
  const setShakeStrength = useCallback((v) => setShakeStrengthByTab((prev) => updateTabFieldMap(prev, active, v, SETTER_BASE.shakeStrength)), [active]);
  const setShakeFrequency = useCallback((v) => setShakeFrequencyByTab((prev) => updateTabFieldMap(prev, active, v, SETTER_BASE.shakeFrequency)), [active]);

  // 播种默认提示词：仅当该页签尚未设置时写入（守卫在纯函数里）。prompts 是模块常量，稳定。
  const seedDefaultPrompt = useCallback((tab) => setDefaultPromptByTab((prev) => seedDefaultPromptMap(prev, tab, prompts)), [prompts]);

  // 跨页签文件写入（如把笔记图片追加到 live-video 输入区）。deps [filesByTab]
  // 与 App.jsx 原 sendImageToVideo 的 memo 抖动一致，不回归 MemoNoteRewriteWorkspace。
  const addFileToTab = useCallback((tab, file) => {
    const { added } = appendFileToTabMap(filesByTab, tab, file);
    if (added) setFilesByTab((prev) => appendFileToTabMap(prev, tab, file).files);
    return added;
  }, [filesByTab]);

  return {
    ...form,
    setText,
    setDefaultPrompt,
    setSecondaryPrompt,
    setFiles,
    setCanvasSize,
    setOutputCount,
    setPerReference,
    setMotionEffect,
    setDurationMode,
    setCustomDuration,
    setShakeStrength,
    setShakeFrequency,
    seedDefaultPrompt,
    addFileToTab,
  };
}
