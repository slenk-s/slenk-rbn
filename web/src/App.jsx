import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const GROUPS = [
  { id: 'ai', label: 'AI 生成', icon: '✦', tabs: [
    { id: 'ai-image', label: 'AI 生图', icon: '▧', description: '从零生成适合小红书笔记封面的原创图片。' },
    { id: 'replace-image', label: '替换生图', icon: '✦', description: '基于上传的参考图生成替换版本，适合做小红书笔记封面。' },
    { id: 'live-video', label: '实况视频', icon: '▶', description: '用本地 FFmpeg 把素材处理成带轻微运镜的实况视频。' }
  ] },
  { id: 'copy', label: '文案处理', icon: '✎', tabs: [
    { id: 'note-rewrite', label: '笔记改写', icon: '✎', description: '把笔记内容改写成更适合小红书发布的版本。' }
  ] },
  { id: 'image', label: '图片处理', icon: '▦', tabs: [
    { id: 'multiply', label: '正片叠底', icon: '◐', description: '用正片叠底思路把多张素材合成纹理/氛围层。' },
    { id: 'layout-tool', label: '排版工具', icon: '▦', description: '规划封面/内页的标题、正文、图片、贴纸位置。' }
  ] },
  { id: 'download', label: '素材下载', icon: '↓', tabs: [
    { id: 'note-download', label: '笔记下载', icon: '↓', description: '上传或粘贴笔记素材，整理成可发布的笔记包。' }
  ] }
];
const TABS = [{ id: 'dashboard', label: '仪表盘', icon: '◈', section: '设置' }, ...GROUPS.flatMap(g => g.tabs.map(t => ({ ...t, section: g.label })))];
const TYPE_TO_TAB = { rewrite: 'note-rewrite', image: 'replace-image', video: 'live-video' };
const TAB_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_TAB).map(([type, tab]) => [tab, type]));
const TEXT_TABS = new Set(['note-rewrite']);
const IMAGE_TABS = new Set(['replace-image', 'ai-image', 'layout-tool']);
const IMAGE_HEAVY_TABS = new Set(['multiply', 'layout-tool']);
const VIDEO_TABS = new Set(['live-video']);
const FILE_TABS = new Set(['note-download']);
const SECTION_HINTS = {
  'ai-image':   { options: '选择画布比例和输出数量。', text: '描述你想要的图片风格、主题和构图。', upload: '可选上传参考图，AI 会参考其风格生成。', result: '生成结果支持一键下载。' },
  'replace-image': { options: '选择画布比例和输出数量。', text: '描述替换方向：主体、背景、风格等。', upload: '上传原始参考图片，AI 将基于此生成替换版。', result: '替换版图片可下载对比。' },
  'live-video':   { options: '选择画布比例，视频时长固定 3 秒。', text: '描述想要的镜头运动方式和节奏。', upload: '上传视频素材，支持 MP4/MOV/WebM。', result: '生成的运镜视频可直接下载。' },
  'note-rewrite': { options: '选择输出画布，方便后续配图。', text: '粘贴原始笔记正文，AI 将改写成更适合小红书的版本。', upload: '可选上传配图素材。', result: '改写结果含正文、标题和标签。' },
  'multiply':     { options: '选择合成画布比例。', text: '描述叠加关系，如"底图+纹理+色块"。', upload: '上传多张素材，按顺序叠加。', result: '合成结果可下载为图片。' },
  'layout-tool':  { options: '选择目标画布尺寸。', text: '描述标题、正文、商品图、贴纸的布局。', upload: '上传需要排版的图片素材。', result: '排版规划结果可下载参考。' },
  'note-download':{ options: '选择整理画布比例。', text: '粘贴笔记链接或正文内容。', upload: '上传笔记相关文件（图片、文档等）。', result: '整理后的素材包可下载。' },
};
const PROMPTS = {
  'replace-image': '请基于上传图片生成一张可用于小红书笔记封面的替换版图片。\n保持原图主体构图和比例，替换画面中的主体/背景/商品细节，使其更符合笔记封面风格。\n要求：画面干净、视觉重点突出、不要加入无关文字、不要改变输出画幅。',
  'ai-image': '请生成一张适合小红书笔记使用的原创图片。\n要求：构图简洁、主体明确、色彩舒服、适合封面展示。\n不要加入文字，不要水印，不要乱码。',
  'live-video': '请基于上传素材生成一段自然、克制的算法运镜视频。\n镜头运动保持轻微推拉和呼吸感，适合做小红书实况封面或笔记动态预览。\n要求：不要夸张抖动，不要裁切主体，保持画面稳定。',
  'note-rewrite': '请把输入笔记改写成更自然、更适合小红书发布的版本。\n保持原意，增强画面感、真实感和代入感，不要夸大，不要营销腔过重。\n输出要求：一段正文 + 3 个可选标题 + 8 个相关标签。',
  'multiply': '请描述你希望叠加的图片关系。\n工具用途：把多张素材按正片叠底思路整理，适合做纹理、色块、氛围层。',
  'layout-tool': '请描述你要排版的标题、正文、商品图和贴纸位置。\n工具用途：先按固定画布规划封面/内页版式，再交给后续生图或编辑。',
  'note-download': '请粘贴或上传笔记素材链接/文本。\n工具用途：整理为可发布的笔记素材包，包括正文、标签、图片清单。'
};
const MOTION_EFFECTS = [
  { value: '手持轻晃', label: '手持轻晃' },
  { value: '缓慢推近', label: '缓慢推近' },
  { value: '缓慢拉远', label: '缓慢拉远' },
  { value: '轻微环绕', label: '轻微环绕' }
];
const FIXED_CANVAS = [
  { label: '不固定画布', value: '' },
  { label: '1080×1080 方形', value: '1080x1080' },
  { label: '1080×1440 竖版', value: '1080x1440' },
  { label: '1920×1080 横版', value: '1920x1080' }
];
const UPLOAD_ACCEPT = {
  image: 'image/png,image/jpeg,image/webp',
  video: 'video/mp4,video/quicktime,video/webm',
  all: 'image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm,.docx,.txt,.md'
};
const EMPTY_PROVIDER = { name: '', providerType: 'openai-compatible', appType: 'openai', baseUrl: '', apiKey: '', textModel: 'gpt-4o-mini', imageModel: 'gpt-image-1', notes: '', active: false };

