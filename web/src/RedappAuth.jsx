import { useCallback, useEffect, useRef, useState } from 'react';
import { createRedappAuthClient } from './redappAuthFlow.js';
import {
  authActionPermissions,
  boundedSessionError,
  canCommitLifecycle,
  cancelOperationCompletion,
  cancelSessionStateCompletion,
  fetchWithDeadline,
  focusNavigationIndex,
  formatAuthExpiry,
  formatRemainingTime,
  isUsableAuth,
  pollLifecycleTransition,
  pollCompletionTransition,
  reserveTransferredGeneration,
  safeAuthorizeUrl,
  safeQrImage,
  sessionStatusPresentation
} from './redappAuthUi.js';

const TERMINAL_STATUSES = new Set(['done', 'failed', 'expired', 'cancelled', 'not-found']);
const SESSION_LABELS = {
  waiting_prompt: '正在准备授权信息', waiting_scan: '等待手机确认', done: '授权成功',
  failed: '授权失败', expired: '授权已过期', cancelled: '授权已取消', 'not-found': '授权会话已失效'
};
const SESSION_GUIDANCE = {
  done: '授权已完成。正在确认本机共享账号状态。', failed: '本次授权未完成，请查看原因后重试。',
  expired: '授权信息已过期，请重新发起授权。', cancelled: '本次授权已取消，可在需要时重新发起。',
  'not-found': '服务器已找不到本次授权会话，请重新发起授权。'
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

function waitForNextPoll(signal) {
  if (signal.aborted) return Promise.reject(Object.assign(new Error('cancelled'), { code: 'AUTH_POLL_CANCELLED' }));
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('cancelled'), { code: 'AUTH_POLL_CANCELLED' })); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, 1500);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function createFetchAdapter(apiBase, token, getSignal) {
  return (path, options = {}) => fetchWithDeadline(fetch, apiBase + path, {
    ...options,
    signal: typeof getSignal === 'function' ? getSignal() : getSignal,
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
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
          <div><h3 id="redapp-auth-title">连接小红书</h3><p>请使用手机完成授权。关闭此窗口不会取消本机正在进行的授权。</p></div>
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
              <p className="auth-modal-tip">授权会更新这台电脑上的共享账号，其他正在使用工作台的人也会受到影响。</p>
            </div>
          </div>
        )}
        <div className="prompt-config-actions auth-modal-actions">
          {mode !== 'resume-publish' && session.status === 'done' && session.refreshError ? <button type="button" className="btn-primary" disabled={refreshing} onClick={onRefreshStatus}>{refreshing ? '刷新中…' : '刷新授权状态'}</button> : null}
          {terminal && session.status !== 'done' && onRetry ? <button type="button" className="btn-primary" onClick={onRetry}>重新授权</button> : null}
          {active ? <button type="button" className="btn-danger" disabled={cancelling} onClick={onCancel}>{cancelling ? '取消中…' : '取消本次授权'}</button> : null}
          <button type="button" className="btn-secondary" onClick={onClose}>关闭窗口</button>
        </div>
      </section>
    </div>
  );
}

