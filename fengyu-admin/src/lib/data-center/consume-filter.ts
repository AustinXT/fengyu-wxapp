/**
 * 数据中心「消耗业绩」统计的寄存单退款排除片段（Drizzle sql 版）。
 *
 * 寄存单退款专用服务单（备注 = DEPOSIT_REFUND_REMARK）是老系统寄存疗程卡退款核销，
 * 走正常服务单流程扣次数但**不是真实消耗**，须从所有「消耗金额 / 项目数」聚合中剔除：
 *   - 实耗 / 生美实耗（SUM(unit_real_price * session_used)）
 *   - 项目数（SUM(session_used) ∩ sales_category IN ('自销自耗','他销自耗')）
 *   - 门店榜 / 员工榜的消耗 & 项目数；员工人效明细的品类拆分实耗
 * 而**不**剔除客流 / 到店人次 / 服务人次 / 保有会员 / 提成（寄存退款是真到店、假消耗；
 * 提成靠管理约束不分配——参考 notes/memory/project_deposit_refund_remark）。
 *
 * ⚠️ 须与 fengyu-staff/cloudfunctions/staffApi/utils/consume-filter.js 同口径
 * （项目禁止跨端共享代码目录，各端独立副本，靠 consistency.deposit-refund-filter.test.ts 守护）。
 *
 * @param soAlias service_orders 的表别名（如 'so' / 'so2'）。
 *   - 普通 WHERE / CTE 内 INNER JOIN：放进 WHERE，`AND ${excludeDepositRefundSql('so')}`
 *   - 排名榜 LEFT JOIN service_orders：放进 ON 子句（保留零业绩门店出行），别名通常 'so2'
 */
import { sql, type SQL } from 'drizzle-orm'
import { DEPOSIT_REFUND_REMARK } from '@/lib/service-remark'

export function excludeDepositRefundSql(soAlias = 'so'): SQL {
  return sql`${sql.raw(soAlias)}.remark IS DISTINCT FROM ${DEPOSIT_REFUND_REMARK}`
}
