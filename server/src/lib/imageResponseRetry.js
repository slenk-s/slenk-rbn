// 图像供应商偶尔会返回 HTTP 200 但没有可用图片字段；把识别规则集中在这里，
// 让请求层可以只对「明确成功但空图」做有限重试，不改变供应商错误处理。
export function hasUsableImage(data) {
  const candidates = [
    data?.data?.[0]?.url,
    data?.data?.[0]?.b64_json,
    data?.images?.[0],
    data?.url,
    data?.output?.image,
    data?.b64_json
  ];
  return candidates.some(value => typeof value === 'string' && value.trim().length > 0);
}

export async function requestWithImageRetry(request, { retries = 2, delayMs = 5000, onRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    const data = await request();
    if (hasUsableImage(data) || attempt >= retries) return data;
    onRetry?.(attempt + 1, data);
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}
