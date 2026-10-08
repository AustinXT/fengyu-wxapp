/**
 * 会员等级判定纯函数（迁自 cronTask/index.js:91-113）
 *
 * 与 [member-level-rules](memory:project_member_level_rules) 一致：
 *   - 黑钻 ≥ 100000、金钻 ≥ 60000、粉钻 ≥ 30000、星钻 ≥ 10000
 *   - 其余一律落在下限档「初钻」（#545：会员客的 member_level 不允许为 NULL）
 *
 * 因此 `threshold`（system_configs.new_member_threshold）自此不参与等级判定，
 * 只用于 customer_type 的入会判定；入参保留是为了与各端调用点同签名。
 *
 * 升降级判定基于序数：null < 初钻 < 星钻 < 粉钻 < 金钻 < 黑钻
 */

import { memberLevelEnum } from '@db/enums'

export type MemberLevel = (typeof memberLevelEnum.enumValues)[number]

export const LEVEL_RANK: Record<string, number> = {
  null: 0,
  初钻: 1,
  星钻: 2,
  粉钻: 3,
  金钻: 4,
  黑钻: 5,
}

export function determineMemberLevel(spend: number, threshold: number): MemberLevel {
  if (spend >= 100000) return '黑钻'
  if (spend >= 60000) return '金钻'
  if (spend >= 30000) return '粉钻'
  if (spend >= 10000) return '星钻'
  return '初钻'
}

export function isUpgrade(from: MemberLevel | null, to: MemberLevel | null): boolean {
  return (LEVEL_RANK[String(to)] || 0) > (LEVEL_RANK[String(from)] || 0)
}

export function isDowngrade(from: MemberLevel | null, to: MemberLevel | null): boolean {
  return (LEVEL_RANK[String(to)] || 0) < (LEVEL_RANK[String(from)] || 0)
}
