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
  // 1) 按 id 并集，冲突保本地（同 id 时本地覆盖云端）。
  const byId = new Map();
  for (const row of cloudRows || []) if (row?.id) byId.set(row.id, row);
  for (const row of localRows || []) if (row?.id) byId.set(row.id, row);

  // 2) username 必须唯一：本地 slenk_notes_users 有 UNIQUE(username)。
  //    若云端行与本地（或云端内部）不同 id 撞同名，保本地、丢云端，否则 importSyncRows 会触发 UNIQUE 约束。
  const localUsername = new Map();
  for (const row of localRows || []) if (row?.id) localUsername.set(String(row.username || ''), row.id);

  const byUsername = new Map(); // username -> 已保留行的 id
  const out = [];
  for (const row of byId.values()) {
    const key = String(row.username || '');
    const held = byUsername.get(key);
    if (held === undefined) { byUsername.set(key, row.id); out.push(row); continue; }
    // 同名冲突：当前行是本地行则顶替已保留的云端行；是云端行则丢弃。
    if (localUsername.get(key) === row.id) {
      const idx = out.findIndex(r => r.id === held);
      if (idx >= 0) out[idx] = row;
      byUsername.set(key, row.id);
    }
  }
  return out;
}
