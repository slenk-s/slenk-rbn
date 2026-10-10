const state = { tab: 'split', uploads: {}, preview: { title: '笔记标题', content: '这里显示笔记正文内容。', tags: [] } };
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const main = $('#main');
const modalBackdrop = $('#modalBackdrop');
const modalContent = $('#modalContent');

const TAB_LABELS = {
  dashboard: '仪表盘', replace: '替换生图', split: '裂变生图', video: '实况视频', download: '笔记下载', rewrite: '笔记改写', batch: '批量改写', images: 'AI图片生成', transfer: '无损快传', word: 'Word改写', compose: '正片叠底', layout: '排版工具', ppt: 'AI PPT', product: '商品下载', subtitle: '视频去字幕', script: '视频文案提取'
};

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function card({ title, desc = '', actions = '', children = '' }) {
  return `<section class="card">
    <div class="card-head"><div><div class="card-title">${title}</div><div class="card-desc">${desc}</div></div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>
    ${children}
  </section>`;
}

function dropzone(label, hint, icon = '☁') {
  return `<label class="dropzone"><span class="upload-icon">${icon}</span><strong>${label}</strong><span>${hint}</span><input type="file" hidden multiple accept="image/png,image/jpeg"></label>`;
}

function uploads(key, label, hint, icon = '☁') {
  return `<div class="field">${label}</div>${dropzone(hint, '支持 JPG、PNG', icon)}${state.uploads[key] ? uploadGrid(key) : ''}`;
}

function uploadGrid(key) {
  return `<div class="grid-uploads" data-grid="${key}">${state.uploads[key].map((f,i)=>`<div class="thumb"><img src="${f.url}" alt="${f.name}"></div>`).join('')}</div>`;
}

function serviceConfig(target = 'image') {
  openModal(`
    <div class="modal-head"><h3>${target === 'rewrite' ? '笔记改写服务配置' : '生图服务配置'}</h3><button class="close" data-close>×</button></div>
    <p class="muted small">修改后会自动保存，并立即作用于当前模块。</p>
    <div class="row grid-2">
      <div><label>文字服务</label><select><option>模型1</option></select></div>
      <div><label>文字模型</label><select><option>deepseek-v4-pro</option><option>deepseek-flash</option></select></div>
    </div>
    <div class="divider"></div>
    <div class="row grid-2">
      <div><label>生图服务</label><select><option>模型1</option></select></div>
      <div><label>生图模型</label><select><option>GPT Image 2</option><option>GPT Image 2.5</option><option>GPT Image 2 VIP</option></select></div>
    </div>
  `);
}

function editImageConfig() {
  openModal(`
    <div class="modal-head"><h3>编辑单图生成</h3><button class="close" data-close>×</button></div>
    <p class="muted">描述第 1 张图片的生成方向。</p>
    <div class="row grid-2">
      <textarea>严格基于输入图片进行清晰度增强和轻微美化。

要求：
1. 必须保留原图主体内容、题目、答案、知识点、排版结构和页面布局一致
2. 不得新增、删除、替换、改写任何文字，不得生成其他讲义、其他题目或其他页面
3. 只允许增强清晰度、对比度、纸张质感、轻微去噪、色彩校正和边缘锐化
4. 色彩自然，避免过度滤镜、夸张锐化或明显 AI 感
5. 不添加水印、二维码、平台 UI、无关 logo 或无关文字
6. 直接输出处理后的图片</textarea>
      <div class="dropzone"><span class="upload-icon">+</span><strong>上传参考图</strong><span>学习图片风格</span></div>
    </div>
    <div class="status-strip"><span class="muted">213 字</span><div class="actions"><button class="btn gray" data-close>取消</button><button class="btn orange" data-close>立即生成</button></div></div>
  `);
}

function openModal(html) {
  modalContent.innerHTML = html;
  modalBackdrop.classList.remove('hidden');
}
function closeModal() { modalBackdrop.classList.add('hidden'); }

function renderDashboard() {
  main.innerHTML = `
    ${card({ title:'工作台', desc:'快速查看常用功能与账号状态。', actions:`<button class="btn primary" data-open-service>服务配置</button>` })}
    <div class="row grid-3">
      ${['仪表盘','替换生图','裂变生图','实况视频','笔记改写','AI图片生成','Word改写','排版工具','AI PPT','视频文案提取','无损快传','正片叠底'].map(x=>`<button class="card" style="cursor:pointer" data-goto="${x}">${x}</button>`).join('')}
    </div>`;
}

