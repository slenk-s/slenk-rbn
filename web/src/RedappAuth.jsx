import { useCallback, useEffect, useRef, useState } from 'react';
import {
  accountDisplayName,
  accountLoginHint,
  accountStatusLabel,
  createRedappAuthClient,
  REDAPP_GATED_ACTION_DEADLINE_MS
} from './redappAuthFlow.js';
import {
  boundedSessionError,
  dashboardPollFailureDisposition,
  fetchWithDeadline,
  focusNavigationIndex,
  formatAuthExpiry,
  formatRemainingTime,
  safeAuthorizeUrl,
  safeQrImage
} from './redappAuthUi.js';

const TERMINAL_STATUSES = new Set(['done', 'failed', 'expired', 'cancelled', 'not-found', 'timeout', 'cancel-not-applied', 'publish-uncertain', 'publish-restart-unknown', 'publish-outcome-unknown', 'publish-failed']);
const SESSION_LABELS = {
  waiting_prompt: '正在准备授权信息', waiting_scan: '等待手机确认', done: '授权成功',
  failed: '授权失败', expired: '授权已过期', cancelled: '授权已取消', 'not-found': '授权会话已失效',
  timeout: '授权等待已超时', 'cancel-not-applied': '正在查询发布结果',
  'publish-uncertain': '发布结果待确认', 'publish-restart-unknown': '原任务结果未知', 'publish-outcome-unknown': '上传结果未知', 'publish-failed': '发布失败'
};
const SESSION_GUIDANCE = {
  done: '授权已完成，正在刷新账号状态。', failed: '本次授权未完成，请查看原因后重试。',
  expired: '授权信息已过期，请重新发起授权。', cancelled: '本次授权已取消，可在需要时重新发起。',
  'not-found': '服务器已找不到本次授权会话，请重新发起授权。',
  timeout: '授权等待已超时，请重新发起授权。',
  'cancel-not-applied': '授权已完成，正在查询同一次发布结果。',
  'publish-uncertain': '服务端可能仍在发布，请查询同一次发布结果。',
  'publish-restart-unknown': '服务已重启，无法确认原任务结果；核对小红书小工具预览记录后，可确认风险并重新发布。',
  'publish-outcome-unknown': '上传可能已生效。请先检查小红书小工具上传记录和预览记录，再确认是否重新发布。',
  'publish-failed': '本次发布已失败，笔记内容仍保留，可重新提交。'
};
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useCurrentTime(enabled, initialNow) {
  const [now, setNow] = useState(() => initialNow ?? Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

function waitForNextPoll(signal, delayMs = 1500) {
  if (signal.aborted) return Promise.reject(Object.assign(new Error('cancelled'), { code: 'AUTH_POLL_CANCELLED' }));
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('cancelled'), { code: 'AUTH_POLL_CANCELLED' })); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// options.deadlineMs 覆盖默认 20s 截止：账号/登录/取消/退出等服务端动作要等待
// 版本门禁（180s）+ CLI（120s），必须给宽截止；会话轮询 GET 保持小截止。
function createFetchAdapter(apiBase, token, getSignal) {
  return (path, options = {}) => {
    const { deadlineMs, ...init } = options;
    return fetchWithDeadline(fetch, apiBase + path, {
      ...init,
      signal: typeof getSignal === 'function' ? getSignal() : getSignal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) }
    }, deadlineMs ?? 20_000);
  };
}

