// 给一次性的 fetch 套时间盒：到点主动中断，让调用方拿到确定错误而不是无限转圈。
// 注意：signal 由这里持有，调用方传进来的 signal 会被覆盖。
export async function fetchWithTimeout(url, options, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw new Error('请求超时（' + Math.round(timeoutMs / 1000) + ' 秒），请稍后重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
