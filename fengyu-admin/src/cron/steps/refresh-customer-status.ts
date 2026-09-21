/**
 * STEP 1 — customer_status 重算（迁自 cronTask/index.js:34-86）
 *
 * 业务口径：customer_status 仅对 customer_type='会员客' 的顾客有值，
 * 非会员客（流量客 / 体验客 / 小美客）一律 NULL。
 *
 * 必须守住的不变量（#254 就是破了它）：**在单一快照下，每一行要么被某一段命中，
 * 要么现值已经等于应然值** —— 不允许存在「该改却三段都不碰」的行。
 * 注意这不等于「三段命中域的并集 = 全表」：已处于应然值的行本就不该被重写
 * （如非会员客 status 已是 NULL、无单会员客已是休眠），那是守卫在省 updated_at churn，不是漏行。
 *
 * 三段 SQL 在同一事务中串行：
 *   段 1：非会员客一律置 NULL（清理脏数据）
 *   段 2：会员客有到店记录的，按 visits_90d / total_visits 打状态
 *   段 3：会员客但完全无到店记录的，置 '休眠'（含已有旧值的 —— 见 RESET_NO_VISITS_SQL 注释）
 *
 * ⚠️ 「单一快照」这个前提不是摆设：事务是 READ COMMITTED，三条语句各取一次新快照，
 * 段间若有并发写 service_orders 落地，会出现瞬时偏差（某行本轮没人认领，或被段 2/段 3 各写一次）。
 * 这类偏差次日重跑即自愈，与 #254 那种「永久卡住」有本质区别，故不升级隔离级别。
 *
 * 与原 cronTask 的事务边界一致：整体一个 db.transaction，任一段失败 → 全段回滚。
 *
 * SQL 常量 export 出来以便测试做正则形态断言（与原 cronTask __test__ 导出对齐）。
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import type { CronContext } from '../lib/cron-context'

export const RESET_NON_MEMBER_STATUS_SQL = `
UPDATE client_wechat_users
   SET customer_status = NULL, updated_at = NOW()
 WHERE customer_status IS NOT NULL
   AND customer_type != '会员客'
`

/**
 * 段 2 SQL：含 CURRENT_DATE 时间引用。
 * ctx=undefined 时与原 raw SQL 等价（生产路径 + Vitest 形态断言）。
 *
 * ⚠️ 本段一次锁住上千行 client_wechat_users，且加锁顺序由执行计划决定
 * （hash join 走 ctid 物理序 / nested loop 走 HashAggregate 无序输出）。
 * 两个 cron 实例并发跑同一 STEP 时，若各自选了不同计划就可能 40P01 死锁，
 * 输的那个整个 STEP 回滚（三段一个事务）。手动 `--once` 必须与 03:00 定时跑错开 ——
 * runDailyJobs 目前没有任何互斥，靠人守。
 */
export const UPDATE_CUSTOMER_STATUS_SQL = `
WITH visit_stats AS (
  SELECT so.client_user_id,
         MAX(so.service_date) AS last_service_date,
         COUNT(DISTINCT so.service_date) AS total_visits,
         COUNT(DISTINCT so.service_date) FILTER (
           WHERE so.service_date >= CURRENT_DATE - INTERVAL '90 days'
         ) AS visits_90d
  FROM service_orders so
  WHERE so.status = '已完成' AND so.client_user_id IS NOT NULL
  GROUP BY so.client_user_id
)
UPDATE client_wechat_users u
   SET customer_status = CASE
         WHEN vs.visits_90d >= 1 AND vs.total_visits >= 6 THEN '保有会员-稳定'::customer_status
         WHEN vs.visits_90d >= 1 AND vs.total_visits <= 5 THEN '保有会员-有效'::customer_status
         WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '6 months' THEN '沉睡'::customer_status
         WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '12 months' THEN '冰冻'::customer_status
         ELSE '休眠'::customer_status
       END,
       updated_at = NOW()
  FROM visit_stats vs
 WHERE u.user_id = vs.client_user_id
   AND u.customer_type = '会员客'
`

