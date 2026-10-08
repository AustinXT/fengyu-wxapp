/**
 * 会员等级判定共享工具（db 侧权威副本）
 *
 * 生产同源副本共 5 份，函数体必须逐字一致（三份 .js 另有字节级守护）：
 *   - `fengyu-admin/src/cron/lib/member-level.ts`（每日 cron）
 *   - `fengyu-staff/cloudfunctions/staffApi/utils/member-level.js`
 *   - `fengyu-client/cloudfunctions/clientApi/utils/member-level.js`
 *   - `fengyu-client/cloudfunctions/payNotify/member-level.js`
 * 一致性由 staffApi `__tests__/routes/recalc-member-level-sql.test.js` 守护。
 *
 * 另有**不参与生产、也不在守护范围内**的字面副本，改动时须手工同步：
 *   - `db/scripts/verify-member-level-cron.js`（手工 docker 集成验证脚本，内联判定 + S2 断言）
 *   - `db/scripts/recalc-all-customer-types.js` 的等级 CASE（SQL 内联，由 db:test 守护）
 *   - `fengyu-admin/tests/e2e-chains/link-6-member-upgrade.spec.ts` 的 `expectedLevelForSpend`
 *   - `fengyu-admin/tests/e2e-actions/verify-customer-types.ts` 的夹具预置等级
 *
 * 规则见 `.42cog/pm/admin.pr.spec.md` / `project_member_level_rules` 记忆。
 */

export type MemberLevel = '初钻' | '星钻' | '粉钻' | '金钻' | '黑钻'

/** 等级序数；null 视为 0；升级/降级判定基础 */
export const LEVEL_RANK: Record<string, number> = {
  null: 0,
  '初钻': 1,
  '星钻': 2,
  '粉钻': 3,
  '金钻': 4,
  '黑钻': 5,
}

function rank(level: string | null | undefined): number {
  if (!level) return 0
  return LEVEL_RANK[level] ?? 0
}

/**
 * 按滚动 12 个月消费额计算等级。
 * 阈值：黑钻 ≥10w / 金钻 ≥6w / 粉钻 ≥3w / 星钻 ≥1w；其余一律落在下限档「初钻」。
 *
 * #545：会员客的 member_level 不允许为 NULL —— 低于入会门槛同样返回「初钻」。
 * 因此 `threshold`（system_configs.new_member_threshold）自此**不参与等级判定**，
 * 只用于 customer_type 的入会判定；入参保留是为了与三份 JS 副本及各端调用点同签名。
 */
export function determineMemberLevel(spend: number, threshold: number): MemberLevel {
  if (spend >= 100000) return '黑钻'
  if (spend >= 60000) return '金钻'
  if (spend >= 30000) return '粉钻'
  if (spend >= 10000) return '星钻'
  return '初钻'
}

export function isUpgrade(from: string | null | undefined, to: string | null | undefined): boolean {
  return rank(to) > rank(from)
}

export function isDowngrade(from: string | null | undefined, to: string | null | undefined): boolean {
  return rank(to) < rank(from)
}
