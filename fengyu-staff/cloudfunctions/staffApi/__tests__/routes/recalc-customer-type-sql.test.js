/**
 * recalcCustomerType SQL 结构守卫测试
 *
 * 背景：migration 0028-0031 删除 sale_order_type='体验单' 后，旧 CASE SQL
 * 的 ② '小美客' 分支与 ③ '体验客' 分支字节级相同 → '体验客' 死分支。
 * 详见 notes/tickets/bug-recalc-customer-type-dead-branch.md
 *
 * Round 2 修复（audit-15 P0-15-02 预备）：
 * 小美客 / 体验客两分支从 product_categories JOIN 链 + is_card_kind 迁移到
 * sale_items.is_experience capability 列，去掉对 product_categories 的依赖。
 *
 * #187（2026-09-18）Round 3 —— 落地 2026-04-26 Q5.2 决策：
 * 判定金额从订单应付额 `o.total_amount` 换成**单笔订单的非体验部分毛实收**
 * （`sale_items.received` 净额 + 该行逐项退款额 → "曾经收到的钱"，退款不扣减）。
 * 判定逻辑下沉到 RECALC_CUSTOMER_TYPE_CTE（refund_by_item + order_amounts），
 * CASE 只剩三个 `EXISTS(SELECT 1 FROM order_amounts WHERE …)` 分支。
 *
 * 守护范围（**七处副本**）：
 *   逐字镜像（五端运行时）：staffApi / clientApi / payNotify / admin orders.ts / admin recompute-customer-tags
 *   结构性守护（两个全库批量脚本）：db/scripts/recalc-all-customer-types.js / recalc-became-member-at.js
 *   —— 脚本版无 client_user_id 参数过滤、多带输出列，无法逐字比对，故只断言关键片段。
 *
 * 本测试做**源文件文本结构守卫**：
 *   1. CTE 守卫——毛实收表达式、is_experience FILTER 拆分、item_direction='购买'、note→jsonb 三重防线
 *   2. CASE 守卫——三分支阈值/大于零判定 + ELSE 兜底 '流量客'
 *   3. 无旧 JOIN 链——不再出现 product_skus / product_categories JOIN
 *   4. 归因段（became_member_at / is_membership_upgrade）五端逐字一致且已脱离 total_amount
 */

const fs = require('node:fs')
const path = require('node:path')

const STAFF_ORDER_JS = path.resolve(
  __dirname,
  '../../routes/order.js'
)
const PAYNOTIFY_JS = path.resolve(
  __dirname,
  '../../../../../fengyu-client/cloudfunctions/payNotify/index.js'
)
const ADMIN_ORDERS_TS = path.resolve(
  __dirname,
  '../../../../../fengyu-admin/src/actions/orders.ts'
)
const ADMIN_RECOMPUTE_TS = path.resolve(
  __dirname,
  '../../../../../fengyu-admin/src/lib/recompute-customer-tags.ts'
)
const CLIENT_API_ORDER_JS = path.resolve(
  __dirname,
  '../../../../../fengyu-client/cloudfunctions/clientApi/routes/order.js'
)
/**
 * 第 6/7/8 处副本：db/scripts 的全库批量脚本。与五端运行时副本**不逐字一致**
 * （无 client_user_id 参数过滤、多带输出列），故只做结构性守护（关键片段断言），
 * 不进逐字镜像比对。口径漂移时靠这些断言报红。
 *
 * 这三个脚本都会按自身 SQL **覆写线上数据**（customer_type / became_member_at /
 * is_membership_upgrade + document_type），且都幂等可重跑——口径与运行时漂移时，
 * 跑一次就把线上改回旧口径，因此必须纳入守护。
 */
const SCRIPT_RECALC_ALL_TYPES = path.resolve(
  __dirname,
  '../../../../../db/scripts/recalc-all-customer-types.js'
)
const SCRIPT_RECALC_BECAME_MEMBER = path.resolve(
  __dirname,
  '../../../../../db/scripts/recalc-became-member-at.js'
)
const SCRIPT_BACKFILL_UPGRADE_DOC_TYPE = path.resolve(
  __dirname,
  '../../../../../db/scripts/backfill-membership-upgrade-doc-type.js'
)

/** 五端运行时副本（逐字镜像比对范围） */
const RUNTIME_FILES = [
  ['staffApi', STAFF_ORDER_JS],
  ['clientApi', CLIENT_API_ORDER_JS],
  ['payNotify', PAYNOTIFY_JS],
  ['admin orders.ts', ADMIN_ORDERS_TS],
  ['admin recompute-customer-tags.ts', ADMIN_RECOMPUTE_TS],
]

