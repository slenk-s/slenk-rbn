import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { diffLines } from './diffText.js';
import { fetchWithTimeout } from './fetchWithTimeout.js';
import { RedappAuthCard, RedappAuthModal } from './RedappAuth.jsx';
import {
  MINITOOL_PUBLISH_DEADLINE_MS,
  MINITOOL_PUBLISH_REQUEST_DEADLINE_MS,
  canCommitPublishFlow,
  createPublishContinuation,
  createPublishFlow,
  createPublishRequestSnapshot,
  createRedappAuthClient,
  createRedappFetchAdapter,
  interpretCancelResponse,
  mergeDisplayedAuth,
  pollMiniToolPublishJob,
  recoverInitialPublish,
  shouldRecoverAttemptAfterCancel,
  publishAuthTerminal,
  publishWithAuth,
  readApiError
} from './redappAuthFlow.js';
import './App.css';

const API = import.meta.env.VITE_API_URL || window.location.origin;
const GROUPS = [
  { id: 'ai', label: 'AI 生成', icon: '✦', tabs: [
    { id: 'ai-image', label: 'AI 生图', icon: '▧', description: '从零生成适合小红书笔记封面的原创图片。' },
    { id: 'replace-image', label: '替换生图', icon: '✦', description: '基于上传的参考图生成替换版本，适合做小红书笔记封面。' },
    { id: 'live-video', label: '实况视频', icon: '▶', description: '用本地 FFmpeg 把素材处理成带轻微运镜的实况视频。' }
  ] },
  { id: 'copy', label: '文案处理', icon: '✎', tabs: [
    { id: 'note-rewrite', label: '笔记改写', icon: '✎', description: '把笔记内容改写成更适合小红书发布的版本。' }
  ] },

  { id: 'download', label: '素材下载', icon: '↓', tabs: [
    { id: 'note-download', label: '商品下载', icon: '↓', description: '粘贴小红书商品链接，获取商品图片。' }
  ] }
];
const TABS = [{ id: 'dashboard', label: '仪表盘', icon: '◈', section: '设置' }, ...GROUPS.flatMap(g => g.tabs.map(t => ({ ...t, section: g.label })))];
const TYPE_TO_TAB = { rewrite: 'note-rewrite', image: 'replace-image', video: 'live-video' };
const TAB_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_TAB).map(([type, tab]) => [tab, type]));
const TEXT_TABS = new Set(['note-rewrite']);
const IMAGE_TABS = new Set(['replace-image', 'ai-image', 'layout-tool']);
// 只有这两个页签的文本输入区有「二级提示词」，提交时按 默认+二级+用户 三层拼接。
const SECONDARY_PROMPT_TABS = new Set(['replace-image', 'ai-image']);
const IMAGE_HEAVY_TABS = new Set(['multiply', 'layout-tool']);
const VIDEO_TABS = new Set(['live-video']);
const FILE_TABS = new Set(['note-download']);
const SECTION_HINTS = {
  'ai-image':   { options: '选择画布比例和输出数量。', text: '描述你想要的图片风格、主题和构图。', upload: '可选上传参考图，AI 会参考其风格生成。', result: '生成结果支持一键下载。' },
  'replace-image': { options: '选择画布比例、输出数量和生成方式。', text: '描述替换方向：主体、背景、风格等。', upload: '上传原始参考图片，多张时按图号一一对应生成替换版。', result: '替换版图片可下载对比。' },
  'live-video':   { options: '选择画布比例和运镜效果。运动强度影响所有运镜的幅度（0 为静止），抖动频率仅作用于手持轻晃。', text: '描述想要的镜头运动方式和节奏。', upload: '上传图片素材，支持 PNG/JPG/WebP。', result: '生成的运镜视频可直接下载。' },
  'note-rewrite': { options: '选择输出画布，方便后续配图。', text: '粘贴原始笔记正文，AI 将改写成更适合小红书的版本。', upload: '可选上传配图素材。', result: '改写结果含正文、标题和标签。' },
  'multiply':     { options: '选择合成画布比例。', text: '描述叠加关系，如"底图+纹理+色块"。', upload: '上传多张素材，按顺序叠加。', result: '合成结果可下载为图片。' },
  'layout-tool':  { options: '选择目标画布尺寸。', text: '描述标题、正文、商品图、贴纸的布局。', upload: '上传需要排版的图片素材。', result: '排版规划结果可下载参考。' },
  'note-download':{ options: '选择整理画布比例。', text: '粘贴小红书商品链接。', upload: '上传商品相关图片。', result: '商品图片可下载。' },
};
const PROMPTS = {
  'replace-image': '请基于上传图片生成一张可用于小红书笔记封面的替换版图片，成片要像真实用户用手机随手拍的照片，而不是精修广告图。\n保持原图主体构图和比例，替换画面中的主体/背景/商品细节，使其更符合真实生活场景。\n要求：自然光线、质感真实，允许轻微噪点、色差和不完美的小细节；避免影棚布光、塑料质感、过度磨皮、过分对称的摆拍感。\n不要加入无关文字，不要改变输出画幅。',
  'ai-image': '请生成一张适合小红书笔记使用的原创图片，整体是手机实拍的生活记录感，不要商业精修图。\n要求：自然光线、真实生活场景、主体明确、构图随意但舒服，允许轻微噪点、色差和不完美细节。\n避免影棚布光、塑料质感、过度磨皮和过分完美的摆拍感。\n不要加入文字，不要水印，不要乱码。',
  'live-video': '请基于上传素材生成一段自然、克制的算法运镜视频。\n镜头运动保持轻微推拉和呼吸感，适合做小红书实况封面或笔记动态预览。\n要求：不要夸张抖动，不要裁切主体，保持画面稳定。',
  'note-rewrite': '请把输入笔记改写成更自然、更适合小红书发布的版本。\n保持原意，增强画面感、真实感和代入感，不要夸大，不要营销腔过重。\n输出要求：一段正文 + 3 个可选标题 + 8 个相关标签。',
  'multiply': '请描述你希望叠加的图片关系。\n工具用途：把多张素材按正片叠底思路整理，适合做纹理、色块、氛围层。',
  'layout-tool': '请描述你要排版的标题、正文、商品图和贴纸位置。\n工具用途：先按固定画布规划封面/内页版式，再交给后续生图或编辑。',
  'note-download': '请粘贴小红书商品链接。\n工具用途：获取商品主图，整理为可下载的商品图片素材。'
};
const NOTE_PROMPT_STORAGE_KEY = 'slenk-notes-note-prompts-v5';
const NOTE_PROMPT_FIELDS = [
  { key: 'title', label: '标题提示词', hint: '用于生成标题候选，支持 JSON 或编号列表。' },
  { key: 'content', label: '正文提示词', hint: '用于改写正文，要求适合小红书发布。' },
  { key: 'tags', label: '话题标签提示词', hint: '用于提取话题标签，支持 JSON 或 # 标签列表。' },
  { key: 'imageReplace', label: '默认提示词', hint: '图片未填专属提示词时使用，生成时附带标题/正文作主题上下文（不会画进图里）；填了专属提示词则完全以专属提示词为准。' },
];
const AI_DIFF_FIELDS = {
  title: { label: '标题' },
  content: { label: '正文' },
  tags: { label: '话题标签' },
};
const DEFAULT_NOTE_PROMPTS = {
  title: `你是一位擅长小红书爆款标题拆解的资深内容策划。你熟悉小红书搜索、推荐和用户点击心理，能把普通笔记信息改写成让人愿意点开的具体标题。
请先理解输入内容，再围绕以下爆款标题变量输出 5 个候选标题：
1. 具体数字：例如 3 步、7 天、5 件、2 个细节；没有明确数字时不要硬编。
2. 明确人群：锁定输入中的人群、职业、年龄、肤质、场景或身份。
3. 真实场景：优先写使用场景、生活问题或选择困难，不要泛泛写“好物推荐”。
4. 结果导向：写清楚读者能得到的结果、变化或体验，但不要夸大事实。
5. 情绪钩子：可用亲切、惊讶、轻松、治愈等情绪，但不要夸张诱导。
硬性要求：
- 每个标题 10-22 个中文字符，适合移动端首屏阅读。
- 标题必须贴合笔记真实内容，不编造价格、销量、认证、案例或功效。
- 避免“绝了”“封神”“天花板”“必入”“王炸”“全网最低”等高风险词。
- 避免“私信”“加微信”“二维码”“领取资料”等引流违规表达。
- 5 个标题分别使用不同切入角度，避免只换词不换意思。
- 可自然使用 1 个 emoji，但不堆砌。
- 避免模板化标题套路（如"我不允许还有人不知道""家人们谁懂啊"），像真人随手起的口语标题。
不要解释，不要输出 JSON，直接按以下样式输出：
1. 标题
2. 标题
3. 标题
4. 标题
5. 标题`,
  content: `你是一位小红书真实种草文案写手，擅长把零散信息改写成有人味、有细节、有体感的中文正文。
你的写作逻辑是“先抓人，再讲清，最后互动”：
1. 钩子开头：从用户痛点、真实场景或具体使用瞬间切入，前两句就让用户觉得“这和我有关”。
2. 内容主体：用第一人称快速分享核心体验和关键细节，不铺陈背景，不写长段说明。
3. 互动结尾：用一个自然的开放式问题收束，不要写“欢迎评论区告诉我”这类硬引导。
写作要求：
- 语气像真实用户分享，少说明书腔，少广告腔，多用具体动作、细节和结果。
- 避免"首先/其次/再者/最后/总而言之"这类结构化连接词，避免排比句和总分总作文腔；允许短句、碎句和口语化的跳跃表达，像真人随手记录。
- 把抽象形容词改成可感知描述，例如把“很好用”改写成具体时间、动作或变化。
- 保持事实准确，不编造数据、销量、认证、价格、案例、身份和功效。
- 每段 1-2 句，正文控制在 100-200 个中文字符，适合小红书短平快阅读。
- 可少量使用 emoji 增强节奏，但不要为了装饰而使用。
- 避免“绝了”“封神”“天花板”“必入”“王炸”“全网最低”等夸张词。
- 避免“私信”“加微信”“二维码”“领取资料”等引流违规表达。
- 不输出标题，不输出标签，不解释写作过程。
直接输出可发布的正文。`,
  tags: `你是一位小红书搜索词和话题标签策划。请根据笔记标题、正文、商品/主题、目标人群、场景和搜索意图，提取一组高相关性话题标签。
提取逻辑：
1. 核心主题词：用户搜索时最可能直接使用的词。
2. 场景词：例如通勤、宿舍、旅行、送礼、加班、露营等真实使用场景。
3. 人群词：例如学生党、上班族、敏感肌、新手妈妈、租房族等具体人群。
4. 细分品类词：更贴近商品、内容类型或问题解决方式。
5. 结果词：例如平价、懒人友好、收纳、提升幸福感等，但不要夸大功效。
要求：
- 输出 8-12 个标签，按相关性从高到低排序。
- 每行一个标签，标签正文 2-12 个中文字符；不要空格、emoji、标点或解释文字。
- 避免“绝了”“封神”“天花板”“必入”“王炸”“全网最低”等夸张词。
- 避免“私信”“加微信”“二维码”“领取资料”等引流违规表达。
- 不要重复语义相近的标签。
不要输出 JSON，不要解释，直接按以下样式输出：
#标签1
#标签2
#标签3`,
  // 与「替换生图」工作区共用同一条默认值，保持两处行为一致
  imageReplace: PROMPTS['replace-image'],
};
const MOTION_EFFECTS = [
  { value: '手持轻晃', label: '手持轻晃' },
  { value: '缓慢推近', label: '缓慢推近' },
  { value: '缓慢拉远', label: '缓慢拉远' },
  { value: '轻微环绕', label: '轻微环绕' }
];
const FIXED_CANVAS = [
  { label: '不固定画布（模型自定）', value: '' },
  { label: '1080×1080 · 1:1', value: '1080x1080' },
  { label: '1080×1440 · 3:4', value: '1080x1440' },
  { label: '1920×1080 · 16:9', value: '1920x1080' }
];
const UPLOAD_ACCEPT = {
  image: 'image/png,image/jpeg,image/webp',
  video: 'video/mp4,video/quicktime,video/webm',
  all: 'image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm,.docx,.txt,.md'
};
const EMPTY_PROVIDER = { name: '', providerType: 'openai-compatible', appType: 'openai', baseUrl: '', apiKey: '', textModel: 'gpt-4o-mini', imageModel: 'gpt-image-1', imageApi: 'json', notes: '', active: false };

async function readJsonResponse(r) {
  const text = await r.text();
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed[0] === '{' || trimmed[0] === '[') return JSON.parse(trimmed);
  const contentType = r.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) throw new Error('接口返回的不是 JSON：' + (r.status + ' ' + r.url));
  throw new Error('JSON 解析失败：接口返回内容不是合法 JSON');
}

