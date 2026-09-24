/**
 * 客量板块两端口径一致性守护
 *
 * 守护对象：
 *   - fengyu-admin/src/actions/data-center/customer.ts                         (Drizzle / TS)
 *   - fengyu-staff/cloudfunctions/staffApi/routes/mgmt-traffic.js              (pg / JS)
 *
 * 两端 ORM 不同 + admin 多了 byMarket/byStore 明细 → 完整 SQL snapshot 不可行。
 * 守护策略 = "关键不变量字面量匹配"（仿 dashboard.consistency.test.ts）：
 *   1. became_member_at（会员/新会员历史化口径）
 *   2. customer_status 枚举值 '沉睡'/'冰冻'/'休眠'（D-6 重命名后，禁 '预警沉睡'）
 *   3. 消费分桶阈值 1990 / 10000 / 30000 / 60000 / 100000（左闭右开）
 *   4. sales_category IN ('自销自耗','他销自耗')（项目数口径）
 *   5. 成交率分母 = 期初未达会员的到店活跃池 ∪ 本期全部新增会员（D-conv-denom=1c，#284；
 *      两端 KPI 侧走 `sqlInFunction` 切函数体断言，明细侧走 `adminSql` 块）
 *   6. spend = SUM(sale_order_performance_events.amount) @ performance_date（#138 起，与业绩 KPI 同源；
 *      不再按父订单 status 过滤、排除储值卡抵扣；非 metrics.md 的 paid_amount）
 *   7. anchor 反推关键字面量（visits_90d_prev / 6 months / 12 months / 90 days）
 *   8. 一次/二次客活 = 到店天数，(顾客, service_date) 去重（#298）—— 跨定义：admin visitDaysSql /
 *      staff mgmt-traffic / cron refresh-monthly-activity 三方由同一组口径常量拼出整段快照
 *
 * 任一端口径变更必须双端同步，否则数据中心客量板块与员工端 mgmtTraffic 数字对不上。
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, it, expect, beforeAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { visitDaysSql } from '@/lib/data-center/visit-days'
import { UPDATE_MONTHLY_ACTIVITY_SQL } from '@/cron/steps/refresh-monthly-activity'

const ADMIN_CUSTOMER = path.resolve(__dirname, '../customer.ts')
const STAFF_MGMT_TRAFFIC = path.resolve(
  __dirname,
  '../../../../../fengyu-staff/cloudfunctions/staffApi/routes/mgmt-traffic.js',
)

function normalize(src: string): string {
  return src.replace(/\s+/g, ' ').trim()
}

/**
 * 剥离 **JS/TS** 注释（避免 docstring 里的反例引用干扰反向守护）。
 *
 * ⚠ 刻意**不剥 SQL `--` 行注释**。两轮评审把「用正则剥 SQL 注释」这条路彻底打穿：
 *   - 只剥 `-- ` → `--AND ...`（不加空格）绕过
 *   - 放宽到 `(\s)--` → `WHERE TRUE--AND ...`（token 紧贴）仍绕过（codex + GLM 独立复现）
 *   - PG 支持**嵌套**块注释，非贪婪的块注释正则也能被绕
 *   - `--` 出现在 SQL 字符串字面量里（`note = ' --marker' AND paid_amount > 0`）会**误删**
 *     后续有效条件 → 反向断言 `not.toMatch` 反而通过 → 假绿（codex 给出反例，
 *     推翻了我此前「误剥只会误红」的论断）
 *
 * 结论：正则做不了 SQL 词法分析，补一次就冒出下一种等价写法 —— 与 #140 得到的
 * 「黑名单证明不了『没有任何日期条件』」是同一个教训。
 * 因此口径守护的**主力**改为下方 `EXPECTED_SPE_BLOCKS` 块级逐字快照，
 * 它**完全不经过本函数**：块文本与快照差一个字符就红，无需先识别注释。
 *
 * ⚠ 本函数**仅**服务于两类次要断言：逐块定位辅助、以及 `not.toMatch` 反向守卫。
 * 它用正则处理完整源码，codex 指出仍有理论误剥路径（`const marker = '//'; const paid_amount = x`
 * —— `//` 规则从字符串内部删到行尾，反向断言随之假绿；块注释同理）。
 * 当前两个被测文件**不含**触发该误剥的字符串，且这类回退真发生时会改动 FROM 子句 /
 * 块文本，被主守护直接拦下。若日后要彻底闭环，应改用 Babel parser 的真实 comment range
 * （项目已有先例：`.claude/skills/pack-delivery/scripts/strip-comments.mjs`）。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/**
 * **口径守护主力**：7 个 spe 查询块（admin 5 / staff 2）的
 * **投影 + JOIN 链 + WHERE + GROUP BY** 全文逐字快照。
 *
 * 为什么是逐字快照，而不是「找关键字面量」的各种变体 —— 四轮评审把后者逐级打穿：
 *   - r1：只剥 JS 注释 → SQL `-- AND ...` 注释掉过滤，正则仍匹配到注释里的字面量
 *   - r2：补剥 SQL `--` → `--AND`（无空格）绕过；再放宽 → `TRUE--AND`（token 紧贴）绕过；
 *         PG 还支持嵌套块注释；且误剥会让 `not.toMatch` 反向断言**假绿**
 *   - r3：改连续子串 → 因为串不含前导 `AND`，把**第一项**整行注释掉时串仍完整命中；
 *         `BETWEEN` 之后的实参完全没锁，`BETWEEN ${start} AND ${start}`、
 *         `WHERE TRUE OR (...)` 都能让过滤失效而文本不变
 *   - r4：块只从 `FROM` 起、截在 `GROUP BY` 前 → `SUM(spe.amount)` 外面套 `ABS()`/`GREATEST(...,0)`、
 *         改 `GROUP BY` 分组键（人→店）、追加 `HAVING FALSE` 三类改动全部不改块文本
 *
 * 每补一次就冒出下一种等价写法 —— 与 #140 得到的「黑名单证明不了『没有任何日期条件』」
 * 是同一个教训，最终也收敛到同一个形态：**整段逐字快照**。
 * 任何字符级改动（注释、改实参、改聚合函数、改分组键、加 `OR TRUE` / `HAVING`、
 * 调换顺序、插条件）都必须显式更新这里的常量，因此**不需要**先判断某段文本是不是注释。
 *
 * ⚠ 快照的合同是「锁漂移」，不是「证明 SQL 正确」。基线正确性由 round-1 两个谱系独立确认；
 * 日后源码与快照同时更新时，**必须重新做语义审查 + 出数对比**，否则等于把 bug 固化成期望值。
 *
 * ⚠ 射程之外（靠出数对比兜底，两个 reviewer 一致确认）：插值表达式的**生产者**
 * （`scopeFilterSql` / `range.start` / `startDateExpr` 的计算逻辑）、视图定义、结果后处理。
 *
 * ⚠ 改这些常量 = 改口径：必须同步另一端 + 重跑出数对比 + 在 PR 里说明差异。
 */
const EXPECTED_SPE_BLOCKS: Record<'admin' | 'staff', string[]> = {
  admin: [
    // queryOperatedMembers（会员经营人数）
    "SELECT o.client_user_id, SUM(spe.amount::numeric) AS spend FROM sale_order_performance_events spe JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id JOIN client_wechat_users c ON c.user_id = o.client_user_id WHERE ${sc} AND spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款', '退款') AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN ${range.start} AND ${range.end} AND c.customer_type = '会员客' GROUP BY o.client_user_id )",
    // queryMemberAvgTicket（会员客单价）—— CTE 与上一条同形，外层投影不同
    "SELECT o.client_user_id, SUM(spe.amount::numeric) AS spend FROM sale_order_performance_events spe JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id JOIN client_wechat_users c ON c.user_id = o.client_user_id WHERE ${sc} AND spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款', '退款') AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN ${range.start} AND ${range.end} AND c.customer_type = '会员客' GROUP BY o.client_user_id )",
    // queryNewMemberSpend（新会员消费）—— 多 became_member_at 谓词，无 customer_type，无 GROUP BY
    "SELECT COALESCE(SUM(spe.amount::numeric), 0) AS v FROM sale_order_performance_events spe JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id JOIN client_wechat_users c ON c.user_id = o.client_user_id WHERE ${sc} AND c.became_member_at IS NOT NULL AND c.became_member_at::date BETWEEN ${range.start} AND ${range.end} AND spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款', '退款') AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN ${range.start} AND ${range.end}",
    // 门店/市场明细·会员消费分桶 —— 用 skel JOIN 代替 ${sc}
    "SELECT ${groupId} AS group_id, o.client_user_id, SUM(spe.amount::numeric) AS spend FROM sale_order_performance_events spe JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id JOIN skel sk ON sk.store_id = o.store_id JOIN client_wechat_users c ON c.user_id = o.client_user_id WHERE spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款', '退款') AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN ${start} AND ${end} AND c.customer_type = '会员客' GROUP BY ${groupId}, o.client_user_id )",
    // 门店/市场明细·新会员消费
    "SELECT ${groupId} AS group_id, COALESCE(SUM(spe.amount::numeric), 0) AS new_spend FROM sale_order_performance_events spe JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id JOIN skel sk ON sk.store_id = o.store_id JOIN client_wechat_users c ON c.user_id = o.client_user_id WHERE c.became_member_at IS NOT NULL AND c.became_member_at::date BETWEEN ${start} AND ${end} AND spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款', '退款') AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN ${start} AND ${end} GROUP BY ${groupId} )",
  ],
  staff: [
    // queryMemberOps（会员经营 + 6 档分桶）
    "SELECT o.client_user_id, SUM(spe.amount::numeric) AS spend FROM sale_order_performance_events spe JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id JOIN client_wechat_users c ON c.user_id = o.client_user_id WHERE ${sc.sql} AND spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款', '退款') AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)} AND c.customer_type = '会员客' GROUP BY o.client_user_id )",
    // queryNewMemberSpend —— 无 GROUP BY，截到模板结束
    "SELECT COALESCE(SUM(spe.amount::numeric), 0) AS v FROM sale_order_performance_events spe JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id JOIN client_wechat_users c ON c.user_id = o.client_user_id WHERE ${sc.sql} AND c.became_member_at IS NOT NULL AND c.became_member_at::date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)} AND spe.sale_order_type IN ('销售单', '转换单') AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款', '退款') AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)}",
  ],
}

/**
 * 用 **TypeScript parser** 精确取出源码里的 SQL 模板串（只保留含 spe 的那些）。
 *
 * 为什么必须走 AST（round-5 codex P2）：此前用 `lastIndexOf('SELECT')` 在**整份源码**上
 * 找块起点，可被一行 SQL 注释劫持 —— 把真实投影改成 `AVG(spe.amount)`、再补一行
 * `-- SELECT o.client_user_id, SUM(spe.amount::numeric) AS spend`，
 * 提取出的块与原快照**逐字相同** → 全部断言绿。我复现确认了这条。
 *
 * AST 提取一步解决两件事：JS 注释/字符串天然不在模板串节点里；
 * 模板串边界由语法确定，不再靠找反引号（`${sql\`…\`}` 这类嵌套也不会截错）。
 */
function sqlTemplatesFromSource(src: string, fileName: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  )
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      // 去掉包裹的反引号，保留 `${...}` 占位原文
      const text = src.slice(n.getStart(sf) + 1, n.getEnd() - 1)
      if (text.includes('sale_order_performance_events')) out.push(text)
      // ⚠ 必须继续下钻（GLM r6）：`stripSqlComments` 把 `${...}` span 整段原样保留，
      // 所以 **inline 嵌套**的模板（`sql\`${flag ? sql\`…\` : sql\`…\`}\``）里的 SQL 注释不会被剥。
      // 早先命中后 `return` 不下钻，于是「内层放一个带 `-- SELECT …` 诱饵的分支、
      // 真查询改用别的别名」可以让块文本与快照逐字相同 → 全绿而运行时出数已漂移。
      // 下钻后内层模板被独立收集（各自剥注释、各自跑锚点），诱饵会被外层与内层**各计一次**
      // → 块数超出预期 → 红。正常（无 inline 嵌套）情况下不会重复，块数不变。
    }
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(sf, visit)
  return out
}

