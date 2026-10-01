/**
 * 客量板「会员被经营」6 档消费分桶的档位来源（#292）。
 *
 * 结构与会员等级一致：
 *   - 最低一档的下界 = 会员门槛 `system_configs.new_member_threshold`（初钻门槛），
 *     运行时由 `getMemberThreshold()` 读取，**不在这里写死**；与品项板同源
 *   - 其余四个下界固定：星钻 1w / 粉钻 3w / 金钻 6w / 黑钻 10w（与 cron/lib/member-level.ts 同数字）
 *
 * 分桶左闭右开：(-∞, 门槛) / [门槛, 1w) / [1w, 3w) / [3w, 6w) / [6w, 10w) / [10w, +∞)。
 * 「会员经营人数」= spend >= 门槛。
 *
 * ⚠️ 门槛必须 < 10000（STAR），否则 [门槛, 1w) 为空、(-∞, 门槛) 与 [1w, 3w) 重叠，
 * 分桶之和不再等于总数；设置页不做上限校验（2026-09-25 拍板，只在 metrics.md 写明）。
 * ⚠️ UI / 导出的分桶标签「<1990 / ≥1990」保持写死（同日拍板），门槛调整后标签不会跟着变。
 * ⚠️ `client_wechat_users.spending_tier`（终身档位，枚举字面量 '1990-1W'）边界固定、不跟门槛，
 * 与本模块是两回事。
 *
 * staffApi `routes/mgmt-traffic.js` 有同值独立副本（禁止跨端共享代码），
 * 由 `actions/data-center/__tests__/consistency.customer.test.ts` 守护。
 */
export const SPEND_BUCKET_FLOORS = Object.freeze({
  star: 10000,
  pink: 30000,
  gold: 60000,
  black: 100000,
})