function api(path, options = {}) {
  return fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}`} : {}) },
    ...options
  }).then(async r => {
    const data = await readJsonResponse(r);
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  });
}
const MODEL_EMPTY = '__none__';
function modelOptionsFor(mode, providers) {
  const list = Array.isArray(providers) ? providers : [];
  const options = [];
  for (const p of list) {
    const model = mode === 'text' ? (p.textModel || '') : (p.imageModel || '');
    if (!model) continue;
    // 带上供应商名：多个供应商配置同一模型时（如两个 sensenova-u1.5-lite）才能区分走哪家的 key。
    options.push({ value: p.id + '::' + model, label: p.name + ' · ' + model });
  }
  return options;
}
function splitModelValue(value) {
  const raw = String(value || '');
  const idx = raw.indexOf('::');
  if (idx < 0) return { providerId: '', model: raw };
  return { providerId: raw.slice(0, idx), model: raw.slice(idx + 2) };
}
function selectedModelValue(mode, providers, activeProviderId) {
  const list = Array.isArray(providers) ? providers : [];
  const active = list.find(p => p.id === activeProviderId) || null;
  if (!active) return '';
  const model = mode === 'text' ? (active.textModel || '') : (active.imageModel || '');
  return active.id + '::' + model;
}
function resolveImageSrc(img) {
    const item = img && typeof img === 'object' ? img : { url: img };
    const cachedUrl = String(item.cachedUrl || '');
    if (cachedUrl) return API + cachedUrl;
    const u = String(item.url || '');
    if (!u) return '';
    if (/^https?:\/\//.test(u)) {
      if (/xhscdn\.com|xiaohongshu\.com/.test(u)) return API + '/api/download?inline=1&url=' + encodeURIComponent(u);
      return u;
    }
    return API + u;
  }
async function downloadFile(url, name, kind) {
    try {
      const token = localStorage.getItem('token');
      const item = url && typeof url === 'object' ? url : { url };
      const sourceUrl = String(item.cachedUrl || item.url || '');
      const target = sourceUrl.startsWith('/') ? API + sourceUrl : sourceUrl;
    const resp = await fetch(API + '/api/download?url=' + encodeURIComponent(target) + '&name=' + encodeURIComponent(name || 'file'), { headers: { Authorization: 'Bearer ' + token } });
    if (!resp.ok) throw new Error('下载失败');
    const blob = await resp.blob();
    const mime = blob.type || '';
    // 用户要求：图片统一补 .png，视频统一补 .mp4。
    const isVideo = kind === 'video' || (kind == null && mime.includes('mp4'));
    let finalName = name || 'file';
    if (!/\.[a-z0-9]{2,5}$/i.test(finalName)) finalName += isVideo ? '.mp4' : '.png';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = finalName;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { alert(e.message); }
}
function removeTopicTagMarkup(value) {
  return String(value || "")
    .replace(/#([^#\n]{1,40})\[话题\]#/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function unwrapTaskResult(result) {
  if (result && typeof result === 'object' && typeof result.text === 'string' && result.text.trim()) {
    return parseJsonText(result.text);
  }
  return result;
}

function parseJsonText(raw) {
  if (!raw) return null;
  // jsonb 列读出来已经是对象，旧的 JSON 文件存储里是字符串，两种形态都要能解析。
  if (typeof raw === 'object') return raw;
  // LLM 常把 JSON 包在 ```json 代码块里，先剥离再解析，否则标题/标签提取不到。
  const stripped = String(raw).trim().replace(/^```(?:json)?s*/i, '').replace(/```s*$/, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    return parsed && typeof parsed === 'object' ? parsed : { text: String(raw) };
  } catch { return { text: String(raw) }; }
}
// 任务状态文案：发布任务有等待扫码/填充中/待确认等自定义状态，统一在这里翻译。
function statusLabel(s) {
  return { done: '已完成', failed: '失败', queued: '排队中', filling: '填充中', waiting_login: '等待扫码', waiting_confirm: '存草稿中', cancelled: '已取消' }[s] || '处理中';
}
// 任务结果可能是云端公网 URL（Supabase Storage）或本地 /videos 路径，两种都要能展示。
function resultMediaSrc(url) {
  const u = String(url || '');
  return /^https?:\/\//i.test(u) ? u : API + u;
}
// 统一下载：fetch 成 blob 再落地，这样 /api 接口能带鉴权头，
// 跨域的云端 URL 也能真正存成文件（<a download> 对跨域地址会被浏览器忽略）。
async function downloadAsset(url, name) {
  const absolute = String(url || '').startsWith('http') ? String(url) : API + url;
  const headers = absolute.startsWith(API) ? { Authorization: 'Bearer ' + localStorage.getItem('token') } : {};
  const resp = await fetch(absolute, { headers });
  if (!resp.ok) throw new Error('下载失败（HTTP ' + resp.status + '）');
  const blob = await resp.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name || 'download';
  a.click();
  URL.revokeObjectURL(a.href);
}
function DownloadLink({ url, label, name }) {
  return <button type="button" onClick={async (e) => { e.stopPropagation(); try { await downloadAsset(url, name); } catch { window.open(String(url || '').startsWith('http') ? url : API + url, '_blank'); } }}>{label}</button>;
}
// 任务结果整体下载：图片/视频直接拉 blob（多图逐张下），文本存成 txt。
async function downloadTaskResult(task) {
  const result = unwrapTaskResult(parseJsonText(task.result || '')) || {};
  const mediaUrls = Array.isArray(result.videos) && result.videos.length ? result.videos
    : Array.isArray(result.images) && result.images.length ? result.images
    : [result.image, result.video].filter(Boolean);
  if (mediaUrls.length) {
    const isVideo = Boolean(result.video) || (Array.isArray(result.videos) && result.videos.length > 0);
    for (let i = 0; i < mediaUrls.length; i++) {
      await downloadAsset(mediaUrls[i], task.id + '-' + task.type + (mediaUrls.length > 1 ? '-' + (i + 1) : '') + (isVideo ? '.mp4' : '.png'));
    }
    return;
  }
  const text = result.text || (Array.isArray(result.titles) ? result.titles.join('\n') : '') || '';
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = task.id + '-' + task.type + '.txt';
  a.click();
  URL.revokeObjectURL(a.href);
}
// 主题化下拉：原生 <select> 的弹层由系统渲染没法美化，换成自绘组件。
// 点外部/Esc 收起，选中项高亮，样式跟工具条融合。
function ThemedSelect({ value, onChange, options, ariaLabel, className }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const current = (options || []).find(o => o.value === value);
  return (
    <div className={'themed-select' + (className ? ' ' + className : '') + (open ? ' open' : '')} ref={ref}>
      <button type="button" className="themed-select-trigger" aria-label={ariaLabel} aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <span className="themed-select-value">{current ? current.label : '未选择'}</span>
        <span className="themed-select-chevron">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="themed-select-pop" role="listbox">
          {(options || []).map(o => (
            <button type="button" role="option" aria-selected={o.value === value} key={String(o.value)} className={'themed-select-option' + (o.value === value ? ' active' : '')} onClick={() => { onChange(o.value); setOpen(false); }}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
// 带兜底链的图片：sources 依次尝试，全部失败后再带时间戳重试第一个源，仍失败显示占位。
// 解决两类裂图：Supabase 云端 URL 网络抖动（回退本地副本）、本地缓存被清理（回退远端/代理）。
function SmartImg({ sources, alt, className, onClick, draggable, onDragStart, onDragEnd }) {
  const list = (Array.isArray(sources) ? sources : [sources]).filter(Boolean);
  const key = list.join('|');
  const [state, setState] = useState({ key, i: 0, loaded: false });
  if (state.key !== key) setState({ key, i: 0, loaded: false });
  const i = state.key === key ? state.i : 0;
  const loaded = state.key === key && state.loaded;
  if (!list.length || i > list.length) return <div className={'img-broken ' + (className || '')}>图片加载失败</div>;
  const src = i < list.length ? list[i] : list[0] + (list[0].includes('?') ? '&' : '?') + 'r=' + key.length + i;
  // 加载中显示微光骨架屏，避免大图加载期间一片空白；完成后淡入。
  return <img src={src} alt={loaded ? (alt || '') : ''} className={(className || '') + (loaded ? ' smart-img-loaded' : ' smart-img-loading')} onClick={onClick} draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd} onLoad={() => setState({ key, i, loaded: true })} onError={() => setState({ key, i: i + 1, loaded: false })} />;
}
// 远端图片经本地服务端代理转发：浏览器直连境外 CDN 会被本机网络断连（实测 ERR_CONNECTION_CLOSED），
// 而服务端 fetch 正常（curl 同源验证过），代理一层后展示稳定。
function proxiedInline(url) { return API + '/api/download?inline=1&url=' + encodeURIComponent(url); }
// 结果图三来源：本地副本（最快）→ 代理云端（最稳）→ 直连云端（最后兜底）。
function resultImageSources(cloudUrl, localPath) {
  return [localPath ? API + localPath : null, cloudUrl ? proxiedInline(cloudUrl) : null, cloudUrl || null];
}
// 笔记图片的来源链：本地缓存优先，云端走代理，直连兜底。
function noteImageSources(img) {
  const out = [];
  if (img && img.cachedUrl) out.push(API + img.cachedUrl);
  const u = String(img && img.url || '');
  if (u) {
    if (/^https?:\/\//.test(u)) { out.push(proxiedInline(u)); out.push(u); }
    else out.push(API + u);
  }
  return out;
}
function TaskResultWithDownload({ task, onZoom, hideDownloads }) {
  const result = unwrapTaskResult(parseJsonText(task.result || ''));
  if (!result) return <p className="muted">{task.status === 'failed' ? parseJsonText(task.error).error : '任务还没有结果内容。'}</p>;
  const resultDownload = hideDownloads ? null : <DownloadLink url={'/api/tasks/' + task.id + '/download?format=text&name=' + task.id + '-' + task.type + '.txt'} label="下载 TXT" />;
  // 发布任务的结果不是媒体，是流程状态 + 摘要。
  if (task.type === 'publish') {
    const outcomeText = result.outcomeText || '';
    return <div className="task-result-preview">
      {result.stageMessage && <div className="task-result-block"><span>当前阶段</span><strong>{result.stageMessage}</strong></div>}
      {outcomeText && <div className="task-result-block"><span>发布结果</span><strong>{outcomeText}</strong></div>}
      {result.title && <div className="task-result-block"><span>标题</span><strong>{result.title}{result.titleTruncated ? '（超过 20 字，已截断）' : ''}</strong></div>}
      {!!result.imageCount && <div className="task-result-block"><span>图片</span><p>{result.imageCount} 张已上传到发布页</p></div>}
    </div>;
  }
  if (result.text) return <><p className="result-text">{result.text}</p>{resultDownload && <div className="result-actions">{resultDownload}</div>}</>;
  // 结果图三来源：本地副本 → 服务端代理云端 → 直连云端（网络抖动逐级兜底）。
  const localImages = Array.isArray(result.localImages) ? result.localImages : [];
  if (result.images && Array.isArray(result.images)) return <div className="result-gallery">{result.images.map((img, i) => <figure key={i} className="result-media"><SmartImg className="zoomable" sources={/^https?:\/\//.test(String(img)) ? resultImageSources(img, localImages[i]) : [API + img]} alt={'AI图片结果 ' + (i + 1)} onClick={() => onZoom && onZoom(resultMediaSrc(img), (task.label || 'AI图片结果') + ' · 第 ' + (i + 1) + ' 张')} />{(result.images.length > 1 || !hideDownloads) && <figcaption>{result.images.length > 1 ? <span className="result-ref-label">{result.perReference ? '对应参考图 ' + ((result.imageReferences && result.imageReferences[i]) || (i + 1)) : '结果 ' + (i + 1)}</span> : null}{!hideDownloads && <DownloadLink url={img} label="下载图片" name={task.id + '-' + task.type + '-' + (i + 1) + '.png'} />}</figcaption>}</figure>)}</div>;
  if (result.image && typeof result.image === 'string') return <figure className="result-media"><SmartImg className="zoomable" sources={/^https?:\/\//.test(String(result.image)) ? resultImageSources(result.image, result.localImage) : [API + result.image]} alt="AI图片结果" onClick={() => onZoom && onZoom(resultMediaSrc(result.image), task.label || 'AI图片结果')} />{!hideDownloads && <figcaption><DownloadLink url={result.image} label="下载图片" name={task.id + '-' + task.type + '.png'} /></figcaption>}</figure>;
  if (result.videos && Array.isArray(result.videos) && result.videos.length) return <div className="result-gallery">{result.videos.map((v, i) => <figure key={i} className="result-media"><video controls preload="metadata" src={resultMediaSrc(v)} /><figcaption>{result.videos.length > 1 ? <span className="result-ref-label">视频 {i + 1}</span> : null}{!hideDownloads && <DownloadLink url={v} label="下载视频" name={task.id + '-' + task.type + '-' + (i + 1) + '.mp4'} />}</figcaption></figure>)}</div>;
  if (result.video) return <figure className="result-media"><video controls preload="metadata" src={resultMediaSrc(result.video)} />{!hideDownloads && <figcaption><DownloadLink url={result.video} label="下载视频" name={task.id + '-' + task.type + '.mp4'} /></figcaption>}</figure>;
  const titleCandidates = Array.isArray(result.titles) ? result.titles.map(String) : [];
  const displayTitle = titleCandidates[0] || result.title || '';
  const displayContent = removeTopicTagMarkup(result.text || result.content || '');
  const displayTags = (Array.isArray(result.tags) ? result.tags : []).map(t => String(t).replace(/^#/, ''));
  if (titleCandidates.length || displayTitle || displayContent || displayTags.length) {
    return <div className="task-result-preview">
      {titleCandidates.length > 0 && <div className="task-result-block task-result-titles"><span>标题候选</span><ol>{titleCandidates.map((item, i) => <li key={i}>{item}</li>)}</ol></div>}
      {displayTitle && !titleCandidates.length && <div className="task-result-block"><span>标题</span><strong>{displayTitle}</strong></div>}
      {displayContent && <div className="task-result-block"><span>正文</span><p>{displayContent}</p></div>}
      {displayTags.length > 0 && <div className="task-result-block"><span>话题标签</span><div className="result-tag-list">{displayTags.map((tag, i) => <span key={i}>{'#' + tag}</span>)}</div></div>}
      <div className="result-actions">{resultDownload}</div>
    </div>;
  }
  return <pre>{JSON.stringify(result, null, 2)}</pre>;
}
function ResultEmptyState({ tabId }) {
  const hints = { 'ai-image': '🎨 提交后，生成的图片将显示在此区域，支持一键下载。', 'replace-image': '🖼️ 替换版图片将在此展示，可下载与原图对比。', 'live-video': '🎬 运镜视频将在此播放，支持预览和下载。', 'note-rewrite': '📝 改写结果将包含正文、标题和标签，可下载保存。', 'multiply': '◐ 合成结果图片将在此展示，支持下载。', 'layout-tool': '▦ 排版规划结果将在此展示，可作为设计参考。', 'note-download': '📦 整理好的素材包将在此展示，可打包下载。' };
  return <div className="result-empty-state"><div className="result-empty-icon">{hints[tabId]?.split(' ')[0]}</div><p>{hints[tabId] || '暂无结果。提交任务后会显示在这里。'}</p></div>;
}
function ProviderManager({ token, activeProviderId, activeTextProviderId, activeImageProviderId, providers, onProviderChange, setMessage }) {
  const [form, setForm] = useState(EMPTY_PROVIDER);
  const [editingId, setEditingId] = useState('');
  const [availableModels, setAvailableModels] = useState([]);
  function resetForm() { setEditingId(''); setForm(EMPTY_PROVIDER); }
  function clearForm() { setEditingId(''); setForm({ ...EMPTY_PROVIDER, name: '', baseUrl: '', apiKey: '', textModel: '', imageModel: '', notes: '' }); setAvailableModels([]); }
  async function fetchModels() {
    try {
      setMessage('正在获取模型列表...');
      const payload = editingId ? { providerId: editingId } : { baseUrl: form.baseUrl, apiKey: form.apiKey };
      if (!editingId && (!payload.baseUrl || !payload.apiKey)) { setMessage('请先填写 API 请求地址和 API Key，再获取模型。'); return; }
      const data = await api('/api/providers/_models', { method: 'POST', token, body: JSON.stringify(payload) });
      const models = data.models || [];
      setAvailableModels(models);
      setMessage('已获取 ' + models.length + ' 个模型。');
    } catch (err) { setMessage('获取模型失败：' + err.message); }
  }
  async function saveProvider(e) {
    e.preventDefault(); setMessage('正在保存供应商...');
    try {
      const endpoint = editingId ? '/api/providers/' + editingId : '/api/providers';
      const method = editingId ? 'PUT' : 'POST';
      const data = await api(endpoint, { method, token, body: JSON.stringify(form) });
      await onProviderChange(data.providers, data.activeProviderId, data.activeTextProviderId, data.activeImageProviderId);
      setMessage(editingId ? '供应商已更新。' : '供应商已添加。'); resetForm();
    } catch (err) { setMessage(err.message); }
  }
  function editProvider(provider) { setEditingId(provider.id); setForm({ name: provider.name, providerType: provider.providerType, appType: provider.appType, baseUrl: provider.baseUrl, apiKey: '', textModel: provider.textModel, imageModel: provider.imageModel || '', imageApi: provider.imageApi || 'json', notes: provider.notes || '', active: Boolean(provider.active) }); setAvailableModels([provider.appType === 'text' ? provider.textModel : provider.imageModel].filter(Boolean)); }
  function copyProvider(provider) { const base = provider.name || '供应商'; let index = 1; let name = base + '-' + index; while (providers.some(p => p.name === name)) { index += 1; name = base + '-' + index; } setForm({ name, providerType: provider.providerType, appType: provider.appType, baseUrl: provider.baseUrl, apiKey: '', textModel: provider.textModel, imageModel: provider.imageModel || '', imageApi: provider.imageApi || 'json', notes: provider.notes || '', active: false }); setEditingId(provider.id); }
  async function refreshProviders(messageText) { const next = await api('/api/providers', { token }); await onProviderChange(next.providers, next.activeProviderId, next.activeTextProviderId, next.activeImageProviderId); setMessage(messageText || '已切换供应商'); }
  async function activateProvider(provider) { await api('/api/providers/' + provider.id + '/active', { method: 'POST', token, body: JSON.stringify({ mode: provider.appType === 'text' ? 'text' : 'image' }) }); await refreshProviders('已切换供应商。'); }
  async function duplicateProvider() {
    if (!editingId) return;
    try {
      setMessage('正在复制供应商...');
      const created = await api('/api/providers/' + editingId + '/duplicate', { method: 'POST', token });
      await onProviderChange(created.providers, created.activeProviderId, created.activeTextProviderId, created.activeImageProviderId);
      setMessage('供应商已复制新增。');
      const next = created.providers.find(p => p.id === created.provider?.id);
      if (next) { setEditingId(next.id); setForm({ name: next.name, providerType: next.providerType, appType: next.appType, baseUrl: next.baseUrl, apiKey: '', textModel: next.textModel, imageModel: next.imageModel || '', imageApi: next.imageApi || 'json', notes: next.notes || '', active: false }); }
    } catch (err) { setMessage(err.message); }
  }
  const activeProvider = providers.find(p => p.id === activeProviderId);
  const activeTextProvider = providers.find(p => p.id === activeTextProviderId);
  const activeImageProvider = providers.find(p => p.id === activeImageProviderId);
  return (
    <section className="card provider-manager">
      <div className="section-head"><div><h3>AI 供应商</h3><p>新增/编辑供应商，切换当前启用的 AI 后端。</p></div><span className="pill">{activeProvider?.name || 'admin'}</span></div>
      <div className="provider-layout">
        <form className="form-block" onSubmit={saveProvider}>
          <label className="field"><b>名称</b><input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="admin" required /></label>
          <div className="mode-group"><b>模式</b><div className="mode-options">
            <label className={"mode-opt" + (form.appType === 'openai' ? ' active' : '')}><input type="radio" name="appType" checked={form.appType === 'openai'} onChange={() => setForm({ ...form, appType: 'openai', providerType: 'openai-compatible' })} /><span className="mode-icon">🎨</span><span className="mode-text">生图</span></label>
            <label className={"mode-opt" + (form.appType === 'text' ? ' active' : '')}><input type="radio" name="appType" checked={form.appType === 'text'} onChange={() => setForm({ ...form, appType: 'text', providerType: 'openai-compatible' })} /><span className="mode-icon">✍️</span><span className="mode-text">文本</span></label>
          </div></div>
          <label className="field"><b>API Key</b><input type="password" value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} placeholder={editingId ? '留空则保持不变' : '填写密钥'} /></label>
          <label className="field"><b>API 请求地址</b><input type="text" value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.sensenova.cn/v1" /></label>
          <div className="model-row"><b>默认模型</b><div className="model-wrap"><select value={form.appType === 'text' ? form.textModel : form.imageModel} onChange={e => setForm(form.appType === 'text' ? { ...form, textModel: e.target.value } : { ...form, imageModel: e.target.value })}><option value="">未选择</option>{availableModels.map(m => <option key={m} value={m}>{m}</option>)}</select></div></div>
          {form.appType !== 'text' && (
            <div className="model-row"><b>生图接口</b><div className="model-wrap"><select value={form.imageApi} onChange={e => setForm({ ...form, imageApi: e.target.value })}><option value="json">OpenAI JSON 兼容（默认）</option><option value="form">GPT-image 中转站（multipart 编辑）</option></select></div></div>
          )}
          <div className="actions-row"><button type="button" className="btn-secondary" onClick={clearForm}>{editingId ? '取消编辑' : '清空'}</button><button type="button" className="btn-ghost" onClick={fetchModels}>获取模型</button></div>
          <div className={editingId ? 'actions-row actions-row-bottom actions-row-edit' : 'actions-row actions-row-bottom'}><button type="submit" className="btn-primary">{editingId ? '保存修改' : '创建'}</button>{editingId && <button type="button" className="btn-ghost" onClick={duplicateProvider}>复制新增</button>}</div>
        </form>
        <div className="provider-list-block"><div className="list-head"><h3>供应商列表</h3><span className="count">{providers.length} 个</span></div><ul className="providers">{providers.map(p => <li key={p.id} className={p.id === activeProviderId ? 'active' : ''}><div className="p-name"><b>{p.name}</b><span className={"mode-tag" + (p.appType === 'text' ? '' : ' image')}>{p.appType === 'text' ? '文本' : '生图'}</span>{p.imageApi === 'form' && <span className="mode-tag relay">中转</span>}</div><div className="row-btns"><button type="button" onClick={() => editProvider(p)}>编辑</button><button type="button" className="danger" onClick={async () => { await api('/api/providers/' + p.id, { method: 'DELETE', token }); await refreshProviders('供应商已删除。'); }}>删除</button><button type="button" className={(p.appType === 'text' ? p.id === activeTextProviderId : p.id === activeImageProviderId) ? 'active' : ''} onClick={() => activateProvider(p)}>{(p.appType === 'text' ? p.id === activeTextProviderId : p.id === activeImageProviderId) ? '已启用' : '启用'}</button></div></li>)}</ul></div>
      </div>
    </section>
  );
}
const USER_ERROR_TEXT = {
  username_required: '请填写用户名。',
  username_taken: '该用户名已存在。',
  password_too_short: '密码至少 6 位。',
  nothing_to_update: '没有需要保存的改动。',
  cannot_delete_self: '不能删除当前登录的账号。',
  cannot_demote_self: '不能取消自己的管理员身份。',
  user_not_found: '账号不存在，可能已被删除。',
  admin_required: '需要管理员权限。'
};
function UserManager({ token, me, setMessage }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ username: '', password: '', isAdmin: false });
  const [busy, setBusy] = useState(false);
  const [resetFor, setResetFor] = useState('');
  const [resetValue, setResetValue] = useState('');
  const api = (path, options = {}) => fetch(API + path, { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(options.headers || {}) }, ...options }).then(async r => { const data = await readJsonResponse(r); if (!r.ok) throw new Error(data.error || r.statusText); return data; });
  const report = err => setMessage(USER_ERROR_TEXT[err.message] || err.message);
  async function load(message) { try { const data = await api('/api/users'); setUsers(data.users || []); if (message) setMessage(message); } catch (err) { report(err); } }
  useEffect(() => {
    if (!token) return;
    fetch(API + '/api/users', { headers: { Authorization: 'Bearer ' + token } })
      .then(r => readJsonResponse(r))
      .then(data => setUsers(data.users || []))
      .catch(() => {});
  }, [token]);
  async function createUser(e) {
    e.preventDefault(); setBusy(true);
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify(form) });
      setForm({ username: '', password: '', isAdmin: false });
      await load('用户已创建。');
    } catch (err) { report(err); } finally { setBusy(false); }
  }
  async function saveReset(id) {
    if (!resetValue) { setMessage('请填写新密码。'); return; }
    try { await api('/api/users/' + id, { method: 'PUT', body: JSON.stringify({ password: resetValue }) }); setResetFor(''); setResetValue(''); await load('密码已重置。'); } catch (err) { report(err); }
  }
  async function toggleAdmin(user) {
    try { await api('/api/users/' + user.id, { method: 'PUT', body: JSON.stringify({ isAdmin: !user.isAdmin }) }); await load(user.isAdmin ? '已取消管理员。' : '已设为管理员。'); } catch (err) { report(err); }
  }
  async function removeUser(user) {
    const detail = '将同时删除该用户的 ' + (user.noteCount || 0) + ' 条笔记和 ' + (user.taskCount || 0) + ' 个任务，此操作不可撤销。';
    if (!window.confirm('确定删除账号「' + user.username + '」？\n' + detail)) return;
    try { await api('/api/users/' + user.id, { method: 'DELETE' }); await load('用户已删除。'); } catch (err) { report(err); }
  }
  return (
    <section className="card user-manager">
      <div className="section-head"><div><h3>用户管理</h3><p>新增账号、重置密码、分配管理员权限。删除账号会一并清除其笔记与任务。</p></div><span className="pill">{users.length} 个账号</span></div>
      <div className="user-layout">
        <form className="form-block" onSubmit={createUser}>
          <label className="field"><b>用户名</b><input type="text" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} placeholder="新账号用户名" required /></label>
          <label className="field"><b>初始密码</b><input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="至少 6 位" required /></label>
          <label className="check"><input type="checkbox" checked={form.isAdmin} onChange={e => setForm({ ...form, isAdmin: e.target.checked })} /><span>设为管理员</span></label>
          <div className="actions-row actions-row-bottom"><button type="submit" className="btn-primary" disabled={busy}>{busy ? '创建中…' : '创建用户'}</button></div>
        </form>
        <div className="provider-list-block user-list-block">
          <div className="list-head"><h3>账号列表</h3><span className="count">{users.length} 个</span></div>
          <ul className="providers user-list">
            {users.map(u => (
              <li key={u.id} className={u.username === me?.username ? 'active' : ''}>
                <div className="p-name"><b>{u.username}</b><span className={'mode-tag' + (u.isAdmin ? '' : ' image')}>{u.isAdmin ? '管理员' : '普通用户'}</span></div>
                <small className="user-meta">{u.noteCount} 条笔记 · {u.taskCount} 个任务{u.username === me?.username ? ' · 当前登录' : ''}</small>
                {resetFor === u.id
                  ? <div className="user-reset"><input type="password" value={resetValue} onChange={e => setResetValue(e.target.value)} placeholder="新密码" /><button type="button" onClick={() => saveReset(u.id)}>保存</button><button type="button" className="danger" onClick={() => { setResetFor(''); setResetValue(''); }}>取消</button></div>
                  : <div className="row-btns"><button type="button" onClick={() => { setResetFor(u.id); setResetValue(''); }}>重置密码</button><button type="button" onClick={() => toggleAdmin(u)}>{u.isAdmin ? '取消管理员' : '设为管理员'}</button><button type="button" className="danger" onClick={() => removeUser(u)}>删除</button></div>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
function Dashboard({ token, me, activeProviderId, activeTextProviderId, activeImageProviderId, providers, onProviderChange, tasks, setMessage, selectedTaskId, onViewTask, onTaskDelete, onTasksDelete }) {
  const [manageMode, setManageMode] = useState(false);
  // 管理模式下的多选集合；只有本人或管理员的任务可被勾选删除，与后端权限一致。
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const deletableIds = tasks.filter(t => me?.isAdmin || t.userId === me?.id).map(t => t.id);
  const selectedCount = deletableIds.filter(id => selectedIds.has(id)).length;
  const allSelected = deletableIds.length > 0 && selectedCount === deletableIds.length;
  // 内嵌浏览器里 window.confirm 不弹窗、直接返回 false，会让删除看起来"没反应"；
  // 改用两步确认：第一次点进入待确认态，5 秒内再点一次才真正删。
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => {
    if (!confirmingDelete) return;
    const timer = setTimeout(() => setConfirmingDelete(false), 5000);
    return () => clearTimeout(timer);
  }, [confirmingDelete]);
  function toggleManage() { setManageMode(v => !v); setSelectedIds(new Set()); setConfirmingDelete(false); }
  function toggleTaskSelect(id) { setSelectedIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; }); setConfirmingDelete(false); }
  function toggleSelectAll() { setSelectedIds(allSelected ? new Set() : new Set(deletableIds)); setConfirmingDelete(false); }
  async function deleteSelectedTasks() {
    if (!selectedCount || !onTasksDelete) return;
    if (!confirmingDelete) { setConfirmingDelete(true); return; }
    setConfirmingDelete(false);
    await onTasksDelete(deletableIds.filter(id => selectedIds.has(id)));
    setSelectedIds(new Set());
  }
  return (
    <section className="dashboard-settings">
      <section className="card dashboard-hero"><div className="hero-copy"><span className="eyebrow">全站设置区</span><h2>仪表盘</h2><p>集中查看运行状态，并管理 AI 供应商、本地存储、队列与视频 worker。</p></div><div className="hero-stats"><div><b>{providers.length}</b><span>供应商</span></div><div><b>{tasks.length}</b><span>任务</span></div><div><b>Local</b><span>存储</span></div></div></section>
      <div className="dashboard-row">
        <section className="card dashboard-task-list"><div className="section-head"><div><h3>任务列表</h3><p>{tasks.length ? '共 ' + tasks.length + ' 个任务，每 4 秒刷新。' : '提交任务后会在这里显示。'}</p></div><div className="section-head-actions"><button type="button" className={manageMode ? 'btn-secondary manage-active' : 'btn-secondary'} onClick={toggleManage}>{manageMode ? '完成' : '管理'}</button><button type="button" className="btn-secondary" onClick={() => setMessage('正在刷新任务...')}>刷新</button></div></div>{manageMode && <div className="task-batch-bar"><label className="task-select-all"><input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />全选</label><span className="task-batch-count">{selectedCount ? '已选 ' + selectedCount + ' 个' : '勾选后可批量删除'}</span><button type="button" className={confirmingDelete ? 'task-view-btn task-delete-btn confirm-armed' : 'task-view-btn task-delete-btn'} disabled={!selectedCount} onClick={deleteSelectedTasks}>{confirmingDelete ? '确认删除 ' + selectedCount + ' 个？' : '删除所选'}</button></div>}<ul className="task-list">{tasks.map(t => { const canDelete = me?.isAdmin || t.userId === me?.id; return <li key={t.id} data-status={t.status}><div className="task-status-row">{manageMode && canDelete ? <input type="checkbox" className="task-select" checked={selectedIds.has(t.id)} onChange={() => toggleTaskSelect(t.id)} aria-label={'选择 ' + (t.label || t.type)} /> : null}<b>{t.label || t.type}</b>{t.username ? <span className="task-owner">{t.username}</span> : null}<span>{t.status}</span>{!manageMode && <button type="button" className="task-view-btn" onClick={() => onViewTask(t.id)}>查看</button>}</div>{t.error && <small>{parseJsonText(t.error).error}</small>}</li>; })}{tasks.length === 0 && <li className="empty-task">暂无任务</li>}</ul></section>
        <ProviderManager token={token} activeProviderId={activeProviderId} activeTextProviderId={activeTextProviderId} activeImageProviderId={activeImageProviderId} providers={providers} onProviderChange={onProviderChange} setMessage={setMessage} />
      </div>
      <RedappAuthCard apiBase={API} token={token} setMessage={setMessage} />
      {me?.isAdmin ? <UserManager token={token} me={me} setMessage={setMessage} /> : null}
    </section>
  );
}
function loadNotePrompts() {
  try {
    const raw = localStorage.getItem(NOTE_PROMPT_STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : {};
    return { ...DEFAULT_NOTE_PROMPTS, ...saved };
  } catch { return { ...DEFAULT_NOTE_PROMPTS }; }
}
function saveNotePrompts(prompts) {
  try { localStorage.setItem(NOTE_PROMPT_STORAGE_KEY, JSON.stringify(prompts)); return true; } catch { return false; }
}
const NOTE_PROMPT_FIELD_MAP = Object.fromEntries(NOTE_PROMPT_FIELDS.map(f => [f.key, f]));
// 外置的可折叠提示词条：输入即更新内存，失焦由 onPersist 持久化，支持单字段恢复默认。
// 侧边栏任务按笔记分组：noteId 相同的归一组，组头取组内最新任务的笔记标题；
// 无 noteId 的历史任务归入最后的「未分组」。按最新任务时间倒序。
function groupTasksByNote(list) {
  const sorted = [...list].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const byId = new Map();
  const ungrouped = [];
  for (const t of sorted) {
    const nid = t.payload && t.payload.noteId;
    if (!nid) { ungrouped.push(t); continue; }
    if (!byId.has(nid)) byId.set(nid, []);
    byId.get(nid).push(t);
  }
  const groups = [...byId.entries()].map(([key, tasks]) => ({
    key,
    title: String(tasks[0]?.payload?.noteTitle || '').trim() || '未命名笔记',
    tasks,
  }));
  if (ungrouped.length) groups.push({ key: '__ungrouped', title: '未分组', tasks: ungrouped });
  return groups;
}
function PromptStrip({ promptKey, value, onChange, onPersist, onReset }) {
  const [open, setOpen] = useState(false);
  const def = NOTE_PROMPT_FIELD_MAP[promptKey];
  const customized = String(value || '').trim() !== String(DEFAULT_NOTE_PROMPTS[promptKey] || '').trim();
  return (
    <div className={'prompt-strip' + (open ? ' open' : '')}>
      <button type="button" className="prompt-strip-head" onClick={() => setOpen(o => !o)}>
        <b>{def.label}</b>
        {customized && <span className="prompt-strip-badge">已自定义</span>}
        <span className="prompt-strip-chevron">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="prompt-strip-body">
          <span className="prompt-strip-hint">{def.hint}</span>
          <textarea value={value || ''} onChange={e => onChange(e.target.value)} onBlur={onPersist} />
          <div className="prompt-strip-actions"><button type="button" onClick={onReset}>恢复默认</button></div>
        </div>
      )}
    </div>
  );
}
function DiffCell({ line }) {
  if (line.type !== 'changed' || !line.pairs) return <span>{line.new}</span>;
  return <span>{line.pairs.map((p, i) => p.type === 'changed' ? <mark key={i}>{p.new}</mark> : <span key={i}>{p.new}</span>)}</span>;
}
function renderFieldDiff(fieldKey, oldText, newText, titleCandidates, activeIndex, onSelectCandidate, draftTags, onDraftTagsChange) {
  if (fieldKey === 'title' && Array.isArray(titleCandidates) && titleCandidates.length) {
    return (
      <div className="diff-title-options">
        {titleCandidates.map((candidate, index) => (
          <button key={index} type="button" className={'diff-title-option' + (index === activeIndex ? ' active' : '')} onClick={() => onSelectCandidate(index)}>
            <b>标题 {index + 1}</b>
            <span>{candidate}</span>
          </button>
        ))}
      </div>
    );
  }
  if (fieldKey === 'tags' && draftTags) {
    return (
      <div className="diff-inline-edit">
        <label><b>候选话题</b><textarea value={draftTags} onChange={e => onDraftTagsChange(e.target.value)} placeholder="每行一个话题，保留 # 也可以" /></label>
      </div>
    );
  }
  return (
    <div className="diff-lines">
      {diffLines(oldText, newText).map((line, index) => (
        <div key={index} className="diff-line" data-type={line.type}>
          <div className="diff-code"><DiffCell line={line} /></div>
        </div>
      ))}
    </div>
  );
}
function extractTextContent(raw) {
  const source = String(raw?.text || (typeof raw === 'string' ? raw : '') || '').trim();
  if (!source) return '';
  const section = source.match(/(?:正文|文案|content)[:：]?\s*([\s\S]+)/i);
  const base = section?.[1]?.trim() || source.replace(/```(?:json)?\s*|```/g, '').trim();
  return base
    .split('\n')
    .filter(line => {
      const item = line.trim();
      return item
        && !/^(?:#|【)?(?:标题|topic|tags?|标签|话题)/i.test(item)
        && !/^\d+\s*[.)、．：:]/.test(item)
        && !/^(?:titles?|text|content|tags?)\s*[:=]/i.test(item)
        && item.length > 1;
    })
    .join('\n')
    .trim();
}
function extractListItems(lines, maxItems) {
  return lines
    .map(line => line.replace(/^\s*(?:[-*]|\d+\s*[.)、．]|#{1,4})\s*/, '').trim())
    .map(line => line.replace(/^#|^【|^】|[‘’“”']/g, '').trim())
    .filter(line => line && !/^#/.test(line) && line.length <= 32)
    .slice(0, maxItems);
}
function extractStringArray(raw, fallbackKey) {
  const text = raw?.text || (typeof raw === 'string' ? raw : '');
  const data = parseJsonText(text);
  if (data && typeof data === 'object') {
    const key = Object.keys(data).find(k => /title|title候选|候选标题/i.test(k)) || fallbackKey;
    const list = data[key] || data[fallbackKey] || Object.values(data).find(v => Array.isArray(v));
    if (Array.isArray(list)) return list.map(item => String(item).trim()).filter(Boolean);
  }
  const source = String(text || '').trim();
  if (!source) return [];
  if (fallbackKey === 'tags') {
    const tagLines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const hashTags = tagLines.filter(line => /^#/.test(line));
    if (hashTags.length >= 2) return extractListItems(hashTags, 20);
    const inlineTags = source.match(/#[^\s,，、;；]+/g);
    if (inlineTags && inlineTags.length >= 2) return extractListItems(inlineTags, 20);
    return extractListItems(tagLines, 20);
  }
  const numbered = source.match(/(?:^|\n)\s*(?:[-*]|\d+\s*[.)、．])\s*[^\n]+/g);
  return numbered ? extractListItems(numbered, 8) : [];
}
// 全局提示：底部居中的浮动弹窗，自动消失，替代原来的页脚常驻文字。
function useStatusToast(duration = 3200) {
  const [status, setStatusText] = useState('');
  const timer = useRef(null);
  const setStatus = useCallback((msg) => {
    setStatusText(msg);
    if (timer.current) clearTimeout(timer.current);
    if (msg) timer.current = setTimeout(() => setStatusText(''), duration);
  }, [duration]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [status, setStatus];
}

function StatusToast({ text }) {
  if (!text) return null;
  return <div className="status-toast" role="status">{text}</div>;
}

function NoteRewriteWorkspace({ token, mode = 'rewrite', hidden = false, onSendToVideo }) {
  const isDownload = mode === 'download';
  const linkLabel = isDownload ? '商品链接' : '笔记链接';
  const resultLabel = isDownload ? '商品图片' : '图片';
  const [link, setLink] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState([]);
  const [tagInput, setTagInput] = useState('');
  const [images, setImages] = useState([]);
  const [status, setStatus] = useStatusToast();
  const [dragIndex, setDragIndex] = useState(null);
  const [qr, setQr] = useState(null);
  const [notePrompts, setNotePrompts] = useState(loadNotePrompts);
  const [aiDiff, setAiDiff] = useState(null);
  // 按图重生成支持并行：regeneratingIds 存进行中的图片 id，regenLimit 是用户可设的并行上限。
  const [regeneratingIds, setRegeneratingIds] = useState(() => new Set());
  const [regenLimit, setRegenLimit] = useState(2);
  // 并行生成的结果排队等确认：imageReplacePreviews[0] 是当前弹窗展示的那张。
  const [imageReplacePreviews, setImageReplacePreviews] = useState([]);
  const [publishConfirm, setPublishConfirm] = useState(false);
  const [publishChannel, setPublishChannel] = useState('draft');
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishAuth, setPublishAuth] = useState(null);
  const [publishAuthOpen, setPublishAuthOpen] = useState(false);
  const [publishAuthCancelling, setPublishAuthCancelling] = useState(false);
  const publishFlowRef = useRef(null);
  const publishGenerationRef = useRef(0);

  const clearPublishFlow = useCallback((flow = publishFlowRef.current) => {
    if (publishFlowRef.current !== flow) return;
    flow.phase = 'terminal';
    publishFlowRef.current = null;
    setPublishAuth(null);
    setPublishAuthOpen(false);
    setPublishAuthCancelling(false);
  }, []);

  useEffect(() => () => {
    publishFlowRef.current?.controller.abort();
    publishFlowRef.current = null;
  }, []);
  function clearImageSelectionState() {
    // 专属提示词编辑器常驻显示，不再需要选中态；这里只清待确认的替换预览。
    // 进行中的生成任务不清，它们结束后会自行从 regeneratingIds 移除。
    setImageReplacePreviews([]);
  }
  // 按图重生成：以该图为参考走 /images/edits。参考图传原始存储值
  // （/notes-images、/uploads 相对路径或远程 URL），worker 会直接读本地缓存；
  // 不要传 resolveImageSrc() 拼出的带域名绝对地址。
  async function regenerateImage(index) {
    const img = images[index];
    if (!img || img.isVideo || regeneratingIds.has(img.id)) return;
    if (regeneratingIds.size >= regenLimit) { setStatus('已达并行上限（' + regenLimit + ' 个），等一个完成后再试。'); return; }
    // 填了专属提示词就完全以它为准：标题/正文不能再附在后面——模型会把标题当成要画进图里的文字，
    // 直接顶掉用户「不要加入任何文字」这类指令（实测踩过）。
    // 默认提示词路径仍保留标题/正文作为主题上下文，但明确禁止渲染成图中文字。
    const custom = String(img.prompt || '').trim();
    const contextGuard = '（以下标题与正文仅用于理解笔记主题，是内容上下文，严禁以任何形式以文字出现在图片中）';
    const finalPrompt = custom || [notePrompts.imageReplace, (title || content) && contextGuard, title && ('标题：' + title), content && ('正文：' + content)].filter(Boolean).join('\n');
    const reference = img.cachedUrl || img.url;
    if (!reference) { setStatus('该图片缺少可用地址，无法作为参考图。'); return; }
    setRegeneratingIds(prev => new Set(prev).add(img.id));
    try {
      const task = await runTask(
        // 不传画布：worker 会按参考图原始比例出图，不再硬拉成方形。
        { type: 'image', purpose: 'noteImage', payload: { prompt: finalPrompt, imageUrls: [reference], perReference: true, count: 1 } },
        '正在重新生成图片...',
        300000
      );
      const result = parseJsonText(task.result) || {};
      const urls = Array.isArray(result.images) && result.images.length ? result.images : (result.image && typeof result.image === 'string' ? [result.image] : []);
      if (!urls.length) throw new Error('AI 没有返回图片');
      setImageReplacePreviews(prev => [...prev, { id: img.id, url: urls[0], localUrl: Array.isArray(result.localImages) ? result.localImages[0] : (result.localImage || '') }]);
      setStatus('新图已生成，请确认是否替换。');
    } catch (err) {
      setStatus(err.message);
    } finally {
      setRegeneratingIds(prev => { const next = new Set(prev); next.delete(img.id); return next; });
    }
  }
  function applyImageReplace() {
    const preview = imageReplacePreviews[0];
    if (!preview) return;
    const targetIndex = images.findIndex(item => item.id === preview.id);
    if (targetIndex < 0) { setImageReplacePreviews(prev => prev.slice(1)); setStatus('原图已被删除或移动，新图已弃用。'); return; }
    setImages(prev => prev.map((item, i) => {
      if (i !== targetIndex) return item;
      // 旧 cachedUrl 指向旧图，必须丢弃；id/name/prompt 保留，顺序与封面逻辑不变。
      const { cachedUrl, ...rest } = item;
      return { ...rest, url: preview.url };
    }));
    setImageReplacePreviews(prev => prev.slice(1));
    setStatus('已替换为新图。');
  }
  function dismissImageReplace() {
    // 取消只丢弃当前这张，队列里后面的还会接着弹出来。
    setImageReplacePreviews(prev => prev.slice(1));
  }
  async function api(path, options = {}) {
    return fetch(API + path, { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(options.headers || {}) }, ...options }).then(async r => {
      const data = await readJsonResponse(r);
      if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), data, { status: r.status });
      return data;
    });
  }
  function referenceImageUrls() {
    return images.filter(img => !img.isVideo).map(img => resolveImageSrc(img)).filter(Boolean);
  }
  // 笔记身份：智能识别/清空后归零，发任务时惰性生成；同一条笔记的所有任务共享 noteId 供侧边栏分组。
  const noteIdRef = useRef('');
  function currentNoteId() {
    if (!noteIdRef.current) noteIdRef.current = 'note-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    return noteIdRef.current;
  }
  async function runTask({ type, payload, purpose }, message, timeoutMs = 120000) {
    setStatus(message);
    const taskPayload = { ...payload, noteId: currentNoteId(), noteTitle: title.trim() || '未命名笔记' };
    if (purpose) taskPayload.purpose = purpose;
    const data = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ type, tab: 'note-rewrite', payload: taskPayload }) });
    const id = data.id || '';
    if (!id) throw new Error('任务创建失败');
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const list = await api('/api/tasks');
      const task = list.tasks?.find(t => t.id === id);
      if (task?.status === 'done') return task;
      if (task?.status === 'failed') {
        let message2 = task.error;
        try { message2 = JSON.parse(task.error).error || message2; } catch {}
        throw new Error(message2 || 'AI 生成失败');
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error('AI 生成超时');
  }
  function openAiDiff(fieldKey, values, message) {
    setAiDiff({
      fieldKey,
      title: AI_DIFF_FIELDS[fieldKey].label,
      oldText: fieldKey === 'title' ? title : fieldKey === 'content' ? content : tags.map(t => '#' + t).join(' '),
      newText: fieldKey === 'title' ? String(values?.candidates?.[0] || '') : fieldKey === 'content' ? String(values?.text || '') : String(values?.tags?.map(t => '#' + t).join(' ') || ''),
      titleCandidates: values?.candidates || [],
      activeIndex: fieldKey === 'title' ? 0 : null,
      draftTags: fieldKey === 'tags' ? String(values?.tags?.map(t => '#' + t).join(' ') || '') : '',
      message,
    });
  }
  function applyAiDiff() {
    if (!aiDiff) return;
    const { fieldKey, newText, titleCandidates, activeIndex, draftTags, title } = aiDiff;
    if (fieldKey === 'title') {
      const next = titleCandidates?.[activeIndex] || title;
      if (next) setTitle(next);
    } else if (fieldKey === 'content') {
      const next = String(newText || '').slice(0, 1000);
      if (next) setContent(next);
    } else if (fieldKey === 'tags') {
      const nextTags = String(draftTags || newText || '')
        .split(/\s+/)
        .map(t => t.replace(/^#/, '').trim())
        .filter(Boolean);
      if (nextTags.length) setTags([...new Set(nextTags)].slice(0, 20));
    }
    setAiDiff(null);
    setStatus('AI 生成内容已应用。');
  }
  async function aiGenerateTitle() {
    try {
      const task = await runTask({ type: 'rewrite', purpose: 'title', payload: { prompt: notePrompts.title, source: content || link || '请根据当前笔记生成标题。', imageUrls: referenceImageUrls() } }, '正在生成标题...');
      const titles = extractStringArray(task.result, 'titles');
      if (titles.length) {
        if (!title) { setTitle(titles[0]); setStatus('已生成 ' + titles.length + ' 个标题，已填入第 1 个。'); }
        else openAiDiff('title', { candidates: titles }, '已生成 ' + titles.length + ' 个标题，确认后写入。');
      } else setStatus('AI 已返回结果，但没有识别到标题数组。');
    } catch (err) { setStatus(err.message); }
  }
  async function aiGenerateContent() {
    try {
      const task = await runTask({ type: 'rewrite', purpose: 'content', payload: { prompt: notePrompts.content, source: content || link || '请生成一段适合小红书发布的原创笔记正文。', imageUrls: referenceImageUrls() } }, '正在生成正文...');
      const text = parseJsonText(task.result);
      const body = extractTextContent(task.result)
        || (typeof text?.content === 'string' ? text.content : '')
        || (Array.isArray(text?.content) ? String(text.content[0]?.text || '').trim() : '')
        ;
      if (body) {
        if (!content) { setContent(body.slice(0, 1000)); setStatus('正文已生成并填入。'); }
        else openAiDiff('content', { text: body.slice(0, 1000) }, '正文已生成，确认后写入。');
      } else setStatus('AI 已返回结果，但没有识别到正文内容。');
    } catch (err) { setStatus(err.message); }
  }
  async function aiGenerateTags() {
    try {
      const task = await runTask({ type: 'rewrite', purpose: 'tags', payload: { prompt: notePrompts.tags, source: content || link || '请根据当前笔记生成话题标签。', imageUrls: referenceImageUrls() } }, '正在生成话题标签...');
      const nextTags = extractStringArray(task.result, 'tags').map(t => t.replace(/^#/, '')).filter(Boolean);
      if (nextTags.length) {
        if (!tags.length) { setTags(nextTags.slice(0, 20)); setStatus('已生成 ' + nextTags.length + ' 个话题标签。'); }
        else openAiDiff('tags', { tags: nextTags }, '话题标签已生成，确认后写入。');
      } else setStatus('AI 已返回结果，但没有识别到标签数组。');
    } catch (err) { setStatus(err.message); }
  }
  // 外置提示词条：输入即更新内存（AI 生成读取最新值），失焦持久化。
  function updateNotePrompt(key, value) {
    setNotePrompts(prev => ({ ...prev, [key]: value }));
  }
  function persistNotePrompts() {
    const ok = saveNotePrompts(notePrompts);
    setStatus(ok ? '提示词已保存，AI生成将使用新配置。' : '提示词已更新本次会话；浏览器未允许持久化保存。');
  }
  function resetPromptField(key) {
    const next = { ...notePrompts, [key]: DEFAULT_NOTE_PROMPTS[key] };
    setNotePrompts(next);
    const ok = saveNotePrompts(next);
    setStatus(ok ? '已恢复默认提示词。' : '已恢复默认提示词（仅本次会话）。');
  }
  // 去发布：图片传原始存储值（/notes-images 本地缓存或云端 URL），worker 统一解析成本地文件上传。
  // 弹窗确认后提交，本机弹出 Chrome 自动填好内容，最后一步发布由用户手动点。
  function openPublishConfirm() {
    const publishImages = images.filter(img => !img.isVideo).map(img => img.cachedUrl || img.url).filter(Boolean);
    if (!publishImages.length) { setStatus('发布需要至少 1 张图片。'); return; }
    if (!title.trim() && !content.trim()) { setStatus('标题和正文至少填一项。'); return; }
    setPublishConfirm(true);
  }
  async function submitPublish() {
    const publishImages = images.filter(img => !img.isVideo).map(img => img.cachedUrl || img.url).filter(Boolean).slice(0, 9);
    try {
      setStatus('正在提交发布任务…');
      await api('/api/publish', { method: 'POST', body: JSON.stringify({ title, content, images: publishImages, noteId: currentNoteId(), noteTitle: title.trim() || '未命名笔记' }) });
      setPublishConfirm(false);
      setStatus('发布任务已提交：本机即将弹出小红书窗口，填好内容后自动存入草稿箱。');
    } catch (err) { setStatus(err.message); }
  }
  // 小工具渠道：笔记打包成离线小工具上传，返回预览二维码；小红书 App 扫码后直达预填好的发布页。
  async function submitMinitoolPublish() {
    const previousFlow = publishFlowRef.current;
    if (previousFlow && !['terminal', 'failed', 'restart-acknowledged', 'outcome-acknowledged'].includes(previousFlow.phase)) {
      if (previousFlow.phase === 'uncertain') void retryMinitoolPublish();
      return;
    }
    previousFlow?.controller.abort();
    let request;
    try {
      request = createPublishRequestSnapshot({
        title,
        content,
        tags,
        images: images.filter(img => !img.isVideo).map(img => img.cachedUrl || img.url).filter(Boolean).slice(0, 9)
      });
    } catch (error) {
      setStatus(error.message || '无法生成安全的发布标识。');
      return;
    }
    const flow = createPublishFlow({ request, generation: ++publishGenerationRef.current });
    publishFlowRef.current = flow;
    setPublishAuth(null);
    setPublishAuthOpen(false);
    setPublishAuthCancelling(false);
    const continuation = flow.continuation;
    const isCurrent = () => canCommitPublishFlow(publishFlowRef.current, flow, flow.generation, continuation);
    const authApi = createRedappFetchAdapter({ apiBase: API, token, getSignal: () => flow.controller.signal });
    const publishApi = createRedappFetchAdapter({ apiBase: API, token, getSignal: () => flow.controller.signal });
    // 服务端建任务前最坏要跑 180s 版本门禁 + 120s whoami，POST 截止必须覆盖该窗口；GET 轮询仍用小截止。
    const publishPostApi = createRedappFetchAdapter({
      apiBase: API, token, getSignal: () => flow.controller.signal, deadlineMs: MINITOOL_PUBLISH_REQUEST_DEADLINE_MS
    });
    const authClient = createRedappAuthClient({ api: authApi, pollMs: 1500 });
    const requestJob = async path => {
      const response = await publishApi(path);
      if (!response.ok) throw await readApiError(response);
      return response.json();
    };
    const publish = async () => recoverInitialPublish({
      attemptId: flow.attemptId,
      post: async () => {
        flow.postDispatched = true;
        const response = await publishPostApi('/api/publish/minitool', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request)
        });
        if (!response.ok) {
          const error = await readApiError(response);
          if (error.code === 'AUTH_REQUIRED') flow.postDispatched = false;
          throw error;
        }
        return response.json();
      },
      onAttemptId: attemptId => { flow.attemptId = attemptId; },
      poll: attemptId => {
        flow.attemptId = attemptId;
        flow.phase = 'job-polling';
        return pollMiniToolPublishJob({
          attemptId,
          request: requestJob,
          signal: flow.controller.signal,
          pollMs: 1500,
          timeoutMs: MINITOOL_PUBLISH_DEADLINE_MS
        });
      }
    });

    setPublishBusy(true);
    setStatus('正在打包小工具并上传，约需 30~60 秒…');
    try {
      const data = await publishWithAuth({
        publish,
        pollSession: sessionId => authClient.pollSession(sessionId, {
          signal: flow.controller.signal,
          timeoutMs: 10 * 60 * 1000,
          onUpdate: current => {
            if (!isCurrent() || current.sessionId !== flow.sessionId) return;
            setPublishAuth(previous => mergeDisplayedAuth(previous, current));
          }
        }),
        onAuthRequired: auth => {
          if (!isCurrent()) return;
          flow.phase = 'auth-required';
          flow.sessionId = auth.sessionId;
          setPublishAuth({ ...auth, mode: 'resume-publish' });
          setPublishAuthOpen(true);
          setStatus('请完成小红书授权；关闭窗口后仍会自动继续发布。');
        },
        onAuthorized: session => {
          if (!isCurrent() || session.sessionId !== flow.sessionId) return;
          flow.phase = 'replaying';
          setPublishAuth(previous => mergeDisplayedAuth(previous, session));
          setStatus('授权成功，正在继续发布…');
        }
      });
      if (!isCurrent()) return;
      if (!data.qrImage && !data.previewUrl) {
        flow.phase = 'failed';
        setPublishAuth({ sessionId: request.attemptId, status: 'publish-failed', error: '发布已完成，但服务端没有返回二维码或预览链接。请重新提交。', mode: 'resume-publish' });
        setPublishAuthOpen(true);
        setStatus('发布结果缺少二维码和预览链接，本次发布按失败处理。');
        return;
      }
      flow.phase = 'terminal';
      publishFlowRef.current = null;
      setPublishAuth(null);
      setPublishAuthOpen(false);
      setPublishConfirm(false);
      if (data.qrImage) {
        setQr({ url: data.previewUrl || '', image: data.qrImage, tip: '用小红书 App 扫码，打开后点「发布到小红书」即可直达预填好的发布页' });
        setStatus('预览二维码已生成，用小红书 App 扫码发布。');
      } else if (data.previewUrl) {
        setQr({ url: data.previewUrl, image: null, tip: '二维码生成失败，请在手机浏览器打开此链接' });
        setStatus('预览链接已生成（二维码不可用）。');
      } else {
        setStatus('上传成功，但未返回二维码和预览链接。');
      }
    } catch (err) {
      if (!canCommitPublishFlow(publishFlowRef.current, flow, flow.generation, continuation)) return;
      if (flow.phase === 'cancelling' || flow.cancelled) return;
      const terminal = publishAuthTerminal(err, { replay: flow.phase === 'replaying' });
      if (terminal && flow.sessionId) {
        flow.phase = 'terminal';
        setPublishAuth(previous => previous?.sessionId === flow.sessionId
          ? { ...previous, ...terminal, mode: 'resume-publish' }
          : previous);
        setPublishAuthOpen(true);
        setStatus(err.code === 'AUTH_NOT_COMPLETED'
          ? '已取消本次授权，笔记内容和发布渠道已保留，可重新提交。'
          : `${err.message}，笔记内容已保留，可重新提交。`);
      } else if (err?.code === 'PUBLISH_JOB_FAILED') {
        flow.phase = 'failed';
        setPublishAuth({ sessionId: request.attemptId, status: 'publish-failed', error: err.message, mode: 'resume-publish' });
        setPublishAuthOpen(true);
        setStatus('扫码直达发布失败，笔记内容已保留，可重新提交。');
      } else if (err?.code === 'PUBLISH_JOB_UNCERTAIN' || err?.code === 'PUBLISH_JOB_RESTART_UNKNOWN' || err?.code === 'PUBLISH_JOB_OUTCOME_UNKNOWN') {
        flow.phase = err.code === 'PUBLISH_JOB_RESTART_UNKNOWN'
          ? 'restart-unknown'
          : err.code === 'PUBLISH_JOB_OUTCOME_UNKNOWN' ? 'outcome-unknown' : 'uncertain';
        setPublishAuth({
          sessionId: flow.attemptId,
          status: flow.phase === 'restart-unknown'
            ? 'publish-restart-unknown'
            : flow.phase === 'outcome-unknown' ? 'publish-outcome-unknown' : 'publish-uncertain',
          error: flow.phase === 'uncertain'
            ? `发布结果暂时无法确认（任务 ${flow.attemptId}），请查询发布结果`
            : err.message,
          mode: 'resume-publish'
        });
        setPublishAuthOpen(true);
        setStatus(flow.phase === 'uncertain' ? '发布任务仍可能在服务端运行，请使用“查询发布结果”。' : err.message);
      } else {
        clearPublishFlow(flow);
        if (err?.code === 'AUTH_POLL_CANCELLED') setStatus('本次发布已被新的发布请求替代。');
        else setStatus(err.message || '扫码直达发布失败，请重试。');
      }
    } finally {
      if (publishFlowRef.current !== flow || flow.phase !== 'cancelling') setPublishBusy(false);
    }
  }

  async function retryMinitoolPublish() {
    const flow = publishFlowRef.current;
    if (flow?.phase === 'restart-unknown' || flow?.phase === 'outcome-unknown') {
      const outcomeUnknown = flow.phase === 'outcome-unknown';
      if (outcomeUnknown) {
        try {
          const acknowledgeApi = createRedappFetchAdapter({ apiBase: API, token, getSignal: () => flow.controller.signal });
          const response = await acknowledgeApi(`/api/publish/minitool/jobs/${encodeURIComponent(flow.attemptId)}/acknowledge-unknown`, { method: 'POST' });
          if (!response.ok) throw await readApiError(response);
        } catch (error) {
          setStatus(error.message || '无法确认未知结果，请稍后重试。');
          return;
        }
      }
      flow.phase = outcomeUnknown ? 'outcome-acknowledged' : 'restart-acknowledged';
      flow.controller.abort();
      publishFlowRef.current = null;
      setPublishAuth(null);
      setPublishAuthOpen(false);
      setStatus(outcomeUnknown
        ? '已确认上传结果未知；请在核对小红书上传和预览记录后再重新提交。'
        : '已确认原任务结果未知；现在可以重新提交并生成新的发布标识。');
      return;
    }
    if (flow?.phase === 'uncertain') {
      flow.controller.abort();
      flow.controller = new AbortController();
      const continuation = createPublishContinuation(flow);
      flow.cancelled = false;
      flow.phase = 'job-polling';
      setPublishBusy(true);
      setStatus('正在查询发布结果…');
      try {
        const queryApi = createRedappFetchAdapter({ apiBase: API, token, getSignal: () => flow.controller.signal });
        const data = await pollMiniToolPublishJob({
          attemptId: flow.attemptId,
          request: async path => {
            const response = await queryApi(path);
            if (!response.ok) throw await readApiError(response);
            return response.json();
          },
          signal: flow.controller.signal,
          pollMs: 1500,
          timeoutMs: MINITOOL_PUBLISH_DEADLINE_MS
        });
        if (!canCommitPublishFlow(publishFlowRef.current, flow, flow.generation, continuation)) return;
        if (data.qrImage || data.previewUrl) {
          publishFlowRef.current = null;
          setPublishAuth(null);
          setPublishAuthOpen(false);
          setPublishConfirm(false);
          setQr({ url: data.previewUrl || '', image: data.qrImage || null, tip: '用小红书 App 扫码，打开后点「发布到小红书」即可直达预填好的发布页' });
          setStatus('已查询到发布结果。');
        } else {
          flow.phase = 'failed';
          setPublishAuth({ sessionId: flow.request.attemptId, status: 'publish-failed', error: '发布结果缺少二维码和预览链接。', mode: 'resume-publish' });
          setPublishAuthOpen(true);
          setStatus('发布结果缺少二维码和预览链接，本次发布按失败处理。');
        }
      } catch (error) {
        if (publishFlowRef.current === flow) {
          if (error?.code === 'PUBLISH_JOB_RESTART_UNKNOWN' || error?.code === 'PUBLISH_JOB_OUTCOME_UNKNOWN') {
            flow.phase = error.code === 'PUBLISH_JOB_RESTART_UNKNOWN' ? 'restart-unknown' : 'outcome-unknown';
            setPublishAuth({
              sessionId: flow.attemptId,
              status: flow.phase === 'restart-unknown' ? 'publish-restart-unknown' : 'publish-outcome-unknown',
              error: error.message,
              mode: 'resume-publish'
            });
            setPublishAuthOpen(true);
          } else {
            flow.phase = error?.code === 'PUBLISH_JOB_FAILED' ? 'failed' : 'uncertain';
            if (error?.code === 'PUBLISH_JOB_FAILED') {
              setPublishAuth({ sessionId: flow.attemptId, status: 'publish-failed', error: error.message, mode: 'resume-publish' });
              setPublishAuthOpen(true);
            }
          }
          setStatus(error.message || '查询发布结果失败');
        }
      } finally {
        setPublishBusy(false);
      }
      return;
    }
    if (publishAuthCancelling || (flow && !['terminal', 'failed'].includes(flow.phase))) return;
    if (flow) {
      flow.phase = 'terminal';
      flow.controller.abort();
      publishFlowRef.current = null;
    }
    setPublishBusy(false);
    void submitMinitoolPublish();
  }

  async function cancelMinitoolAuth() {
    const flow = publishFlowRef.current;
    if (!flow?.sessionId || publishAuthCancelling || !['auth-required', 'replaying', 'job-created', 'job-polling', 'cancel-failed'].includes(flow.phase)) return;
    const phaseAtCancel = flow.phase;
    const mustRecover = shouldRecoverAttemptAfterCancel(phaseAtCancel) || flow.postDispatched;
    flow.cancelled = true;
    flow.phase = 'cancelling';
    setPublishAuthCancelling(true);
    flow.controller.abort();
    try {
      // 服务端取消要等版本门禁+CLI（最坏约 300s），给宽截止；失败仍按“取消结果不确定”处理。
      const cancelApi = createRedappFetchAdapter({ apiBase: API, token, deadlineMs: MINITOOL_PUBLISH_REQUEST_DEADLINE_MS });
      const response = await createRedappAuthClient({ api: cancelApi }).cancel(flow.sessionId);
      if (publishFlowRef.current !== flow) return;
      const result = interpretCancelResponse(flow.sessionId, response);
      if (mustRecover) {
        flow.cancelled = false;
        flow.controller = new AbortController();
        createPublishContinuation(flow);
        flow.phase = 'uncertain';
        setPublishAuth({ sessionId: flow.attemptId, status: 'publish-uncertain', error: result.error || '正在查询同一次发布结果。', mode: 'resume-publish' });
        setPublishAuthOpen(true);
        setStatus('已保留同一次发布标识，正在恢复结果查询。');
        setPublishAuthCancelling(false);
        void retryMinitoolPublish();
        return;
      }
      flow.phase = 'terminal';
      publishFlowRef.current = null;
      setPublishAuth(previous => previous?.sessionId === flow.sessionId ? {
        ...previous,
        status: result.cancelled ? 'cancelled' : result.status,
        error: result.cancelled ? null : result.error,
        mode: 'resume-publish'
      } : previous);
      setPublishAuthOpen(true);
      setStatus(result.cancelled
        ? '已取消本次授权，笔记内容和发布渠道已保留，可重新提交。'
        : result.error);
    } catch {
      if (publishFlowRef.current !== flow) return;
      if (mustRecover) {
        flow.cancelled = false;
        flow.controller = new AbortController();
        createPublishContinuation(flow);
        flow.phase = 'uncertain';
        setPublishAuth({ sessionId: flow.attemptId, status: 'publish-uncertain', error: '取消结果无法确认，正在查询同一次发布结果。', mode: 'resume-publish' });
        setPublishAuthOpen(true);
        setStatus('取消结果无法确认，已保留同一次发布标识并恢复结果查询。');
        setPublishAuthCancelling(false);
        void retryMinitoolPublish();
        return;
      }
      flow.cancelled = false;
      flow.controller = new AbortController();
      createPublishContinuation(flow);
      flow.phase = 'cancel-failed';
      setPublishAuth(previous => previous?.sessionId === flow.sessionId ? {
        ...previous,
        error: '取消失败，授权可能仍进行',
        mode: 'resume-publish'
      } : previous);
      setPublishAuthOpen(true);
      setStatus('取消失败，授权可能仍进行。可重新打开进度、再次取消，或查询同一次发布结果。');
    } finally {
      if (publishFlowRef.current === flow || flow.phase === 'terminal') {
        setPublishAuthCancelling(false);
        setPublishBusy(false);
      }
    }
  }
  // 真正落库：与生成二维码共用 POST /api/notes，保存后可通过 /p/:id 预览页访问。
  async function saveNoteDraft() {
    if (!title.trim() && !content.trim() && !images.length) { setStatus('标题、正文、图片至少有一项才能保存。'); return; }
    try {
      const res = await fetch(API + '/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ title, content, tags, images }) });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data.error || '保存失败');
      setStatus('笔记已保存到本地库，预览链接：' + data.url);
    } catch (err) { setStatus(err.message); }
  }
  async function generateQr() {
    try {
      setStatus('正在生成预览二维码...');
      const res = await fetch(API + '/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ title, content, tags, images }) });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data.error || '生成失败');
      const qrDataUrl = await QRCode.toDataURL(data.url, { width: 320, margin: 2 });
      setQr({ url: data.url, image: qrDataUrl });
      setStatus('二维码已生成，手机扫码预览笔记。');
    } catch (err) { setStatus(err.message); }
  }
  function clearNote() { setTitle(''); setContent(''); setTags([]); setImages([]); setLink(''); clearImageSelectionState(); noteIdRef.current = ''; setStatus('已清空。'); }
  async function identifyLink() {
    const target = link.trim();
    if (!target) return setStatus('请先粘贴' + linkLabel + '。');
    setStatus('正在识别' + linkLabel + '...');
    try {
      // 解析接口服务端最多跑 25 秒，这里 20 秒先放弃，避免转圈无限等；中断后已落盘的缓存下次解析能直接命中。
      const res = await fetchWithTimeout(API + '/api/notes/parse', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ link: target }) }, 20000);
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data.message || data.error || '识别失败');
      if (data.title) setTitle(data.title);
      if (data.content) setContent(removeTopicTagMarkup(data.content));
      if (Array.isArray(data.tags) && data.tags.length) setTags(data.tags.map(t => String(t).replace(/^#/, '')));
      const items = [];
      if (Array.isArray(data.videos) && data.videos.length) data.videos.forEach((url, i) => items.push({ id: 'video-' + i + '-' + Date.now(), url, name: '视频 ' + (i + 1), isVideo: true }));
      if (Array.isArray(data.images) && data.images.length) data.images.forEach((img, i) => items.push({ id: 'remote-' + i + '-' + Date.now(), url: img.url, cachedUrl: img.cachedUrl, name: resultLabel + ' ' + (i + 1) }));
      if (items.length) { setImages(items); clearImageSelectionState(); }
      noteIdRef.current = '';
      setStatus('已识别：' + (data.title || '无标题') + '，' + (data.images?.length || 0) + ' 张' + resultLabel + (data.videos?.length ? '，' + data.videos.length + ' 个无水印视频' : '') + '。');
    } catch (err) { setStatus(err.message); }
  }
  async function uploadImages(list) { if (!list?.length) return; const fd = new FormData(); Array.from(list).slice(0, 9).forEach(file => fd.append('file', file)); const r = await fetch(API + '/api/upload/files', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd }); const data = await readJsonResponse(r); setImages(prev => { const next = [...prev]; data.files?.forEach(file => { if (!next.some(f => f.url === file.url)) next.push({ ...file, id: file.url || file.name + Date.now() }); }); return next.slice(0, 9); }); setStatus((data.files?.length || 0) + ' 张图片已添加。'); }
  function addTags() { const next = tagInput.split(/[,，\s#]+/).map(t => t.trim()).filter(Boolean); setTags(prev => [...new Set([...prev, ...next])].slice(0, 20)); setTagInput(''); }
  function moveImage(from, to) { if (from === to || from < 0 || to < 0) return; setImages(prev => { const next = [...prev]; const [item] = next.splice(from, 1); next.splice(to, 0, item); return next; }); }
  return (
    <section className={'card note-rewrite-card' + (isDownload ? ' is-download' : '')} style={hidden ? { display: 'none' } : undefined} aria-hidden={hidden}>
      <div className={'note-rewrite-grid' + (isDownload ? ' is-single' : '')}>
        <div className="note-main">
          <div className="note-section smart-link">
            <div className="note-head"><div><h2>{isDownload ? '商品下载' : '智能识别笔记链接'}</h2>{!isDownload && <p>输入笔记链接，智能识别参考内容：标题、正文、标签、图片</p>}</div><span className="pill pill-ok">AI 提取</span></div>
            <div className="note-link-row"><input value={link} onChange={e => setLink(e.target.value)} placeholder={'粘贴小红书' + linkLabel} /><button className="btn-primary" onClick={identifyLink}>智能识别</button><button className="btn-secondary" onClick={clearNote}>清空</button></div>
          </div>
          {!isDownload && (<div className="note-section fields">
            <div><div className="field-head"><label>标题</label><div className="field-meta"><span>{title.length} 字</span><div className="field-actions"><button className="btn-secondary" onClick={aiGenerateTitle}>AI生成</button></div></div></div><PromptStrip promptKey="title" value={notePrompts.title} onChange={v => updateNotePrompt('title', v)} onPersist={persistNotePrompts} onReset={() => resetPromptField('title')} /><input value={title} onChange={e => setTitle(e.target.value)} placeholder="请输入笔记标题" /></div>
            <div><div className="field-head"><label>正文</label><div className="field-meta"><span>{content.length} / 1000</span><div className="field-actions"><button className="btn-secondary" onClick={aiGenerateContent}>AI生成</button></div></div></div><PromptStrip promptKey="content" value={notePrompts.content} onChange={v => updateNotePrompt('content', v)} onPersist={persistNotePrompts} onReset={() => resetPromptField('content')} /><textarea maxLength={1000} value={content} onChange={e => setContent(e.target.value)} placeholder="请输入笔记正文" /></div>
            <div>
              <div className="field-head">
                <label>话题标签</label>
                <div className="field-meta">
                  <span>复制话题 {tags.length} 个</span>
                  <div className="field-actions">
                    <button className="btn-secondary" onClick={aiGenerateTags}>AI生成</button>
                    <button className="btn-secondary" onClick={() => navigator.clipboard?.writeText(tags.map(t => '#' + t).join(' '))}>复制话题</button>
                  </div>
                </div>
              </div>
              <PromptStrip promptKey="tags" value={notePrompts.tags} onChange={v => updateNotePrompt('tags', v)} onPersist={persistNotePrompts} onReset={() => resetPromptField('tags')} />
              <div className="tag-input-row">
                <input value={tagInput} onChange={e => setTagInput(e.target.value)} placeholder="单个或批量添加，例如：学习资料 #英语，八年级" />
                <button className="btn-secondary" onClick={addTags}>添加</button>
              </div>
              {tags.length > 0 && <div className="tag-list">{tags.map((t, i) => <span key={i} className="topic-tag">{'#' + t}<button onClick={() => setTags(tags.filter((_, idx) => idx !== i))}>×</button></span>)}</div>}
            </div>
          </div>)}
          <div className="note-section images">
            <div className="section-title"><h3>图片管理</h3>{!isDownload && <div className="image-toolbar"><label className="regen-limit" title="按图重生成时最多同时跑几个任务">并行上限<input type="number" min="1" max="9" value={regenLimit} onChange={e => setRegenLimit(Math.max(1, Math.min(9, Number(e.target.value) || 1)))} /></label><label className="btn-secondary btn-upload"><input type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={e => uploadImages(e.target.files)} />上传图片</label></div>}</div>
            {!isDownload && <p className="section-desc">支持上传、下载、删除；直接用鼠标拖动图片调整顺序，第一张默认作为封面。</p>}
            {!isDownload && <PromptStrip promptKey="imageReplace" value={notePrompts.imageReplace} onChange={v => updateNotePrompt('imageReplace', v)} onPersist={persistNotePrompts} onReset={() => resetPromptField('imageReplace')} />}
            <div className="image-grid">{images.map((img, index) => (
              <figure
                key={img.id || index}
                className="image-thumb"
                onDragOver={e => e.preventDefault()}
                onDrop={() => { if (dragIndex === null || dragIndex === undefined) return; moveImage(dragIndex, index); clearImageSelectionState(); }}
              >
                {img.isVideo ? <span className="cover-badge cover-badge-video">视频</span> : (index === 0 && <span className="cover-badge">封面</span>)}
                {regeneratingIds.has(img.id) && <div className="image-regen-overlay">生成中…</div>}
                {/* 拖动只从图片/视频本体发起；下方按钮区和提示词编辑区不参与拖拽，文字可以正常选中。
                    dragend 复位 dragIndex，drop 前判空，避免拖选中的文字落进来时误触发排序。 */}
                {img.isVideo
                  ? <video src={API + '/api/download?inline=1&url=' + encodeURIComponent(img.url)} controls preload="metadata" draggable onDragStart={() => { setDragIndex(index); clearImageSelectionState(); }} onDragEnd={() => setDragIndex(null)} />
                  : <SmartImg sources={noteImageSources(img)} alt={img.name || '笔记图片'} draggable onDragStart={() => { setDragIndex(index); clearImageSelectionState(); }} onDragEnd={() => setDragIndex(null)} />}
                <figcaption>
                  <span>{img.name || '图片 ' + (index + 1)}</span>
                  <div>
                    <button type="button" onClick={(e) => { e.stopPropagation(); downloadFile(img, img.name || ('图片 ' + (index + 1)), img.isVideo ? 'video' : 'image'); }}>下载</button>
                    <button onClick={e => { e.stopPropagation(); setImages(images.filter((_, idx) => idx !== index)); clearImageSelectionState(); }}>删除</button>
                    {!img.isVideo && onSendToVideo && <button type="button" className="thumb-send-video" title="把这张图送到实况视频页的图片输入区" onClick={(e) => { e.stopPropagation(); onSendToVideo({ url: img.cachedUrl || img.url, name: img.name || ('图片 ' + (index + 1)) }); }}>传入</button>}
                  </div>
                </figcaption>
                {!img.isVideo && (
                  <div className="image-prompt-editor" onClick={e => e.stopPropagation()}>
                    <textarea
                      value={img.prompt || ''}
                      placeholder="可选：填写此图专属提示词；留空则使用上方默认提示词"
                      onChange={e => setImages(prev => prev.map((item, i) => i === index ? { ...item, prompt: e.target.value } : item))}
                    />
                    <button type="button" className="btn-secondary" disabled={regeneratingIds.has(img.id)} onClick={() => regenerateImage(index)}>
                      {regeneratingIds.has(img.id) ? '生成中…' : '提交'}
                    </button>
                  </div>
                )}
              </figure>
            ))}{images.length === 0 && <div className="empty-image">暂无图片</div>}</div>
          </div>
        </div>
        {!isDownload && (<aside className="preview-panel">
          <div className="preview-head"><h3>预览效果</h3><span>小红书样式</span></div>
          <div className="xhs-preview"><header><div className="avatar"></div><div><b>笔记作者</b><small>{images.length} 张图片</small></div><button className="follow-btn">关注</button></header><div className="preview-images">{images.filter(img => !img.isVideo).length ? images.filter(img => !img.isVideo).map((img, i) => <SmartImg key={i} sources={noteImageSources(img)} alt={'预览图 ' + (i + 1)} />) : <div className="no-image">暂无图片</div>}</div><h4>{title || '笔记标题'}</h4><p>{content || '笔记正文内容将显示在这里。'}</p><div className="topic-tags">{tags.map((t, i) => <span key={i}>{'#' + t}</span>)}</div></div>
          <div className="publish-actions"><button className="btn-primary" onClick={openPublishConfirm}>去发布</button><button className="btn-secondary" onClick={saveNoteDraft}>保存笔记</button><button className="btn-secondary" onClick={generateQr}>生成小红书直发二维码</button></div>
        </aside>)}
      </div>
      <StatusToast text={status} />
{aiDiff && (
        <div className="prompt-config-backdrop ai-diff-backdrop" onClick={() => setAiDiff(null)}>
          <div className="prompt-config-modal ai-diff-modal" onClick={e => e.stopPropagation()}>
            <button type="button" className="prompt-config-close" onClick={() => setAiDiff(null)}>×</button>
            <h3>{aiDiff.title} · 改动对比</h3>
            <p>{aiDiff.message}确认后才会写入表单。</p>
            <div className="diff-panel">
              {renderFieldDiff(aiDiff.fieldKey, aiDiff.oldText, aiDiff.newText, aiDiff.titleCandidates, aiDiff.activeIndex, (index) => setAiDiff(prev => prev && { ...prev, activeIndex: index }), aiDiff.draftTags, (value) => setAiDiff(prev => prev && { ...prev, draftTags: value, newText: value }))}
            </div>
            <div className="prompt-config-actions">
              <button type="button" className="btn-secondary" onClick={() => setAiDiff(null)}>取消</button>
              <button type="button" className="btn-primary" onClick={applyAiDiff}>应用</button>
            </div>
          </div>
        </div>
      )}
      {imageReplacePreviews.length > 0 && (() => {
        const preview = imageReplacePreviews[0];
        const targetIndex = images.findIndex(item => item.id === preview.id);
        if (targetIndex < 0) return null;
        const target = images[targetIndex];
        return (
          <div className="prompt-config-backdrop" onClick={dismissImageReplace}>
            <div className="prompt-config-modal" onClick={e => e.stopPropagation()}>
              <button type="button" className="prompt-config-close" onClick={dismissImageReplace}>×</button>
              <h3>替换图片确认{imageReplacePreviews.length > 1 ? '（还有 ' + (imageReplacePreviews.length - 1) + ' 张待确认）' : ''}</h3>
              <p>「{target.name || '图片 ' + (targetIndex + 1)}」将被替换为新图，原图不保留。</p>
              <div className="image-compare-grid">
                <figure><SmartImg sources={noteImageSources(target)} alt="原图" /><figcaption>原图</figcaption></figure>
                <div className="image-compare-arrow">→</div>
                <figure><SmartImg sources={/^https?:\/\//.test(String(preview.url || '')) ? resultImageSources(preview.url, preview.localUrl) : [API + preview.url]} alt="新图" /><figcaption>新图</figcaption></figure>
              </div>
              <div className="prompt-config-actions">
                <button type="button" className="btn-secondary" onClick={() => downloadFile(preview.url, (target.name || '图片 ' + (targetIndex + 1)) + '-新图', 'image')}>下载新图</button>
                <button type="button" className="btn-secondary" onClick={dismissImageReplace}>取消</button>
                <button type="button" className="btn-primary" onClick={applyImageReplace}>应用</button>
              </div>
            </div>
          </div>
        );
      })()}
      {publishConfirm && (
        <div className="prompt-config-backdrop" onClick={() => setPublishConfirm(false)}>
          <div className="prompt-config-modal" onClick={e => e.stopPropagation()}>
            <button type="button" className="prompt-config-close" onClick={() => setPublishConfirm(false)}>×</button>
            <h3>发布到小红书</h3>
            <div className="publish-channel">
              <label className={'channel-opt' + (publishChannel === 'draft' ? ' active' : '')}><input type="radio" name="publish-channel" checked={publishChannel === 'draft'} onChange={() => setPublishChannel('draft')} /><b>存入草稿箱</b><span>本机弹出浏览器自动填好并存草稿，之后在 App 草稿箱发布</span></label>
              <label className={'channel-opt' + (publishChannel === 'minitool' ? ' active' : '')}><input type="radio" name="publish-channel" checked={publishChannel === 'minitool'} onChange={() => setPublishChannel('minitool')} /><b>扫码直达</b><span>打包成小工具生成二维码，App 扫码直达预填好的发布页</span></label>
            </div>
            <div className="prompt-config-actions">
              <button type="button" className="btn-secondary" onClick={() => setPublishConfirm(false)}>取消</button>
              <button type="button" className="btn-primary" disabled={publishBusy} onClick={publishChannel === 'minitool' ? submitMinitoolPublish : submitPublish}>{publishBusy ? '处理中…' : '提交'}</button>
            </div>
          </div>
        </div>
      )}
      {publishAuthOpen && publishAuth ? (
        <RedappAuthModal
          session={publishAuth}
          mode="resume-publish"
          onClose={() => {
            setPublishAuthOpen(false);
            setStatus('授权窗口已隐藏；授权成功后会自动继续发布。');
          }}
          onCancel={cancelMinitoolAuth}
          onRetry={retryMinitoolPublish}
          cancelling={publishAuthCancelling}
        />
      ) : null}
      {!publishAuthOpen && publishAuth ? (
        <button type="button" className="auth-progress-reopen" onClick={() => setPublishAuthOpen(true)}>
          查看小红书授权进度
        </button>
      ) : null}
      {qr && (
        <div className="qr-backdrop" onClick={() => setQr(null)}>
          <div className="qr-modal" onClick={e => e.stopPropagation()}>
            <button type="button" className="qr-close" onClick={() => setQr(null)}>×</button>
            <h3>小红书笔记预览</h3>
            {qr.image ? <img src={qr.image} alt="笔记预览二维码" /> : null}
            <p className="qr-url">{qr.url}</p>
            <p className="qr-tip">{qr.tip || '手机与电脑在同一局域网时，扫码即可打开预览'}</p>
          </div>
        </div>
      )}
    </section>
  );
}


function Workspace({ token }) {
  const [active, setActive] = useState('dashboard');
  const [lastToolTab, setLastToolTab] = useState('replace-image');
  const [textByTab, setTextByTab] = useState({});
  const [defaultPromptByTab, setDefaultPromptByTab] = useState({});
  const [secondaryPromptByTab, setSecondaryPromptByTab] = useState({});
  const [filesByTab, setFilesByTab] = useState({});
  const [noteDrafts, setNoteDrafts] = useState({});
  const [canvasSizeByTab, setCanvasSizeByTab] = useState({});
  const [outputCountByTab, setOutputCountByTab] = useState({});
  const [perReferenceByTab, setPerReferenceByTab] = useState({});
  const [motionEffectByTab, setMotionEffectByTab] = useState({});
  const [durationModeByTab, setDurationModeByTab] = useState({});
  const [customDurationByTab, setCustomDurationByTab] = useState({});
  const [shakeStrengthByTab, setShakeStrengthByTab] = useState({});
  const [shakeFrequencyByTab, setShakeFrequencyByTab] = useState({});
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [taskDetailId, setTaskDetailId] = useState('');
  const [lightbox, setLightbox] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [providers, setProviders] = useState([]);
  const [selectedModels, setSelectedModels] = useState({});
  const [activeProviderId, setActiveProviderId] = useState('');
  const [activeTextProviderId, setActiveTextProviderId] = useState('');
  const [activeImageProviderId, setActiveImageProviderId] = useState('');
  const [status, setStatus] = useStatusToast();
  const [me, setMe] = useState(null);
  const activeTab = TABS.find(tab => tab.id === active) || TABS[0];
  const activeTabLabel = activeTab.label;
  const hints = SECTION_HINTS[active] || {};
  const layoutVariant = active === 'replace-image' || active === 'ai-image' ? 'replace-image' : TEXT_TABS.has(active) ? 'text-focused' : IMAGE_HEAVY_TABS.has(active) ? 'image-heavy' : VIDEO_TABS.has(active) ? 'video-focused' : 'default';
  const isTextFocused = TEXT_TABS.has(active);
  const isImageHeavy = IMAGE_HEAVY_TABS.has(active);
  
  const isFileFocused = FILE_TABS.has(active);
  const isLiveVideo = VIDEO_TABS.has(active);
  const uploadLabel = isLiveVideo ? '图片' : isFileFocused ? '文件' : '图片';
  const uploadAccept = isLiveVideo ? UPLOAD_ACCEPT.image : isFileFocused ? UPLOAD_ACCEPT.all : UPLOAD_ACCEPT.image;
  useEffect(() => {
    const prompt = PROMPTS[active] || '';
    setDefaultPromptByTab(prev => (prev[active] !== undefined ? prev : { ...prev, [active]: prompt }));
    if (active !== 'dashboard') setLastToolTab(active);
  }, [active]);

  const text = textByTab[active] || '';
  const defaultPrompt = defaultPromptByTab[active] !== undefined ? defaultPromptByTab[active] : (PROMPTS[active] || '');
  const secondaryPrompt = secondaryPromptByTab[active] || '';
  const files = filesByTab[active] || [];
  const noteDraft = noteDrafts[active] || { link: '', title: '', content: '', tags: [], tagInput: '', selectedImageIds: [] };
  // 默认画布：竖版 3:4（小红书笔记最常用的比例）。
  const canvasSize = canvasSizeByTab[active] || '1080x1440';
  const outputCount = outputCountByTab[active] || '1';
  // 多张参考图时默认按图号一一对应生成；要「多张参考图合成一张」时关掉这个开关。
  const perReference = perReferenceByTab[active] !== false;
  const motionEffect = motionEffectByTab[active] || '手持轻晃';
  const durationMode = durationModeByTab[active] || 'fixed';
  const customDuration = customDurationByTab[active] || '3';
  // 用 ?? 而不是 ||：用户显式调到 0（静止画面）必须能生效，只有从未设置时才用默认值。
  const shakeStrength = shakeStrengthByTab[active] ?? 35;
  const shakeFrequency = shakeFrequencyByTab[active] ?? 45;
  const setText = (v) => setTextByTab(prev => ({ ...prev, [active]: typeof v === 'function' ? v(prev[active] || '') : v }));
  const setNoteDraft = (v) => setNoteDrafts(prev => ({ ...prev, [active]: { ...(prev[active] || { link: '', title: '', content: '', tags: [], tagInput: '', selectedImageIds: [] }), ...(typeof v === 'function' ? v(prev[active] || { link: '', title: '', content: '', tags: [], tagInput: '', selectedImageIds: [] }) : v) } }));
  const setDefaultPrompt = (v) => setDefaultPromptByTab(prev => ({ ...prev, [active]: typeof v === 'function' ? v(prev[active] || '') : v }));
  const setSecondaryPrompt = (v) => setSecondaryPromptByTab(prev => ({ ...prev, [active]: typeof v === 'function' ? v(prev[active] || '') : v }));
  const setFiles = (v) => setFilesByTab(prev => ({ ...prev, [active]: typeof v === 'function' ? v(prev[active] || []) : v }));
  const setCanvasSize = (v) => setCanvasSizeByTab(prev => ({ ...prev, [active]: typeof v === 'function' ? v(prev[active] || '1080x1440') : v }));
  const setOutputCount = (v) => setOutputCountByTab(prev => ({ ...prev, [active]: typeof v === 'function' ? v(prev[active] || '1') : v }));
  const setPerReference = (v) => setPerReferenceByTab(prev => ({ ...prev, [active]: v }));
  const fileInputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const setMotionEffect = (v) => setMotionEffectByTab(prev => ({ ...prev, [active]: typeof v === 'function' ? v(prev[active] || '手持轻晃') : v }));
  const setDurationMode = (v) => setDurationModeByTab(prev => ({ ...prev, [active]: typeof v === 'function' ? v(prev[active] || 'fixed') : v }));
  const setCustomDuration = (v) => setCustomDurationByTab(prev => ({ ...prev, [active]: typeof v === 'function' ? v(prev[active] || '3') : v }));
  const setShakeStrength = (v) => setShakeStrengthByTab(prev => ({ ...prev, [active]: typeof v === 'function' ? v(prev[active] || 0) : v }));
  const setShakeFrequency = (v) => setShakeFrequencyByTab(prev => ({ ...prev, [active]: typeof v === 'function' ? v(prev[active] || 0) : v }));
  const refresh = useCallback(async () => {
    try {
      const [taskData, providerData] = await Promise.all([api('/api/tasks', { token }), api('/api/providers', { token })]);
      setTasks(taskData.tasks || []); setProviders(providerData.providers || []); setActiveProviderId(providerData.activeProviderId || ''); setActiveTextProviderId(providerData.activeTextProviderId || ''); setActiveImageProviderId(providerData.activeImageProviderId || '');
    } catch (err) { setStatus(err.message); }
  }, [token]);
  useEffect(() => { if (!token) return; refresh(); const timer = setInterval(refresh, 4000); return () => clearInterval(timer); }, [token, refresh]);
  useEffect(() => { if (!token) return; api('/api/auth/me', { token }).then(data => setMe(data.user || null)).catch(() => setMe(null)); }, [token]);
  const clearedTabs = useRef(new Set());
  const pendingTaskId = useRef('');
  useEffect(() => {
    if (!token || active === 'dashboard') return;
    if (clearedTabs.current.has(active)) return;
    const expectedType = TAB_TO_TYPE[active];
    // 归属按来源页签 tab 判断，而不是队列类型：rewrite 类型被 3 个页签共用，
    // 只看 type 会把别的页签任务误判成“本页已选”，导致结果区串任务。
    const belongs = t => t && ((t.tab === active) || (!t.tab && expectedType && t.type === expectedType));
    const selected = selectedTaskId ? tasks.find(t => t.id === selectedTaskId) : null;
    if (selected && belongs(selected)) return;
    // 刚提交的任务还没随刷新出现时，先保持空白等它出现，不要闪回旧任务。
    if (selectedTaskId && selectedTaskId === pendingTaskId.current) return;
    if (pendingTaskId.current && selectedTaskId !== pendingTaskId.current) pendingTaskId.current = '';
    const candidate = tasks.find(t => belongs(t) && (t.status === 'done' || t.status === 'failed'));
    if (candidate) setSelectedTaskId(candidate.id);
  }, [token, active, tasks, selectedTaskId]);
  async function createTask(type, payload) {
    clearedTabs.current.delete(active);
    pendingTaskId.current = '';   // 切换页签后再提交，旧页签的等待标记作废
    setStatus('任务已提交到 Redis 队列。');
    const result = await api('/api/tasks', { method: 'POST', token, body: JSON.stringify({ type, tab: active, payload }) });
    pendingTaskId.current = result.id || '';
    setSelectedTaskId(result.id || ''); await refresh();
  }
  // 笔记改写/商品下载的图片卡片一键把图送进实况视频页输入区：追加到最后，不跳转页面。
  function sendImageToVideo(file) {
    if (!file || !file.url) return;
    const cur = filesByTab['live-video'] || [];
    if (cur.some(f => f.url === file.url)) { setStatus('这张图已在实况视频输入区。'); return; }
    setFilesByTab(prev => ({ ...prev, 'live-video': [...(prev['live-video'] || []), { url: file.url, name: file.name || '笔记图片' }].slice(0, 9) }));
    setStatus('已传送到实况视频的图片输入区。');
  }
  function viewTask(taskId) { setSelectedTaskId(taskId); const task = tasks.find(t => t.id === taskId); const targetTab = task ? (task.tab || TYPE_TO_TAB[task.type] || lastToolTab) : lastToolTab; clearedTabs.current.delete(targetTab); setActive(targetTab); setLastToolTab(targetTab); }
  function openTaskDetail(taskId) { setTaskDetailId(taskId); }
  async function uploadMany(list) {
    if (!list?.length) return;
    const fd = new FormData(); Array.from(list).forEach(file => fd.append('file', file));
    const r = await fetch(`${API}/api/upload/files`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    const data = await readJsonResponse(r); const uploaded = data.files || [];
      setFiles(prev => { const seen = new Set(prev.map(f => f.url)); const next = [...prev]; for (const file of uploaded) { if (!seen.has(file.url)) next.push(file); } return next.slice(0, 9); }); setStatus((data.files?.length || 0) + ' 个素材已保存到本地存储路径。');
  }
  async function submitCurrentTask() {
    // AI 生图 / 替换生图：默认 + 二级 + 用户 三层提示词拼接（空层跳过）；
    // 其余页签保持原回退逻辑：用户填了用用户的，否则用默认。
    const submitText = SECONDARY_PROMPT_TABS.has(active)
      ? [defaultPrompt.trim(), secondaryPrompt.trim(), text.trim()].filter(Boolean).join('\n')
      : (text.trim() || defaultPrompt.trim() || PROMPTS[active] || '');
    if (IMAGE_TABS.has(active)) return createTask('image', { prompt: submitText, image: files[0]?.url, imageUrls: files.map(f => f.url), canvasSize, count: Number(outputCount) || 1, perReference, providerId: selectedProviderId, model: selectedModelName });
    if (VIDEO_TABS.has(active)) {
      // 随机时长入口已下线，统一按定时秒数提交。
      // 多张图由同一任务逐张出片（worker 产出 videos 数组），结果区并列展示所有视频。
      const duration = Number(customDuration) || 3;
      return createTask('video', { prompt: submitText, mediaUrls: files.map(f => f.url), canvasSize, duration, durationMode: 'fixed', motionEffect, shakeStrength, shakeFrequency, providerId: selectedProviderId, model: selectedModelName });
    }
    return createTask('rewrite', { prompt: submitText, source: text.trim() || submitText, canvasSize, providerId: selectedProviderId, model: selectedModelName });
  }
  function resetPrompt() { setText(PROMPTS[active] || ''); }
  const currentTask = tasks.find(t => t.id === selectedTaskId);
  const [collapsedTaskGroups, setCollapsedTaskGroups] = useState(() => new Set());
  // 侧边栏任务列表只显示当前功能的任务；早期任务可能没有 tab 字段，用 TYPE_TO_TAB 兜底。
  const tabTasks = active === 'dashboard' ? [] : tasks.filter(t => (t.tab || TYPE_TO_TAB[t.type]) === active);
  const taskGroups = groupTasksByNote(tabTasks);
  const taskDetail = tasks.find(t => t.id === taskDetailId);
  // 不能只看 TAB_TO_TYPE：ai-image / replace-image 不在 TYPE_TO_TAB 的反向映射里，
  // 否则会被误判成文本模式，页面芯片和提交都会错用文本供应商。
  const activeMode = TEXT_TABS.has(active) || FILE_TABS.has(active) ? 'text' : 'image';
  const modeActiveProviderId = activeMode === 'text' ? (activeTextProviderId || activeProviderId) : (activeImageProviderId || activeProviderId);
  const selectedModel = selectedModels[active] || selectedModelValue(activeMode, providers, modeActiveProviderId);
  const parsedSelectedModel = splitModelValue(selectedModel);
  const selectedProviderId = parsedSelectedModel.providerId || modeActiveProviderId;
  const selectedModelName = parsedSelectedModel.model || (providers.find(p => p.id === selectedProviderId)?.model || '');
  
  // Extract the image/video/file input section into a variable
  const inputSection = !isTextFocused ? (
    <div className={'panel-cell cell-upload' + (isImageHeavy ? ' cell-image-large' : '')}>
      <div className="cell-head"><div className="section-title-block"><h3>{isLiveVideo ? '图片输入区' : isFileFocused ? '文件输入区' : '图片输入区'}</h3><p>{hints.upload}</p></div></div>
      <div className="cell-body">
        <div className="upload-zone">
          <input ref={fileInputRef} type="file" multiple accept={uploadAccept} hidden onChange={e => { uploadMany(e.target.files); e.target.value = ''; }} />
          <div className={'file-grid file-grid-9 file-grid-strip' + (dragOver ? ' drag-active' : '')} onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={e => { e.preventDefault(); setDragOver(false); uploadMany(e.dataTransfer.files); }}>
            {files.map((file, index) => <figure key={file.url || index} className="file-thumb"><div className="thumb-media" onClick={() => setLightbox({ url: API + file.url, name: file.name || '素材预览', isVideo: !!(file.url && file.url.includes('/videos/')) })}>{file.url && file.url.includes('/videos/') ? <video src={API + file.url} muted preload="metadata" /> : <img src={API + file.url} alt={file.name || '素材预览'} />}</div><figcaption><span>{file.name}</span><a href={API + file.url} download={file.name || '素材'} onClick={(e) => e.stopPropagation()}>下载</a><button type="button" className="thumb-remove" onClick={(e) => { e.stopPropagation(); setFiles(files.filter((_, i) => i !== index)); }}>移除</button></figcaption></figure>)}
            {Array.from({ length: Math.max(0, 9 - files.length) }, (_, i) => <button type="button" key={'empty-' + i} className="file-slot-empty" title={'点击或拖入 ' + uploadLabel + '，最多 9 个素材'} aria-label="添加素材" onClick={() => fileInputRef.current?.click()}><span>+</span></button>)}
          </div>
        </div>
      </div>
    </div>
  ) : null;
  
  return (
    <div className="app">
      <header className="topbar"><div className="brand"><div className="logo">S</div><div><h1>Slenk Notes</h1></div></div><div className="top-actions"><div className="top-models"><span className="model-chip text">文本 {providers.find(p => p.id === (activeTextProviderId || activeProviderId))?.textModel || '未选择'}</span><span className="model-chip image">生图 {providers.find(p => p.id === (activeImageProviderId || activeProviderId))?.imageModel || '未选择'}</span><span className="model-chip page">当前 {selectedModelName || '未选择'}</span></div><span className="top-user" title="当前登录用户"><b>{me?.username || ""}</b>{me?.isAdmin ? <em>管理员</em> : null}</span><button className="btn-secondary" onClick={refresh}>刷新任务</button><button className="btn-danger" onClick={() => { localStorage.clear(); location.reload(); }}>退出</button></div></header>
      <div className="layout">
        <aside className="sidebar"><div className="sidebar-nav"><div className="sidebar-title"><b>工作台</b><span>{TABS.length} 个功能</span></div>
          <nav className="tabs"><button className={active === 'dashboard' ? 'active' : ''} onClick={() => setActive('dashboard')}><span className="tab-icon">◈</span><span className="tab-label">仪表盘</span></button></nav>
          {GROUPS.map(group => <div key={group.id} className="tab-group"><nav className="tabs">{group.tabs.map(tab => <button key={tab.id} className={tab.id === active ? 'active' : ''} onClick={() => { setActive(tab.id); setSelectedTaskId(''); }}><span className="tab-icon">{tab.icon}</span><span className="tab-label">{tab.label}</span></button>)}</nav></div>)}
          </div>
          {active !== 'dashboard' && (<div className="sidebar-tasks"><div className="sidebar-tasks-head"><b>任务列表</b><span>{tabTasks.length} 个</span></div><ul className="task-list sidebar-task-list">{taskGroups.map(g => (
            <li key={g.key} className="task-group">
              <button type="button" className="task-group-head" onClick={() => setCollapsedTaskGroups(prev => { const next = new Set(prev); if (next.has(g.key)) next.delete(g.key); else next.add(g.key); return next; })}>
                <span className="task-group-chevron">{collapsedTaskGroups.has(g.key) ? '▸' : '▾'}</span>
                <span className="task-group-title" title={g.title}>{g.title.length > 14 ? g.title.slice(0, 14) + '…' : g.title}</span>
                <span className="task-group-count">{g.tasks.length}</span>
              </button>
              {!collapsedTaskGroups.has(g.key) && (<ul className="task-group-items">{g.tasks.map(t => <li key={t.id} data-status={t.status} className={t.id === selectedTaskId ? 'selected' : ''}><button type="button" className="sidebar-task-item" onClick={() => openTaskDetail(t.id)}><span className="sidebar-task-label">{t.label || t.type}</span>{t.username ? <span className="task-owner">{t.username}</span> : null}<span className="sidebar-task-state">{statusLabel(t.status)}</span></button></li>)}</ul>)}
            </li>
          ))}{tabTasks.length === 0 && <li className="empty-task">当前功能暂无任务</li>}</ul></div>)}
        </aside>
        <main className="workspace">
          <NoteRewriteWorkspace token={token} mode="rewrite" hidden={active !== 'note-rewrite'} onSendToVideo={sendImageToVideo} />
          <NoteRewriteWorkspace token={token} mode="download" hidden={active !== 'note-download'} onSendToVideo={sendImageToVideo} />
          {active === 'dashboard' ? (
            <Dashboard token={token} me={me} activeProviderId={activeProviderId} activeTextProviderId={activeTextProviderId} activeImageProviderId={activeImageProviderId} providers={providers} onProviderChange={(nextProviders, nextActiveProviderId, nextActiveTextProviderId, nextActiveImageProviderId) => { setProviders(nextProviders || []); setActiveProviderId(nextActiveProviderId || ''); if (nextActiveTextProviderId !== undefined) setActiveTextProviderId(nextActiveTextProviderId || ''); if (nextActiveImageProviderId !== undefined) setActiveImageProviderId(nextActiveImageProviderId || ''); }} onProvidersUpdate={(data) => { setProviders(data.providers || []); setActiveProviderId(data.activeProviderId || ''); setActiveTextProviderId(data.activeTextProviderId || ''); setActiveImageProviderId(data.activeImageProviderId || ''); }} tasks={tasks} setMessage={ setStatus} selectedTaskId={selectedTaskId} onViewTask={openTaskDetail} onTaskDelete={async (id) => { await api('/api/tasks/' + id, { method: 'DELETE', token }); await refresh(); setStatus('任务已删除。'); }} onTasksDelete={async (ids) => { const r = await api('/api/tasks/batch-delete', { method: 'POST', token, body: JSON.stringify({ ids }) }); await refresh(); setStatus('已删除 ' + (r.deleted ?? ids.length) + ' 个任务。'); }} />
          ) : active === 'note-rewrite' || active === 'note-download' ? null : (
            <section className={'card tool-panel layout-' + layoutVariant + ' ' + (TEXT_TABS.has(active) ? 'text-focused' : IMAGE_HEAVY_TABS.has(active) ? 'image-heavy' : VIDEO_TABS.has(active) ? 'video-focused' : 'default') + ' ' + (isTextFocused ? 'row-text-only' : '')}>
              <div className="panel-row"><div className="panel-cell panel-title-cell"><div className="title-row"><span className="title-label">{activeTabLabel}</span><div className="meta-chips"><span className="meta-chip">任务 {tasks.length}</span></div>{(active === 'replace-image' || active === 'ai-image') && <div className="option-row title-options"><ThemedSelect value={canvasSize} onChange={setCanvasSize} options={FIXED_CANVAS} ariaLabel="画布比例" /><ThemedSelect value={outputCount} onChange={setOutputCount} options={[1, 2, 3, 4].map(n => ({ value: String(n), label: n + ' 张' }))} ariaLabel="输出数量" /><label className="option-check" title="多张参考图时按图号一一对应生成；需要多张参考图合成一张时取消勾选"><input type="checkbox" checked={perReference} onChange={e => setPerReference(e.target.checked)} /><span>按参考图一一对应</span></label></div>}{VIDEO_TABS.has(active) && <div className="option-row range-row title-options title-options-video"><ThemedSelect className="model-select" value={selectedModel} onChange={v => setSelectedModels(prev => ({ ...prev, [active]: v }))} options={[{ value: MODEL_EMPTY, label: '未选择' }, ...modelOptionsFor(activeMode, providers)]} ariaLabel="本页模型" /><ThemedSelect value={canvasSize} onChange={setCanvasSize} options={FIXED_CANVAS} ariaLabel="画布比例" /><ThemedSelect value={motionEffect} onChange={setMotionEffect} options={MOTION_EFFECTS} ariaLabel="运镜效果" /><div className="range-item"><label className="option-label">强度</label><input type="range" min="0" max="100" value={shakeStrength} onChange={e => setShakeStrength(Number(e.target.value))} style={{ '--progress': shakeStrength + '%' }} /><span className="range-value">{shakeStrength}</span></div><div className="range-item"><label className="option-label">频率</label><input type="range" min="0" max="100" value={shakeFrequency} onChange={e => setShakeFrequency(Number(e.target.value))} style={{ '--progress': shakeFrequency + '%' }} /><span className="range-value">{shakeFrequency}</span></div><div className="range-item"><label className="option-label">时长</label><input type="range" min="1" max="8" value={customDuration} onChange={e => setCustomDuration(e.target.value)} style={{ '--progress': ((Number(customDuration) || 3) - 1) / 7 * 100 + '%' }} /><span className="range-value">{customDuration} 秒</span></div><div className="title-actions"><button className="btn-primary action-primary" onClick={submitCurrentTask}>提交</button><button className="btn-secondary" onClick={resetPrompt}>重置</button></div></div>}{!VIDEO_TABS.has(active) && <div className="title-actions"><ThemedSelect className="model-select" value={selectedModel} onChange={v => setSelectedModels(prev => ({ ...prev, [active]: v }))} options={[{ value: MODEL_EMPTY, label: '未选择' }, ...modelOptionsFor(activeMode, providers)]} ariaLabel="本页模型" /><button className="btn-primary action-primary" onClick={submitCurrentTask}>提交</button><button className="btn-secondary" onClick={resetPrompt}>重置</button></div>}</div></div>
                <div className="panel-cell cell-options"><div className="cell-head"><div className="section-title-block"><h3>选项区</h3><p>{hints.options}</p></div></div><div className="cell-body"><div className="option-row"><select value={canvasSize} onChange={e => setCanvasSize(e.target.value)} aria-label="画布比例">{FIXED_CANVAS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>{IMAGE_TABS.has(active) && <select value={outputCount} onChange={e => setOutputCount(e.target.value)} aria-label="输出数量">{[1,2,3,4].map(n => <option key={n} value={String(n)}>{n} 张</option>)}</select>}{IMAGE_TABS.has(active) && <label className="option-check" title="多张参考图时按图号一一对应生成；需要多张参考图合成一张时取消勾选"><input type="checkbox" checked={perReference} onChange={e => setPerReference(e.target.checked)} /><span>按参考图一一对应</span></label>}</div></div></div></div>
              <div className='panel-row'>
                <div className={'panel-cell' + (isTextFocused ? ' cell-text-fullwidth' : '')}><div className="cell-head"><div className="section-title-block"><h3>文本输入区</h3><p>{hints.text}</p></div></div><div className="cell-body text-input-split"><div className="prompt-section"><div className="prompt-label">默认提示词</div><textarea className="prompt-default" value={defaultPrompt} onChange={e => setDefaultPrompt(e.target.value)} placeholder="暂无默认提示词" /></div>{SECONDARY_PROMPT_TABS.has(active) && <div className="prompt-section"><div className="prompt-label">二级提示词</div><textarea className="prompt-default prompt-secondary" value={secondaryPrompt} onChange={e => setSecondaryPrompt(e.target.value)} placeholder="可选：二级默认提示词；提交时按「默认 + 二级 + 用户」顺序拼接" /></div>}<div className="prompt-section"><div className="prompt-label">用户提示词</div><textarea value={text} onChange={e => setText(e.target.value)} placeholder="在此输入或修改提示词..." /></div></div></div>
                {inputSection}
              </div>
              <div className="panel-row panel-row-result"><div className="panel-cell result-cell"><aside className="result-side"><div className="section-title-block"><h3>生成结果输出区</h3><p>{hints.result}</p></div>{currentTask ? <div className="result-meta"><span className={'pill ' + (currentTask.status === 'failed' ? 'pill-bad' : currentTask.status === 'done' ? 'pill-ok' : '')}>{statusLabel(currentTask.status)}</span><span className="result-meta-line">任务编号 {currentTask.id.slice(0, 8)}</span></div> : null}<div className="result-side-actions">{selectedTaskId ? <button type="button" className="btn-secondary" onClick={() => { clearedTabs.current.add(active); setSelectedTaskId(''); }}>清空选择</button> : null}</div></aside><div className="result-stage cell-body">{currentTask ? <TaskResultWithDownload task={currentTask} onZoom={(url, name) => setLightbox({ url, name, isVideo: false })} /> : <ResultEmptyState tabId={active} />}</div></div></div>
            </section>
          )}
        </main>
      </div>
      <StatusToast text={status} />
      {lightbox && (
        <div className="lightbox-backdrop" onClick={() => setLightbox(null)}>
          <div className="lightbox-body" onClick={e => e.stopPropagation()}>
            <button type="button" className="lightbox-close" onClick={() => setLightbox(null)}>×</button>
            {lightbox.isVideo ? <video src={lightbox.url} controls autoPlay /> : <img src={lightbox.url} alt={lightbox.name} />}
            <div className="lightbox-caption">{lightbox.name}</div>
          </div>
        </div>
      )}
      {taskDetail && (
        <div className="prompt-config-backdrop task-detail-backdrop" onClick={() => setTaskDetailId('')}>
          <div className="prompt-config-modal task-detail-modal" onClick={e => e.stopPropagation()}>
            <button type="button" className="prompt-config-close" onClick={() => setTaskDetailId('')}>×</button>
            <div className="task-detail-head">
              <div>
                <h3>{taskDetail.label || taskDetail.type} · 任务结果</h3>
                <p>点击任务列表即可查看完整输出；关闭后不会切换或清空当前功能区。</p>
              </div>
              <span className={'pill ' + (taskDetail.status === 'failed' ? 'pill-bad' : taskDetail.status === 'done' ? 'pill-ok' : '')}>
                {statusLabel(taskDetail.status)}
              </span>
            </div>
            <div className="task-detail-meta">
              <span>任务编号 {taskDetail.id.slice(0, 8)}</span>
              <span>{taskDetail.type}</span>
              <span>{taskDetail.createdAt ? new Date(taskDetail.createdAt).toLocaleString('zh-CN') : '暂无创建时间'}</span>
            </div>
            {taskDetail.error && <div className="task-detail-error">{parseJsonText(taskDetail.error).error || parseJsonText(taskDetail.error).text || taskDetail.error}</div>}
            <div className="task-detail-result">
              <TaskResultWithDownload task={taskDetail} hideDownloads onZoom={(url, name) => setLightbox({ url, name, isVideo: false })} />
            </div>
            <div className="prompt-config-actions">
              {taskDetail.status === 'done' && taskDetail.type !== 'publish' && <button type="button" className="btn-secondary" onClick={() => downloadTaskResult(taskDetail)}>下载</button>}
              <button type="button" className="btn-primary" onClick={() => setTaskDetailId('')}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function Auth() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  async function login(e) {
    e.preventDefault(); setError('');
    try {
      const r = await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const data = await readJsonResponse(r);
      if (!r.ok) throw new Error(data.error || '登录失败');
      localStorage.setItem('token', data.token);
      location.reload();
    } catch (err) { setError(err.message); }
  }
  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={login}>
        <div className="auth-brand"><div className="logo">S</div><h1>Slenk Notes</h1><p>原创笔记图工作台</p></div>
        <label>用户名<input value={username} onChange={e => setUsername(e.target.value)} placeholder="请输入用户名" required /></label>
        <label>密码<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="请输入密码" required /></label>
        {error && <p className="auth-error">{error}</p>}
        <button className="btn-primary" type="submit">登录</button>
      </form>
    </div>
  );
}
function NotePreviewPage({ noteId }) {
  const [note, setNote] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    fetch(API + '/api/notes/' + noteId).then(async r => {
      const data = await readJsonResponse(r);
      if (!r.ok) throw new Error(data.error || '加载失败');
      setNote(data.note);
    }).catch(err => setError(err.message));
  }, [noteId]);
  if (error) return <div className="note-page"><p className="auth-error">{error}</p></div>;
  if (!note) return <div className="note-page"><p>加载中...</p></div>;
  return (
    <div className="note-page">
      <article className="note-page-card">
        <div className="note-page-images">{note.images.map((img, i) => <SmartImg key={i} sources={noteImageSources(img)} alt={img.name || ('图片 ' + (i + 1))} />)}</div>
        <h1>{note.title || '笔记标题'}</h1>
        <p className="note-page-content">{note.content}</p>
        <div className="topic-tags">{note.tags.map((t, i) => <span key={i}>{'#' + t}</span>)}</div>
      </article>
    </div>
  );
}

export default function App() {
  const previewMatch = window.location.pathname.match(/^\/p\/([A-Za-z0-9_-]+)/);
  if (previewMatch) return <NotePreviewPage noteId={previewMatch[1]} />;
  const token = localStorage.getItem('token');
  if (!token) return <Auth />;
  return <Workspace token={token} />;
}
