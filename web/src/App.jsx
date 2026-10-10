import { useState } from 'react';
import './App.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const TABS = ['仪表盘','替换生图','裂变生图','实况视频','笔记下载','笔记改写','批量改写','AI图片生成','无损快传','Word改写','正片叠底','排版工具','AI PPT','商品下载','视频去字幕','视频文案提取'];

function api(path, options = {}) {
  return fetch(`${API}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
    },
    ...options
  }).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  });
}

function Auth() {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    setErr('');
    try {
      const data = await api(mode === 'login' ? '/api/auth/login' : '/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
      localStorage.setItem('token', data.token);
      setToken(data.token);
    } catch (e) {
      setErr(e.message);
    }
  }

  if (token) {
    return <div className="auth-ok">已登录，正在进入工作台…</div>;
  }

  return (
    <form className="auth" onSubmit={submit}>
      <h1>原创笔记图工作台</h1>
      <div className="tabs-small">
        <button type="button" className={mode==='login' ? 'active':''} onClick={() => setMode('login')}>登录</button>
        <button type="button" className={mode==='register' ? 'active':''} onClick={() => setMode('register')}>注册</button>
      </div>
      <input placeholder="邮箱" value={email} onChange={e=>setEmail(e.target.value)} />
      <input placeholder="密码" type="password" value={password} onChange={e=>setPassword(e.target.value)} />
      {err && <div className="err">{err}</div>}
      <button className="btn-primary">{mode === 'login' ? '登录' : '注册'}</button>
      <p className="muted">真实账号体系：后端 SQLite + JWT + bcrypt</p>
    </form>
  );
}

function UploadZone({ label, value, onValue }) {
  return (
    <label className="dropzone">
      <span>{label}</span>
      <input type="file" accept="image/png,image/jpeg" onChange={async e => {
        const file = e.target.files[0];
        if (!file) return;
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch(`${API}/api/upload/file`, { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }, body: fd });
        const data = await res.json();
        onValue(data.url);
      }} />
    </label>
  );
}

function ToolPanel({ token, active }) {
  const [text, setText] = useState('');
  const [target, setTarget] = useState('');
  const [sample, setSample] = useState('');
  const [status, setStatus] = useState('');
  const [tasks, setTasks] = useState([]);

  async function refresh() {
    const data = await api('/api/tasks', { token });
    setTasks(data.tasks || []);
  }

  async function createTask(type, payload) {
    setStatus('已提交任务，后端排队中…');
    await api('/api/tasks', { method: 'POST', token, body: JSON.stringify({ type, payload }) });
    await refresh();
  }

  return (
    <div className="workspace">
      <section className="card">
        <h2>{active}</h2>
        <p className="muted">这里接入真实 AI API、文件存储和任务队列。</p>
        <div className="grid">
          <div>
            <label>提示词 / 文案</label>
            <textarea value={text} onChange={e=>setText(e.target.value)} placeholder="粘贴笔记正文、图片要求或改写要求" />
          </div>
          <div>
            <label>输入图</label>
            <UploadZone label="点击上传参考图" value={target} onValue={setTarget} />
            {target && <img src={`${API}${target}`} />}
          </div>
        </div>
        <div className="actions">
          <button className="btn-primary" onClick={()=>createTask('image', { prompt: text, image: target })}>生成图片</button>
          <button className="btn-secondary" onClick={()=>createTask('rewrite', { prompt: text, source: text })}>改写文本</button>
          <button className="btn-secondary" onClick={()=>createTask('video', { mediaUrls: [target], motion:'手持轻晃', duration:3 })}>生成视频</button>
        </div>
      </section>

      <section className="card tasks">
        <h3>任务队列</h3>
        <button onClick={refresh}>刷新</button>
        <ul>
          {tasks.map(t => <li key={t.id}><b>{t.type}</b> {t.status} {t.error ? t.error : ''}</li>)}
        </ul>
      </section>
      <div className="status">{status}</div>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [active, setActive] = useState(TABS[2]);
  const [me, setMe] = useState(null);

  if (!token) return <Auth />;

  return (
    <div className="app">
      <header className="topbar">
        <div><h1>天寻AI原创笔记图生成器</h1><p>账号体系 + AI API + 文件存储 + 任务队列</p></div>
        <div className="top-actions">
          <button className="btn-secondary" onClick={async () => { const d = await api('/api/auth/me', { token }); setMe(d.user); }}>用户</button>
          <button className="btn-danger" onClick={() => localStorage.clear()}>退出</button>
        </div>
      </header>
      <nav className="tabs">{TABS.map(t => <button key={t} className={t===active?'active':''} onClick={() => setActive(t)}>{t}</button>)}</nav>
      <main><ToolPanel token={token} active={active} /></main>
    </div>
  );
}