function renderReplace() {
  main.innerHTML = `
    <div class="hint">批量替换文档内容并生成图片</div>
    ${card({ title:'替换生图', desc:'建议上传主体清晰、角度接近的商品图和样例图，可显著提高替换对齐效果。', actions:`<span class="chip">生图：模型1 / GPT Image 2</span><button class="btn" data-open-service>服务配置</button>`, children:`
      <div class="row grid-2">
        <div><label>目标图（可选，单张）</label>${dropzone('点击或拖拽上传目标图','不上传则仅用样例图与提示词','🖼')}</div>
        <div><label>样例图（支持多张，JPG/PNG）</label>${dropzone('点击或拖拽上传样例图','支持 JPG、PNG 格式','＋')}</div>
      </div>
    `})}
    ${card({ title:'替换提示词', desc:'上传目标图时：图1是目标商品参考图，图2及之后是待替换的样例图。', actions:`<button class="btn ghost small">恢复默认提示词</button>`, children:`<textarea>${'上传目标图时：图1是目标商品参考图，图2及之后是待替换的样例图；未上传目标图时：图1及之后是待处理样例图。对每张样例图，严格保持原图的场景、构图、镜头角度、光影、透视、画布尺寸与比例不变；仅将样例图中的原商品替换为目标商品，并让目标商品对齐原商品的相同中心位置、相同占画面比例、相同朝向/角度和相同遮挡关系，不要上下移、左右偏移、放大或缩小、边缘自然融合，去除原文字水印，不新增文字/水印。'}</textarea>`})}
    <div class="status-strip"><button class="btn gray" disabled>批量生成</button><button class="btn">全选替换结果</button></div>`;
}

function renderSplit() {
  main.innerHTML = `
    <div class="hint">一篇文章生成多风格笔记图片</div>
    ${card({ title:'裂变功能默认设置', desc:'用于生成多风格笔记图片与裂变变体。', actions:`<button class="btn ghost small">恢复默认提示词</button><span class="chip">生图：模型1 / GPT Image 2</span><button class="btn" data-open-service>服务配置</button>`, children:`
      <div class="row grid-2">
        <div><label>每张参考图生成变体数量</label><input value="3"><div class="help">默认 3，最大支持 6 张</div></div>
        <div><label>用于生图文本提取的默认提示词</label><textarea>请仅输出中文提示词正文，完整描述图中主体、构图、场景、光线、材质、色彩、氛围与风格；不要前言解释、不要标题、不要英文。</textarea></div>
      </div>
      <div class="divider"></div>
      <div><label>用于裂变生成的默认提示词</label><textarea>通过改变图片的角度，不要改变产品大小、产品的摆放角度方式、产品的展示数量背景，可以修改背景，背景可以参考原图背景逻辑，可以加一些适用的小道具或者装饰，不要被检测到同质化了。</textarea></div>
    `})}
    <div class="status-strip"><span class="muted">当前使用替换阶段带入的图片进行裂变（0 张）。</span><button class="btn primary">我要上传并开始新的裂变任务</button></div>
    ${dropzone('点击或拖拽上传更多输入图','支持 JPG、PNG，可与替换生图带入结果混合裂变')}`;
}

function renderVideo() {
  main.innerHTML = `
    <div class="hint">上传素材图，生成产品实况展示视频</div>
    ${card({ title:'爆款生图神器 · 视频生成', desc:'本地算法生成轻运镜短视频，不调用 AI 模型。', actions:`<div class="actions"><button class="btn orange">算法运镜视频</button><button class="btn">AI实况视频</button></div>`, children:`<label>素材图（每张都会生成一个视频）</label>${dropzone('点击上传或拖拽图片到此处','支持 JPG、PNG 格式；算法运镜单次最多 10 张')}</div>`})}
    ${card({ title:'运镜效果', desc:'支持手持轻晃、推进、拉远、平移和轻微漂移等基础运镜。', children:`<select><option>手持轻晃</option><option>推进</option><option>拉远</option><option>平移</option><option>轻微漂移</option></select>`})}
    <div class="status-strip"><label>抖动强度</label><input type="range" value="35"><span class="chip">35 / 100</span><label>抖动频率</label><input type="range" value="45"><span class="chip">45 / 100</span></div>`;
}

