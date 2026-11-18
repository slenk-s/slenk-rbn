// TiDB 镜像拉取时的合并规则（纯函数，便于单测）。
// 目标：新机器/清空的本地能从云端补全供应商和用户，同时：
//   - 供应商按 updated_at 新者胜（LWW）；
//   - 用户冲突保本地（用户行没有 updated_at，密码哈希绝不能被云端旧值回滚）；
//   - 任何一端独有的行都保留——云端删除不向下传播，避免误清空本地。

function ts(row) {
  const t = Date.parse(String(row?.updated_at || '').replace(' ', 'T'));
  return Number.isFinite(t) ? t : 0;
}

export function mergeProviders(localRows, cloudRows) {
  const map = new Map();
  for (const row of localRows || []) if (row?.id) map.set(row.id, row);
  for (const row of cloudRows || []) {
    if (!row?.id) continue;
    const local = map.get(row.id);
    if (!local || ts(row) > ts(local)) map.set(row.id, row);
  }
  return [...map.values()];
}

export function mergeUsers(localRows, cloudRows) {
  const map = new Map();
  // 先铺云端，再用本地覆盖：并集 + 冲突保本地。
  for (const row of cloudRows || []) if (row?.id) map.set(row.id, row);
  for (const row of localRows || []) if (row?.id) map.set(row.id, row);
  return [...map.values()];
}