/**
 * 剥掉 SQL 注释的**字符扫描状态机**（不是正则）。
 *
 * 四轮评审证明正则做不了这件事（`--AND` / `TRUE--AND` / 嵌套块注释 / 字符串内的 `--`
 * 逐个绕过，详见 `EXPECTED_SPE_BLOCKS`）。这里按词法逐字符走，是可判定的：
 *   - `'...'` 单引号串（`''` 为转义）、`"..."` 双引号标识符、`$tag$...$tag$` dollar-quote → 原样保留
 *   - `${...}` JS 插值按大括号配平整段跳过 —— 必须先于引号处理，
 *     否则 `${excludeDepositRefundSql('so')}` 里的 `'so'` 会被当成 SQL 字符串起点
 *   - `--` 到行尾、`/* … *\/`（**支持 PG 的嵌套**）→ 替换为一个空格（不是删除，避免 token 粘连）
 *
 * ⚠ `$1` / `$2` 这类 PG 参数占位不会被误判为 dollar-quote。
 *
 * ⚠ **未闭合的字面量/注释直接抛错**（codex r6）：此前只是「原样复制剩余文本」，
 * 于是在某个受保护 `SELECT` 前插入未闭合的 `$tag$`，块起点仍从内部 `SELECT` 算，
 * 提取结果与快照逐字相同 —— 运行时 SQL 已语法错误，守护却全绿（fail-open）。
 * 现在改为抛错，由 vitest 直接报红。
 *
 * ⚠ 已知未覆盖的 PG 词法形态（**当前两文件零命中**，引入时最坏是误红）：
 *   - `E'...'` 的反斜杠转义、`U&'...'` unicode 字符串（GLM r7 B1）
 *   - `name$tag$` 这种 tag 与前一标识符的边界
 *   - `${...}` 配平不识别 span 内 JS 字符串里的裸 `{` / `}`（如 `${f('}')}`）
 */
function stripSqlComments(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const c2 = sql.slice(i, i + 2)

    if (c2 === '${') {
      let depth = 0
      let j = i
      let closed = false
      while (j < n) {
        if (sql[j] === '{') depth++
        else if (sql[j] === '}') {
          depth--
          if (depth === 0) {
            j++
            closed = true
            break
          }
        }
        j++
      }
      if (!closed) throw new Error(`模板插值 \${...} 未闭合（偏移 ${i}）`)
      out += sql.slice(i, j)
      i = j
      continue
    }

    if (c === "'") {
      let j = i + 1
      let closed = false
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2
          else {
            j++
            closed = true
            break
          }
        } else j++
      }
      if (!closed) throw new Error(`SQL 里有未闭合的单引号字符串（偏移 ${i}）`)
      out += sql.slice(i, j)
      i = j
      continue
    }

    if (c === '"') {
      let j = i + 1
      while (j < n && sql[j] !== '"') j++
      if (j >= n) throw new Error(`SQL 里有未闭合的双引号标识符（偏移 ${i}）`)
      j++
      out += sql.slice(i, j)
      i = j
      continue
    }

    if (c === '$') {
      // PG 的 dollar-quote tag 规则同未引标识符：可含数字、首位不可数字；`$$` 也合法。
      // `$1` / `$2` 参数占位不匹配（数字开头且无闭合 `$`）。
      // ⚠ 已知简化：未检查 tag 与前一个标识符的边界，`name$tag$` 会被误判为起始符（当前零命中）。
      //   未闭合时抛错，所以最坏是误红，不会静默放行。
      // 用 Unicode 属性转义：PG 的未引标识符允许非 ASCII 字母（`$标签$` 合法）
      const m = /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(sql.slice(i))
      if (m) {
        const tag = m[0]
        const close = sql.indexOf(tag, i + tag.length)
        if (close < 0) throw new Error(`SQL 里有未闭合的 dollar-quote ${tag}（偏移 ${i}）`)
        const j = close + tag.length
        out += sql.slice(i, j)
        i = j
        continue
      }
    }

    if (c2 === '--') {
      let j = i
      while (j < n && sql[j] !== '\n') j++
      out += ' '
      i = j
      continue
    }

    if (c2 === '/*') {
      let depth = 0
      let j = i
      while (j < n) {
        if (sql.slice(j, j + 2) === '/*') {
          depth++
          j += 2
        } else if (sql.slice(j, j + 2) === '*/') {
          depth--
          j += 2
          if (depth === 0) break
        } else j++
      }
      if (depth !== 0) throw new Error(`SQL 里有未闭合的块注释（偏移 ${i}）`)
      out += ' '
      i = j
      continue
    }

    out += c
    i++
  }
  return out
}

/**
 * 每个 spe 查询块 = **投影 + JOIN 链 + WHERE + GROUP BY**，取自
 * AST 提取 + SQL 注释剥净后的模板串。
 *
 *   起点：该 `FROM` 之前最近的 `SELECT`
 *   终点：`GROUP BY` 之后的第一个 `)`（CTE 收尾）；无 `GROUP BY` 时到模板串结束
 *
 * 注释已在上一步剥净，故起点不再会被注释里的 `SELECT` 劫持。
 *
 * ⚠ 已知边界（当前 7 块均无这些形态）：
 *   - `GROUP BY COALESCE(a,b)` / `HAVING SUM(x) > 0` 会让终点落在该 `)` 上（GLM r5）。
 *     **首次引入时会误红**（块文本变），但维护者刷新快照后该 `)` 之后的内容不再受保护；
 *     届时应把终点改为从 CTE 的 `AS (` 起做括号配平。
 *   - 锚点与表名计数都**大小写敏感**，`FROM SALE_ORDER_PERFORMANCE_EVENTS spe` 可同时绕过两者
 *     （GLM r7 B2）。PG 标识符大小写不敏感，但全仓一律小写，这需要刻意规避才会发生。
 *   - inline 嵌套里**不含表名**的诱饵（`${flag ? sql\`-- x\` : sql\`date_trunc(…)\`}`）
 *     不改变块数/表名计数（GLM r7 B3）—— 属已接受的「插值生产者」边界的 inline 变体，
 *     与 `startDateExpr` 同族，靠出数对比兜底。
 */
function speBlocksFromSource(src: string, fileName: string): string[] {
  const out: string[] = []
  for (const tmpl of sqlTemplatesFromSource(src, fileName)) {
    const sql = normalize(stripSqlComments(tmpl))
    const anchor = /FROM\s+sale_order_performance_events\s+spe/g
    let m: RegExpExecArray | null
    while ((m = anchor.exec(sql)) !== null) {
      const start = sql.lastIndexOf('SELECT', m.index)
      const after = m.index + m[0].length
      const groupBy = sql.indexOf('GROUP BY', after)
      let end: number
      if (groupBy >= 0) {
        const close = sql.indexOf(')', groupBy)
        end = close >= 0 ? close + 1 : sql.length
      } else {
        end = sql.length
      }
      out.push(sql.slice(start < 0 ? m.index : start, end).trim())
    }
  }
  return out
}

/**
 * 该文件里全部 spe 相关 SQL 的**纯 SQL 文本**（注释已剥净），供子串/计数类断言使用。
 *
 * ⚠ 这些断言必须用它、不能用源码原文：分桶阈值与经营人数门槛落在块快照射程之外，
 * round-5 codex 实测「改有效值 + 用 SQL 注释把原值补回去」可让计数/alias 断言假绿。
 */
function sqlTextFromSource(src: string, fileName: string): string {
  return normalize(
    sqlTemplatesFromSource(src, fileName)
      .map(stripSqlComments)
      .join(' \n '),
  )
}

/**
 * 切出**指定函数体内**的全部 SQL 模板串，剥净 SQL 注释。
 *
 * ⚠ 为什么必须有这个函数，不能直接对 `adminSrc` / `staffSrc` 做 `toMatch`（pr-ready round-8）：
 *
 * 成交率分母的 KPI 侧不变量一度是对**源码原文**断言的，于是
 * 「删掉 ① 的 `OR became_member_at` 分支和整个 ② 分支，再补一行
 *   `-- c.customer_type IN ('体验客','小美客') OR c.became_member_at::date BETWEEN ...`」
 * 能让全部断言照绿 —— 与 `EXPECTED_SPE_BLOCKS` 上方记载的假绿路径是同一条，换个位置复发了。
 * 红检只测了「删代码」，没测「删代码 + 用注释把字面量补回去」，所以没抓住。
 *
 * `sqlTemplatesFromSource` 帮不上：它按设计只收含 `sale_order_performance_events` 的模板
 * （那是 `EXPECTED_SPE_BLOCKS` 块数断言的基底，放宽采集条件会连带改块数、动了另一套守护）。
 * 因此这里另起一个**按函数名定位**的 AST 采集器，复用同一个 `stripSqlComments` 词法状态机。
 *
 * 同时它天然解决了另一个问题：admin 的明细 `traffic_cust` CTE 是同口径副本，含一模一样的
 * 字面量。对全文断言时，把 KPI 那处删掉、只留明细那处也照样绿（红检 R2 实测复现过）。
 * 按函数名切片后，两处各自被独立守护。
 *
 * ScriptKind 按后缀选，因此对 staffApi 的 `.js` 同样有效。
 */
function sqlInFunction(src: string, fileName: string, fnName: string): string {
  const sf = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  )
  const out: string[] = []
  const collectTemplates = (n: ts.Node): void => {
    if (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      out.push(src.slice(n.getStart(sf) + 1, n.getEnd() - 1))
    }
    ts.forEachChild(n, collectTemplates)
  }
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === fnName) {
      ts.forEachChild(n, collectTemplates)
    }
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(sf, visit)
  return normalize(out.map(stripSqlComments).join(' \n '))
}

/**
 * 指定函数声明的**完整源码**（剥 JS 注释 + 归一空白），含非 SQL 部分：
 * scope 生产者的列名实参、mode→条件的三元映射、结果取值 —— sqlInFunction 只收模板串，看不到这些（#298 评审 P2）。
 */
function fnSource(src: string, fileName: string, fnName: string): string {
  const sf = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  )
  const hits: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === fnName) hits.push(src.slice(n.getStart(sf), n.getEnd()))
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(sf, visit)
  if (hits.length !== 1) throw new Error(`fnSource: ${fnName} 在 ${fileName} 中命中 ${hits.length} 处`)
  return normalize(stripComments(hits[0]))
}

