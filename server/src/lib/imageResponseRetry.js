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

export function hasUsableText(data) {
  const content = data?.choices?.[0]?.message?.content || data?.output?.text || data?.message || data?.text || '';
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) return content.some(item => typeof item?.text === 'string' && item.text.trim().length > 0);
  return false;
}

async function requestWithResultRetry(request, hasResult, { retries = 2, delayMs = 5000, onRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    const data = await request();
    if (hasResult(data) || attempt >= retries) return data;
    onRetry?.(attempt + 1, data);
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

export function requestWithImageRetry(request, options) {
  return requestWithResultRetry(request, hasUsableImage, options);
}

export function requestWithTextRetry(request, options) {
  return requestWithResultRetry(request, hasUsableText, options);
}