/**
 * 从源文件提取 `SELECT CASE ... END AS computed_type` 段
 * @param {string} filePath
 * @returns {string}
 */
function extractCaseSql(filePath) {
  const src = fs.readFileSync(filePath, 'utf8')
  const match = src.match(/SELECT CASE[\s\S]*?END AS computed_type/m)
  if (!match) {
    throw new Error(`未在 ${filePath} 找到 "SELECT CASE ... END AS computed_type" 段`)
  }
  return match[0]
}

/**
 * 提取顾客分类跃迁的金额 CTE（#187 起判定逻辑的真正所在）。
 * 锚定 `WITH refund_by_item AS (` 起、`GROUP BY o.sale_order_id` + 闭合括号止。
 * 旧口径（判定写在 CASE 里、无 CTE）→ 抛错，强制五端全部迁移完毕才通过。
 * @param {string} filePath
 * @returns {string}
 */
function extractCte(filePath) {
  const src = fs.readFileSync(filePath, 'utf8')
  const match = src.match(/WITH refund_by_item AS \([\s\S]*?GROUP BY o\.sale_order_id, o\.received\s*\)/m)
  if (!match) {
    throw new Error(
      `未在 ${filePath} 找到 RECALC_CUSTOMER_TYPE_CTE（WITH refund_by_item … GROUP BY o.sale_order_id, o.received）；` +
      '可能仍为旧的 total_amount 口径'
    )
  }
  return match[0]
}

/**
 * 规范化 SQL 文本：折叠连续空白为单空格 + 占位符归一化（$1/$2 与 ${var} 都→?）
 * 占位符归一化使跨端镜像比对时 native pg ($1) 与 Drizzle sql template (${var}) 等价。
 */
function normalizeSql(sql) {
  return sql
    .replace(/\$\d+/g, '?')
    .replace(/\$\{[^}]+\}/g, '?')
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .trim()
}

/**
 * 提取会员升级归因 UPDATE 段（首次跃迁为会员客时给触发单打 is_membership_upgrade 标记）
 * 用于跨端镜像对比：staff / payNotify / admin orders.ts / admin recompute-customer-tags / clientApi 五端逐字一致。
 * @param {string} filePath
 * @returns {string}
 */
function extractMembershipUpgradeAttribution(filePath) {
  const src = fs.readFileSync(filePath, 'utf8')
  const match = src.match(/UPDATE sale_orders SET is_membership_upgrade[\s\S]*?LIMIT 1\s*\)/)
  if (!match) {
    throw new Error(`未在 ${filePath} 找到会员升级归因 UPDATE 段（is_membership_upgrade）`)
  }
  return match[0]
}

/**
 * 提取 became_member_at UPDATE 段（首笔达标单时间口径）。
 * 正则锚定 UPDATE client_wechat_users SET became_member_at，终止于其选单子查询的 LIMIT 1)。
 * 旧口径 `SET became_member_at = NOW()` 无 LIMIT 1) → 抛错，强制 5 端全部迁移完毕才通过。
 * @param {string} filePath
 * @returns {string}
 */
function extractBecameMemberAtUpdate(filePath) {
  const src = fs.readFileSync(filePath, 'utf8')
  // ⚠️ 必须一路匹配到 WHERE user_id：正则若止于 `LIMIT 1)`，删掉 WHERE 子句（=全表覆写
  // 所有顾客的 became_member_at，不可逆）守护测试仍会通过——闸门 2 GLM 的摘录误报暴露了这个盲区。
  const match = src.match(
    /UPDATE client_wechat_users SET became_member_at[\s\S]*?LIMIT 1\s*\)[\s\S]{0,40}?WHERE user_id = (?:\$\d+|\$\{[^}]+\})/
  )
  if (!match) {
    throw new Error(
      `未在 ${filePath} 找到完整的 became_member_at UPDATE（含 LIMIT 1 子查询 + WHERE user_id）；` +
      '可能仍为旧 NOW() 口径，或 WHERE 子句被删（会全表覆写）'
    )
  }
  return match[0]
}