function api(path, options = {}) {
  return fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}`} : {}) },
    ...options
  }).then(async r => {
    const data = await r.json().catch(() => ({}));
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
    options.push({ value: p.id + '::' + model, label: (p.name || p.id) + ' · ' + model });
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
function parseJsonText(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { text: String(raw) };
  } catch { return { text: String(raw) }; }
}
function DownloadLink({ url, label, name }) {
  const absolute = url.startsWith('http') ? url : API + url;
  return <a href={absolute} download={name || ''}><button type="button">{label}</button></a>;
}
function TaskResultWithDownload({ task }) {
  const result = parseJsonText(task.result || '');
  if (!result) return <p className="muted">{task.status === 'failed' ? parseJsonText(task.error).error : '任务还没有结果内容。'}</p>;
  if (result.text) return <><p className="result-text">{result.text}</p><div className="result-actions"><DownloadLink url={'/api/tasks/' + task.id + '/download?format=text&name=' + task.id + '-' + task.type + '.txt'} label="下载 TXT" /></div></>;
  if (result.images && Array.isArray(result.images)) return <div className="result-gallery">{result.images.map((img, i) => <figure key={i} className="result-media"><img src={API + img} alt={'AI图片结果 ' + (i + 1)} /><figcaption><DownloadLink url={img} label="下载图片" name={task.id + '-' + task.type + '-' + (i + 1) + '.png'} /></figcaption></figure>)}</div>;
  if (result.image && typeof result.image === 'string') return <figure className="result-media"><img src={API + result.image} alt="AI图片结果" /><figcaption><DownloadLink url={result.image} label="下载图片" name={task.id + '-' + task.type + '.png'} /></figcaption></figure>;
  if (result.video) return <figure className="result-media"><video controls src={API + result.video} /><figcaption><DownloadLink url={result.video} label="下载视频" name={task.id + '-' + task.type + '.mp4'} /></figcaption></figure>;
  return <pre>{JSON.stringify(result, null, 2)}</pre>;
}
function ResultEmptyState({ tabId }) {
  const hints = { 'ai-image': '🎨 提交后，生成的图片将显示在此区域，支持一键下载。', 'replace-image': '🖼️ 替换版图片将在此展示，可下载与原图对比。', 'live-video': '🎬 运镜视频将在此播放，支持预览和下载。', 'note-rewrite': '📝 改写结果将包含正文、标题和标签，可下载保存。', 'multiply': '◐ 合成结果图片将在此展示，支持下载。', 'layout-tool': '▦ 排版规划结果将在此展示，可作为设计参考。', 'note-download': '📦 整理好的素材包将在此展示，可打包下载。' };
  return <div className="result-empty-state"><div className="result-empty-icon">{hints[tabId]?.split(' ')[0]}</div><p>{hints[tabId] || '暂无结果。提交任务后会显示在这里。'}</p></div>;
}
function ProviderManager({ token, activeProviderId, providers, onProviderChange, setMessage }) {
  const [form, setForm] = useState(EMPTY_PROVIDER);
  const [editingId, setEditingId] = useState('');
  function resetForm() { setEditingId(''); setForm(EMPTY_PROVIDER); }
  function clearForm() { setEditingId(''); setForm({ ...EMPTY_PROVIDER, name: '', baseUrl: '', apiKey: '', textModel: '', imageModel: '', notes: '' }); }
  async function saveProvider(e) {
    e.preventDefault(); setMessage('正在保存供应商...');
    try {
      const endpoint = editingId ? '/api/providers/' + editingId : '/api/providers';
      const method = editingId ? 'PUT' : 'POST';
      const data = await api(endpoint, { method, token, body: JSON.stringify(form) });
      await onProviderChange(data.providers, data.activeProviderId);
      setMessage(editingId ? '供应商已更新。' : '供应商已添加。'); resetForm();
    } catch (err) { setMessage(err.message); }
  }
  function editProvider(provider) { setEditingId(provider.id); setForm({ name: provider.name, providerType: provider.providerType, appType: provider.appType, baseUrl: provider.baseUrl, apiKey: '', textModel: provider.textModel, imageModel: provider.imageModel || '', notes: provider.notes || '', active: Boolean(provider.active) }); }
  function copyProvider(provider) { const base = provider.name || '供应商'; let index = 1; let name = base + '-' + index; while (providers.some(p => p.name === name)) { index += 1; name = base + '-' + index; } setForm({ name, providerType: provider.providerType, appType: provider.appType, baseUrl: provider.baseUrl, apiKey: '', textModel: provider.textModel, imageModel: provider.imageModel || '', notes: provider.notes || '', active: false }); setEditingId(provider.id); }
  async function refreshProviders(messageText) { const next = await api('/api/providers', { token }); await onProviderChange(next.providers, next.activeProviderId); setMessage(messageText || '已切换供应商'); }
  async function activateProvider(provider) { await api('/api/providers/' + provider.id + '/active', { method: 'POST', token, body: JSON.stringify({ mode: provider.appType === 'text' ? 'text' : 'image' }) }); await refreshProviders('已切换供应商。'); }
  async function duplicateProvider() {
    if (!editingId) return;
    try {
      setMessage('正在复制供应商...');
      const created = await api('/api/providers/' + editingId + '/duplicate', { method: 'POST', token });
      await onProviderChange(created.providers, created.activeProviderId);
      setMessage('供应商已复制新增。');
      const next = created.providers.find(p => p.id === created.provider?.id);
      if (next) { setEditingId(next.id); setForm({ name: next.name, providerType: next.providerType, appType: next.appType, baseUrl: next.baseUrl, apiKey: '', textModel: next.textModel, imageModel: next.imageModel || '', notes: next.notes || '', active: false }); }
    } catch (err) { setMessage(err.message); }
  }
  const activeProvider = providers.find(p => p.id === activeProviderId);
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
          <div className="model-row"><b>默认模型</b><div className="model-wrap"><select value={form.appType === 'text' ? form.textModel : form.imageModel} onChange={e => setForm(form.appType === 'text' ? { ...form, textModel: e.target.value } : { ...form, imageModel: e.target.value })}><option value="">未选择</option><option value="gpt-4o-mini">gpt-4o-mini</option><option value="gpt-image-1">gpt-image-1</option><option value="sensenova-6.8-flash-lite">sensenova-6.8-flash-lite</option><option value="sensenova-u1.5-lite">sensenova-u1.5-lite</option></select></div></div>
          <div className="actions-row"><button type="button" className="btn-secondary" onClick={clearForm}>{editingId ? '取消编辑' : '清空'}</button><button type="button" className="btn-ghost" onClick={() => setMessage('请先在供应商配置里填写模型名称。')}>获取模型</button></div>
          <div className={editingId ? 'actions-row actions-row-bottom actions-row-edit' : 'actions-row actions-row-bottom'}><button type="submit" className="btn-primary">{editingId ? '保存修改' : '创建'}</button>{editingId && <button type="button" className="btn-ghost" onClick={duplicateProvider}>复制新增</button>}</div>
        </form>
        <div className="provider-list-block"><div className="list-head"><h3>供应商列表</h3><span className="count">{providers.length} 个</span></div><ul className="providers">{providers.map(p => <li key={p.id} className={p.id === activeProviderId ? 'active' : ''}><div className="p-name"><b>{p.name}</b><span className={"mode-tag" + (p.appType === 'text' ? '' : ' image')}>{p.appType === 'text' ? '文本' : '生图'}</span></div><div className="row-btns"><button type="button" onClick={() => editProvider(p)}>编辑</button><button type="button" className="danger" onClick={async () => { await api('/api/providers/' + p.id, { method: 'DELETE', token }); await refreshProviders('供应商已删除。'); }}>删除</button><button type="button" className={p.id === activeProviderId ? 'active' : ''} onClick={() => activateProvider(p)}>{p.id === activeProviderId ? '已启用' : '启用'}</button></div></li>)}</ul></div>
      </div>
    </section>
  );
}
function Dashboard({ token, activeProviderId, providers, onProviderChange, tasks, setMessage, selectedTaskId, onViewTask, onTaskDelete }) {
  const [manageMode, setManageMode] = useState(false);
  return (
    <section className="dashboard-settings">
      <section className="card dashboard-hero"><div className="hero-copy"><span className="eyebrow">全站设置区</span><h2>仪表盘</h2><p>集中查看运行状态，并管理 AI 供应商、本地存储、队列与视频 worker。</p></div><div className="hero-stats"><div><b>{providers.length}</b><span>供应商</span></div><div><b>{tasks.length}</b><span>任务</span></div><div><b>Local</b><span>存储</span></div></div></section>
      <div className="dashboard-row">
        <section className="card dashboard-task-list"><div className="section-head"><div><h3>任务列表</h3><p>{tasks.length ? '共 ' + tasks.length + ' 个任务，每 4 秒刷新。' : '提交任务后会在这里显示。'}</p></div><div className="section-head-actions"><button type="button" className={manageMode ? 'btn-secondary manage-active' : 'btn-secondary'} onClick={() => setManageMode(v => !v)}>{manageMode ? '完成' : '管理'}</button><button type="button" className="btn-secondary" onClick={() => setMessage('正在刷新任务...')}>刷新</button></div></div><ul className="task-list">{tasks.map(t => <li key={t.id} data-status={t.status}><div className="task-status-row"><b>{t.type}</b><span>{t.status}</span>{manageMode ? <button type="button" className="task-view-btn task-delete-btn" onClick={() => onTaskDelete && onTaskDelete(t.id)}>删除</button> : <button type="button" className="task-view-btn" onClick={() => onViewTask(t.id)}>查看</button>}</div>{t.error && <small>{parseJsonText(t.error).error}</small>}</li>)}{tasks.length === 0 && <li className="empty-task">暂无任务</li>}</ul></section>
        <ProviderManager token={token} activeProviderId={activeProviderId} providers={providers} onProviderChange={onProviderChange} setMessage={setMessage} />
      </div>
    </section>
  );
}
function NoteRewriteWorkspace({ token }) {
  const [link, setLink] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState([]);
  const [tagInput, setTagInput] = useState('');
  const [images, setImages] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [status, setStatus] = useState('');
  const [dragIndex, setDragIndex] = useState(null);
  async function api(path, options = {}) {
    return fetch(API + path, { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(options.headers || {}) }, ...options }).then(async r => { const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(data.error || r.statusText); return data; });
  }
  async function aiCall(payload, message) {
    setStatus(message);
    try {
      const data = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ type: 'rewrite', tab: 'note-rewrite', payload }) });
      const id = data.id || '';
      if (!id) throw new Error('任务创建失败');
      const started = Date.now();
      while (Date.now() - started < 60000) {
        const list = await api('/api/tasks');
        const task = list.tasks?.find(t => t.id === id);
        if (task?.status === 'done') { setStatus('AI 已返回结果，请查看任务详情或重新生成。'); return; }
        if (task?.status === 'failed') throw new Error(task.error || 'AI 生成失败');
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      throw new Error('AI 生成超时');
    } catch (err) { setStatus(err.message); }
  }
  async function identifyLink() { if (!link.trim()) return setStatus('请先粘贴笔记链接。'); await aiCall({ prompt: '请识别输入的小红书笔记链接，提取标题、正文、标签和图片 URL。输出 JSON：{"title":"","content":"","tags":[],"images":[]}', source: link.trim() }, '正在智能识别链接内容...'); }
  async function uploadImages(list) { if (!list?.length) return; const fd = new FormData(); Array.from(list).slice(0, 9).forEach(file => fd.append('file', file)); const r = await fetch(API + '/api/upload/files', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd }); const data = await r.json(); setImages(prev => { const next = [...prev]; data.files?.forEach(file => { if (!next.some(f => f.url === file.url)) next.push({ ...file, id: file.url || file.name + Date.now() }); }); return next.slice(0, 9); }); setStatus((data.files?.length || 0) + ' 张图片已添加。'); }
  function addTags() { const next = tagInput.split(/[,，\s#]+/).map(t => t.trim()).filter(Boolean); setTags(prev => [...new Set([...prev, ...next])].slice(0, 20)); setTagInput(''); }
  function restoreImage(e, index) {
    e.stopPropagation();
    setImages(prev => {
      const next = [...prev];
      const item = images[index];
      const restored = { ...item, id: (item.id || 'img') + '-restore-' + Date.now() };
      next.splice(index, 0, restored);
      return next;
    });
  }
  function toggleSelect(id) { setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]); }
  function moveImage(from, to) { if (from === to || from < 0 || to < 0) return; setImages(prev => { const next = [...prev]; const [item] = next.splice(from, 1); next.splice(to, 0, item); return next; }); }
  return (
    <section className="card note-rewrite-card">
      <div className="note-rewrite-grid">
        <div className="note-main">
          <div className="note-section smart-link">
            <div className="note-head"><div><h2>智能识别笔记链接</h2><p>输入笔记链接，智能识别参考内容：标题、正文、标签、图片</p></div><span className="pill pill-ok">AI 提取</span></div>
            <div className="note-link-row"><input value={link} onChange={e => setLink(e.target.value)} placeholder="粘贴小红书笔记链接" /><button className="btn-primary" onClick={identifyLink}>智能识别</button></div>
          </div>
          <div className="note-section fields">
            <div><label>标题</label><div className="field-meta"><span>{title.length} 字</span><button className="btn-secondary" onClick={() => aiCall({ prompt: "基于链接和正文生成 3 个小红书标题，输出 JSON titles 数组。", source: link || content }, '正在生成标题...')}>AI生成</button></div><input value={title} onChange={e => setTitle(e.target.value)} placeholder="请输入笔记标题" /></div>
            <div><label>正文</label><div className="field-meta"><span>{content.length} / 1000</span><button className="btn-secondary" onClick={() => aiCall({ prompt: PROMPTS['note-rewrite'], source: link || content || '请生成一段适合小红书发布的原创笔记正文。' }, '正在生成正文...')}>AI生成</button></div><textarea maxLength={1000} value={content} onChange={e => setContent(e.target.value)} placeholder="请输入笔记正文" /></div>
            <div>
              <label>话题标签</label>
              <div className="field-meta">
                <span>复制话题 {tags.length} 个</span>
                <button className="btn-secondary" onClick={() => navigator.clipboard?.writeText(tags.map(t => '#' + t).join(' '))}>复制话题</button>
              </div>
              <div className="tag-input-row">
                <input value={tagInput} onChange={e => setTagInput(e.target.value)} placeholder="单个或批量添加，例如：学习资料 #英语，八年级" />
                <button className="btn-secondary" onClick={addTags}>添加</button>
              </div>
              {tags.length > 0 && <div className="tag-list">{tags.map((t, i) => <span key={i} className="topic-tag">{'#' + t}<button onClick={() => setTags(tags.filter((_, idx) => idx !== i))}>×</button></span>)}</div>}
            </div>
          </div>
          <div className="note-section images">
            <div className="section-title"><h3>图片管理</h3><p>支持上传、下载、删除、还原；直接用鼠标拖动图片调整顺序，第一张默认作为封面。</p></div>
            <div className="image-toolbar"><button className="btn-secondary" onClick={() => aiCall({ prompt: '请为当前笔记生成一组适合小红书封面和内页的图片，保持风格统一。', source: title + '\n' + content }, '正在统一风格...')}>统一风格</button><span>已选 {selectedIds.length} / {images.length} 张</span><button className="btn-secondary" onClick={() => setSelectedIds(images.map(i => i.id))}>全选</button><button className="btn-secondary" onClick={() => setSelectedIds([])}>全不选</button><button className="btn-secondary" onClick={async () => { const urls = selectedIds.map(id => images.find(i => i.id === id)?.url).filter(Boolean); setStatus(urls.length ? '图片链接已复制。' : '未选择图片。'); if (urls.length) navigator.clipboard?.writeText(urls.join('\n')); }}>下载</button><label className="btn-secondary btn-upload"><input type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={e => uploadImages(e.target.files)} />上传图片</label><button className="btn-secondary" onClick={() => aiCall({ prompt: '请为当前笔记生成 1 张小红书图片，输出 JSON images。', source: title + '\n' + content }, '正在生成图片...')}>AI生成</button></div>
            <div className="image-grid">{images.map((img, index) => <figure key={img.id || index} className={'image-thumb' + (selectedIds.includes(img.id) ? ' selected' : '')} draggable onDragStart={() => setDragIndex(index)} onDragOver={e => e.preventDefault()} onDrop={() => moveImage(dragIndex, index)} onClick={() => toggleSelect(img.id)}><span className="cover-badge">封面</span><input type="checkbox" checked={selectedIds.includes(img.id)} onChange={() => toggleSelect(img.id)} /><img src={API + img.url} alt={img.name || '笔记图片'} /><figcaption><span>{img.name || '图片 ' + (index + 1)}</span><div><a href={API + img.url} download={img.name || '图片'}>下载</a><button onClick={e => { e.stopPropagation(); setImages(images.filter((_, idx) => idx !== index)); }}>删除</button><button onClick={(e) => restoreImage(e, index)}>还原</button></div></figcaption></figure>)}{images.length === 0 && <div className="empty-image">暂无图片</div>}</div>
          </div>
        </div>
        <aside className="preview-panel">
          <div className="preview-head"><h3>预览效果</h3><span>小红书样式</span></div>
          <div className="xhs-preview"><header><div className="avatar">笔记作者</div><div><b>笔记作者</b><small>{images.length} 张图片</small></div><button className="follow-btn">关注</button></header><div className="preview-images">{images.length ? images.map((img, i) => <img key={i} src={API + img.url} alt={'预览图 ' + (i + 1)} />) : <div className="no-image">暂无图片</div>}</div><h4>{title || '笔记标题'}</h4><p>{content || '笔记正文内容将显示在这里。'}</p><div className="topic-tags">{tags.map((t, i) => <span key={i}>{'#' + t}</span>)}</div></div>
          <div className="publish-actions"><button className="btn-primary" onClick={() => setStatus('当前笔记草稿已保存到前端状态：' + title + ' / ' + tags.length + ' 个标签 / ' + images.length + ' 张图片。')}>保存笔记</button><button className="btn-secondary" onClick={() => setStatus('飞书同步功能待接入当前工作台的发布 API。')}>同步飞书</button><button className="btn-secondary" onClick={() => setStatus('小红书直发二维码需接入对应发布服务后生成。')}>生成小红书直发二维码</button></div>
        </aside>
      </div>
      <footer className="status note-status">{status}</footer>
    </section>
  );
}


function Workspace({ token }) {
  const [active, setActive] = useState('dashboard');
  const [lastToolTab, setLastToolTab] = useState('replace-image');
  const [textByTab, setTextByTab] = useState({});
  const [defaultPromptByTab, setDefaultPromptByTab] = useState({});
  const [filesByTab, setFilesByTab] = useState({});
  const [noteDrafts, setNoteDrafts] = useState({});
  const [canvasSizeByTab, setCanvasSizeByTab] = useState({});
  const [outputCountByTab, setOutputCountByTab] = useState({});
  const [motionEffectByTab, setMotionEffectByTab] = useState({});
  const [durationModeByTab, setDurationModeByTab] = useState({});
  const [customDurationByTab, setCustomDurationByTab] = useState({});
  const [shakeStrengthByTab, setShakeStrengthByTab] = useState({});
  const [shakeFrequencyByTab, setShakeFrequencyByTab] = useState({});
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [lightbox, setLightbox] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [providers, setProviders] = useState([]);
  const [selectedModels, setSelectedModels] = useState({});
  const [activeProviderId, setActiveProviderId] = useState('');
  const [activeTextProviderId, setActiveTextProviderId] = useState('');
  const [activeImageProviderId, setActiveImageProviderId] = useState('');
  const [status, setStatus] = useState('');
  const activeTab = TABS.find(tab => tab.id === active) || TABS[0];
  const activeTabLabel = activeTab.label;
  const hints = SECTION_HINTS[active] || {};
  const layoutVariant = TEXT_TABS.has(active) ? 'text-focused' : IMAGE_HEAVY_TABS.has(active) ? 'image-heavy' : VIDEO_TABS.has(active) ? 'video-focused' : 'default';
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
  const files = filesByTab[active] || [];
  const noteDraft = noteDrafts[active] || { link: '', title: '', content: '', tags: [], tagInput: '', selectedImageIds: [] };
  const canvasSize = canvasSizeByTab[active] || '1080x1080';
  const outputCount = outputCountByTab[active] || '1';
  const motionEffect = motionEffectByTab[active] || '手持轻晃';
  const durationMode = durationModeByTab[active] || 'fixed';
  const customDuration = customDurationByTab[active] || '3';
  const shakeStrength = shakeStrengthByTab[active] || 0;
  const shakeFrequency = shakeFrequencyByTab[active] || 0;
  const setText = (v) => setTextByTab(prev => ({ ...prev, [active]: typeof v === 'function' ? v(prev[active] || '') : v }));
  const setNoteDraft = (v) => setNoteDrafts(prev => ({ ...prev, [active]: { ...(prev[active] || { link: '', title: '', content: '', tags: [], tagInput: '', selectedImageIds: [] }), ...(typeof v === 'function' ? v(prev[active] || { link: '', title: '', content: '', tags: [], tagInput: '', selectedImageIds: [] }) : v) } }));
  const setDefaultPrompt = (v) => setDefaultPromptByTab(prev => ({ ...prev, [active]: typeof v === 'function' ? v(prev[active] || '') : v }));
  const setFiles = (v) => setFilesByTab(prev => ({ ...prev, [active]: typeof v === 'function' ? v(prev[active] || []) : v }));
  const setCanvasSize = (v) => setCanvasSizeByTab(prev => ({ ...prev, [active]: typeof v === 'function' ? v(prev[active] || '1080x1080') : v }));
  const setOutputCount = (v) => setOutputCountByTab(prev => ({ ...prev, [active]: typeof v === 'function' ? v(prev[active] || '1') : v }));
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
  function viewTask(taskId) { setSelectedTaskId(taskId); const task = tasks.find(t => t.id === taskId); const targetTab = task ? (task.tab || TYPE_TO_TAB[task.type] || lastToolTab) : lastToolTab; clearedTabs.current.delete(targetTab); setActive(targetTab); setLastToolTab(targetTab); }
  async function uploadMany(list) {
    if (!list?.length) return;
    const fd = new FormData(); Array.from(list).forEach(file => fd.append('file', file));
    const r = await fetch(`${API}/api/upload/files`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    const data = await r.json(); const uploaded = data.files || [];
      setFiles(prev => { const seen = new Set(prev.map(f => f.url)); const next = [...prev]; for (const file of uploaded) { if (!seen.has(file.url)) next.push(file); } return next.slice(0, 9); }); setStatus((data.files?.length || 0) + ' 个素材已保存到本地存储路径。');
  }
  function submitCurrentTask() {
    const submitText = text.trim() || defaultPrompt.trim() || PROMPTS[active] || '';
    if (IMAGE_TABS.has(active)) return createTask('image', { prompt: submitText, image: files[0]?.url, imageUrls: files.map(f => f.url), canvasSize, count: Number(outputCount) || 1, providerId: selectedProviderId, model: selectedModelName });
    if (VIDEO_TABS.has(active)) {
      const duration = durationMode === 'random' ? 8 : Number(customDuration) || 3;
      return createTask('video', { prompt: submitText, mediaUrls: files.map(f => f.url), canvasSize, duration, durationMode, motionEffect, shakeStrength, shakeFrequency, providerId: selectedProviderId, model: selectedModelName });
    }
    return createTask('rewrite', { prompt: submitText, source: text.trim() || submitText, canvasSize, providerId: selectedProviderId, model: selectedModelName });
  }
  function resetPrompt() { setText(PROMPTS[active] || ''); }
  const currentTask = tasks.find(t => t.id === selectedTaskId);
  const activeMode = (TAB_TO_TYPE[active] || 'rewrite') === 'rewrite' ? 'text' : 'image';
  const selectedModel = selectedModels[active] || selectedModelValue(activeMode, providers, activeProviderId);
  const parsedSelectedModel = splitModelValue(selectedModel);
  const modeActiveProviderId = activeMode === 'text' ? (activeTextProviderId || activeProviderId) : (activeImageProviderId || activeProviderId);
  const selectedProviderId = parsedSelectedModel.providerId || modeActiveProviderId;
  const selectedModelName = parsedSelectedModel.model || (providers.find(p => p.id === selectedProviderId)?.model || '');
  
  // Extract the image/video/file input section into a variable
  const inputSection = !isTextFocused ? (
    <div className={'panel-cell' + (isImageHeavy ? ' cell-image-large' : '')}>
      <div className="cell-head"><div className="section-title-block"><h3>{isLiveVideo ? '图片输入区' : isFileFocused ? '文件输入区' : '图片输入区'}</h3><p>{hints.upload}</p></div></div>
      <div className="cell-body">
        <div className="upload-zone">
          <label className="dropzone"><input type="file" multiple accept={uploadAccept} onChange={e => uploadMany(e.target.files)} /><span>点击或拖入 {uploadLabel}，最多 9 个素材</span></label>
          <div className="file-grid file-grid-9 file-grid-strip">
            {files.map((file, index) => <figure key={file.url || index} className="file-thumb"><div className="thumb-media" onClick={() => setLightbox({ url: API + file.url, name: file.name || '素材预览', isVideo: !!(file.url && file.url.includes('/videos/')) })}>{file.url && file.url.includes('/videos/') ? <video src={API + file.url} muted /> : <img src={API + file.url} alt={file.name || '素材预览'} />}</div><figcaption><span>{file.name}</span><a href={API + file.url} download={file.name || '素材'} onClick={(e) => e.stopPropagation()}>下载</a><button type="button" className="thumb-remove" onClick={(e) => { e.stopPropagation(); setFiles(files.filter((_, i) => i !== index)); }}>移除</button></figcaption></figure>)}
            {Array.from({ length: Math.max(0, 9 - files.length) }, (_, i) => <div key={'empty-'+i} className="file-slot-empty"><span>+</span></div>)}
          </div>
        </div>
      </div>
    </div>
  ) : null;
  
  return (
    <div className="app">
      <header className="topbar"><div className="brand"><div className="logo">S</div><div><h1>Slenk Notes</h1></div></div><div className="top-actions"><div className="top-models"><span className="model-chip text">文本 {providers.find(p => p.id === (activeTextProviderId || activeProviderId))?.textModel || '未选择'}</span><span className="model-chip image">生图 {providers.find(p => p.id === (activeImageProviderId || activeProviderId))?.imageModel || '未选择'}</span><span className="model-chip page">当前 {selectedModelName || '未选择'}</span></div><button className="btn-secondary" onClick={refresh}>刷新任务</button><button className="btn-danger" onClick={() => localStorage.clear()}>退出</button></div></header>
      <div className="layout">
        <aside className="sidebar"><div className="sidebar-title"><b>工作台</b><span>{TABS.length} 个功能</span></div>
          <nav className="tabs"><button className={active === 'dashboard' ? 'active' : ''} onClick={() => setActive('dashboard')}><span className="tab-icon">◈</span><span className="tab-label">仪表盘</span></button></nav>
          {GROUPS.map(group => <div key={group.id} className="tab-group"><div className="tab-group-label"><span>{group.icon}</span>{group.label}</div><nav className="tabs">{group.tabs.map(tab => <button key={tab.id} className={tab.id === active ? 'active' : ''} onClick={() => { setActive(tab.id); setSelectedTaskId(''); }}><span className="tab-icon">{tab.icon}</span><span className="tab-label">{tab.label}</span></button>)}</nav></div>)}
        </aside>
        <main className="workspace">
          {active === 'dashboard' ? (
            <Dashboard token={token} activeProviderId={activeProviderId} activeTextProviderId={activeTextProviderId} activeImageProviderId={activeImageProviderId} providers={providers} onProviderChange={(nextProviders, nextActiveProviderId) => { setProviders(nextProviders || []); setActiveProviderId(nextActiveProviderId || ''); }} onProvidersUpdate={(data) => { setProviders(data.providers || []); setActiveProviderId(data.activeProviderId || ''); setActiveTextProviderId(data.activeTextProviderId || ''); setActiveImageProviderId(data.activeImageProviderId || ''); }} tasks={tasks} setMessage={ setStatus} selectedTaskId={selectedTaskId} onViewTask={viewTask} onTaskDelete={async (id) => { await api('/api/tasks/' + id, { method: 'DELETE', token }); await refresh(); setStatus('任务已删除。'); }} />
          ) : active === 'note-rewrite' ? (
            <NoteRewriteWorkspace token={token} />
          ) : (
            <section className={'card tool-panel layout-' + layoutVariant + ' ' + (TEXT_TABS.has(active) ? 'text-focused' : IMAGE_HEAVY_TABS.has(active) ? 'image-heavy' : VIDEO_TABS.has(active) ? 'video-focused' : 'default') + ' ' + (isTextFocused ? 'row-text-only' : '')}>
              <div className="panel-row"><div className="panel-cell panel-title-cell"><div className="title-row"><span className="title-label">{activeTabLabel}</span><div className="meta-chips"><span className="meta-chip">任务 {tasks.length}</span><span className="meta-chip provider-chip">{providers.find(p => p.id === selectedProviderId)?.name || '未配置供应商'}</span></div><div className="title-actions"><select className="model-select" value={selectedModel} onChange={e => setSelectedModels(prev => ({ ...prev, [active]: e.target.value }))} aria-label="本页模型">
  <option value={MODEL_EMPTY}>未选择</option>
  {modelOptionsFor(activeMode, providers).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
</select><button className="btn-primary action-primary" onClick={submitCurrentTask}>{IMAGE_TABS.has(active) ? '提交生成' : VIDEO_TABS.has(active) ? '提交视频任务' : '提交任务'}</button><button className="btn-secondary" onClick={resetPrompt}>重置提示词</button></div></div></div>
                <div className="panel-cell"><div className="cell-head"><div className="section-title-block"><h3>选项区</h3><p>{hints.options}</p></div></div><div className="cell-body"><div className="option-row"><select value={canvasSize} onChange={e => setCanvasSize(e.target.value)} aria-label="画布比例">{FIXED_CANVAS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>{IMAGE_TABS.has(active) && <select value={outputCount} onChange={e => setOutputCount(e.target.value)} aria-label="输出数量">{[1,2,3,4].map(n => <option key={n} value={String(n)}>{n} 张</option>)}</select>}{VIDEO_TABS.has(active) && <select value={motionEffect} onChange={e => setMotionEffect(e.target.value)} aria-label="运镜效果">{MOTION_EFFECTS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>}</div>{VIDEO_TABS.has(active) && <><div className="option-row range-row range-pair"><div className="range-item"><label className="option-label">抖动强度</label><input type="range" min="0" max="100" value={shakeStrength} onChange={e => setShakeStrength(Number(e.target.value))} style={{ '--progress': shakeStrength + '%' }} /><span className="range-value">{shakeStrength}</span></div><div className="range-item"><label className="option-label">抖动频率</label><input type="range" min="0" max="100" value={shakeFrequency} onChange={e => setShakeFrequency(Number(e.target.value))} style={{ '--progress': shakeFrequency + '%' }} /><span className="range-value">{shakeFrequency}</span></div></div><div className="option-row duration-row"><span className="option-label">视频时长</span><div className="duration-options"><label className="radio-item duration-radio"><input type="radio" name="durationMode" value="random" checked={durationMode === 'random'} onChange={e => setDurationMode(e.target.value)} /><span>随机时长</span><span className="duration-hint">上限 8 秒</span></label><label className="radio-item duration-radio"><input type="radio" name="durationMode" value="fixed" checked={durationMode === 'fixed'} onChange={e => setDurationMode(e.target.value)} /><span>定时时长</span><input type="number" className="duration-input" min="1" max="30" value={customDuration} onChange={e => setCustomDuration(e.target.value)} /><span>秒</span></label></div></div></>}</div></div></div>
              <div className='panel-row'>
                <div className={'panel-cell' + (isTextFocused ? ' cell-text-fullwidth' : '')}><div className="cell-head"><div className="section-title-block"><h3>文本输入区</h3><p>{hints.text}</p></div></div><div className="cell-body text-input-split"><div className="prompt-section"><div className="prompt-label">默认提示词</div><textarea className="prompt-default" value={defaultPrompt} onChange={e => setDefaultPrompt(e.target.value)} placeholder="暂无默认提示词" /></div><div className="prompt-section"><div className="prompt-label">用户提示词</div><textarea value={text} onChange={e => setText(e.target.value)} placeholder="在此输入或修改提示词..." /></div></div></div>
                {inputSection}
              </div>
              <div className="panel-row panel-row-result"><div className="panel-cell result-cell"><aside className="result-side"><div className="section-title-block"><h3>生成结果输出区</h3><p>{hints.result}</p></div>{currentTask ? <div className="result-meta"><span className={'pill ' + (currentTask.status === 'failed' ? 'pill-bad' : 'pill-ok')}>{currentTask.status === 'done' ? '已完成' : currentTask.status === 'failed' ? '失败' : currentTask.status === 'queued' ? '排队中' : '处理中'}</span><span className="result-meta-line">任务编号 {currentTask.id.slice(0, 8)}</span></div> : null}<div className="result-side-actions">{selectedTaskId ? <button type="button" className="btn-secondary" onClick={() => { clearedTabs.current.add(active); setSelectedTaskId(''); }}>清空选择</button> : null}</div></aside><div className="result-stage cell-body">{currentTask ? <TaskResultWithDownload task={currentTask} /> : <ResultEmptyState tabId={active} />}</div></div></div>
            </section>
          )}
        </main>
      </div>
      <footer className="status">{status}</footer>
      {lightbox && (
        <div className="lightbox-backdrop" onClick={() => setLightbox(null)}>
          <div className="lightbox-body" onClick={e => e.stopPropagation()}>
            <button type="button" className="lightbox-close" onClick={() => setLightbox(null)}>×</button>
            {lightbox.isVideo ? <video src={lightbox.url} controls autoPlay /> : <img src={lightbox.url} alt={lightbox.name} />}
            <div className="lightbox-caption">{lightbox.name}</div>
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
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '登录失败');
      localStorage.setItem('token', data.token);
      location.reload();
    } catch (err) { setError(err.message); }
  }
  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={login}>
        <div className="auth-brand"><div className="logo">S</div><h1>Slenk Notes</h1><p>原创笔记图工作台</p></div>
        <label>用户名<input value={username} onChange={e => setUsername(e.target.value)} placeholder="admin" required /></label>
        <label>密码<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="123456" required /></label>
        {error && <p className="auth-error">{error}</p>}
        <button className="btn-primary" type="submit">登录</button>
      </form>
    </div>
  );
}
export default function App() {

  const token = localStorage.getItem('token');
  if (!token) return <Auth />;
  return <Workspace token={token} />;
}
