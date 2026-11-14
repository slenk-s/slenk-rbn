// 有界并发池：按索引回填，输出顺序与输入一致。
// 任一项抛错时立即中断：置 stopped 让其余 worker 在完成当前项后退出，不再领取新 item。
export async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  let stopped = false;
  const runNext = async () => {
    for (;;) {
      if (stopped) return;
      const i = next;
      if (i >= items.length) return;
      next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        stopped = true;
        throw err;
      }
    }
  };
  const size = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: size }, runNext));
  return results;
}