export function RedappAuthModal({ session, mode = 'manage', onClose, onCancel, onRetry, onRefreshStatus, cancelling, refreshing }) {
  const dialogRef = useRef(null);
  const openerRef = useRef(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  const terminal = TERMINAL_STATUSES.has(session?.status);
  const now = useCurrentTime(Number.isFinite(session?.expiresAt) && !terminal);

  useEffect(() => {
    openerRef.current = document.activeElement;
    const dialog = dialogRef.current;
    const focusables = dialog ? [...dialog.querySelectorAll(FOCUSABLE)] : [];
    (focusables[0] || dialog)?.focus();
    const onKeyDown = event => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll(FOCUSABLE)];
      if (!items.length) { event.preventDefault(); dialog.focus(); return; }
      const current = items.indexOf(document.activeElement);
      event.preventDefault();
      items[focusNavigationIndex(current, items.length, event.shiftKey ? -1 : 1)].focus();
    };
    dialog?.addEventListener('keydown', onKeyDown);
    return () => {
      dialog?.removeEventListener('keydown', onKeyDown);
      openerRef.current?.focus?.();
    };
  }, []);

  if (!session) return null;
  const qrImage = safeQrImage(session.qrImage);
  const authorizeUrl = safeAuthorizeUrl(session.authorizeUrl);
  const active = session.status === 'waiting_prompt' || session.status === 'waiting_scan';
  const sessionError = boundedSessionError(session.error);

  return (
    <div className="prompt-config-backdrop auth-qr-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} tabIndex={-1} className="prompt-config-modal auth-qr-modal" role="dialog" aria-modal="true" aria-labelledby="redapp-auth-title">
        <button type="button" className="prompt-config-close" onClick={onClose} aria-label="关闭授权窗口">×</button>
        <div className="auth-modal-heading">
          <div><h3 id="redapp-auth-title">连接小红书</h3><p>请使用手机完成授权。关闭此窗口不会取消正在进行的授权。</p></div>
          <span className={'auth-session-state ' + (terminal ? 'terminal' : 'active')} role="status">{SESSION_LABELS[session.status] || '等待授权'}</span>
        </div>
        {terminal ? (
          <div className="auth-terminal-panel">
            <p>{mode === 'resume-publish' && session.status === 'done'
              ? '授权成功，正在继续发布…'
              : SESSION_GUIDANCE[session.status]}</p>
            {session.refreshError ? <p className="auth-card-error" role="alert">{session.refreshError}</p> : null}
            {sessionError ? <p className="auth-card-error" role="alert">{sessionError}</p> : null}
          </div>
        ) : (
          <div className="auth-modal-content">
            {qrImage ? <img className="auth-qr-image" src={qrImage} alt="小红书授权二维码" /> : <div className="auth-qr-placeholder">授权二维码准备中</div>}
            <div className="auth-modal-details">
              <div className="auth-countdown"><span>剩余时间</span><b>{formatRemainingTime(session.expiresAt, now)}</b></div>
              {session.userCode ? <div className="auth-user-code"><span>授权码</span><strong>{session.userCode}</strong></div> : null}
              {authorizeUrl ? <a className="auth-authorize-link" href={authorizeUrl} target="_blank" rel="noreferrer">在浏览器中打开授权页面</a> : null}
              <p className="auth-modal-tip">授权只会更新当前账号的凭证，不影响你的其他账号。</p>
            </div>
          </div>
        )}
        <div className="prompt-config-actions auth-modal-actions">
          {mode !== 'resume-publish' && session.status === 'done' && session.refreshError ? <button type="button" className="btn-primary" disabled={refreshing} onClick={onRefreshStatus}>{refreshing ? '刷新中…' : '刷新授权状态'}</button> : null}
          {terminal && session.status !== 'done' && onRetry ? <button type="button" className="btn-primary" onClick={onRetry}>{mode === 'resume-publish' && session.status === 'publish-uncertain' ? '查询发布结果' : mode === 'resume-publish' && ['publish-restart-unknown', 'publish-outcome-unknown'].includes(session.status) ? '我已核对，允许重新发布' : '重新授权'}</button> : null}
          {active ? <button type="button" className="btn-danger" disabled={cancelling} onClick={onCancel}>{cancelling ? '取消中…' : '取消本次授权'}</button> : null}
          <button type="button" className="btn-secondary" onClick={onClose}>关闭窗口</button>
        </div>
      </section>
    </div>
  );
}