/**
 * 段 3 SQL：会员客 ∧ 无已完成服务单 → '休眠'。
 *
 * ⚠️ 守卫必须是 `IS DISTINCT FROM '休眠'` 而非 `IS NULL`（#254）：
 * `NOT EXISTS(已完成服务单)` 与段 2 的 `visit_stats` join 互为补集（visit_stats 正由
 * `status='已完成'` 分组而来），「只补段 2 没分到的」这一意图已由它完整表达。再叠一个
 * `IS NULL` 就把「段 2 没分到 **且** 已有旧值」误判成不需要处理 —— 这类行三段全不匹配，
 * 旧状态永久卡住、cron 跑多少次都不自愈（prod 2026-09-22 实际命中 2 行）。
 *
 * 那 2 行的**成因至今未定位**，别把下面这句当已知结论：应用层写 service_orders.status 的
 * 路径全部封死了「已完成 → 其它态」（admin services.ts:1523/1595、staffApi service.js:1325），
 * 而实测那 2 人任何状态的服务单都是 0 条（撤销会留下 '已取消' 的行）。已知能绕过守卫的通道是
 * db/scripts 一次性修复脚本（repair-cancel-conversion-order-2608130108.js:328 就在
 * `UPDATE service_orders SET status='已取消' … WHERE status='已完成'`）与手工 SQL。
 * 修复的正当性不依赖成因：无论哪条通道，三段覆盖域必须是全表，否则脏了就不可自愈。
 *
 * 改用 `IS DISTINCT FROM` 既消除缺口（NULL 行仍命中），又保留「已是休眠就不重写
 * updated_at」的原意，与 refresh-spending-tier.ts 的范式一致。
 *
 * ⚠️ 本段的 `'休眠'` 出现 **2 处**（SET 与守卫），**两者必须永远相等** ——
 * 只改 SET 漏改守卫不会报错，而是让守卫恒真、段 3 每天重写全部无单会员客（静默劣化，
 * 比两处都漏改当场炸 22P02 更坏）。单测 `SET 与守卫的「休眠」字面量必须一致` 钉的就是这条。
 *
 * ⚠️⚠️ 枚举重命名（本仓做过一次：'预警沉睡' → '沉睡'）波及面**远不止本段** ——
 * 本文件段 2 的 CASE ELSE、`db/scripts/update-customer-status.js`、
 * `db/scripts/calc-monthly-activity.js`（含它的 dry-run 预览 CASE）、
 * 以及读取侧的 `src/actions/data-center/customer.ts`、`staffApi/routes/{customer,mgmt-traffic}.js`、
 * staff 小程序筛选项……**别照抄任何数字**（写死的计数必然过期，本注释已经错过两轮），
 * 改之前现查：`grep -rn "'休眠'" --include='*.ts' --include='*.js' --include='*.sql'`。
 * 本仓禁止跨端共享代码目录，这些副本一律靠人同步。
 */
export const RESET_NO_VISITS_SQL = `
UPDATE client_wechat_users u
   SET customer_status = '休眠'::customer_status, updated_at = NOW()
 WHERE u.customer_type = '会员客'
   AND u.customer_status IS DISTINCT FROM '休眠'::customer_status
   AND NOT EXISTS (
     SELECT 1 FROM service_orders so
      WHERE so.client_user_id = u.user_id AND so.status = '已完成'
   )
`

/**
 * 动态构造段 2 SQL：将 raw 中的 `CURRENT_DATE` 替换为 ctx.referenceDate 注入的字面量。
 * 仅替换 `CURRENT_DATE` 三处（90 days / 6 months / 12 months 各 1），不影响 `NOW()`（updated_at 仍真实时间）。
 */
function buildUpdateCustomerStatusSql(ctx?: CronContext): string {
  if (!ctx?.referenceDate) return UPDATE_CUSTOMER_STATUS_SQL
  const dateStr = formatYmd(ctx.referenceDate)
  // 用字面量替换（参数化此处复杂度高且 PG 不缓存查询计划差异）
  return UPDATE_CUSTOMER_STATUS_SQL.replace(/CURRENT_DATE/g, `('${dateStr}'::date)`)
}

function formatYmd(d: Date): string {
  // Asia/Shanghai 日历日期（与 PG CURRENT_DATE 在 +0800 时区一致）
  const shanghaiMs = d.getTime() + 8 * 60 * 60 * 1000
  return new Date(shanghaiMs).toISOString().slice(0, 10)
}

