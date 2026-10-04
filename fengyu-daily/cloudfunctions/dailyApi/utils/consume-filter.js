/**
 * 数据中心「消耗业绩」统计的寄存单退款排除片段（staffApi 共享 util）。
 *
 * 寄存单退款专用服务单（备注 = DEPOSIT_REFUND_REMARK）是老系统寄存疗程卡退款核销，
 * 走正常服务单流程扣次数但**不是真实消耗**，须从所有「消耗金额 / 项目数」聚合中剔除：
 *   - 实耗 / 生美实耗（SUM(unit_real_price * session_used)）
 *   - 项目数（SUM(session_used) ∩ sales_category IN ('自销自耗','他销自耗')）
 *   - 门店榜 / 员工榜的消耗 & 项目数；salesData 分客型实耗
 * 而**不**剔除客流 / 到店人次 / 服务人次 / 保有会员 / 提成（寄存退款是真到店、假消耗）。
 *
 * ⚠️ DEPOSIT_REFUND_REMARK 须与 fengyu-admin/src/lib/service-remark.ts 字面量完全一致
 * （项目禁止跨端共享代码目录，各端独立副本，靠 admin consistency.deposit-refund-filter.test.ts 守护）。
 * 常量纯中文 + 半角空格 + em-dash + 全角逗号，无单引号 → 内联为带引号 SQL 字面量是注入安全的。
 */

const DEPOSIT_REFUND_REMARK = '寄存单退款专用 — 老系统寄存疗程卡退款核销，不计消耗业绩';

/**
 * 排除寄存单退款服务单的 SQL 片段。
 * @param {string} alias service_orders 的表别名（如 'so' / 'so2'）
 *   - 普通 WHERE / CTE 内 INNER JOIN：放进 WHERE
 *   - 排名榜 LEFT JOIN service_orders：放进 ON 子句（保留零业绩门店出行），别名通常 'so2'
 * @returns {string} 形如 `so.remark IS DISTINCT FROM '<常量>'`
 */
function excludeDepositRefundSql(alias = 'so') {
  return `${alias}.remark IS DISTINCT FROM '${DEPOSIT_REFUND_REMARK}'`;
}

module.exports = { DEPOSIT_REFUND_REMARK, excludeDepositRefundSql };