export function RedappAuthCard({ apiBase, token, setMessage }) {
  const mounted = useRef(false);
  const pollController = useRef(null);
  const operationController = useRef(null);
  const operationGeneration = useRef(0);
  const lifecycle = useRef({ generation: 0, sessionId: null });
  const [auth, setAuth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [session, setSession] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  const makeClient = useCallback(signal => createRedappAuthClient({
    api: createFetchAdapter(apiBase, token, signal), pollMs: 1500
  }), [apiBase, token]);

  const beginOperation = useCallback(({ abortPoll = false, sessionId = lifecycle.current.sessionId } = {}) => {
    operationController.current?.abort();
    if (abortPoll) pollController.current?.abort();
    const controller = new AbortController();
    operationController.current = controller;
    const generation = ++operationGeneration.current;
    lifecycle.current = { generation, sessionId };
    return { controller, generation, client: makeClient(controller.signal) };
  }, [makeClient]);
  const isCurrent = useCallback((generation, controller, sessionId = lifecycle.current.sessionId) => mounted.current
    && !controller.signal.aborted
    && canCommitLifecycle(lifecycle.current, generation, sessionId), []);

  const refreshStatus = useCallback(async ({ quiet = false, closeDone = false } = {}) => {
    const { controller, generation, client } = beginOperation();
    if (!quiet) setLoading(true);
    setBusy(true);
    setError('');
    try {
      const next = await client.status();
      if (!isCurrent(generation, controller)) return null;
      setAuth(next);
      if (closeDone && isUsableAuth(next)) {
        lifecycle.current = { generation, sessionId: null };
        setSession(null); setModalOpen(false); setMessage?.('小红书授权已连接。');
      } else if (closeDone) {
        setSession(previous => previous?.status === 'done'
          ? { ...previous, refreshError: '授权完成，但当前账号状态仍不可用' }
          : previous);
      }
      return next;
    } catch (cause) {
      if (isCurrent(generation, controller) && cause?.name !== 'AbortError') {
        setAuth(null);
        setError('无法读取授权状态，请稍后重试。');
        if (closeDone) setSession(previous => previous?.status === 'done'
          ? { ...previous, refreshError: '授权成功，状态刷新失败' }
          : previous);
      }
      return null;
    } finally {
      if (isCurrent(generation, controller)) { setLoading(false); setBusy(false); }
    }
  }, [beginOperation, isCurrent, setMessage]);

  useEffect(() => {
    mounted.current = true;
    const kickoff = setTimeout(() => refreshStatus(), 0);
    return () => {
      clearTimeout(kickoff);
      mounted.current = false;
      operationController.current?.abort();
      pollController.current?.abort();
    };
  }, [refreshStatus]);

  const sessionId = session?.sessionId;
  const pollGeneration = session?.pollGeneration;
  useEffect(() => {
    if (!sessionId) return undefined;
    pollController.current?.abort();
    const controller = new AbortController();
    pollController.current = controller;
    const pollTransition = pollLifecycleTransition(lifecycle.current, sessionId, pollGeneration);
    if (pollTransition.commit === false) return () => controller.abort();
    const generation = pollTransition.generation;
    operationGeneration.current = Math.max(operationGeneration.current, generation);
    lifecycle.current = pollTransition.lifecycle;
    const pollClient = makeClient(controller.signal);

    const pollIsCurrent = () => mounted.current
      && !controller.signal.aborted
      && canCommitLifecycle(lifecycle.current, generation, sessionId);

    async function pollExactSession() {
      while (!controller.signal.aborted) {
        try {
          const current = await pollClient.session(sessionId);
          if (!pollIsCurrent() || current?.sessionId !== sessionId) return;
          if (current.status === 'done') {
            try {
              const nextAuth = await pollClient.status();
              if (!pollIsCurrent()) return;
              setAuth(nextAuth);
              const transition = pollCompletionTransition('done', nextAuth);
              if (transition.close) {
                lifecycle.current = { generation, sessionId: null };
                setSession(previous => previous?.sessionId === sessionId ? null : previous);
                setModalOpen(false);
                setMessage?.('小红书授权已连接。');
              } else {
                setSession(previous => previous?.sessionId === sessionId
                  ? { ...previous, ...current, ...transition }
                  : previous);
              }
            } catch (cause) {
              if (!pollIsCurrent() || cause?.name === 'AbortError') return;
              setAuth(null);
              setSession(previous => previous?.sessionId === sessionId
                ? { ...previous, ...current, ...pollCompletionTransition('done', null) }
                : previous);
            }
            return;
          }
          setSession(previous => previous?.sessionId === sessionId ? { ...previous, ...current } : previous);
          if (TERMINAL_STATUSES.has(current.status)) return;
          if (current.status !== 'waiting_prompt' && current.status !== 'waiting_scan') {
            setSession(previous => previous?.sessionId === sessionId ? { ...previous, status: 'failed', error: '收到未知授权状态。' } : previous);
            return;
          }
          await waitForNextPoll(controller.signal);
        } catch (cause) {
          if (!pollIsCurrent() || cause?.code === 'AUTH_POLL_CANCELLED' || cause?.name === 'AbortError') return;
          const status = cause?.status === 404 ? 'not-found' : 'failed';
          setSession(previous => previous?.sessionId === sessionId ? { ...previous, status, error: boundedSessionError(cause?.message) } : previous);
          return;
        }
      }
    }
    pollExactSession();
    return () => controller.abort();
  }, [makeClient, pollGeneration, sessionId, setMessage]);

  async function connect() {
    if (!auth || busy) return;
    setConfirmLogout(false);
    setError('');
    if (session && !TERMINAL_STATUSES.has(session.status)) { setModalOpen(true); return; }
    const { controller, generation, client } = beginOperation();
    setBusy(true);
    try {
      const next = await client.login();
      if (!isCurrent(generation, controller)) return;
      setSession(next);
      setModalOpen(true);
    } catch (cause) {
      if (isCurrent(generation, controller) && cause?.name !== 'AbortError') setError('无法开始授权，请确认 redapp CLI 可用后重试。');
    } finally {
      if (isCurrent(generation, controller)) setBusy(false);
    }
  }

  async function cancelSession() {
    const cancellingId = session?.sessionId;
    if (!cancellingId || busy) return;
    const { controller, generation, client } = beginOperation();
    let releasedBusy = false;
    setBusy(true); setError('');
    try {
      const cancelled = await client.cancel(cancellingId);
      const transition = cancelOperationCompletion({
        lifecycle: lifecycle.current,
        operationGeneration: generation,
        sessionId: cancellingId,
        responseStatus: cancelled.status,
        succeeded: true
      });
      if (!transition.commit || controller.signal.aborted || cancelled.sessionId !== cancellingId) return;
      operationGeneration.current = reserveTransferredGeneration(
        operationGeneration.current,
        transition.pollGeneration
      );
      setBusy(transition.busy);
      releasedBusy = true;
      pollController.current?.abort();
      lifecycle.current = transition.lifecycle;
      setSession(previous => {
        const completion = cancelSessionStateCompletion({
          currentSession: previous,
          response: cancelled,
          transition
        });
        return completion.commit === false ? previous : completion.session;
      });
    } catch {
      const transition = cancelOperationCompletion({
        lifecycle: lifecycle.current,
        operationGeneration: generation,
        sessionId: cancellingId,
        succeeded: false
      });
      if (transition.commit && !controller.signal.aborted) {
        operationGeneration.current = reserveTransferredGeneration(
          operationGeneration.current,
          transition.pollGeneration
        );
        setBusy(transition.busy);
        releasedBusy = true;
        lifecycle.current = transition.lifecycle;
        setSession(previous => previous?.sessionId === cancellingId
          ? { ...previous, pollGeneration: transition.pollGeneration }
          : previous);
        setError('取消授权失败，当前授权可能仍在进行。');
      }
    } finally {
      if (!releasedBusy && isCurrent(generation, controller)) setBusy(false);
    }
  }

  async function logout() {
    const activeSession = Boolean(session && !TERMINAL_STATUSES.has(session.status));
    if (activeSession) return;
    if (!confirmLogout) { setConfirmLogout(true); setError(''); return; }
    const { controller, generation, client } = beginOperation({ abortPoll: true, sessionId: null });
    setBusy(true); setLoading(true); setError('');
    try {
      const next = await client.logout();
      if (!isCurrent(generation, controller, null)) return;
      setAuth(next); setSession(null); setModalOpen(false); setConfirmLogout(false); setMessage?.('已退出本机共享的小红书授权。');
    } catch (cause) {
      if (isCurrent(generation, controller, null) && cause?.name !== 'AbortError') setError('退出失败，当前共享授权没有被确认移除。');
    } finally { if (isCurrent(generation, controller, null)) { setBusy(false); setLoading(false); } }
  }

  const presentation = sessionStatusPresentation(session, auth);
  const scope = Array.isArray(auth?.scope) ? auth.scope.filter(item => typeof item === 'string').slice(0, 8) : [];
  const connected = isUsableAuth(auth);
  const activeSession = Boolean(session && !TERMINAL_STATUSES.has(session.status));
  const permissions = authActionPermissions({ auth, activeSession, loading, busy });

  return (
    <>
      <section className="card redapp-auth-card">
        <div className="section-head auth-card-head">
          <div><h3>小红书本机授权</h3><p>管理当前电脑用于发布的小红书账号。</p></div>
          <span className={'auth-status-pill ' + presentation.tone}><i className="auth-status-dot" />{loading ? '读取中…' : presentation.label}</span>
        </div>
        <div className="auth-shared-warning"><b>共享电脑提示</b><span>此授权由本机所有工作台用户共用。连接、重新授权或退出都会影响其他用户。</span></div>
        {error ? <p className="auth-card-error" role="alert">{error}</p> : null}
        {!loading && !auth ? <p className="auth-cli-unavailable">状态未知/读取失败。刷新成功前不会更改本机共享授权。</p> : null}
        {!loading && auth?.available ? <dl className="auth-status-grid">
          <div><dt>账号</dt><dd>{auth.openIdMasked || (auth.loggedIn ? '已隐藏' : '未连接')}</dd></div>
          <div><dt>授权范围</dt><dd>{scope.length ? scope.join('、') : '未提供'}</dd></div>
          <div><dt>访问授权到期</dt><dd>{formatAuthExpiry(auth.expireTimeMs)}</dd></div>
          <div><dt>刷新授权到期</dt><dd>{formatAuthExpiry(auth.refreshExpireTimeMs)}</dd></div>
        </dl> : null}
        {!loading && auth && !auth.available ? <p className="auth-cli-unavailable">redapp CLI 当前不可用，无法在这台电脑上管理小红书授权。</p> : null}
        {session ? <div className="auth-session-summary"><span>共享授权进度：<b>{presentation.label}</b></span><button type="button" className="btn-secondary" onClick={() => setModalOpen(true)}>查看授权进度</button></div> : null}
        {confirmLogout ? <div className="auth-logout-confirm" role="alert"><p><b>确认退出共享授权？</b> 这会让本机所有用户暂时无法发布到小红书。</p><div><button type="button" className="btn-danger" disabled={busy || loading} onClick={logout}>{busy ? '退出中…' : '确认影响所有用户并退出'}</button><button type="button" className="btn-secondary" disabled={busy || loading} onClick={() => setConfirmLogout(false)}>取消</button></div></div> : null}
        <div className="auth-card-actions">
          <button type="button" className="btn-primary" disabled={!permissions.connect || !auth?.available} onClick={connect}>{busy ? '处理中…' : connected ? '重新授权' : '连接小红书'}</button>
          <button type="button" className="btn-secondary" disabled={!permissions.refresh} onClick={() => refreshStatus()}>{loading ? '刷新中…' : '刷新状态'}</button>
          {auth?.loggedIn ? <button type="button" className="btn-danger" disabled={!permissions.logout} onClick={logout}>退出共享授权</button> : null}
        </div>
      </section>
      {modalOpen && session ? <RedappAuthModal session={session} onClose={() => setModalOpen(false)} onCancel={cancelSession} onRetry={connect} onRefreshStatus={() => refreshStatus({ closeDone: true })} cancelling={busy} refreshing={busy} /> : null}
    </>
  );
}