describe('客量板块两端口径一致性守护', () => {
  let adminSrc: string
  let staffSrc: string
  let adminCode: string // 剥 JS 注释后的源码（供非 SQL 断言用）
  let adminSql: string // AST 提取 + 剥净 SQL 注释后的纯 SQL
  let staffSql: string

  beforeAll(() => {
    adminSrc = fs.readFileSync(ADMIN_CUSTOMER, 'utf-8')
    staffSrc = fs.readFileSync(STAFF_MGMT_TRAFFIC, 'utf-8')
    adminCode = normalize(stripComments(adminSrc))
    adminSql = sqlTextFromSource(adminSrc, ADMIN_CUSTOMER)
    staffSql = sqlTextFromSource(staffSrc, STAFF_MGMT_TRAFFIC)
  })

  describe('会员 / 新会员 = became_member_at（历史化）', () => {
    it('admin 用 became_member_at::date', () => {
      expect(adminSrc).toMatch(/became_member_at::date/)
    })
    it('staff 用 became_member_at::date', () => {
      expect(staffSrc).toMatch(/became_member_at::date/)
    })
    it('两端均含 became_member_at IS NOT NULL 守卫', () => {
      expect(adminSrc).toMatch(/became_member_at\s+IS\s+NOT\s+NULL/)
      expect(staffSrc).toMatch(/became_member_at\s+IS\s+NOT\s+NULL/)
    })
  })

  describe('customer_status 枚举 = 沉睡 / 冰冻 / 休眠（D-6 重命名后）', () => {
    it('admin 含三档字面量', () => {
      expect(adminCode).toMatch(/'沉睡'/)
      expect(adminCode).toMatch(/'冰冻'/)
      expect(adminCode).toMatch(/'休眠'/)
    })
    it('staff 含三档字面量', () => {
      const staffCode = normalize(stripComments(staffSrc))
      expect(staffCode).toMatch(/'沉睡'/)
      expect(staffCode).toMatch(/'冰冻'/)
      expect(staffCode).toMatch(/'休眠'/)
    })
    it('两端禁用旧枚举 预警沉睡（防回归）', () => {
      expect(adminCode).not.toMatch(/预警沉睡/)
      expect(normalize(stripComments(staffSrc))).not.toMatch(/预警沉睡/)
    })
    it('两端保有会员状态字面量一致（保有会员-稳定 / 保有会员-有效）', () => {
      expect(adminSrc).toMatch(/保有会员-稳定/)
      expect(adminSrc).toMatch(/保有会员-有效/)
      expect(staffSrc).toMatch(/保有会员-稳定/)
      expect(staffSrc).toMatch(/保有会员-有效/)
    })

    /**
     * #294：本组三条断言把 UI 文案与 SQL 绑死。
     *
     * 客量板沉睡卡的 hint 写「截面快照（**仅会员客**）」、导出表头写「沉睡(截面·仅会员客)」，
     * 而冰冻/休眠不带这个括注 —— 这个文案差异的唯一依据就是下面两处 SQL 里
     * 沉睡独有的 `customer_type = '会员客'`。若它被删/被加到另两档上，文案立刻变成错的，
     * 而在补这组断言之前**全仓没有任何守护**（上面四条只断言枚举字面量存在，
     * 与本差异无关 —— 闸门 2 codex 指出原注释「被 consistency 守护」是不实陈述）。
     *
     * ⚠ 必须用 `adminCode`（剥过 JS 注释）而非 `adminSrc`：`customer.ts:174` 的 docstring
     * 与 `:542` 的 SQL 行注释都写着「沉睡追加 customer_type='会员客'」，
     * 用原文断言会被注释假绿。本组特征串含 `? sql` / `FILTER (WHERE` / `AS dormant`，
     * 注释里不含这些 token，`stripComments` 不剥 SQL `--` 也不影响判定。
     */
    it("沉睡档独有 customer_type='会员客'（标量侧）—— UI「仅会员客」文案的依据", () => {
      expect(adminCode).toMatch(
        /status === '沉睡'\s*\?\s*sql` AND c\.customer_type = '会员客'`\s*:\s*sql``/,
      )
    })
    it("沉睡档独有 customer_type='会员客'（明细 status_agg 侧）", () => {
      expect(adminCode).toMatch(
        /FILTER\s*\(WHERE c\.customer_status = '沉睡' AND c\.customer_type = '会员客'\)\s*AS dormant/,
      )
    })
    /**
     * ⚠ 本条是**黑名单**，与本文件 `stripComments` 上方记录的教训同源：正则黑名单
     * 证明不了「没有任何客型条件」。这里显式锁两种语序（正序 / 反序），
     * 仍可被 `c.customer_type IN (…)`、大小写变体、跨行拆分等写法绕过。
     * 真正兜底的是上面两条正向断言 —— 它们锚定沉睡分支的完整形态，
     * 任何把客型过滤挪到另两档的改法都会先让正向断言失配。
     */
    it('冰冻 / 休眠不得附带客型过滤（否则三档口径对等，UI 角标即失真）', () => {
      for (const status of ['冰冻', '休眠']) {
        // 正序：customer_status = 'X' AND c.customer_type ...
        expect(adminCode).not.toMatch(new RegExp(`customer_status = '${status}' AND c\\.customer_type`))
        // 反序：c.customer_type = '…' AND c.customer_status = 'X'（GLM r2 指出的绕过路径）
        expect(adminCode).not.toMatch(new RegExp(`customer_type = '[^']*' AND c\\.customer_status = '${status}'`))
      }
    })
  })

  describe('消费分桶阈值（左闭右开，6 档）', () => {
    const thresholds = ['1990', '10000', '30000', '60000', '100000']

    /**
     * ⚠ 必须带数字边界（GLM r4 P3-2）：裸的 `toContain('10000')` 恒真，
     * 因为 `100000` 里就含 `10000` —— 把 `< 10000` 整个删掉这条断言也不会红。
     */
    for (const [side, getSrc] of [
      ['admin', () => adminSql],
      ['staff', () => staffSql],
    ] as Array<[string, () => string]>) {
      it(`${side} 含全部 5 个阈值字面量（带数字边界）`, () => {
        for (const t of thresholds) {
          expect(getSrc(), `${side} 缺阈值 ${t}（或只作为更长数字的子串出现）`).toMatch(
            new RegExp(`(?<!\\d)${t}(?!\\d)`),
          )
        }
      })
    }

    /**
     * 分桶区间成对锁死。两端都必须有 —— GLM r4 指出 staff 此前只有 `toContain` 弱断言，
     * 把 `< 60000` 改成 `< 50000` 时 `'60000'` 仍被下一桶的 `>= 60000` 满足 → 全绿。
     */
    const PAIRS: Array<[string, RegExp]> = [
      ['[1990, 10000)', /spend\s*>=\s*1990\s+AND\s+spend\s*<\s*10000/g],
      ['[10000, 30000)', /spend\s*>=\s*10000\s+AND\s+spend\s*<\s*30000/g],
      ['[30000, 60000)', /spend\s*>=\s*30000\s+AND\s+spend\s*<\s*60000/g],
      ['[60000, 100000)', /spend\s*>=\s*60000\s+AND\s+spend\s*<\s*100000/g],
      ['[100000, ∞)', /spend\s*>=\s*100000/g],
      ['(-∞, 1990)', /spend\s*<\s*1990/g],
    ]

    /**
     * ⚠ 必须按**出现次数**断言，不能只判「存在」：
     * staff 每个区间写两遍（`bucketN_count` 的 `COUNT(*) FILTER` + `bucketN_spend` 的
     * `SUM(spend) FILTER`），只改其中一处时「存在」断言仍绿 —— 实测确认过这条漏网。
     * admin 每个区间只写一遍。
     */
    for (const [side, getCode, times] of [
      ['admin', () => adminSql, 1],
      ['staff', () => staffSql, 2],
    ] as Array<[string, () => string, number]>) {
      it(`${side} 分桶区间为左闭右开（按出现次数锁死，防单处漂移）`, () => {
        for (const [label, re] of PAIRS) {
          const hits = getCode().match(re) ?? []
          expect(
            hits.length,
            `${side} 的分桶区间 ${label} 出现 ${hits.length} 次，期望 ${times} 次` +
              `（改了其中一处上/下界？${side === 'staff' ? 'count 与 spend 两处必须同改' : ''}）`,
          ).toBe(times)
        }
      })
    }

    /**
     * 「会员经营人数」（spend >= 1990 去重人数）的门槛必须与分桶同值。
     * 它落在 GROUP BY **之后**的外层投影里，不在块级快照射程内（GLM r4 P3-2），
     * 故单独锁一条；否则把 `>= 1990` 改成 `>= 199` 时，分桶断言仍由明细查询满足 → 全绿。
     *
     * ⚠ **仅 admin 有这条**：staff 的 `queryMemberOps` 只返回 6 个桶的 count/spend
     * （`bucket1_count` … `bucket6_count`），不产出「经营人数」聚合，由调用方按桶汇总。
     * 这是两端有意的产出差异，不是漏改 —— 两端的**分桶阈值**仍由上面的成对 regex 共同锁死。
     */
    it('admin「经营人数」门槛为 spend >= 1990（staff 无此聚合，见注释）', () => {
      // ⚠ 必须逐个 alias 锁：admin 有两处（KPI 的 `AS v` + 明细的 `AS operated_total`），
      // 只判「存在」时改掉其中一处，另一处仍满足正则 → 全绿（实测确认过这条漏网）。
      for (const alias of ['v', 'operated_total']) {
        expect(
          adminSql,
          `admin 的经营人数门槛（AS ${alias}）不是 FILTER (WHERE spend >= 1990)`,
        ).toMatch(new RegExp(`FILTER\\s*\\(\\s*WHERE\\s+spend\\s*>=\\s*1990\\s*\\)\\s+AS\\s+${alias}(?![A-Za-z0-9_])`))
      }
      expect(
        staffSql,
        'staff 侧出现了经营人数聚合 —— 若这是有意新增，请同步本用例与两端出数对比',
      ).not.toMatch(/FILTER\s*\(\s*WHERE\s+spend\s*>=\s*1990\s*\)/)
    })

    it('admin 不复用 spending_tier 列（区间消费 ≠ lifetime 快照）', () => {
      expect(adminCode).not.toMatch(/spending_tier/)
    })
  })

  describe('项目数 = sales_category IN (自销自耗, 他销自耗)', () => {
    it('admin', () => {
      expect(adminSrc).toMatch(/sales_category\s+IN\s*\(\s*'自销自耗'\s*,\s*'他销自耗'\s*\)/)
    })
    it('staff', () => {
      expect(staffSrc).toMatch(/sales_category\s+IN\s*\(\s*'自销自耗'\s*,\s*'他销自耗'\s*\)/)
    })
  })

  /**
   * #284（2026-09-22 拍板 D-conv-denom=1c，推翻原 D-2=B）：
   * 分母 = ① 期初未达会员的到店活跃池 ∪ ② 本期全部新增会员。
   *
   * 旧断言只查「文件里存在 `customer_type IN ('体验客','小美客')`」—— 回退到旧口径后
   * 该字面量依然留在 ① 分支里，断言恒绿，是个**空转守护**。这里改为逐条锁两个分支的结构。
   *
   * ⚠ KPI 侧的 `queryTrialFootfall` 不含 `sale_order_performance_events`，
   * 不在 `adminSql`/`staffSql` 的采集范围内（见 `sqlTemplatesFromSource` 的过滤条件），
   * 只能对源码原文断言；明细侧的同口径守护见「市场明细人数在市场内去重」，那条走 `adminSql`。
   */
  describe('成交率分母 = 期初未达会员活跃池 ∪ 本期全部新增会员（D-conv-denom=1c，#284）', () => {
    let adminTrial: string
    let staffTrial: string
    beforeAll(() => {
      adminTrial = sqlInFunction(adminSrc, ADMIN_CUSTOMER, 'queryTrialFootfall')
      staffTrial = sqlInFunction(staffSrc, STAFF_MGMT_TRAFFIC, 'queryTrialFootfall')
    })

    /**
     * 切片完整性自检。两种退化都要拦：
     *   - 函数被改名/删除 → 空串
     *   - AST 只捞到半截（例如日后 SQL 被拆成多个模板、或函数被包进别的结构）
     *     → 恰好只剩 ① 分支时，下面的 ② 断言才会红；先在这里就把「首尾都在」钉住，
     *       失败信息更直接。
     */
    it('两端都能切出完整的 queryTrialFootfall SQL（切片锚点有效）', () => {
      for (const [side, sqlText] of [['admin', adminTrial], ['staff', staffTrial]] as const) {
        expect(sqlText, `${side} queryTrialFootfall 的 SQL 未切出`).toBeTruthy()
        expect(sqlText, `${side} 切片缺 ① 分支的 FROM service_orders`).toMatch(/FROM\s+service_orders\s+so/)
        expect(sqlText, `${side} 切片缺外层子查询别名 ) t —— 可能只捞到半截`).toMatch(/\)\s*t\b/)
      }
    })

    /** 两端 KPI 分母查询共享的结构不变量（整体层面） */
    const DENOM_INVARIANTS: Array<[string, RegExp]> = [
      ['外层对 UNION 结果去重', /COUNT\(DISTINCT\s+t\.uid\)/],
      ['① 到店活跃池取已完成服务单', /FROM\s+service_orders\s+so[\s\S]*?so\.status\s*=\s*'已完成'/],
      [
        '① 期初未达会员 = 当前仍未达会员 OR 本期内才转化（缺 OR 即回到只升不降的快照口径）',
        /c\.customer_type\s+IN\s*\(\s*'体验客'\s*,\s*'小美客'\s*\)\s*OR\s+c\.became_member_at::date\s+BETWEEN/,
      ],
      [
        '② 本期全部新增会员 UNION 进分母（缺它则分子 ⊄ 分母，单店成交率仍可能 > 100%）',
        /UNION[\s\S]*?SELECT\s+c\.user_id\s+AS\s+uid[\s\S]*?FROM\s+client_wechat_users\s+c/,
      ],
    ]

    it.each(DENOM_INVARIANTS)('admin：%s', (_label, re) => {
      expect(adminTrial).toMatch(re)
    })

    it.each(DENOM_INVARIANTS)('staff：%s', (_label, re) => {
      expect(staffTrial).toMatch(re)
    })

    /**
     * 切出 `UNION` 之后的 ② 分支单独断言（codex round-1 P2）。
     *
     * ⚠ 为什么整体断言不够：`became_member_at::date BETWEEN` 这个字面量**① 分支里也有**
     * （① 的 OR 右半边就是它）。于是「把 ② 的 `AND c.became_member_at::date BETWEEN ... `
     * 整行删掉」——分母会纳入**全部历史会员**（回溯到 2022-08）、成交率被直接扭曲——
     * 而上面 `DENOM_INVARIANTS` 的 BETWEEN 断言被 ① 顶上，守护照样全绿。
     *
     * 按 `UNION` 切分后 ① 的内容不在切片里，字面量无法互相顶替。
     */
    const secondBranch = (sqlText: string): string => sqlText.split(/\bUNION\b/)[1] ?? ''

    /**
     * 切片前提自检（round-2 codex/DeepSeek P3）：`split(/\bUNION\b/)[1]` 隐含
     * 「目标 SQL 里第一个 UNION 就是两分支的边界」。若日后 ① 内部引入子查询 UNION，
     * `[1]` 会取到中段、② 的真过滤被静默漏检。这里把「恰好一个 UNION」钉死，
     * 前提一破就红，不会静默漂移。
     */
    it('两端分母 SQL 恰有一个 UNION（secondBranch 切片的前提）', () => {
      for (const [side, sqlText] of [['admin', adminTrial], ['staff', staffTrial]] as const) {
        expect(sqlText.match(/\bUNION\b/g) ?? [], `${side} 的分母 SQL 不是恰好一个 UNION`).toHaveLength(1)
      }
    })

    /**
     * ② 分支的结构不变量。
     *
     * ⚠ 日期条件必须连同**边界实参**一起锁（round-2 codex P2）：只断言
     * `became_member_at::date BETWEEN` 的话，`BETWEEN DATE '1900-01-01' AND ${range.end}`
     * 或 `BETWEEN ${range.start} AND ${range.start}` 都照样绿 —— 前者正是 R11 要防的
     * 「重新纳入全部历史会员」。两端的区间表达式不同名，所以分开列。
     */
    const BRANCH2_COMMON: Array<[string, RegExp]> = [
      ['② 从 client_wechat_users 取本期新增会员', /SELECT\s+c\.user_id\s+AS\s+uid[\s\S]*?FROM\s+client_wechat_users\s+c/],
      ['② 有 became_member_at IS NOT NULL 守卫', /c\.became_member_at\s+IS\s+NOT\s+NULL/],
    ]
    /** 两端各自的「本期」区间表达式（连边界实参一起锁） */
    const BRANCH2_RANGE: Record<'admin' | 'staff', [string, RegExp]> = {
      admin: [
        '② 的本期限定用 range.start/range.end（缺或改坏则纳入错误区间的会员）',
        /c\.became_member_at::date\s+BETWEEN\s+\$\{range\.start\}\s+AND\s+\$\{range\.end\}/,
      ],
      staff: [
        '② 的本期限定用 startDateExpr/endDateExpr（缺或改坏则纳入错误区间的会员）',
        /c\.became_member_at::date\s+BETWEEN\s+\$\{startDateExpr\(period\)\}\s+AND\s+\$\{endDateExpr\(period\)\}/,
      ],
    }

    it.each(BRANCH2_COMMON)('admin ② 分支：%s', (_label, re) => {
      const b2 = secondBranch(adminTrial)
      expect(b2, 'admin 的 UNION ② 分支切不出来').toBeTruthy()
      expect(b2).toMatch(re)
    })

    it.each(BRANCH2_COMMON)('staff ② 分支：%s', (_label, re) => {
      const b2 = secondBranch(staffTrial)
      expect(b2, 'staff 的 UNION ② 分支切不出来').toBeTruthy()
      expect(b2).toMatch(re)
    })

    it('admin ② 分支：' + BRANCH2_RANGE.admin[0], () => {
      expect(secondBranch(adminTrial)).toMatch(BRANCH2_RANGE.admin[1])
    })

    it('staff ② 分支：' + BRANCH2_RANGE.staff[0], () => {
      expect(secondBranch(staffTrial)).toMatch(BRANCH2_RANGE.staff[1])
    })

    /**
     * 两段 scope 各自绑定到正确的列，且用在正确的分支上（codex round-1 P2 / DeepSeek P3）。
     *
     * ⚠ admin 侧的列名是 `scopeFilterSql` 的**字符串参数**，不落进 SQL 模板 ——
     * 所以上面所有基于 SQL 文本的断言都看不见它。把 ① 的 `scVisit` 从 `so.store_id`
     * 改成 `c.bound_store_id`（或把两个插值位置对调），admin KPI 就与 staff、与明细的
     * 「按服务发生门店」口径分叉了，而 `customer.test.ts` 不执行真实 SQL，全绿。
     * staff 侧因为 `buildSaleScope` 在运行期把 `so.store_id` 拼进 SQL，已被
     * `mgmt-traffic.test.js` 的 market/store `test.each` 兜住，admin 侧此前没有对应断言。
     */
    it('admin 两段 scope 绑定正确的列，且分别用在 ①/② 分支上', () => {
      expect(adminCode, '① 应按服务发生门店 so.store_id 取 scope').toMatch(
        /scVisit\s*=\s*scopeFilterSql\(session,\s*scope,\s*'so\.store_id'\)/,
      )
      expect(adminCode, '② 应按顾客绑定门店 c.bound_store_id 取 scope（与分子同源）').toMatch(
        /scMember\s*=\s*scopeFilterSql\(session,\s*scope,\s*'c\.bound_store_id'\)/,
      )
      // 插值占位在模板里原样保留，可据此锁住「哪段用哪个」
      const [branch1, branch2] = [adminTrial.split(/\bUNION\b/)[0], secondBranch(adminTrial)]
      expect(branch1, '① 分支未使用 scVisit').toContain('${scVisit}')
      expect(branch1, '① 分支误用了 scMember').not.toContain('${scMember}')
      expect(branch2, '② 分支未使用 scMember').toContain('${scMember}')
      expect(branch2, '② 分支误用了 scVisit').not.toContain('${scVisit}')
    })

    /**
     * staff 侧的同款守护（round-2 DeepSeek P2）。
     *
     * ⚠ 我在 round-1 误以为 `mgmt-traffic.test.js` 的 market/store `test.each` 已经兜住了
     * 这条 —— **不成立**。那四个断言（`params===[scopeId,scopeId]`、`so.store_id = $1`、
     * `c.bound_store_id = $2`、`$2` 存在）锁的是「列 → 参数号」的绑定，而参数号来自
     * **变量声明顺序**（`scVisit` 用 1、`scMember` 用 `1 + scVisit.params.length`），
     * 不是「哪个分支用哪个占位」。
     *
     * 攻击路径：只把模板里两行插值对调（`WHERE ${scMember.sql}` 放进 ①、
     * `WHERE ${scVisit.sql}` 放进 ②），变量声明不动 —— SQL 里 `so.store_id = $1` 与
     * `c.bound_store_id = $2` 仍双双出现、params 仍是两个 scopeId，全绿；
     * 而 ① 变成按绑定门店取 scope、② 变成按服务发生门店，口径彻底反了。
     *
     * staff 的占位带 `.sql` 后缀（`buildXxxScope` 返回 `{sql, params}`），与 admin 不同。
     */
    it('staff 两段 scope 分别用在 ①/② 分支上（占位带 .sql 后缀）', () => {
      const [branch1, branch2] = [staffTrial.split(/\bUNION\b/)[0], secondBranch(staffTrial)]
      expect(branch1, '① 分支未使用 scVisit').toContain('${scVisit.sql}')
      expect(branch1, '① 分支误用了 scMember').not.toContain('${scMember.sql}')
      expect(branch2, '② 分支未使用 scMember').toContain('${scMember.sql}')
      expect(branch2, '② 分支误用了 scVisit').not.toContain('${scVisit.sql}')
    })

    /**
     * 这条断言的对象是**代码**（scope 由哪个 helper、按哪一列构造），不是 SQL 文本，
     * 所以用剥过 JS 注释的 `adminCode` / `staffCode` 而非原文 —— 否则一行
     * `// const scMember = scopeFilterSql(session, scope, 'c.bound_store_id')` 就能让它假绿。
     */
    it('两端 ② 分支都按 bound_store_id 归店（与各自的分子 newMemberCount 同源）', () => {
      // ⚠ 锚到 scMember 这个绑定名，否则分子 queryNewMemberCount 里的同一行调用会让断言假绿
      expect(adminCode).toMatch(/scMember\s*=\s*scopeFilterSql\(session,\s*scope,\s*'c\.bound_store_id'\)/)
      expect(normalize(stripComments(staffSrc))).toMatch(
        /buildClientScope\(scopeType,\s*scopeId,\s*'c',\s*1\s*\+\s*scVisit\.params\.length\)/,
      )
    })
  })

  /**
   * #138（2026-09-16）：spend 从「订单快照 `received - refunded_amount` @ `paid_at`」
   * 改为「已入账款项流水 `SUM(spe.amount)` @ `performance_date`」，与业绩 KPI 同源。
   *
   * 连带两个语义变化（都是有意的）：
   *   - **不再按父订单 status 过滤** —— 款项流水自带 status，部分支付订单的已到账款也计入
   *   - **排除储值卡抵扣** —— `change_type IN ('首次支付','回款','退款')`，与组织层级业绩一致
   *
   * 分桶阈值（1990 / 1w / 3w / 6w / 10w）不变。
   */
  describe('会员消费 spend = 已入账款项流水 @ 业绩归属日期（#138，两端同源）', () => {
    const SPEND_INVARIANTS: Array<[string, RegExp]> = [
      ['金额取款项流水', /SUM\(spe\.amount::numeric\)/],
      ['数据源是业绩事件视图', /FROM\s+sale_order_performance_events\s+spe/],
      ['JOIN 回订单表取 client_user_id', /JOIN\s+sale_orders\s+o\s+ON\s+o\.sale_order_id\s*=\s*spe\.sale_order_id/],
      ['订单类型限定', /spe\.sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)/],
      ['款项状态已支付', /spe\.status\s*=\s*'已支付'/],
      ['排除储值卡抵扣', /spe\.change_type\s+IN\s*\(\s*'首次支付'\s*,\s*'回款'\s*,\s*'退款'\s*\)/],
      ['排除 workfine 历史单', /spe\.legacy_source\s+IS\s+DISTINCT\s+FROM\s+'workfine'/],
      ['日期走业绩归属日期', /spe\.performance_date\s+BETWEEN/],
    ]

    it.each(SPEND_INVARIANTS)('admin 侧：%s', (_label, re) => {
      expect(adminCode).toMatch(re)
    })

    it.each(SPEND_INVARIANTS)('staff 侧：%s', (_label, re) => {
      expect(normalize(stripComments(staffSrc))).toMatch(re)
    })

    /**
     * ⚠ 上面的 `toMatch` 只证明「文件里存在」，挡不住**单处漏改**：
     * admin 有 5 个会员消费查询（3 个 KPI + 2 个明细），staff 有 2 个。
     * 删掉其中一处的 `change_type` 过滤，其余几处仍满足正则 —— 实测确认过这条漏网。
     *
     * 这里按 `FROM sale_order_performance_events spe` 切块，**逐块**检查 WHERE 侧过滤：
     * 断言数随查询数自适应（用 `>=`，新增/合并查询不会在**本条**产生一堆假红），
     * 失败时能指出是第几个查询缺了哪一项。
     * 块尾截到 `GROUP BY` / 下一个查询，避免借用后文字符串造成假绿。
     *
     * ⚠ **本条是失败定位辅助，不是主守护**。它用剥过 JS 注释的文本 + 5 条独立正则，
     * 因此「把某行过滤注释掉」这类改动它**拦不住**（SQL 注释刻意不剥，原因见
     * `stripComments`）。真正拦下的是下方 `EXPECTED_SPE_BLOCKS` 块级逐字快照；
     * 本条的价值是在那条红掉之后，直接指出「第几个查询缺了哪一项」——
     * 快照断言只能告诉你「这一块不一样」，定位到具体哪一项要靠这里。
     *
     * 另两点澄清（GLM 评审 P3-3）：
     * 1. 「自适应」只限本条。「金额按出现次数锁死」与主守护都是精确 `toBe(5/2)`，
     *    新增 spe 查询仍会红在那里——那是有意的（防某处改回订单快照），需连同更新期望值。
     * 2. 截断标记 `SELECT\s+COALESCE` 对当前 5+2 块**从未实际命中**（全截在 GROUP BY 或 EOF），
     *    末块因此会借用后文文本。GLM 实测确认借用段不含任何 `spe.*` 引用
     *    （别名必须先有 FROM 才成立），**无假绿路径**，只是失败信息定位偏长。
     */
    it('每个会员消费查询块内的过滤都齐全（逐块定位辅助，防单处漏改）', () => {
      const WHERE_INVARIANTS: Array<[string, RegExp]> = [
        ['订单类型', /spe\.sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)/],
        ['款项状态已支付', /spe\.status\s*=\s*'已支付'/],
        ['排除储值卡抵扣', /spe\.change_type\s+IN\s*\(\s*'首次支付'\s*,\s*'回款'\s*,\s*'退款'\s*\)/],
        ['排除 workfine', /spe\.legacy_source\s+IS\s+DISTINCT\s+FROM\s+'workfine'/],
        ['归属日期区间', /spe\.performance_date\s+BETWEEN/],
      ]
      const SITES: Array<[string, string, number]> = [
        ['admin', adminCode, 5],
        ['staff', normalize(stripComments(staffSrc)), 2],
      ]
      for (const [side, code, minBlocks] of SITES) {
        const blocks = code
          .split(/FROM\s+sale_order_performance_events\s+spe/)
          .slice(1)
          // 块尾截到 GROUP BY 或下一个 SELECT，避免借用后文内容假绿
          .map((b) => b.split(/GROUP BY|SELECT\s+COALESCE/)[0])
        expect(blocks.length, `${side} 的会员消费查询数少于预期（整块被删？）`)
          .toBeGreaterThanOrEqual(minBlocks)
        blocks.forEach((block, i) => {
          for (const [label, re] of WHERE_INVARIANTS) {
            expect(block, `${side} 第 ${i + 1} 个会员消费查询缺「${label}」`).toMatch(re)
          }
        })
      }
    })

    /**
     * **口径守护主力**（设计理由见 `EXPECTED_SPE_BLOCKS` 的说明）。
     *
     * 在**原文**（只归一化空白，不剥任何注释）上切出 7 个 spe 查询块，
     * 逐块与快照全等比较。这条一旦红，说明 JOIN 链或 WHERE 里有任何字符被动过 ——
     * 上方的逐块断言用来进一步告诉你「是第几个查询缺了哪一项」。
     */
    it('7 个 spe 查询块逐字快照（主守护，不依赖注释剥离）', () => {
      for (const [side, src, file] of [
        ['admin', adminSrc, ADMIN_CUSTOMER],
        ['staff', staffSrc, STAFF_MGMT_TRAFFIC],
      ] as Array<['admin' | 'staff', string, string]>) {
        const expectedBlocks = EXPECTED_SPE_BLOCKS[side]
        const blocks = speBlocksFromSource(src, file)

        expect(
          blocks.length,
          `${side} 的 spe 查询块数为 ${blocks.length}，期望 ${expectedBlocks.length}。` +
            '整块被删、或新增了会员消费查询（后者需同步更新 EXPECTED_SPE_BLOCKS + 出数对比）。',
        ).toBe(expectedBlocks.length)

        blocks.forEach((block, i) => {
          expect(
            block,
            `${side} 第 ${i + 1} 个 spe 查询块与快照不符。\n` +
              '任何字符级改动都会命中这条：过滤被删/被注释、BETWEEN 实参被换、' +
              '加了 OR TRUE、顺序调换、插了别的条件。\n' +
              '确认是有意的口径变更后，同步更新 EXPECTED_SPE_BLOCKS、另一端副本，并重跑出数对比。',
          ).toBe(expectedBlocks[i])
        })
      }
    })

    /**
     * 上一条的**反向验证**：把四轮评审逐级打穿的每种绕过形态固化下来。
     *
     * ⚠ 关键在于这些变异是**注入真实源码后再走 `speBlocksFromSource()`**的
     * （codex r4 指出：上一版只比较孤立字符串，提取或截断逻辑退化时这条用例自身仍会全绿，
     * 等于没验证到主守护）。现在提取逻辑一旦退化，这里就会红。
     *
     * 前几版守护（剥 SQL 注释 / 找关键字面量 / 连续子串 / 只锁 FROM..GROUP BY）对这些形态
     * 各有漏网，详见 `EXPECTED_SPE_BLOCKS` 的说明。
     */
    it('各种绕过形态注入源码后都会破坏块级逐字快照（反向验证主守护）', () => {
      const CHANGE_TYPE = "AND spe.change_type IN ('首次支付', '回款', '退款')"
      const ORDER_TYPE = "AND spe.sale_order_type IN ('销售单', '转换单')"
      const AMOUNT = 'SUM(spe.amount::numeric) AS spend'
      // ⚠ 必须带 `spe.performance_date` 前缀：裸的 `${range.start} AND ${range.end}`
      // 在源码里首次出现于 became_member_at 谓词（spe 块之外），replace 会打偏 →
      // 变异落在块外、块文本不变 → 用例误判成「未被拦下」。这条是本用例自己抓出来的。
      const RANGE = 'AND spe.performance_date BETWEEN ${range.start} AND ${range.end}'

      // 用例前提：这些锚点必须在源码里真实存在，否则 replace 静默失效 → 用例假绿
      for (const [label, anchor] of [
        ['change_type 过滤', CHANGE_TYPE],
        ['订单类型过滤', ORDER_TYPE],
        ['金额表达式', AMOUNT],
        ['区间实参', RANGE],
        ['分组键', 'GROUP BY o.client_user_id'],
      ] as Array<[string, string]>) {
        expect(adminSrc.includes(anchor), `用例前提失效：源码里找不到${label}「${anchor}」`).toBe(true)
      }

      const rep = (from: string, to: string) => adminSrc.replace(from, to)

      const BYPASS_ATTEMPTS: Array<[string, string]> = [
        // r1：最常见的维护动作，只剥 JS 注释时漏网
        ['行首 `-- ` 带空格', rep(CHANGE_TYPE, `-- ${CHANGE_TYPE}`)],
        // 自查：`--` 后不带空格同样是合法 PG 注释
        ['行首 `--` 无空格', rep(CHANGE_TYPE, `--${CHANGE_TYPE}`)],
        // r2 codex：token 紧贴 `--`（前面无空白），两版剥注释正则都拦不住。
        // ⚠ 必须连同换行一起吃掉、真的注释掉后续条件 —— 只在行尾加 `--` 等于注释了个空，
        // SQL 语义没变，本就不该红（codex r5 P3-2 指出上一版这条变异名不副实）。
        [
          'token 紧贴 `--`',
          adminSrc.replace(/'已支付'\s+AND spe\.change_type/, `'已支付'--AND spe.change_type`),
        ],
        // PG 块注释 / 嵌套块注释（非贪婪正则会在内层 */ 停下）
        ['块注释包裹', rep(CHANGE_TYPE, `/* ${CHANGE_TYPE} */`)],
        ['嵌套块注释', rep(CHANGE_TYPE, `/* outer /* nested */ ${CHANGE_TYPE} */`)],
        // r3 codex：注释掉**第一项** —— 连续子串版因串不含前导 AND 而完全漏网
        ['注释掉第一项过滤', rep(ORDER_TYPE, `-- ${ORDER_TYPE}`)],
        // r3 codex：BETWEEN 实参漂移 / OR 短路 —— 连续子串版止于 BETWEEN，同样漏网
        ['BETWEEN 起止同值', rep(RANGE, 'AND spe.performance_date BETWEEN ${range.start} AND ${range.start}')],
        ['BETWEEN 起止颠倒', rep(RANGE, 'AND spe.performance_date BETWEEN ${range.end} AND ${range.start}')],
        // ⚠ 同样要精确锚定到 spe 查询：裸的 `WHERE ${sc}` 在别的 KPI 查询里先出现
        [
          'OR TRUE 短路 WHERE',
          adminSrc.replace(
            /WHERE \$\{sc\}(\s+)AND spe\.sale_order_type/,
            'WHERE TRUE OR ${sc}$1AND spe.sale_order_type',
          ),
        ],
        // r4 codex：金额表达式被 clamp —— 块只从 FROM 起时完全漏网。
        // 这是**最可能真实发生**的一类（业务要求「不显示负数」）
        ['ABS 抹平退款净额', rep(AMOUNT, 'ABS(SUM(spe.amount::numeric)) AS spend')],
        ['GREATEST clamp', rep(AMOUNT, 'GREATEST(SUM(spe.amount::numeric), 0) AS spend')],
        // r4 GLM：聚合粒度从「人」变「店」；r4 codex：HAVING 归零 —— 截在 GROUP BY 前时都漏网
        ['改 GROUP BY 分组键', rep('GROUP BY o.client_user_id', 'GROUP BY o.store_id')],
        ['追加 HAVING FALSE', rep('GROUP BY o.client_user_id', 'GROUP BY o.client_user_id HAVING FALSE')],
        // 不是注释，但同样是口径漂移
        ['中间插入额外条件', rep(CHANGE_TYPE, `${CHANGE_TYPE} AND 1 = 1`)],
      ]

      const expected = EXPECTED_SPE_BLOCKS.admin
      for (const [label, mutatedSrc] of BYPASS_ATTEMPTS) {
        expect(mutatedSrc, `「${label}」构造无效：replace 未生效，用例本身失效`).not.toBe(adminSrc)

        const blocks = speBlocksFromSource(mutatedSrc, ADMIN_CUSTOMER)
        const allMatch =
          blocks.length === expected.length && blocks.every((b, i) => b === expected[i])
        expect(
          allMatch,
          `「${label}」变异后 7 块仍逐字命中快照。两种可能：\n` +
            '① 主守护漏了这条路径（假绿复活）；\n' +
            '② 本用例的替换锚点没落在 spe 查询块内（构造错误，需把锚点写得更精确）。\n' +
            '先确认 ②：锚点在源码里的首次出现是否就在某个 spe 查询里。',
        ).toBe(false)
      }
    })

    /**
     * `stripSqlComments()` 是整个守护的地基 —— 它错了，上面所有逐字快照一起失效。
     * 所以它自己也要被测：这里逐条钉死词法边界。
     */
    describe('stripSqlComments 词法边界（守护的地基）', () => {
      const clean = (s: string) => normalize(stripSqlComments(s))

      it('剥掉行注释的各种贴法', () => {
        expect(clean("a = 1\n-- AND b = 2\nAND c = 3")).toBe('a = 1 AND c = 3')
        expect(clean("a = 1\n--AND b = 2\nAND c = 3"), '`--` 后不带空格').toBe('a = 1 AND c = 3')
        expect(clean("a = 1--AND b = 2\nAND c = 3"), 'token 紧贴 `--`').toBe('a = 1 AND c = 3')
      })

      it('剥掉块注释，含 PG 的嵌套块注释', () => {
        expect(clean('a = 1 /* AND b = 2 */ AND c = 3')).toBe('a = 1 AND c = 3')
        expect(
          clean('a = 1 /* outer /* inner */ AND b = 2 */ AND c = 3'),
          'PG 支持嵌套；非贪婪正则会在内层 */ 停下，状态机不会',
        ).toBe('a = 1 AND c = 3')
      })

      it('字符串字面量里的注释符**不能**被当成注释', () => {
        expect(clean("note = '-- not a comment' AND c = 3")).toBe(
          "note = '-- not a comment' AND c = 3",
        )
        expect(clean("note = '/* not a comment */' AND c = 3")).toBe(
          "note = '/* not a comment */' AND c = 3",
        )
        expect(clean("note = 'it''s -- fine' AND c = 3"), "'' 转义").toBe(
          "note = 'it''s -- fine' AND c = 3",
        )
      })

      it('${} 插值整段跳过——里面的引号不得干扰 SQL 词法', () => {
        // 若不先跳过 ${}，`'so'` 的开引号会吞掉后面的 `--`，导致注释漏剥
        expect(clean("AND ${excludeDepositRefundSql('so')}\n-- AND b = 2\nAND c = 3")).toBe(
          "AND ${excludeDepositRefundSql('so')} AND c = 3",
        )
        // 插值内的大括号要按配平跳过
        expect(clean('AND ${f({ a: 1 })} AND c = 3')).toBe('AND ${f({ a: 1 })} AND c = 3')
      })

      it('PG 参数占位 $1/$2 不被误判为 dollar-quote', () => {
        expect(clean('a = $1 AND b = $2\n-- AND c = 3\nAND d = $3')).toBe(
          'a = $1 AND b = $2 AND d = $3',
        )
      })

      it('dollar-quote 内容原样保留', () => {
        expect(clean("a = $tag$ -- not a comment $tag$ AND c = 3")).toBe(
          "a = $tag$ -- not a comment $tag$ AND c = 3",
        )
      })

      it('注释替换成空格而非删除，不制造新 token', () => {
        // 若删成空串，`1` 与 `AND` 会粘成 `1AND`
        expect(clean('a = 1/* x */AND c = 3')).toBe('a = 1 AND c = 3')
      })

      /**
       * 未闭合字面量必须 **fail-loud**（codex r6 P2-2）。
       * 早先只是「原样复制剩余文本」——于是在某个受保护 `SELECT` 前插入未闭合的 `$tag$`，
       * 块起点仍从内部 `SELECT` 算，提取结果与快照逐字相同：运行时 SQL 已语法错误，守护却全绿。
       */
      it('未闭合的注释/引号/插值直接抛错（fail-loud）', () => {
        expect(() => stripSqlComments('a = 1 /* unclosed')).toThrow(/未闭合的块注释/)
        expect(() => stripSqlComments("a = 'unclosed")).toThrow(/未闭合的单引号/)
        expect(() => stripSqlComments('a = "unclosed')).toThrow(/未闭合的双引号/)
        expect(() => stripSqlComments('a = $tag$ unclosed')).toThrow(/未闭合的 dollar-quote/)
        expect(() => stripSqlComments('a = ${unclosed')).toThrow(/未闭合/)
      })

      it('dollar-quote tag 允许含数字 / 非 ASCII（PG 规则同未引标识符）', () => {
        expect(clean("a = $t1$ -- not a comment $t1$ AND c = 3")).toBe(
          "a = $t1$ -- not a comment $t1$ AND c = 3",
        )
        expect(clean("a = $$ -- not a comment $$ AND c = 3"), '匿名 $$ 也合法').toBe(
          "a = $$ -- not a comment $$ AND c = 3",
        )
        expect(clean("a = $标签$ -- not a comment $标签$ AND c = 3"), '非 ASCII tag').toBe(
          "a = $标签$ -- not a comment $标签$ AND c = 3",
        )
      })
    })

    /**
     * 反向变异同样要打一次 **staff** 源（GLM r5：此前只打 admin）。
     * staff 的插值形态与 admin 不同（`${sc.sql}` / `${startDateExpr(period)}`），
     * 且其中一块**没有 GROUP BY**（走「截到模板串结束」分支），值得单独验一次。
     */
    it('staff 侧变异同样被主守护拦下（提取逻辑跨端有效）', () => {
      const anchor = "AND spe.status = '已支付'"
      expect(staffSrc.includes(anchor), `用例前提失效：staff 源码里找不到「${anchor}」`).toBe(true)

      const CASES: Array<[string, string]> = [
        ['注释掉款项状态过滤', staffSrc.replace(anchor, `-- ${anchor}`)],
        ['clamp 掉退款净额', staffSrc.replace(
          'SUM(spe.amount::numeric) AS spend',
          'GREATEST(SUM(spe.amount::numeric), 0) AS spend',
        )],
        // ⚠ 锚点必须唯一命中 queryNewMemberSpend（GLM r6 P3-1）：
        // 裸的 `AND spe.performance_date BETWEEN ...` 首次出现在 queryMemberOps（**有** GROUP BY），
        // `replace` 只换第一处 → 「无 GROUP BY」那条分支其实从未被反向变异打过，
        // 标签名不副实。这里用该块独有的收尾形态（模板串末尾紧跟反引号）定位。
        ['无 GROUP BY 那块改区间实参', staffSrc.replace(
          'AND spe.performance_date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)}`',
          'AND spe.performance_date BETWEEN ${startDateExpr(period)} AND ${startDateExpr(period)}`',
        )],
      ]

      const expected = EXPECTED_SPE_BLOCKS.staff
      for (const [label, mutatedSrc] of CASES) {
        expect(mutatedSrc, `「${label}」构造无效：replace 未生效`).not.toBe(staffSrc)
        const blocks = speBlocksFromSource(mutatedSrc, STAFF_MGMT_TRAFFIC)
        const allMatch =
          blocks.length === expected.length && blocks.every((b, i) => b === expected[i])
        expect(allMatch, `staff 侧「${label}」未被主守护拦下`).toBe(false)
      }
    })

    /**
     * 直接验证 AST 提取会**下钻 inline 嵌套模板**（GLM r6 P2-1 的关键修复点）。
     *
     * 绕过链：`stripSqlComments` 把 `${...}` span 整段原样保留（含里面的 SQL 注释），
     * 若命中外层模板后就 `return` 不下钻，则内层分支里的 `-- SELECT …` 诱饵永远不会被剥，
     * `lastIndexOf('SELECT')` 落到诱饵上 → 块文本与快照逐字相同，而真查询（改了别名/聚合）
     * 已经漂移。下钻后内层模板被独立收集，诱饵会被外层与内层**各计一次** → 块数超标 → 红。
     */
    it('AST 提取会下钻 inline 嵌套模板（诱饵无法藏在 ${} span 里）', () => {
      const fake = [
        'const q = sql`',
        '  WITH m AS (${flag',
        '    ? sql`SELECT AVG(spe.amount::numeric) AS spend',
        '        FROM sale_order_performance_events spe GROUP BY o.client_user_id)`',
        '    : sql`-- SELECT o.client_user_id, SUM(spe.amount::numeric) AS spend',
        '        SELECT 1 FROM sale_order_performance_events spe GROUP BY o.client_user_id)`}',
        '`',
      ].join('\n')

      const templates = sqlTemplatesFromSource(fake, 'fake.ts')
      expect(
        templates.length,
        '内层模板没有被独立收集 —— `visit` 命中后又不下钻了？诱饵通道会复活',
      ).toBeGreaterThan(1)

      // 外层 + 两个内层都含表名，块会被重复计入 → 真实文件里这会让块数超标而报红
      const blocks = speBlocksFromSource(fake, 'fake.ts')
      expect(blocks.length, 'inline 嵌套应产生重复计数（正是报红的来源）').toBeGreaterThan(2)
    })

    /**
     * 锁死两端 spe 表名的出现次数（GLM r6 P3-2）。
     *
     * 守护的可见性 = 「模板文本含字面表名」∧「锚点要求别名恰为 `spe`」。
     * **新增**一个 `FROM sale_order_performance_events s`（别名不是 `spe`）的查询时，
     * 锚点不匹配 → 块数不变 → 静默全绿，而该端出数已经变了。
     * 就地改别名会被块快照拦下，所以这纯属「新增查询」通道 —— 这条把它也关掉。
     */
    it('两端 spe 表名出现次数锁死（防新增别名不同的查询绕过锚点）', () => {
      const countTable = (sql: string) =>
        (sql.match(/sale_order_performance_events/g) ?? []).length
      expect(
        countTable(adminSql),
        'admin 的 spe 表引用次数变了：新增/删除了会员消费查询？' +
          '若是有意变更，需同步 EXPECTED_SPE_BLOCKS + 两端出数对比。',
      ).toBe(5)
      expect(countTable(staffSql), 'staff 的 spe 表引用次数变了，同上').toBe(2)
    })

    /**
     * 跨端一致性：两端镜像查询的 **WHERE 子句整体**必须结构相同。
     *
     * 演进（GLM r4 P3-3 → codex r5 P2-3）：
     *   - 旧版单一 `EXPECTED_SPE_WHERE` 常量同时匹配两个文件，跨端一致**由构造保证**；
     *     改成 per-side 快照后这个性质丢了 —— 「单端改 SQL + 只更新本端快照」两端各自全绿。
     *   - 第一次补救只断言「两端都含五件套子串」，codex 指出**仍不够**：
     *     在 admin 侧用 `NOT (` 或 `TRUE OR (` 把整段五件套包起来、再同步 admin 快照，
     *     子串仍在 → 两端断言都绿，可语义已经反了。
     *
     * 现在比较整段 WHERE：把两端**必然不同**的插值（`${sc}` vs `${sc.sql}`、
     * `${range.start}` vs `${startDateExpr(period)}`）统一抹成 `${}` 占位后要求逐字相等。
     * 任何包装、增删条件、调序都会让两边不等。
     */
    it('两端镜像查询的 WHERE 子句结构完全一致（跨端一致性）', () => {
      const whereOf = (block: string): string => {
        const w = block.indexOf('WHERE ')
        expect(w, `块里找不到 WHERE：${block.slice(0, 80)}…`).toBeGreaterThanOrEqual(0)
        const gb = block.indexOf('GROUP BY')
        const seg = gb >= 0 ? block.slice(w, gb) : block.slice(w)
        // 抹平两端插值差异：只比较 SQL 结构，不比较插值表达式本身
        return seg.trim().replace(/\$\{[^}]*\}/g, '${}')
      }

      // admin 明细（索引 3/4）是 admin 独有的 byMarket/byStore，staff 无对应实现
      // ⚠ admin[1]（queryMemberAvgTicket）必须单列一行（codex r6）：
      // 早先只比 [0,0] 和 [2,1]，注释却写着「经营人数/客单价」——
      // 于是「只改客单价 CTE 的 WHERE + 同步刷新 admin[1] 快照」可以两端全绿，
      // 而那正是 r5 已确认的 `NOT (...)` 语义反转路径。
      const MIRRORED: Array<[number, number, string]> = [
        [0, 0, '会员经营人数 ↔ queryMemberOps'],
        [1, 0, '会员客单价 ↔ queryMemberOps'],
        [2, 1, '新会员消费 ↔ queryNewMemberSpend'],
      ]
      for (const [ai, si, label] of MIRRORED) {
        expect(
          whereOf(EXPECTED_SPE_BLOCKS.admin[ai]),
          `跨端 WHERE 结构不一致：${label}\n` +
            '两端是镜像实现，同 scope 同区间必须出同样的数；' +
            '若这是有意的单端变更，请在 PR 里说明并附两端出数对比。',
        ).toBe(whereOf(EXPECTED_SPE_BLOCKS.staff[si]))
      }

      // admin 的两个明细查询没有 staff 对应，但 WHERE 结构必须与它自己的 KPI 版一致
      // （差异只在 scope：KPI 用 `${sc}`，明细用 skel JOIN，故这里剔除 scope 段再比）
      const dropScope = (w: string) => w.replace(/^WHERE \$\{\} AND /, 'WHERE ')
      expect(
        dropScope(whereOf(EXPECTED_SPE_BLOCKS.admin[3])),
        'admin 明细·会员消费分桶的 WHERE 与 KPI 版不一致',
      ).toBe(dropScope(whereOf(EXPECTED_SPE_BLOCKS.admin[0])))
      expect(
        dropScope(whereOf(EXPECTED_SPE_BLOCKS.admin[4])),
        'admin 明细·新会员消费的 WHERE 与 KPI 版不一致',
      ).toBe(dropScope(whereOf(EXPECTED_SPE_BLOCKS.admin[2])))
    })

    it('金额一律取款项流水（按出现次数锁死，防某处改回订单快照）', () => {
      for (const [side, code, expected] of [
        ['admin', adminCode, 5],
        ['staff', normalize(stripComments(staffSrc)), 2],
      ] as Array<[string, string, number]>) {
        const hits = code.match(/SUM\(spe\.amount::numeric\)/g) ?? []
        expect(hits.length, `${side} 的 SUM(spe.amount) 出现 ${hits.length} 次，期望 ${expected} 次`)
          .toBe(expected)
      }
    })

    it('两端都不得回退到订单快照口径', () => {
      for (const code of [adminCode, normalize(stripComments(staffSrc))]) {
        expect(code, 'spend 回退到 received - refunded_amount').not.toMatch(
          /received::numeric\s*-\s*COALESCE\(\s*o\.refunded_amount,\s*0\s*\)::numeric/i,
        )
        expect(code, '日期回退到 paid_at').not.toMatch(/o\.paid_at::date\s+BETWEEN/)
      }
    })

    it('两端禁用 paid_amount（已 DROP，防回归）', () => {
      expect(adminCode).not.toMatch(/paid_amount/)
      expect(normalize(stripComments(staffSrc))).not.toMatch(/paid_amount/)
    })
  })

  describe('市场明细人数在市场内去重', () => {
    it('会员消费先按分组 + 顾客聚合，再计算分桶', () => {
      expect(adminCode).toMatch(/group_skel\s+AS\s*\(/)
      expect(adminCode).toMatch(/member_spend\s+AS\s*\([\s\S]*?JOIN\s+skel\s+sk\s+ON\s+sk\.store_id\s*=\s*o\.store_id[\s\S]*?GROUP BY \$\{groupId\},\s*o\.client_user_id/i)
      expect(adminCode).toMatch(/spend_agg\s+AS\s*\([\s\S]*?GROUP BY\s+group_id/i)
    })

    it('流量客人数按分组 DISTINCT 顾客，不由门店人数求和', () => {
      // #284 起分母是 UNION 子查询，去重锚点从 so.client_user_id 移到内层统一别名 uid
      expect(adminSql).toMatch(/traffic_cust\s+AS\s*\([\s\S]*?COUNT\(DISTINCT\s+uid\)\s+AS\s+traffic_customers[\s\S]*?GROUP BY\s+group_id/i)
      expect(adminCode).not.toMatch(/SUM\(traffic_cust\.traffic_customers\)/i)
    })

    /**
     * #284：明细行的成交率分母必须与 KPI 同为方案 1c（期初未达会员活跃池 ∪ 本期全部新增会员），
     * 且 ② 分支的归店方式与分子 `newmem` 逐字一致 —— 组内「分子 ⊆ 分母」全靠这个对齐，
     * 破了它明细行就会重新出 > 100%（分母漏人）或 '--'（分母归零）。
     *
     * ⚠ 用 `adminSql`（AST 提取 + 剥净 SQL 注释）而非源码原文：否则把 ② 分支删掉、
     * 再用 `-- UNION SELECT c.user_id AS uid FROM client_wechat_users c JOIN skel ...`
     * 注释把字面量补回去，断言照样绿（本文件 round-5 已实测过这条假绿路径）。
     */
    it('明细分母 = 活跃池 ∪ 本期全部新增会员，② 分支与分子 newmem 同源（D-conv-denom=1c）', () => {
      // 边界取到下一个 CTE，避免非贪婪在 COUNT(...) 的右括号上提前收口
      const trafficCust = /traffic_cust\s+AS\s*\(([\s\S]*?)visits_agg\s+AS\s*\(/.exec(adminSql)?.[1]
      expect(trafficCust, 'traffic_cust CTE 未能定位（被删除/改名，或 visits_agg 不再紧随其后）').toBeTruthy()
      // ① 到店活跃池：期初未达会员 = 当前仍未达会员 OR 本期内才转化
      expect(trafficCust).toMatch(/JOIN\s+skel\s+sk\s+ON\s+sk\.store_id\s*=\s*so\.store_id/)
      expect(
        trafficCust,
        '① 分支缺 became_member_at OR 分支 —— 本期已转化的人会被重新抹出明细分母',
      ).toMatch(
        /c\.customer_type\s+IN\s*\(\s*'体验客'\s*,\s*'小美客'\s*\)\s*OR\s+c\.became_member_at::date\s+BETWEEN/,
      )
      // ② 本期全部新增会员，归店方式必须与 newmem 的 JOIN 逐字一致
      expect(trafficCust, '② 分支（本期全部新增会员）缺失或未按 bound_store_id 归店').toMatch(
        /UNION[\s\S]*?FROM\s+client_wechat_users\s+c\s+JOIN\s+skel\s+sk\s+ON\s+sk\.store_id\s*=\s*c\.bound_store_id/,
      )
      // ⚠ 下面三条必须在**切出 UNION 之后的 ② 分支**上断言，不能对整个 CTE 断言：
      // `became_member_at::date BETWEEN` 在 ① 的 OR 右半边也有，对整块 toMatch 时
      // 删掉 ② 的日期限定（分母纳入全部历史会员）照样全绿。
      expect(trafficCust!.match(/\bUNION\b/g) ?? [], '明细分母不是恰好一个 UNION（切片前提已破）').toHaveLength(1)
      const branch2 = trafficCust!.split(/\bUNION\b/)[1] ?? ''
      expect(branch2, '明细分母的 UNION ② 分支切不出来').toBeTruthy()
      expect(branch2, '② 未按 bound_store_id 归店').toMatch(/c\.bound_store_id\s+IS\s+NOT\s+NULL/)
      expect(branch2, '② 缺 became_member_at IS NOT NULL 守卫').toMatch(/c\.became_member_at\s+IS\s+NOT\s+NULL/)
      // ⚠ 连边界实参一起锁：只判 BETWEEN 存在的话，改成 BETWEEN DATE '1900-01-01' AND ${end}
      // （重新纳入全部历史会员）或 BETWEEN ${start} AND ${start} 都照样绿
      expect(branch2, '② 的本期限定缺失或边界实参被改坏 —— 分母会纳入错误区间的会员').toMatch(
        /c\.became_member_at::date\s+BETWEEN\s+\$\{start\}\s+AND\s+\$\{end\}/,
      )
      // 分子 newmem 的归店方式必须同步存在，否则「分子 ⊆ 分母」的对齐前提就没了
      expect(adminSql).toMatch(
        /newmem\s+AS\s*\([\s\S]*?FROM\s+client_wechat_users\s+c\s+JOIN\s+skel\s+sk\s+ON\s+sk\.store_id\s*=\s*c\.bound_store_id/,
      )
    })
  })

  describe('sale_order_type 过滤 = IN (销售单, 转换单)', () => {
    it('admin', () => {
      expect(adminSrc).toMatch(/sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)/)
    })
    it('staff', () => {
      expect(staffSrc).toMatch(/sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)/)
    })
  })

  describe('本月激活 anchor 反推关键字面量', () => {
    it('admin 含 visits_90d_prev + 6/12 months + 90 days', () => {
      expect(adminSrc).toMatch(/visits_90d_prev/)
      expect(adminSrc).toMatch(/INTERVAL\s+'6 months'/)
      expect(adminSrc).toMatch(/INTERVAL\s+'12 months'/)
      expect(adminSrc).toMatch(/INTERVAL\s+'90 days'/)
    })
    it('staff 含 visits_90d_prev + 6/12 months + 90 days', () => {
      expect(staffSrc).toMatch(/visits_90d_prev/)
      expect(staffSrc).toMatch(/INTERVAL\s+'6 months'/)
      expect(staffSrc).toMatch(/INTERVAL\s+'12 months'/)
      expect(staffSrc).toMatch(/INTERVAL\s+'90 days'/)
    })
    it('admin anchor 非保有判定 visits_90d_prev = 0', () => {
      expect(adminCode).toMatch(/visits_90d_prev\s*=\s*0/)
    })
  })

  describe('保有会员 = 90 天到店窗口 + became_member_at 守卫', () => {
    it('admin 含 90 days 窗口', () => {
      expect(adminCode).toMatch(/INTERVAL\s+'90 days'/)
    })
    it('staff 客流/保有走 service_orders + status 已完成', () => {
      expect(staffSrc).toMatch(/status\s*=\s*'已完成'/)
      expect(adminSrc).toMatch(/status\s*=\s*'已完成'/)
    })
  })

  describe('维护者提醒 — 漂移时双端对照', () => {
    it('admin 注释提及移植源 mgmt-traffic', () => {
      expect(adminSrc).toMatch(/mgmt-traffic/i)
    })
  })
  /**
   * 8. 一次/二次客活 = 到店天数（#298）—— **跨定义**一致性守护
   *
   * 同名概念「一次客活 / 二次客活」在仓里有三处运行时定义，2026-09 审计发现前两处按服务单行数、
   * 后一处按到店天数，同一个 admin 里差 62 人：
   *   ① admin 数据中心 KPI（queryActive）与明细（queryRegActiveBreakdown）→ 共用 visitDaysSql
   *   ② staffApi mgmt-traffic（queryActiveOnce / queryActiveTwice）→ 独立副本
   *   ③ cron refresh-monthly-activity（顾客列表「月度客活」筛选的数据源）
   * 三方的预期文本都由下面同一组口径常量拼出来：改任何一方的去重列 / 过滤条件 / 档位阈值，
   * 要么它自己的整段快照红，要么（改了常量）其余两方一起红 —— 不存在只改一侧还全绿的路径。
   * （db/scripts/calc-monthly-activity.js 与一次性 repair 脚本同为按天，但已退役/一次性，不在守护内。）
   *
   * 整段逐字等值，不做「含某字面量」匹配（见 EXPECTED_SPE_BLOCKS 上方四轮评审记录）。
   *   - visitDaysSql 按 **Drizzle 实际渲染出的 SQL** 比对，连同日期轴白名单的取值一起锁住；
   *   - customer.ts 用的 visitDaysSql 必须就是上面被渲染的那一个（import 来源 + 无本地同名替身）；
   *   - KPI / staff 按**整个函数源码**比对（含 scope 列名实参与 once/twice 映射，只锁模板串会漏）。
   */
  describe('一次/二次客活 = 到店天数，(顾客, service_date) 去重（#298，跨定义）', () => {
    const VISIT_DAY_COL = 'so.service_date'
    const VISIT_FILTER = "so.status = '已完成' AND so.client_user_id IS NOT NULL"
    const RETAINED = "c.customer_status IN ('保有会员-稳定', '保有会员-有效')"

    const staffExpected = (fnName: string, daysClause: string): string =>
      `async function ${fnName}(scopeType, scopeId, period) { ` +
      "const ssc = buildSaleScope(scopeType, scopeId, 'so', 1) " +
      "const csc = buildClientScope(scopeType, scopeId, 'c', 1 + ssc.params.length) " +
      'const rows = await pg.query( ' +
      `\`WITH visit_count AS ( SELECT so.client_user_id, COUNT(DISTINCT ${VISIT_DAY_COL}) AS days ` +
      `FROM service_orders so WHERE \${ssc.sql} AND ${VISIT_FILTER} ` +
      `AND ${VISIT_DAY_COL} BETWEEN \${startDateExpr(period)} AND \${endDateExpr(period)} ` +
      'GROUP BY so.client_user_id ) SELECT COUNT(*) AS v FROM visit_count vc ' +
      'JOIN client_wechat_users c ON c.user_id = vc.client_user_id ' +
      `WHERE \${csc.sql} AND ${RETAINED} AND ${daysClause}\`, ` +
      '[...ssc.params, ...csc.params], ) return Number(rows[0]?.v || 0) }'

    const adminKpiExpected =
      'async function queryActive( session: AuthSession, scope: DataCenterScope, range: ResolvedRange, ' +
      "mode: 'once' | 'twice', ): Promise<number> { " +
      "const ssc = scopeFilterSql(session, scope, 'so.store_id') " +
      "const csc = scopeFilterSql(session, scope, 'c.bound_store_id') " +
      "const daysClause = mode === 'once' ? sql`vc.days = 1` : sql`vc.days >= 2` " +
      'const rows = await db.execute(sql` ' +
      "WITH visit_days AS (${visitDaysSql({ axis: 'service_date', scope: ssc, range })}), " +
      'visit_count AS ( SELECT vd.client_user_id, COUNT(DISTINCT vd.visit_date) AS days ' +
      'FROM visit_days vd GROUP BY vd.client_user_id ) ' +
      'SELECT COUNT(*) AS v FROM visit_count vc JOIN client_wechat_users c ON c.user_id = vc.client_user_id ' +
      `WHERE \${csc} AND ${RETAINED} AND \${daysClause} \`) return num(first(rows).v) }`

    const breakdownActiveExpected =
      "visit_days AS (${visitDaysSql({ axis: 'service_date', scope: serviceScope, range })}), " +
      'visit_count AS ( SELECT vd.client_user_id, c.bound_store_id AS store_id, ' +
      'COUNT(DISTINCT vd.visit_date) AS days, c.customer_status AS cstatus ' +
      'FROM visit_days vd JOIN client_wechat_users c ON c.user_id = vd.client_user_id ' +
      'WHERE ${customerScope} AND c.bound_store_id IS NOT NULL ' +
      'GROUP BY vd.client_user_id, c.bound_store_id, c.customer_status ), ' +
      'active AS ( SELECT store_id, COUNT(*) FILTER (WHERE days = 1) AS visit_once, ' +
      'COUNT(*) FILTER (WHERE days >= 2) AS visit_twice FROM visit_count ' +
      `WHERE cstatus IN ('保有会员-稳定', '保有会员-有效') GROUP BY store_id ), `

    const cronActivity = (src: string): string => normalize(stripSqlComments(src))
    const breakdownActive = (src: string): string => {
      const bd = sqlInFunction(src, ADMIN_CUSTOMER, 'queryRegActiveBreakdown')
      const from = bd.indexOf('visit_days AS (')
      const to = bd.indexOf('status_agg AS (')
      return from > 0 && to > from ? bd.slice(from, to) : ''
    }

    /** customer.ts 里 visitDaysSql 标识符的全部出现：来源 import + 声明 + 引用 */
    const visitDaysSqlUsage = (src: string) => {
      const sf = ts.createSourceFile(ADMIN_CUSTOMER, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const imports: string[] = []
      let localDecls = 0
      let refs = 0
      const visit = (n: ts.Node): void => {
        if (ts.isImportDeclaration(n)) {
          const named = n.importClause?.namedBindings
          if (named && ts.isNamedImports(named) && named.elements.some((e) => e.name.text === 'visitDaysSql')) {
            imports.push(normalize(n.getText(sf)))
          }
          return
        }
        if (
          (ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isParameter(n) || ts.isClassDeclaration(n)) &&
          n.name &&
          ts.isIdentifier(n.name) &&
          n.name.text === 'visitDaysSql'
        ) {
          localDecls++
        }
        if (ts.isIdentifier(n) && n.text === 'visitDaysSql') refs++
        ts.forEachChild(n, visit)
      }
      ts.forEachChild(sf, visit)
      return { imports, localDecls, refs }
    }

    it('admin visitDaysSql 渲染结果：DISTINCT (client_user_id, service_date) + 已完成 + 挂顾客', () => {
      const q = new PgDialect().sqlToQuery(
        visitDaysSql({ axis: 'service_date', scope: sql`TRUE`, range: { start: '2026-09-01', end: '2026-09-24' } }),
      )
      expect(normalize(q.sql)).toBe(
        `SELECT DISTINCT so.client_user_id, ${VISIT_DAY_COL} AS visit_date FROM service_orders so ` +
          `WHERE TRUE AND ${VISIT_FILTER} AND ${VISIT_DAY_COL} BETWEEN $1 AND $2`,
      )
      expect(q.params).toEqual(['2026-09-01', '2026-09-24'])
    })

    it('visitDaysSql 拒绝白名单外的日期轴（含原型链键；sql.raw 只吃闭集）', () => {
      for (const axis of ['completed_at', 'toString', 'constructor', '__proto__']) {
        expect(() =>
          visitDaysSql({ axis: axis as never, scope: sql`TRUE`, range: { start: '2026-09-01', end: '2026-09-24' } }),
        ).toThrow(/未知日期轴/)
      }
    })

    it('customer.ts 用的 visitDaysSql 就是被渲染校验的那一个（import 来源锁定，无本地替身）', () => {
      const u = visitDaysSqlUsage(adminSrc)
      expect(u.imports).toEqual(["import { visitDaysSql } from '@/lib/data-center/visit-days'"])
      expect(u.localDecls).toBe(0)
      // 引用恰为 KPI 1 + 明细 1（import 节点不计入）
      expect(u.refs).toBe(2)
    })

    it('admin KPI queryActive 整个函数快照（scope 列名 + once/twice 映射 + 经 visitDaysSql 按天数分档）', () => {
      expect(fnSource(adminSrc, ADMIN_CUSTOMER, 'queryActive')).toBe(adminKpiExpected)
    })

    it('admin 明细 queryRegActiveBreakdown：客活段整段快照 + scope 生产者 + 外层汇总不对调', () => {
      expect(breakdownActive(adminSrc)).toBe(breakdownActiveExpected)
      const fn = fnSource(adminSrc, ADMIN_CUSTOMER, 'queryRegActiveBreakdown')
      expect(fn).toContain("const serviceScope = scopeFilterSql(session, scope, 'so.store_id')")
      expect(fn).toContain("const customerScope = scopeFilterSql(session, scope, 'c.bound_store_id')")
      expect(fn.match(/const serviceScope = /g)).toHaveLength(1)
      expect(fn.match(/const customerScope = /g)).toHaveLength(1)
      // 外层汇总：两列各恰好出现一次且一一对应（对调 → 红）
      const sqlText = sqlInFunction(adminSrc, ADMIN_CUSTOMER, 'queryRegActiveBreakdown')
      expect(sqlText).toContain(
        'COALESCE(SUM(active.visit_once), 0) AS visit_once, COALESCE(SUM(active.visit_twice), 0) AS visit_twice,',
      )
      expect(sqlText.match(/active\.visit_once/g)).toHaveLength(1)
      expect(sqlText.match(/active\.visit_twice/g)).toHaveLength(1)
      // 结果映射（行为侧另见 customer.test.ts 的 visitOnce=3 / visitTwice=2 断言）
      expect(fn).toContain('visitOnce: num(r.visit_once), visitTwice: num(r.visit_twice),')
    })

    it('staff queryActiveOnce / queryActiveTwice 整个函数快照（含 scope 生产者）', () => {
      expect(fnSource(staffSrc, STAFF_MGMT_TRAFFIC, 'queryActiveOnce')).toBe(
        staffExpected('queryActiveOnce', 'vc.days = 1'),
      )
      expect(fnSource(staffSrc, STAFF_MGMT_TRAFFIC, 'queryActiveTwice')).toBe(
        staffExpected('queryActiveTwice', 'vc.days >= 2'),
      )
    })

    it('cron monthly_activity 段 2 整段快照（顾客列表「月度客活」筛选的数据源）', () => {
      expect(cronActivity(UPDATE_MONTHLY_ACTIVITY_SQL)).toBe(
        `WITH visit_days AS ( SELECT so.client_user_id, COUNT(DISTINCT ${VISIT_DAY_COL}) AS days ` +
          `FROM service_orders so WHERE ${VISIT_FILTER} ` +
          `AND ${VISIT_DAY_COL} >= date_trunc('month', CURRENT_DATE)::date ` +
          `AND ${VISIT_DAY_COL} < (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::date ` +
          'GROUP BY so.client_user_id ) UPDATE client_wechat_users u SET monthly_activity = ' +
          "(CASE WHEN vd.days >= 2 THEN '二次客活' ELSE '一次客活' END)::monthly_activity, updated_at = NOW() " +
          'FROM visit_days vd WHERE u.user_id = vd.client_user_id',
      )
    })

    it('反向验证：各侧回退 / 对调 / 替身都会让对应快照红', () => {
      const mutate = (src: string, from: string, to: string): string => {
        expect(src).toContain(from)
        return src.replace(from, to)
      }
      const onlyIn = (src: string, fnHead: string, from: string, to: string): string => {
        const at = src.indexOf(fnHead)
        expect(at).toBeGreaterThanOrEqual(0)
        return src.slice(0, at) + mutate(src.slice(at), from, to)
      }
      // staff：只改 once（孪生函数 twice 保持原样 → 按函数名定位）
      const staffMut = onlyIn(staffSrc, 'async function queryActiveOnce', 'COUNT(DISTINCT so.service_date) AS days', 'COUNT(*) AS days')
      expect(fnSource(staffMut, STAFF_MGMT_TRAFFIC, 'queryActiveOnce')).not.toBe(staffExpected('queryActiveOnce', 'vc.days = 1'))
      expect(fnSource(staffMut, STAFF_MGMT_TRAFFIC, 'queryActiveTwice')).toBe(staffExpected('queryActiveTwice', 'vc.days >= 2'))
      // staff：改完用 SQL 注释把字面量补回去
      const staffComment = onlyIn(
        staffSrc,
        'async function queryActiveOnce',
        'COUNT(DISTINCT so.service_date) AS days',
        'COUNT(*) AS days -- COUNT(DISTINCT so.service_date) AS days',
      )
      expect(fnSource(staffComment, STAFF_MGMT_TRAFFIC, 'queryActiveOnce')).not.toBe(staffExpected('queryActiveOnce', 'vc.days = 1'))
      // staff：scope 生产者列别名被改
      const staffScope = onlyIn(staffSrc, 'async function queryActiveTwice', "buildSaleScope(scopeType, scopeId, 'so', 1)", "buildSaleScope(scopeType, scopeId, 'c', 1)")
      expect(fnSource(staffScope, STAFF_MGMT_TRAFFIC, 'queryActiveTwice')).not.toBe(staffExpected('queryActiveTwice', 'vc.days >= 2'))
      // cron 改成按行数
      const cronMut = mutate(UPDATE_MONTHLY_ACTIVITY_SQL, 'COUNT(DISTINCT so.service_date)', 'COUNT(so.service_date)')
      expect(cronActivity(cronMut)).not.toBe(cronActivity(UPDATE_MONTHLY_ACTIVITY_SQL))
      // admin KPI：once/twice 映射对调
      const kpiSwap = mutate(adminSrc, "mode === 'once' ? sql`vc.days = 1`", "mode !== 'once' ? sql`vc.days = 1`")
      expect(fnSource(kpiSwap, ADMIN_CUSTOMER, 'queryActive')).not.toBe(adminKpiExpected)
      // admin KPI：scope 列名被改
      const kpiScope = onlyIn(adminSrc, 'async function queryActive(', "scopeFilterSql(session, scope, 'so.store_id')", "scopeFilterSql(session, scope, 'c.bound_store_id')")
      expect(fnSource(kpiScope, ADMIN_CUSTOMER, 'queryActive')).not.toBe(adminKpiExpected)
      // admin 明细：绕开 visitDaysSql 直接数行
      const bdMut = mutate(adminSrc, 'COUNT(DISTINCT vd.visit_date) AS days,', 'COUNT(*) AS days,')
      expect(breakdownActive(bdMut)).not.toBe(breakdownActiveExpected)
      // admin：换 import 来源 / 本地同名替身
      const importSwap = mutate(adminSrc, "from '@/lib/data-center/visit-days'", "from '@/lib/data-center/visit-days-legacy'")
      expect(visitDaysSqlUsage(importSwap).imports).not.toEqual(["import { visitDaysSql } from '@/lib/data-center/visit-days'"])
      const localStub = mutate(
        adminSrc,
        "import { visitDaysSql } from '@/lib/data-center/visit-days'\n",
        'const visitDaysSql = (o: unknown) => sql`${o}`\n',
      )
      const u = visitDaysSqlUsage(localStub)
      expect(u.imports).toEqual([])
      expect(u.localDecls).toBe(1)
    })
  })
})