describe('recalcCustomerType SQL 源文件守卫', () => {
  describe('金额 CTE（#187 判定逻辑所在）', () => {
    for (const [label, file] of RUNTIME_FILES) {
      describe(label, () => {
        let cte

        beforeAll(() => {
          cte = extractCte(file)
        })

        test('毛实收表达式 = received 净额 + 该行逐项退款额（退款不扣减）', () => {
          expect(cte).toContain('si.received::numeric + COALESCE(rbi.refunded, 0)')
        })

        test('毛实收按 sale_amount 封顶（LEAST），防加回非逆运算导致的不可逆误升', () => {
          // 加回的是 note.items[].refundAmount 原始额，而 received 的扣减主路径按
          // sale_payment_item_receipts 负额净算（还带 GREATEST(0) clamp）——两者不是严格互逆。
          // 已结清订单的行级毛额上限就是 sale_amount，以此封顶把「误升会员客」压成「最多漏升」。
          expect(cte).toContain('LEAST(si.received::numeric + COALESCE(rbi.refunded, 0),')
          expect(cte).toContain('si.sale_amount::numeric)')
        })

        test('无明细行订单回退订单级 received（WorkFine 历史单只建 sale_orders）', () => {
          // ⚠️ 必须是 NOT EXISTS(整张单无任何 sale_items) 而非 COUNT(购买行)=0：
          // LEFT JOIN 的 ON 带了 item_direction='购买'，COUNT=0 只说明「无购买行」。
          // 若某销售单只含退出方向行，COUNT=0 会误走回退分支、用订单级 received 且
          // **绕过 LEAST 封顶** → 可能不可逆误升为会员客（闸门 2 GLM P1）。
          expect(cte).toContain(
            'CASE WHEN NOT EXISTS (SELECT 1 FROM sale_items si2 WHERE si2.sale_order_id = o.sale_order_id)'
          )
          expect(cte).toContain('THEN GREATEST(o.received::numeric, 0)')
          // 必须是 LEFT JOIN，INNER 会让无明细行的历史单整个消失（相对旧口径是回归）
          expect(cte).toContain('LEFT JOIN sale_items si ON si.sale_order_id = o.sale_order_id')
        })

        test('按 is_experience 拆分为 non_trial / trial 两个 FILTER 聚合', () => {
          expect(cte).toContain('FILTER (WHERE si.is_experience = false), 0)')
          expect(cte).toContain('END AS non_trial')
          expect(cte).toContain('FILTER (WHERE si.is_experience = true), 0)')
          expect(cte).toContain('END AS trial')
        })

        test('FILTER 聚合结果 COALESCE 归零（防 NULL > 0 使分支静默不命中）', () => {
          expect(cte).toMatch(/COALESCE\(SUM\([\s\S]*?FILTER \(WHERE si\.is_experience = false\), 0\)/)
          expect(cte).toMatch(/COALESCE\(SUM\([\s\S]*?FILTER \(WHERE si\.is_experience = true\), 0\)/)
        })

        test("只聚合 item_direction='购买' 行（与 STEP 1.5 退款扣减作用域一致，排除转出/转入负数行)", () => {
          // 挂在 LEFT JOIN 的 ON 条件上——放进 WHERE 会把 LEFT JOIN 退化成 INNER，
          // 无明细行的历史单又会消失。
          expect(cte).toMatch(
            /LEFT JOIN sale_items si ON si\.sale_order_id = o\.sale_order_id\s*AND si\.item_direction = '购买'/
          )
        })

        test('退款聚合只认已支付的退款流水', () => {
          expect(cte).toContain("AND sop.change_type = '退款'")
          expect(cte).toContain("AND sop.status = '已支付'")
        })

        test('退款展开范围限定在参与判定的已结清销售单（收窄 22P02 爆炸半径）', () => {
          // 本 CTE 按顾客聚合（原 RECEIVED_REFUNDED_DEDUCT_SQL 按单聚合）。不加这两条限定，
          // 该顾客任一充值单/寄存单上的脏 note 都会被展开，把故障半径放大到其全部收款事务。
          expect(cte).toContain("AND ro.status IN ('已支付', '已完成')")
          expect(cte).toContain("AND ro.sale_order_type = '销售单'")
        })

        test("排除 OVERPAY 哨兵行（与 per-item-refund helper 口径对齐）", () => {
          // 历史 note 里 refSaleItemId='OVERPAY' 是订单级多收余数的分摊哨兵，不对应任何 sale_item。
          // 当前靠 LEFT JOIN 不匹配也能自然过滤，显式排除是为了让意图可读 + 防将来改 JOIN 方式踩坑。
          expect(cte).toContain("AND elem ->> 'refSaleItemId' <> 'OVERPAY'")
        })

        test("note→jsonb 三重防线（LIKE '{\"%' 守门 + 嵌套 CASE 延迟 cast + jsonb_typeof 兜非数组），根除 22P02", () => {
          // 守门比 RECEIVED_REFUNDED_DEDUCT_SQL 的 LIKE '{%' **有意加严**：
          // `{手工备注}` 这类以 { 开头但非合法 JSON 的值能通过 '{%'，到 ::jsonb 才抛 22P02（已实测复现）。
          // 合法的含 items 的 note 必然以 {" 开头，故加严不会漏掉任何真数据。
          expect(cte).toContain('sop.note LIKE \'{"%\'')
          expect(cte).toContain("jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'")
          expect(cte).toContain("ELSE '[]'::jsonb END")
        })

        test('订单范围仍限已支付/已完成的销售单', () => {
          expect(cte).toContain("AND o.status IN ('已支付', '已完成')")
          expect(cte).toContain("AND o.sale_order_type = '销售单'")
        })

        test('按订单分组（单笔口径，不跨订单累计）', () => {
          expect(cte).toContain('GROUP BY o.sale_order_id, o.received')
        })

        test('不再依赖 product_categories JOIN 链（已迁移到 is_experience）', () => {
          expect(cte).not.toContain('JOIN product_skus')
          expect(cte).not.toContain('JOIN product_categories')
          expect(cte).not.toContain('is_card_kind')
        })

        test('不含已删除的回款单枚举字面量', () => {
          expect(cte).not.toContain('ref_sale_order_id')
          expect(cte).not.toContain("'回款单'")
        })
      })
    }

    test('五端 CTE 规范化后逐字相同（占位符归一化后 $1 与 ${clientUserId} 等价）', () => {
      const staffN = normalizeSql(extractCte(STAFF_ORDER_JS))
      for (const [label, file] of RUNTIME_FILES.slice(1)) {
        expect(normalizeSql(extractCte(file)), `${label} CTE 与 staffApi 漂移`).toBe(staffN)
      }
    })
  })

  describe('CASE 分支（三档判定）', () => {
    for (const [label, file] of RUNTIME_FILES) {
      describe(label, () => {
        let caseSql

        beforeAll(() => {
          caseSql = extractCaseSql(file)
        })

        test('会员客：存在一张单其 non_trial 达阈值', () => {
          expect(normalizeSql(caseSql)).toContain(
            "WHEN EXISTS (SELECT 1 FROM order_amounts WHERE non_trial >= ?) THEN '会员客'"
          )
        })

        test('小美客：存在一张单其 non_trial > 0', () => {
          expect(normalizeSql(caseSql)).toContain(
            "WHEN EXISTS (SELECT 1 FROM order_amounts WHERE non_trial > 0) THEN '小美客'"
          )
        })

        test('体验客：存在一张单其 trial > 0', () => {
          expect(normalizeSql(caseSql)).toContain(
            "WHEN EXISTS (SELECT 1 FROM order_amounts WHERE trial > 0) THEN '体验客'"
          )
        })

        test('ELSE 兜底必须是流量客', () => {
          expect(caseSql).toMatch(/ELSE '流量客'/)
        })

        test('判定不再直接比 o.total_amount（#187 旧口径回归守护）', () => {
          expect(caseSql).not.toContain('o.total_amount')
        })

        test('不再出现 ② ③ 分支字节级相同的死分支模式', () => {
          const olderDeadPattern = /WHEN EXISTS \(\s*SELECT 1 FROM sale_orders\s*WHERE[^)]*sale_order_type = '销售单'\s*\)\s*THEN '小美客'/
          expect(caseSql).not.toMatch(olderDeadPattern)
        })
      })
    }

    test('五端 CASE 规范化后逐字相同', () => {
      const staffN = normalizeSql(extractCaseSql(STAFF_ORDER_JS))
      for (const [label, file] of RUNTIME_FILES.slice(1)) {
        expect(normalizeSql(extractCaseSql(file)), `${label} CASE 与 staffApi 漂移`).toBe(staffN)
      }
    })
  })

  describe('fengyu-admin actions/orders.ts (recordPayment 触发点)', () => {
    /**
     * 截取 recordPayment 的函数体。
     * ⚠️ 原断言在**整个 orders.ts** 上搜宽泛模式，先命中的是更早的 confirmOfflinePayment，
     * 于是删掉 recordPayment 里的调用、甚至把它移回 recalcPaidSessionsForOrder 之前，测试照样通过
     * ——守护是误通过（闸门 2 codex 抓出）。必须先切出函数体再断言。
     */
    function recordPaymentBody() {
      const src = fs.readFileSync(ADMIN_ORDERS_TS, 'utf8')
      const start = src.indexOf('export const recordPayment = withPermission(')
      expect(start, 'orders.ts 里找不到 export const recordPayment').toBeGreaterThan(-1)
      const next = src.indexOf('\nexport const ', start + 1)
      return src.slice(start, next === -1 ? undefined : next)
    }

    test('recordPayment 事务结清时必须调用 recalcCustomerType（防 audit-15 P0-15-01 admin 触发点跃迁缺失复发）', () => {
      const body = recordPaymentBody()
      expect(body).toMatch(/targetStatus\s*===\s*'已支付'[\s\S]{0,300}recalcCustomerType\s*\(\s*tx\s*,/)
    })

    test('recordPayment 里 recalcCustomerType 必须排在 recalcPaidSessionsForOrder 之后（#187）', () => {
      // 跃迁判定已改读 sale_items.received，而它由 recalcPaidSessionsForOrder 的 STEP1 写出；
      // 排在前面会读到本次回款之前的旧值，少算本笔回款额。
      const body = recordPaymentBody()
      const paidSessionsAt = body.indexOf('recalcPaidSessionsForOrder(tx,')
      const recalcTypeAt = body.indexOf('recalcCustomerType(tx,')
      expect(paidSessionsAt, 'recordPayment 内未找到 recalcPaidSessionsForOrder').toBeGreaterThan(-1)
      expect(recalcTypeAt, 'recordPayment 内未找到 recalcCustomerType').toBeGreaterThan(-1)
      expect(recalcTypeAt).toBeGreaterThan(paidSessionsAt)
    })
  })

  describe('参数绑定身份与 CTE 引用（防 normalizeSql 把身份抹平后的误通过）', () => {
    // normalizeSql 把 $1/$2/${…} 一律换成 ?，绑定反了也能"逐字一致"。
    // 这里在**归一化之前**断言各参数的身份（闸门 2 codex 抓出）。
    test('三个云函数端：CTE 只用 $1（顾客），阈值 $2 只出现在判定/归因条件里', () => {
      for (const [label, file] of RUNTIME_FILES.filter(([l]) => !l.startsWith('admin'))) {
        const cte = extractCte(file)
        expect(cte, `${label} CTE 不应出现阈值参数 $2`).not.toMatch(/\$2/)
        expect(cte, `${label} CTE 应按 $1 过滤顾客`).toContain('ro.client_user_id = $1')
        expect(cte, `${label} CTE 应按 $1 过滤顾客`).toContain('o.client_user_id = $1')
        const caseSql = extractCaseSql(file)
        expect(caseSql, `${label} CASE 不应出现顾客参数 $1`).not.toMatch(/\$1/)
        expect(caseSql, `${label} CASE 应按 $2 比阈值`).toContain('non_trial >= $2')
      }
    })

    test('admin 两端：CTE 只插 clientUserId，阈值 threshold 只出现在判定/归因条件里', () => {
      for (const [label, file] of RUNTIME_FILES.filter(([l]) => l.startsWith('admin'))) {
        const cte = extractCte(file)
        expect(cte, `${label} CTE 不应插入 threshold`).not.toContain('${threshold}')
        expect(cte, `${label} CTE 应插入 clientUserId`).toContain('ro.client_user_id = ${clientUserId}')
        const caseSql = extractCaseSql(file)
        expect(caseSql, `${label} CASE 不应插入 clientUserId`).not.toContain('${clientUserId}')
        expect(caseSql, `${label} CASE 应按 threshold 比阈值`).toContain('non_trial >= ${threshold}')
      }
    })

    test('CASE 查询必须真的引用金额 CTE（删掉引用不得静默通过）', () => {
      // extractCaseSql 只截 SELECT CASE 段，删掉它前面的 ${CTE} 引用不会让别的断言失败。
      const cteRef = /\$\{(RECALC_CUSTOMER_TYPE_CTE|recalcCustomerTypeCte\([^)]*\))\}\s*\n\s*SELECT CASE/
      for (const [label, file] of RUNTIME_FILES) {
        expect(fs.readFileSync(file, 'utf8'), `${label} 的 SELECT CASE 前缺 CTE 引用`).toMatch(cteRef)
      }
    })
  })

  describe('会员升级归因 UPDATE（is_membership_upgrade）镜像一致性', () => {
    let staffAttr
    let paynotifyAttr
    let adminAttr
    let adminRecomputeAttr
    let clientApiAttr

    beforeAll(() => {
      staffAttr = extractMembershipUpgradeAttribution(STAFF_ORDER_JS)
      paynotifyAttr = extractMembershipUpgradeAttribution(PAYNOTIFY_JS)
      adminAttr = extractMembershipUpgradeAttribution(ADMIN_ORDERS_TS)
      adminRecomputeAttr = extractMembershipUpgradeAttribution(ADMIN_RECOMPUTE_TS)
      clientApiAttr = extractMembershipUpgradeAttribution(CLIENT_API_ORDER_JS)
    })

    test('五端归因段目标列一致：UPDATE sale_orders SET is_membership_upgrade = true', () => {
      const re = /^UPDATE sale_orders SET is_membership_upgrade = true/
      expect(staffAttr).toMatch(re)
      expect(paynotifyAttr).toMatch(re)
      expect(adminAttr).toMatch(re)
      expect(adminRecomputeAttr).toMatch(re)
      expect(clientApiAttr).toMatch(re)
    })

    test('五端规范化后逐字相同（占位符归一化后 $1 与 ${clientUserId} 等价）', () => {
      const staffN = normalizeSql(staffAttr)
      expect(normalizeSql(paynotifyAttr)).toBe(staffN)
      expect(normalizeSql(adminAttr)).toBe(staffN)
      expect(normalizeSql(adminRecomputeAttr)).toBe(staffN)
      expect(normalizeSql(clientApiAttr)).toBe(staffN)
    })

    test('五端归因选单条件已改为 oa.non_trial >= 阈值（#187，不再比 o.total_amount）', () => {
      for (const s of [staffAttr, paynotifyAttr, adminAttr, adminRecomputeAttr, clientApiAttr]) {
        expect(normalizeSql(s)).toContain('WHERE oa.non_trial >= ?')
        expect(s).not.toContain('o.total_amount')
      }
    })

    test('五端归因段 JOIN 金额 CTE 取数（与会员客判定 CASE 同源）', () => {
      // 源文本里 CTE 以插值形式出现：云函数 ${RECALC_CUSTOMER_TYPE_CTE}、admin ${recalcCustomerTypeCte(clientUserId)}。
      // 两者归一化后都是 ?，故此处断言原始插值引用 + JOIN 子句，确保归因段确实走 CTE 而非自带一份判定。
      const cteRef = /\$\{(RECALC_CUSTOMER_TYPE_CTE|recalcCustomerTypeCte\([^)]*\))\}/
      for (const s of [staffAttr, paynotifyAttr, adminAttr, adminRecomputeAttr, clientApiAttr]) {
        expect(s).toMatch(cteRef)
        expect(s).toContain('JOIN order_amounts oa ON oa.sale_order_id = o.sale_order_id')
      }
    })

    test('五端无回款单累计分支（单笔订单口径）', () => {
      // 2026-04-26 sale-order-domain-refactor 后，回款记录下沉到
      // sale_order_payments.change_type='回款'，sale_orders 不再产生旧“回款单”类型行。
      for (const s of [staffAttr, paynotifyAttr, adminAttr, adminRecomputeAttr, clientApiAttr]) {
        expect(s).not.toContain('ref_sale_order_id')
        expect(s).not.toContain("'回款单'")
      }
    })

    test('五端归因段都按 paid_at ASC NULLS LAST, created_at ASC, sale_order_id ASC 取首笔达标单', () => {
      // sale_order_id 是确定性兜底：两张达标单的 paid_at 与 created_at 完全相同时，
      // 没有唯一键 PG 不保证两次独立查询选同一单，会让 became_member_at 与
      // is_membership_upgrade 落到不同订单上（codex 闸门 2 抓出）。
      const re = /ORDER BY o\.paid_at ASC NULLS LAST, o\.created_at ASC, o\.sale_order_id ASC/
      expect(staffAttr).toMatch(re)
      expect(paynotifyAttr).toMatch(re)
      expect(adminAttr).toMatch(re)
      expect(adminRecomputeAttr).toMatch(re)
      expect(clientApiAttr).toMatch(re)
    })
  })

  describe('became_member_at 口径 UPDATE（首笔达标单时间）镜像一致性', () => {
    let staffBma
    let paynotifyBma
    let adminBma
    let adminRecomputeBma
    let clientApiBma

    beforeAll(() => {
      staffBma = extractBecameMemberAtUpdate(STAFF_ORDER_JS)
      paynotifyBma = extractBecameMemberAtUpdate(PAYNOTIFY_JS)
      adminBma = extractBecameMemberAtUpdate(ADMIN_ORDERS_TS)
      adminRecomputeBma = extractBecameMemberAtUpdate(ADMIN_RECOMPUTE_TS)
      clientApiBma = extractBecameMemberAtUpdate(CLIENT_API_ORDER_JS)
    })

    test('五端目标列一致：UPDATE client_wechat_users SET became_member_at = COALESCE((…SELECT COALESCE(o.paid_at, o.created_at)…', () => {
      const re = /^UPDATE client_wechat_users SET became_member_at = COALESCE\(\(/
      expect(staffBma).toMatch(re)
      expect(paynotifyBma).toMatch(re)
      expect(adminBma).toMatch(re)
      expect(adminRecomputeBma).toMatch(re)
      expect(clientApiBma).toMatch(re)
      for (const s of [staffBma, paynotifyBma, adminBma, adminRecomputeBma, clientApiBma]) {
        expect(s).toContain('SELECT COALESCE(o.paid_at, o.created_at)')
      }
    })

    test('五端规范化后逐字相同（占位符归一化后 $1 与 ${clientUserId} 等价）', () => {
      const staffN = normalizeSql(staffBma)
      expect(normalizeSql(paynotifyBma)).toBe(staffN)
      expect(normalizeSql(adminBma)).toBe(staffN)
      expect(normalizeSql(adminRecomputeBma)).toBe(staffN)
      expect(normalizeSql(clientApiBma)).toBe(staffN)
    })

    test('五端 became_member_at 段必须带 WHERE user_id（防全表覆写）', () => {
      for (const s2 of [staffBma, paynotifyBma, adminBma, adminRecomputeBma, clientApiBma]) {
        expect(normalizeSql(s2)).toMatch(/WHERE user_id = \?/)
      }
    })

    test('五端 became_member_at 用 COALESCE 兜底，空集不得把已有值抹成 NULL', () => {
      // 标量子查询无行返回 NULL，裸 SET 会直接抹掉已有 became_member_at。
      // 外层「只在首次跃迁时执行」是隐含契约，COALESCE 把它变成显式保护（闸门 2 GLM P2）。
      for (const s2 of [staffBma, paynotifyBma, adminBma, adminRecomputeBma, clientApiBma]) {
        expect(s2).toContain('SET became_member_at = COALESCE((')
        expect(normalizeSql(s2)).toContain('), became_member_at) WHERE user_id = ?')
      }
    })

    test('五端 became_member_at 段不含 NOW()（旧跃迁时刻口径已下线）', () => {
      expect(staffBma).not.toMatch(/NOW\(\)/)
      expect(paynotifyBma).not.toMatch(/NOW\(\)/)
      expect(adminBma).not.toMatch(/NOW\(\)/)
      expect(adminRecomputeBma).not.toMatch(/NOW\(\)/)
      expect(clientApiBma).not.toMatch(/NOW\(\)/)
    })

    test('五端选单条件已改为 oa.non_trial >= 阈值（#187，与 is_membership_upgrade 归因同源 ⇒ 选同一单）', () => {
      for (const s of [staffBma, paynotifyBma, adminBma, adminRecomputeBma, clientApiBma]) {
        expect(normalizeSql(s)).toContain('WHERE oa.non_trial >= ?')
        expect(s).not.toContain('o.total_amount')
      }
    })

    test('五端无回款单累计分支（单笔订单口径，与五端 is_membership_upgrade 归因段同源）', () => {
      for (const s of [staffBma, paynotifyBma, adminBma, adminRecomputeBma, clientApiBma]) {
        expect(s).not.toContain('ref_sale_order_id')
        expect(s).not.toContain("'回款单'")
      }
    })

    test('五端都按 paid_at ASC NULLS LAST, created_at ASC, sale_order_id ASC 取首笔达标单（与各端 is_membership_upgrade 同序 ⇒ 选同一单）', () => {
      const re = /ORDER BY o\.paid_at ASC NULLS LAST, o\.created_at ASC, o\.sale_order_id ASC/
      expect(staffBma).toMatch(re)
      expect(paynotifyBma).toMatch(re)
      expect(adminBma).toMatch(re)
      expect(adminRecomputeBma).toMatch(re)
      expect(clientApiBma).toMatch(re)
    })

    test('回归守护：五端源码不再出现旧的 SET became_member_at = NOW() 形态', () => {
      const re = /SET became_member_at\s*=\s*NOW\(\)/
      for (const [, file] of RUNTIME_FILES) {
        expect(fs.readFileSync(file, 'utf8')).not.toMatch(re)
      }
    })
  })

  /**
   * 第 6/7 处副本：db/scripts 的全库批量脚本。
   * 这两个脚本会把全库 customer_type / became_member_at 按自身 SQL 重算覆写——
   * 口径与运行时漂移时，跑一次脚本就会把线上数据改回旧口径，因此必须纳入守护。
   * 无法逐字比对（全库版无 $clientUserId 过滤、多带输出列），故断言关键片段。
   */
  describe('db/scripts 全库批量脚本口径对齐（第 6/7 处副本）', () => {
    const SCRIPTS = [
      ['recalc-all-customer-types.js', SCRIPT_RECALC_ALL_TYPES],
      ['recalc-became-member-at.js', SCRIPT_RECALC_BECAME_MEMBER],
      // ⚠️ 第 8 处曾只声明常量、未进本数组 —— 守护形同虚设（codex 闸门 2 抓出）。
      // 它写 is_membership_upgrade + document_type，幂等可重跑，漏守护就会把线上打标改回旧口径。
      ['backfill-membership-upgrade-doc-type.js', SCRIPT_BACKFILL_UPGRADE_DOC_TYPE],
    ]

    for (const [label, file] of SCRIPTS) {
      describe(label, () => {
        let src

        beforeAll(() => {
          src = fs.readFileSync(file, 'utf8')
        })

        test('含金额 CTE（refund_by_item + order_amounts）', () => {
          expect(src).toContain('refund_by_item AS (')
          expect(src).toContain('order_amounts AS (')
        })

        test('毛实收表达式与运行时一致（received 净额 + 逐项退款额，LEAST 封顶）', () => {
          expect(src).toContain('LEAST(si.received::numeric + COALESCE(rbi.refunded, 0),')
          expect(src).toContain('si.sale_amount::numeric)')
        })

        test('无明细行订单回退订单级 received（与运行时同语义）', () => {
          expect(src).toContain(
            'CASE WHEN NOT EXISTS (SELECT 1 FROM sale_items si2 WHERE si2.sale_order_id = o.sale_order_id)'
          )
          expect(src).toContain('THEN GREATEST(o.received::numeric, 0)')
          expect(src).toContain('LEFT JOIN sale_items si ON si.sale_order_id = o.sale_order_id')
        })

        test('non_trial 按 is_experience = false 聚合且 COALESCE 归零', () => {
          expect(src).toContain('FILTER (WHERE si.is_experience = false), 0)')
          expect(src).toContain('END AS non_trial')
        })

        test("只聚合 item_direction='购买' 行", () => {
          expect(src).toContain("AND si.item_direction = '购买'")
        })

        test("note→jsonb 三重防线（与运行时逐字同源，守门加严为 LIKE '{\"%'）", () => {
          expect(src).toContain('sop.note LIKE \'{"%\'')
          expect(src).toContain("jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'")
        })

        test('退款聚合只认已支付的退款流水 + 排除 OVERPAY + 限定已结清销售单', () => {
          expect(src).toContain("AND sop.change_type = '退款'")
          expect(src).toContain("AND sop.status = '已支付'")
          expect(src).toContain("AND elem ->> 'refSaleItemId' <> 'OVERPAY'")
          // 本 CTE 按全库聚合，不限定订单范围会把脏 note 的 22P02 半径放到最大
          expect(src).toContain("WHERE ro.status IN ('已支付', '已完成')")
          expect(src).toContain("AND ro.sale_order_type = '销售单'")
        })

        test('达标判定改用 non_trial >= 阈值，不再比 o.total_amount（#187 回归守护）', () => {
          expect(src).toMatch(/non_trial >= /)
          expect(src).not.toMatch(/o\.total_amount >= /)
        })

        test('按订单分组（单笔口径）', () => {
          expect(src).toContain('GROUP BY o.sale_order_id, o.client_user_id, o.paid_at, o.created_at, o.received')
        })
      })
    }

    test('recalc-all-customer-types.js 的小美客/体验客改按金额判（non_trial / trial > 0）', () => {
      const src = fs.readFileSync(SCRIPT_RECALC_ALL_TYPES, 'utf8')
      expect(src).toMatch(/xiaomei_users AS \([\s\S]*?WHERE non_trial > 0/)
      expect(src).toMatch(/tiyan_users AS \([\s\S]*?WHERE trial > 0/)
    })

    test('recalc-became-member-at.js 选单序与运行时一致（末位 sale_order_id 兜底确定性）', () => {
      const src = fs.readFileSync(SCRIPT_RECALC_BECAME_MEMBER, 'utf8')
      expect(src).toContain(
        'ORDER BY oa.client_user_id, oa.paid_at ASC NULLS LAST, oa.created_at ASC, oa.sale_order_id ASC'
      )
    })

    test('三个脚本的 DISTINCT ON 选单都带 sale_order_id 确定性兜底', () => {
      expect(fs.readFileSync(SCRIPT_RECALC_ALL_TYPES, 'utf8')).toContain(
        'ORDER BY client_user_id, paid_at ASC NULLS LAST, created_at ASC, sale_order_id ASC'
      )
      expect(fs.readFileSync(SCRIPT_BACKFILL_UPGRADE_DOC_TYPE, 'utf8')).toContain(
        'ORDER BY o.client_user_id, o.paid_at ASC NULLS LAST, o.created_at ASC, o.sale_order_id ASC'
      )
    })
  })
})
