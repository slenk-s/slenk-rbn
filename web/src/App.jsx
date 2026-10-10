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
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('123456');
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    setErr('');
    try {
      const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      location.reload();
    } catch (e) {
      setErr(e.message);
    }
  }

  return (
    <form className="auth">
      <h1>原创笔记图工作台</h1>
      <p className="muted">账号：admin  密码：123456</p>
      <input placeholder="账号" value={username} onChange={e => setUsername(e.target.value)} />
      <input placeholder="密码" type="password" value={password} onChange={e => setPassword(e.target.value)} />
      {err && <div className="err">{err}</div>}
      <button className="btn-primary">登录</button>
    </form>
  );
}

function Workspace({ token }) {
  const [active, setActive] = useState(TABS[2]);
  const [text, setText] = useState('');
  const [fileUrl, setFileUrl] = useState('');
  const [tasks, setTasks] = useState([]);
  const [status, setStatus] = useState('');

  async function refresh() {
    const data = await api('/api/tasks', { token });
    setTasks(data.tasks || []);
  }

  async function createTask(type, payload) {
    setStatus('任务已提交到 Redis 队列。');
    await api('/api/tasks', { method: 'POST', token, body: JSON.stringify({ type, payload }) });
    await refresh();
  }

  return (
    <div className="app">
      <header className="topbar">
        <div><h1>天寻AI原创笔记图生成器</h1><p>SenseNova + Redis + FFmpeg + 本地存储</p></div>
        <div className="top-actions">
          <button className="btn-secondary" onClick={refresh}>刷新任务</button>
          <button className="btn-danger" onClick={() => localStorage.clear()}>退出</button>
        </div>
      </header>
      <nav className="tabs">{TABS.map(t => <button key={t} className={t===active?'active':''} onClick={() => setActive(t)}>{t}</button>)}</nav>
      <main className="workspace">
        <section className="card">
          <h2>{active}</h2>
          <label>提示词 / 笔记正文</label>
          <textarea value={text} onChange={e => setText(e.target.value)} placeholder="输入图片生成、文案改写或视频生成要求" />
          <div className="grid">
            <label>输入图</label>
            <input type="file" accept="image/png,image/jpeg" onChange={async e => {
              const file = e.target.files[0];
              if (!file) return;
              const fd = new FormData();
              fd.append('file', file);
              const r = await fetch(`${API}/api/upload/file`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
              const data = await r.json();
              setFileUrl(data.url);
              setStatus('文件已保存到本地存储路径。');
            }} />
            {fileUrl && <img src={`${API}${fileUrl}`} />}
          </div>
          <div className="actions">
            <button className="btn-primary" onClick={() => createTask('image', { prompt: text, image: fileUrl })}>生成图片</button>
            <button className="btn-secondary" onClick={() => createTask('rewrite', { prompt: text, source: text })}>SenseNova 改写</button>
            <button className="btn-secondary" onClick={() => createTask('video', { mediaUrls: [fileUrl], motion: '手持轻晃', duration: 3, shakeStrength: 35, shakeFrequency: 45 })}>生成实况视频</button>
          </div>
        </section>
        <section className="card tasks">
          <h3>任务队列</h3>
          <ul>{tasks.map(t => <li key={t.id}><b>{t.type}</b> {t.status} {t.error ? ` - ${t.error}` : ''}</li>)}</ul>
        </section>
        <div className="status">{status}</div>
      </main>
    </div>
  );
}

export default function App() {
  const token = localStorage.getItem('token');
  if (!token) return <Auth />;
  return <Workspace token={token} />;
}
