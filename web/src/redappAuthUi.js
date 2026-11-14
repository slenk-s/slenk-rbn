const DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
export const MAX_QR_IMAGE_LENGTH = Math.ceil(2 * 1024 * 1024 / 3) * 4 + 64;

// 仪表盘轮询的失败分级：只有取消与 404（会话确已不存在）立即终止；
// 瞬时失败（网络抖动、单次 5xx、单次超时）应在会话预算内重试，服务端会话最长存活 10 分钟。
export function dashboardPollFailureDisposition(cause) {
  if (cause?.code === 'AUTH_POLL_CANCELLED' || cause?.name === 'AbortError') return 'abort';
  if (cause?.status === 404) return 'not-found';
  return 'retry';
}

export async function fetchWithDeadline(fetchImpl, input, options = {}, deadlineMs = 20_000) {
  const deadline = new AbortController();
  const callerSignal = options.signal;
  const timeoutError = new DOMException(`Request exceeded ${deadlineMs}ms`, 'TimeoutError');
  const timer = setTimeout(() => deadline.abort(timeoutError), deadlineMs);
  let signal;
  let cleanup = () => {};

  if (!callerSignal) {
    signal = deadline.signal;
  } else if (typeof AbortSignal.any === 'function') {
    signal = AbortSignal.any([callerSignal, deadline.signal]);
  } else {
    const combined = new AbortController();
    const forwardCaller = () => combined.abort(callerSignal.reason);
    const forwardDeadline = () => combined.abort(deadline.signal.reason);
    callerSignal.addEventListener('abort', forwardCaller, { once: true });
    deadline.signal.addEventListener('abort', forwardDeadline, { once: true });
    if (callerSignal.aborted) forwardCaller();
    cleanup = () => {
      callerSignal.removeEventListener('abort', forwardCaller);
      deadline.signal.removeEventListener('abort', forwardDeadline);
    };
    signal = combined.signal;
  }

  try {
    return await fetchImpl(input, { ...options, signal });
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}

export function safeAuthorizeUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

export function safeQrImage(value) {
  return typeof value === 'string'
    && value.length <= MAX_QR_IMAGE_LENGTH
    && DATA_IMAGE_PATTERN.test(value)
    ? value
    : '';
}

export function formatRemainingTime(expiresAt, now = Date.now()) {
  if (!Number.isFinite(expiresAt)) return '等待授权';
  const remaining = Math.ceil((expiresAt - now) / 1000);
  if (remaining <= 0) return '已到期';
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatAuthExpiry(value, { locale = 'zh-CN', timeZone } = {}) {
  if (!Number.isFinite(value)) return '未提供';
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(millis);
  if (!Number.isFinite(date.getTime())) return '未提供';
  const parts = new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    ...(timeZone ? { timeZone } : {})
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value || '';
  return `${part('year')}/${part('month')}/${part('day')} ${part('hour')}:${part('minute')}`;
}

export function boundedSessionError(value, maxLength = 240) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function focusNavigationIndex(currentIndex, count, direction) {
  if (count <= 0) return -1;
  if (currentIndex < 0) return direction < 0 ? count - 1 : 0;
  return (currentIndex + direction + count) % count;
}
