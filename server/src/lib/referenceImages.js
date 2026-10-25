// 参考图收集与张数上限。
//
// 一一对应模式下每次编辑请求只带一张参考图，请求体不随张数增长，可以直接放到
// 前端上传上限；合成一张模式把所有参考图塞进同一个请求，请求体随张数线性增长，
// 所以那个模式仍然收紧，截断时必须打日志而不是静默丢弃。

export const MAX_PER_REFERENCE_IMAGES = 9;
export const MAX_REFERENCE_IMAGES = 2;

export function collectReferenceImages(payload) {
  const input = payload || {};
  const list = input.imageUrls?.length ? input.imageUrls : (input.image ? [input.image] : []);
  const refs = (Array.isArray(list) ? list : [list]).filter(Boolean);
  const perReference = input.perReference !== false;
  const limit = perReference ? MAX_PER_REFERENCE_IMAGES : MAX_REFERENCE_IMAGES;
  if (refs.length <= limit) return refs;
  console.warn(`[worker] 参考图超过 ${limit} 张上限，只取前 ${limit} 张（收到 ${refs.length} 张，${perReference ? '一一对应' : '合成一张'}）`);
  return refs.slice(0, limit);
}
