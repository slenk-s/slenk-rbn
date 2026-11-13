// 扫码自动匹配：登录成功后把回执里的 openId 绑定到发起登录的账号槽位。
// 匹配只在当前用户范围内进行；其他用户是否绑过同一 openId 不影响。
//
// 返回形状：{ matched, conflict?, existingId?, accountId }。
// - 首次扫码（该 openId 无归属）→ bindOpenIdForUser 回填，返回 { matched: true, accountId }。
// - 该 openId 已属当前用户的另一账号 → 清理本次待绑定行与新凭证目录，返回 { matched: false, conflict: true, existingId }。
// - 同一账号重新扫码（已是属主）→ 不改库，返回 { matched: true, accountId }。
// - 并发撞 unique(user_id, open_id) 直接抛出 XHS_ACCOUNT_DUPLICATE（由上层映射到会话）。
export async function matchLoginToAccount({ userId, accountId, credentialDir, openId, registry }) {
  const existing = await registry.findByOpenIdForUser(userId, openId);
  if (existing) {
    if (existing.id === accountId) {
      // 同一账号重新扫码：已是该 openId 的属主，无需改库。
      return { matched: true, accountId };
    }
    // 该 openId 已属于当前用户的另一个账号：清理本次待绑定行（连同新凭证目录），返回冲突。
    await registry.deleteForUser(userId, accountId, { deleteCredentials: true });
    return { matched: false, conflict: true, existingId: existing.id };
  }
  // 首次扫码：回填 openId；并发撞 unique 约束由 store 映射为 XHS_ACCOUNT_DUPLICATE 抛出。
  await registry.bindOpenIdForUser(userId, accountId, { openId });
  return { matched: true, accountId };
}
