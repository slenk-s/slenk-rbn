// 给一次性的 fetch 套时间盒：到点主动中断，让调用方拿到确定错误而不是无限转圈。
// 调用方 signal 与 deadline 共同生效；任一先中断都会取消底层请求。
export async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const callerSignal = options.signal;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(callerSignal.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (timedOut) throw new Error('请求超时（' + Math.round(timeoutMs / 1000) + ' 秒），请稍后重试');
    throw err;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}