export interface CustomerStatusResult {
  clearedNonMember: number
  updatedMember: number
  resetNoVisit: number
  /**
   * 段 3 命中规模反常 —— 典型形态是 service_orders 处于异常态
   * （restore 进行中 / client_user_id 被批量置空 / 表刚清过重灌）。
   * 此时段 3 会把大批非休眠会员客一次刷成「休眠」，数据看板当天全归休眠档。
   * 不抛错（可自愈，且抛错会在新环境首跑等场景误伤），只标记 + warn 供运维判读。
   */
  suspiciousBulkReset: boolean
  /** 会员客总数，`suspiciousBulkReset` 的分母；也方便运维直接判读段 3 的占比 */
  memberTotal: number
  stats: Array<{ customer_status: string | null; cnt: number }>
}

/** 段 3 单跑命中多少行才值得怀疑数据源塌了。稳态下日增量是个位数（dev 实测 2）。 */
const BULK_RESET_SUSPICION_THRESHOLD = 100
/** 段 3 命中占会员客总数的比例上限。稳态约 0.1%，超过 10% 说明不是自然增量。 */
const BULK_RESET_SUSPICION_RATIO = 0.1

export async function refreshCustomerStatus(
  db: Db,
  ctx?: CronContext,
): Promise<CustomerStatusResult> {
  // 段 1/3 无时间引用，段 2 的 CURRENT_DATE 由 buildUpdateCustomerStatusSql 注入
  const updateSql = buildUpdateCustomerStatusSql(ctx)

  const result = await db.transaction(async (tx) => {
    const cleared = (await tx.execute(sql.raw(RESET_NON_MEMBER_STATUS_SQL))) as unknown as {
      count?: number
    }
    const updated = (await tx.execute(sql.raw(updateSql))) as unknown as {
      count?: number
    }
    const reset = (await tx.execute(sql.raw(RESET_NO_VISITS_SQL))) as unknown as { count?: number }

    const stats = (await tx.execute(sql`
      SELECT customer_status, COUNT(*)::int AS cnt
      FROM client_wechat_users
      GROUP BY customer_status
      ORDER BY customer_status
    `)) as Array<{ customer_status: string | null; cnt: number }>

    const memberTotalRows = (await tx.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM client_wechat_users WHERE customer_type = '会员客'
    `)) as Array<{ cnt: number }>
    const memberTotal = Number(memberTotalRows[0]?.cnt ?? 0)

    const updatedMember = updated.count ?? 0
    const resetNoVisit = reset.count ?? 0
    // 判据用「占会员客总数的比例」，不是「段 2 是否为 0」也不是「段 3 是否反超段 2」：
    // service_orders 中等塌陷（比如误删 40%）时段 2 仍会命中上千行，前两种判据都整片漏报
    // —— 1889 会员里 729 人被静默刷成休眠（稳态基线才 2 人）却不告警。
    // 绝对下限 100 是为了不让小库 / 新环境的自然波动刷屏。
    const suspiciousBulkReset =
      resetNoVisit >= BULK_RESET_SUSPICION_THRESHOLD &&
      resetNoVisit > memberTotal * BULK_RESET_SUSPICION_RATIO

    return {
      clearedNonMember: cleared.count ?? 0,
      updatedMember,
      resetNoVisit,
      suspiciousBulkReset,
      memberTotal,
      stats,
    }
  })

  // 告警放在 COMMIT 之后：事务内打印会在「已把这些行刷成休眠」之后又回滚，日志撒谎更难排障。
  if (result.suspiciousBulkReset) {
    const pct = ((result.resetNoVisit / result.memberTotal) * 100).toFixed(1)
    console.warn(
      `[customerStatus] 段 3 命中 ${result.resetNoVisit} 行 = 会员客总数 ${result.memberTotal} 的 ${pct}%` +
        `（段 2 命中 ${result.updatedMember} 行）—— service_orders 可能处于异常态` +
        '（restore 中 / client_user_id 被批量置空 / 表刚重灌）。' +
        '这些会员客已被刷成「休眠」，数据看板当天会偏向休眠档；' +
        '确认数据源恢复后重跑本 STEP 即可还原。',
    )
  }

  return result
}