function renderRewrite() {
  main.innerHTML = `
    <div class="hint">整理标题、正文、话题和图片顺序，预览发布效果</div>
    <div class="split-layout">
      <div class="main">
        ${card({ title:'笔记改写', desc:'整理标题、正文、话题和图片顺序，右侧实时预览发布效果。', actions:`<button class="btn" data-open-service>服务配置</button><button class="btn">提示词配置</button><button class="btn">复制完整文案</button>`, children:`
          <div><label>输入笔记链接，智能识别参考内容：标题 / 正文 / 标签 / 图片</label><div class="row grid-2"><input placeholder="粘贴小红书笔记链接"><button class="btn primary">智能识别</button></div></div>
          <div class="divider"></div>
          <div><label>标题</label><input id="noteTitle" value="${state.preview.title}"></div>
          <div class="divider"></div>
          <div><label>正文</label><textarea id="noteContent" maxlength="1000">${state.preview.content}</textarea></div>
          <div class="divider"></div>
          <div><label>话题标签</label><input id="noteTags" value="${state.preview.tags.join(' #')}"></div>
        `})}
        ${card({ title:'图片管理', desc:'支持上传、下载、删除、还原，直接用鼠标拖动图片调整顺序。', actions:`<button class="btn ghost">统一风格</button><button class="btn">AI生成</button>`, children:`<div class="grid-uploads"><div class="thumb">暂无图片</div></div>`})}
      </div>
      <aside>
        ${card({ title:'预览效果', desc:'小红书样式', children:`<div class="phone"><div class="phone-header"><div style="display:flex;gap:8px;align-items:center"><span class="avatar"></span><b>笔记作者</b></div><span class="badge">关注</span></div><div class="phone-body" id="previewEmpty">暂无图片</div><div class="phone-footer"><b id="previewTitle">${state.preview.title}</b><p class="muted small" id="previewContent">${state.preview.content}</p></div></div>`})}
      </aside>
    </div>`;
  $('#noteTitle').oninput = e => { state.preview.title = e.target.value; $('#previewTitle').textContent = e.target.value; };
  $('#noteContent').oninput = e => { state.preview.content = e.target.value; $('#previewContent').textContent = e.target.value; };
  $('#noteTags').oninput = e => state.preview.tags = e.target.value.split('#').map(x=>x.trim()).filter(Boolean);
}

function renderSimple(name, desc = '工具原型入口，后续可接入具体业务逻辑。') {
  main.innerHTML = card({ title: name, desc, actions:`<button class="btn" data-open-service>服务配置</button>`, children:`<div class="dropzone"><span class="upload-icon">＋</span><strong>${name}</strong><span>可在此接入上传、参数配置与结果下载</span></div>` });
}

function render() {
  $$('#tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
  if (state.tab === 'dashboard') return renderDashboard();
  if (state.tab === 'replace') return renderReplace();
  if (state.tab === 'split') return renderSplit();
  if (state.tab === 'video') return renderVideo();
  if (state.tab === 'rewrite') return renderRewrite();
  renderSimple(TAB_LABELS[state.tab] || state.tab);
}

$('#tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  state.tab = btn.dataset.tab;
  render();
});

document.addEventListener('click', e => {
  const close = e.target.closest('[data-close]');
  if (close) return closeModal();
  const service = e.target.closest('[data-open-service]');
  if (service) return serviceConfig();
  const goto = e.target.closest('[data-goto]');
  if (goto) {
    const target = [...$('#tabs').children].find(x => x.textContent.trim() === goto.dataset.goto);
    if (target) { state.tab = target.dataset.tab; render(); }
  }
});

modalBackdrop.addEventListener('click', e => { if (e.target === modalBackdrop) closeModal(); });

document.addEventListener('change', e => {
  const fileInput = e.target.closest('input[type="file"]');
  if (!fileInput) return;
  const reader = new FileReader();
  reader.onload = () => fileInput.parentElement.insertAdjacentHTML('beforeend', `<div class="thumb"><img src="${reader.result}"></div>`);
  reader.readAsDataURL(fileInput.files[0]);
});

render();