// 账号列表卡片：每个 Slenk 用户管理自己的小红书账号（含待绑定条目），互不影响。
// 同一时刻全卡片只保留一个进行中的扫码会话（服务端也限制同用户单会话）。
export function RedappAuthCard({ apiBase, token, setMessage }) {
  const mounted = useRef(false);
  const pollController = useRef(null);
  const operationController = useRef(null);
  const [accounts, setAccounts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState('');
  const [error, setError] = useState('');
  const [session, setSession] = useState(null); // { ...session, accountId }
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmLogoutId, setConfirmLogoutId] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteCredentials, setDeleteCredentials] = useState(true);

  const makeClient = useCallback(signal => createRedappAuthClient({
    api: createFetchAdapter(apiBase, token, signal), pollMs: 1500
  }), [apiBase, token]);

  const beginOperation = useCallback(({ abortPoll = false } = {}) => {
    operationController.current?.abort();
    if (abortPoll) pollController.current?.abort();
    const controller = new AbortController();
    operationController.current = controller;
    return { controller, client: makeClient(controller.signal) };
  }, [makeClient]);

  const refreshAccounts = useCallback(async ({ quiet = false } = {}) => {
    const { controller, client } = beginOperation();
    if (!quiet) setLoading(true);
    try {
      const list = await client.listAccounts({ deadlineMs: REDAPP_GATED_ACTION_DEADLINE_MS });
      if (!mounted.current || controller.signal.aborted) return null;
      setAccounts(Array.isArray(list) ? list : []);
      setError('');
      return list;
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted && cause?.name !== 'AbortError') {
        setAccounts(null);
        setError('无法读取账号列表，请稍后重试。');
      }
      return null;
    } finally {
      if (mounted.current && !controller.signal.aborted) setLoading(false);
    }
  }, [beginOperation]);

  useEffect(() => {
    mounted.current = true;
    const kickoff = setTimeout(() => refreshAccounts(), 0);
    return () => {
      clearTimeout(kickoff);
      mounted.current = false;
      operationController.current?.abort();
      pollController.current?.abort();
    };
  }, [refreshAccounts]);

  // 「退出」两步确认：第一次进入待确认态，5 秒内未二次点击自动复位。
  useEffect(() => {
    if (!confirmLogoutId) return undefined;
    const timer = setTimeout(() => setConfirmLogoutId(''), 5000);
    return () => clearTimeout(timer);
  }, [confirmLogoutId]);

  const sessionId = session?.sessionId;
  const sessionAccountId = session?.accountId;
  useEffect(() => {
    if (!sessionId) return undefined;
    pollController.current?.abort();
    const controller = new AbortController();
    pollController.current = controller;
    const client = makeClient(controller.signal);
    const alive = () => mounted.current && !controller.signal.aborted;
    const budgetAt = Date.now() + 10 * 60 * 1000;
    let transientFailures = 0;

    async function finishDone(current) {
      // 扫码成功后服务端已完成自动匹配/落库；无论成功、冲突还是异常都刷新列表
      // （冲突时本次待绑定行已被服务端清理）。
      let list = null;
      try { list = await client.listAccounts({ deadlineMs: REDAPP_GATED_ACTION_DEADLINE_MS }); } catch { list = null; }
      if (!alive()) return;
      if (Array.isArray(list)) { setAccounts(list); setLoading(false); }
      const match = current?.auth?.match;
      setSession(null);
      setModalOpen(false);
      setMessage?.(match?.conflict === true
        ? '这个账号之前已经绑定过，已复用现有绑定。'
        : match && match.matched === false
          ? '扫码成功，但账号绑定结果异常，请刷新账号列表确认。'
          : '小红书账号授权成功。');
    }

    async function pollExactSession() {
      while (!controller.signal.aborted) {
        try {
          const current = await client.session(sessionId, { accountId: sessionAccountId });
          if (!alive() || current?.sessionId !== sessionId) return;
          transientFailures = 0;
          if (current.status === 'done') { await finishDone(current); return; }
          setSession(previous => previous?.sessionId === sessionId ? { ...previous, ...current, accountId: sessionAccountId } : previous);
          if (TERMINAL_STATUSES.has(current.status)) return;
          if (current.status !== 'waiting_prompt' && current.status !== 'waiting_scan') {
            setSession(previous => previous?.sessionId === sessionId ? { ...previous, status: 'failed', error: '收到未知授权状态。' } : previous);
            return;
          }
          await waitForNextPoll(controller.signal);
        } catch (cause) {
          if (!alive()) return;
          const disposition = dashboardPollFailureDisposition(cause);
          if (disposition === 'abort') return;
          if (disposition === 'not-found') {
            setSession(previous => previous?.sessionId === sessionId ? { ...previous, status: 'not-found', error: boundedSessionError(cause?.message) } : previous);
            return;
          }
          transientFailures += 1;
          if (Date.now() >= budgetAt) {
            setSession(previous => previous?.sessionId === sessionId ? { ...previous, status: 'failed', error: boundedSessionError(cause?.message) } : previous);
            return;
          }
          const waited = await waitForNextPoll(controller.signal, Math.min(1500 * transientFailures, 5000)).then(() => true, () => false);
          if (!waited) return;
        }
      }
    }
    pollExactSession();
    return () => controller.abort();
  }, [makeClient, sessionId, sessionAccountId, setMessage]);

  async function startScan(account) {
    if (!account?.id || busyAction) return;
    setError('');
    setConfirmLogoutId('');
    if (session && !TERMINAL_STATUSES.has(session.status)) { setModalOpen(true); return; }
    const { controller, client } = beginOperation();
    setBusyAction(`login:${account.id}`);
    try {
      const next = await client.login({ accountId: account.id, deadlineMs: REDAPP_GATED_ACTION_DEADLINE_MS });
      if (!mounted.current || controller.signal.aborted) return;
      setSession({ ...next, accountId: account.id });
      setModalOpen(true);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted && cause?.name !== 'AbortError') {
        setError(cause?.code === 'XHS_LOGIN_BUSY'
          ? '已有一个扫码授权在进行，请先完成或取消它。'
          : '无法开始授权，请确认 redapp CLI 可用后重试。');
      }
    } finally {
      if (mounted.current) setBusyAction('');
    }
  }

  // 添加账号：先创建待绑定行（列表立即出现「待绑定」条目），随后立即对该账号发起扫码。
  async function addAccount() {
    if (busyAction) return;
    setError('');
    const { controller, client } = beginOperation();
    setBusyAction('create');
    let created = null;
    try {
      created = await client.createAccount({ deadlineMs: REDAPP_GATED_ACTION_DEADLINE_MS });
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted && cause?.name !== 'AbortError') {
        setError('无法创建账号，请稍后重试。');
      }
    }
    if (!mounted.current) return;
    setBusyAction('');
    if (!created?.id) return;
    await refreshAccounts({ quiet: true });
    await startScan({ id: created.id, status: 'pending_bind' });
  }

  async function cancelSession() {
    const cancelling = session;
    if (!cancelling?.sessionId || busyAction) return;
    const { controller, client } = beginOperation();
    setBusyAction('cancel');
    setError('');
    try {
      const cancelled = await client.cancel(cancelling.sessionId, { accountId: cancelling.accountId, deadlineMs: REDAPP_GATED_ACTION_DEADLINE_MS });
      if (!mounted.current || controller.signal.aborted || cancelled?.sessionId !== cancelling.sessionId) return;
      pollController.current?.abort();
      if (cancelled.status === 'done') {
        // 取消未生效（授权已完成）：按完成处理，刷新账号列表。
        setSession(null);
        setModalOpen(false);
        const list = await refreshAccounts({ quiet: true });
        if (list) setMessage?.('授权已完成，账号状态已刷新。');
        return;
      }
      setSession(previous => previous?.sessionId === cancelling.sessionId
        ? { ...previous, ...cancelled, accountId: cancelling.accountId }
        : previous);
    } catch {
      if (mounted.current && !controller.signal.aborted) setError('取消授权失败，当前授权可能仍在进行。');
    } finally {
      if (mounted.current) setBusyAction('');
    }
  }

  async function logoutAccount(account) {
    if (!account?.id || busyAction) return;
    if (confirmLogoutId !== account.id) { setConfirmLogoutId(account.id); return; }
    setConfirmLogoutId('');
    const { controller, client } = beginOperation({ abortPoll: session?.accountId === account.id });
    setBusyAction(`logout:${account.id}`);
    setError('');
    try {
      await client.logout({ accountId: account.id, deadlineMs: REDAPP_GATED_ACTION_DEADLINE_MS });
      if (!mounted.current) return;
      if (session?.accountId === account.id) { setSession(null); setModalOpen(false); }
      await refreshAccounts({ quiet: true });
      setMessage?.('已退出该账号的小红书授权。');
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted && cause?.name !== 'AbortError') {
        setError('退出失败，未能确认该账号授权已移除。');
      }
    } finally {
      if (mounted.current) setBusyAction('');
    }
  }

  async function performDelete() {
    const target = deleteTarget;
    if (!target?.id || busyAction) return;
    const { controller, client } = beginOperation({ abortPoll: session?.accountId === target.id });
    setBusyAction(`delete:${target.id}`);
    setError('');
    try {
      await client.deleteAccount(target.id, { deleteCredentials, deadlineMs: REDAPP_GATED_ACTION_DEADLINE_MS });
      if (!mounted.current) return;
      if (session?.accountId === target.id) { setSession(null); setModalOpen(false); }
      setDeleteTarget(null);
      await refreshAccounts({ quiet: true });
      setMessage?.(deleteCredentials
        ? '账号已删除，本机凭证文件已一并清理。'
        : '账号已解绑，本机凭证文件已保留。');
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted && cause?.name !== 'AbortError') {
        setError('删除失败，请稍后重试。');
      }
    } finally {
      if (mounted.current) setBusyAction('');
    }
  }

  const list = Array.isArray(accounts) ? accounts : [];
  const busy = Boolean(busyAction);

  return (
    <>
      <section className="card redapp-auth-card">
        <div className="section-head auth-card-head">
          <div><h3>小红书账号管理</h3><p>每个用户管理自己的小红书账号，互不影响。</p></div>
          <div className="section-head-actions">
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => refreshAccounts()}>{loading ? '刷新中…' : '刷新'}</button>
            <button type="button" className="btn-primary" disabled={busy} onClick={addAccount}>{busyAction === 'create' ? '创建中…' : '添加小红书账号'}</button>
          </div>
        </div>
        {error ? <p className="auth-card-error" role="alert">{error}</p> : null}
        {loading && !accounts ? <p className="auth-cli-unavailable">正在读取账号列表…</p> : null}
        {!loading && !accounts ? <p className="auth-cli-unavailable">账号列表读取失败。刷新成功前不会更改任何账号。</p> : null}
        {accounts && list.length === 0 ? <p className="auth-cli-unavailable">还没有绑定小红书账号。点击「添加小红书账号」，用小红书 App 扫码完成绑定。</p> : null}
        {list.length ? (
          <ul className="xhs-account-list">
            {list.map(account => (
              <li key={account.id} className={'xhs-account-row' + (account.status === 'pending_bind' ? ' pending' : '')}>
                <div className="xhs-account-info">
                  <div className="xhs-account-title">
                    <b>{accountDisplayName(account)}</b>
                    <span className={'xhs-account-pill ' + (account.status === 'bound' ? 'bound' : 'pending')}>{accountStatusLabel(account.status)}</span>
                  </div>
                  <div className="xhs-account-meta">
                    <span>{accountLoginHint(account)}</span>
                    {account.status === 'bound' && Number.isFinite(account.expireTimeMs) ? <span>授权到期 {formatAuthExpiry(account.expireTimeMs)}</span> : null}
                    {account.credentialDirHint ? <span className="xhs-account-dir">{account.credentialDirHint}</span> : null}
                  </div>
                </div>
                <div className="xhs-account-actions">
                  {account.status === 'pending_bind' ? (
                    <button type="button" className="btn-primary" disabled={busy} onClick={() => startScan(account)}>{busyAction === `login:${account.id}` ? '发起中…' : '扫码绑定'}</button>
                  ) : (
                    <>
                      <button type="button" className="btn-secondary" disabled={busy} onClick={() => startScan(account)}>{busyAction === `login:${account.id}` ? '发起中…' : '重新授权'}</button>
                      {account.loggedIn ? (
                        <button type="button" className={confirmLogoutId === account.id ? 'btn-danger' : 'btn-secondary'} disabled={busy} onClick={() => logoutAccount(account)}>
                          {confirmLogoutId === account.id ? '再次点击确认退出' : busyAction === `logout:${account.id}` ? '退出中…' : '退出'}
                        </button>
                      ) : null}
                    </>
                  )}
                  <button type="button" className="btn-secondary xhs-account-delete" disabled={busy} onClick={() => { setDeleteTarget(account); setDeleteCredentials(true); }}>删除</button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {session ? (
          <div className="auth-session-summary">
            <span>扫码授权进度：<b>{SESSION_LABELS[session.status] || '等待授权'}</b></span>
            <button type="button" className="btn-secondary" onClick={() => setModalOpen(true)}>查看授权进度</button>
          </div>
        ) : null}
      </section>
      {modalOpen && session ? (
        <RedappAuthModal
          session={session}
          onClose={() => setModalOpen(false)}
          onCancel={cancelSession}
          onRetry={() => startScan({ id: session.accountId })}
          cancelling={busyAction === 'cancel'}
        />
      ) : null}
      {deleteTarget ? (
        <div className="prompt-config-backdrop auth-qr-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setDeleteTarget(null); }}>
          <section className="prompt-config-modal xhs-delete-modal" role="dialog" aria-modal="true" aria-labelledby="xhs-delete-title">
            <button type="button" className="prompt-config-close" onClick={() => setDeleteTarget(null)} aria-label="关闭删除确认">×</button>
            <h3 id="xhs-delete-title">删除小红书账号</h3>
            <p>将删除「{accountDisplayName(deleteTarget)}」的绑定。之后可以重新添加并扫码绑定。</p>
            <label className="xhs-delete-check">
              <input type="checkbox" checked={deleteCredentials} onChange={event => setDeleteCredentials(event.target.checked)} />
              <span>同时删除凭证文件（本机保存的登录凭证；取消勾选则仅解绑，凭证保留）</span>
            </label>
            <div className="prompt-config-actions">
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => setDeleteTarget(null)}>取消</button>
              <button type="button" className="btn-danger" disabled={busy} onClick={performDelete}>{busyAction === `delete:${deleteTarget.id}` ? '删除中…' : '确认删除'}</button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
