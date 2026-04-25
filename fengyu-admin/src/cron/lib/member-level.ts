/**
 * 会员等级判定纯函数（迁自 cronTask/index.js:91-113）
 *
 * 与 [member-level-rules](memory:project_member_level_rules) 一致：
 *   - 黑钻 ≥ 100000、金钻 ≥ 60000、粉钻 ≥ 30000、星钻 ≥ 10000
 *   - 初钻 ≥ system_configs.new_member_threshold（默认 1980，运行时由 getMemberThreshold 注入）
 *   - 低于初钻门槛 → null
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

export function determineMemberLevel(spend: number, threshold: number): MemberLevel | null {
  if (spend >= 100000) return '黑钻'
  if (spend >= 60000) return '金钻'
  if (spend >= 30000) return '粉钻'
  if (spend >= 10000) return '星钻'
  if (spend >= threshold) return '初钻'
  return null
}

export function isUpgrade(from: MemberLevel | null, to: MemberLevel | null): boolean {
  return (LEVEL_RANK[String(to)] || 0) > (LEVEL_RANK[String(from)] || 0)
}

export function isDowngrade(from: MemberLevel | null, to: MemberLevel | null): boolean {
  return (LEVEL_RANK[String(to)] || 0) < (LEVEL_RANK[String(from)] || 0)
}
