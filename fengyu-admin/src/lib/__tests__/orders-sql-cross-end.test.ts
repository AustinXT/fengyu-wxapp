/**
 * 跨端 SQL 一致性守护：admin orders.ts ↔ staff order.js ↔ payNotify index.js
 *
 * 配合 staff 侧 jest
 * `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js`
 * 形成对称守护（test-colocation feedback：admin CI 必须自查自家文件）。
 *
 * 背景：T5 ticket（2026-05-19）发现 admin `applyRechargeOnOrderPaid` 在 2026-04-26
 * capability 化重构时漏改了 face value 识别路径（保持单路径直到 2026-05-19），
 * 而 staff/client 早已双路径。漂移期 23 天。
 *
 * 守护对象：
 *   §2.1 applyRechargeOnOrderPaid 三端独立副本：
 *     - SELECT recharge items (capability 列 + sku.price JOIN，双路径面值识别)
 *     - UPSERT prepaid_cards (ON CONFLICT user_id + balance += EXCLUDED.balance)
 *     - INSERT card_transactions type='充值'（admin Drizzle ORM insert / pg INSERT SQL）
 *
 *   §2.2 confirmOfflinePayment 储值卡抵扣扣款 6 段（admin ↔ staff 字面对齐）：
 *     1. SELECT prepaid_card_amount, client_user_id FROM sale_orders ... FOR UPDATE
 *        (admin 端独立加锁；staff 端使用早先 SELECT 出的 order 行 + 后续 FOR UPDATE 锁余额)
 *     2. SELECT 1 FROM card_transactions WHERE ref_order_id AND type='扣款' LIMIT 1 (幂等)
 *     3. SELECT card_id, balance FROM prepaid_cards WHERE user_id FOR UPDATE
 *     4. UPDATE prepaid_cards SET balance = balance - ? WHERE card_id
 *     5. INSERT INTO card_transactions type='扣款' + external_ref=card-deduct-{saleOrderId}
 *        + ON CONFLICT (external_ref) DO NOTHING
 *     6. INSERT INTO sale_order_payments change_type='储值卡抵扣' payment_method='储值卡'
 *
 * 占位符归一化：$1/$2（pg）与 ${var}（Drizzle）都 → ?，空白压缩。
 */

import { describe, test, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// admin/src/lib/__tests__/ → repo root 上 4 级
const REPO_ROOT = path.resolve(__dirname, '../../../..')

const FILES = {
  adminOrdersTs: path.resolve(REPO_ROOT, 'fengyu-admin/src/actions/orders.ts'),
  staffOrderJs: path.resolve(REPO_ROOT, 'fengyu-staff/cloudfunctions/staffApi/routes/order.js'),
  payNotifyIndexJs: path.resolve(REPO_ROOT, 'fengyu-client/cloudfunctions/payNotify/index.js'),
}

function readFile(p: string): string {
  return fs.readFileSync(p, 'utf8')
}

/**
 * 跨端归一化 SQL 文本，方便 pg($1) 与 Drizzle(${var}) 字面比对。
 */
function normalizeSql(sql: string): string {
  return sql
    .replace(/\$\d+/g, '?')
    .replace(/\$\{[^}]+\}/g, '?')
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .trim()
}

/**
 * 提取源文件中第一个含 marker 的 backtick 字符串内容（无外层反引号）。
 * 兼容 Drizzle sql`...` 与 pg client.query(`...`) 两种用法。
 */
function extractBacktickContaining(src: string, marker: string): string {
  const matches = src.matchAll(/`([^`]+)`/g)
  for (const m of matches) {
    if (m[1].includes(marker)) return m[1]
  }
  throw new Error(`未找到含 "${marker}" 的 backtick 字符串`)
}

// ─────────────────────────────────────────────────────────────────────────────
// §2.1 applyRechargeOnOrderPaid SQL 三端独立副本守护
// ─────────────────────────────────────────────────────────────────────────────
describe('admin/staff/payNotify applyRechargeOnOrderPaid 三端 SQL 一致性', () => {
  let adminSrc: string
  let staffSrc: string
  let payNotifySrc: string

  beforeAll(() => {
    adminSrc = readFile(FILES.adminOrdersTs)
    staffSrc = readFile(FILES.staffOrderJs)
    payNotifySrc = readFile(FILES.payNotifyIndexJs)
  })

  describe('Recharge identification SELECT（capability 列 + 双路径面值识别）', () => {
    // 三端共有 marker：SELECT si.sku_id, si.product_name + JOIN product_skus + is_recharge_card = true
    const MARKER = 'sk.price AS sku_price'

    test('三端 SELECT 必须用 capability 列 is_recharge_card = true 识别充值行（严格小写）', () => {
      const adminSql = normalizeSql(extractBacktickContaining(adminSrc, MARKER))
      const staffSql = normalizeSql(extractBacktickContaining(staffSrc, MARKER))
      const payNotifySql = normalizeSql(extractBacktickContaining(payNotifySrc, MARKER))

      // 严格小写（无 /i flag）：staff/payNotify pg 实现已统一小写 true，
      // admin Drizzle 端必须对齐避免 SQL 大小写漂移误差（虽然 pg 接受 TRUE，
      // 但跨端字面对齐是 snapshot 守护的硬约束）。
      expect(adminSql).toMatch(/is_recharge_card\s*=\s*true/)
      expect(staffSql).toMatch(/is_recharge_card\s*=\s*true/)
      expect(payNotifySql).toMatch(/is_recharge_card\s*=\s*true/)
    })

    test('三端字面对齐：admin recharge SELECT 与 staff/payNotify 归一化后字面同义（容差 admin LIMIT 1 + 缺 sale_item_id 列）', () => {
      const adminSql = normalizeSql(extractBacktickContaining(adminSrc, MARKER))
      const staffSql = normalizeSql(extractBacktickContaining(staffSrc, MARKER))
      const payNotifySql = normalizeSql(extractBacktickContaining(payNotifySrc, MARKER))

      expect(staffSql).toBe(payNotifySql)
      const adminAligned = adminSql
        .replace(/\s*LIMIT\s+1\s*$/i, '')
        .replace(/SELECT\s+/, 'SELECT si.sale_item_id, ')
      expect(adminAligned).toBe(staffSql)
    })

    test('三端 SELECT 必须 LEFT JOIN product_skus 取 sk.price（真实 SKU 路径面值源）', () => {
      const adminSql = normalizeSql(extractBacktickContaining(adminSrc, MARKER))
      const staffSql = normalizeSql(extractBacktickContaining(staffSrc, MARKER))
      const payNotifySql = normalizeSql(extractBacktickContaining(payNotifySrc, MARKER))

      const joinRe = /LEFT\s+JOIN\s+product_skus\s+sk\s+ON\s+si\.sku_id\s*=\s*sk\.sku_id/i
      expect(adminSql).toMatch(joinRe)
      expect(staffSql).toMatch(joinRe)
      expect(payNotifySql).toMatch(joinRe)
    })

    test('三端 SELECT 列集字面一致（sku_id, product_name, sk.price AS sku_price）', () => {
      const adminSql = normalizeSql(extractBacktickContaining(adminSrc, MARKER))
      const staffSql = normalizeSql(extractBacktickContaining(staffSrc, MARKER))
      const payNotifySql = normalizeSql(extractBacktickContaining(payNotifySrc, MARKER))

      // 三端列集允许差异：admin 只读 sku_id + product_name + sku_price（不需要 sale_item_id 做 external_ref）
      // staff/payNotify 多读 sale_item_id 用于生成 card-recharge-{sale_item_id} external_ref
      // 但 is_recharge_card = true、sku_price、product_skus JOIN 三个不变量必须严格一致
      for (const sql of [adminSql, staffSql, payNotifySql]) {
        expect(sql).toMatch(/si\.sku_id/i)
        expect(sql).toMatch(/si\.product_name/i)
        expect(sql).toMatch(/sk\.price\s+AS\s+sku_price/i)
      }
    })
  })

  describe('UPSERT prepaid_cards（已在 staff 侧测试守护，admin 侧二次确认）', () => {
    const MARKER = 'INSERT INTO prepaid_cards'

    test('三端 UPSERT 必须用 ON CONFLICT (user_id) + balance += EXCLUDED.balance', () => {
      const adminSql = normalizeSql(extractBacktickContaining(adminSrc, MARKER))
      const staffSql = normalizeSql(extractBacktickContaining(staffSrc, MARKER))
      const payNotifySql = normalizeSql(extractBacktickContaining(payNotifySrc, MARKER))

      for (const sql of [adminSql, staffSql, payNotifySql]) {
        expect(sql).toMatch(/ON CONFLICT\s*\(user_id\)/i)
        expect(sql).toMatch(/balance\s*=\s*prepaid_cards\.balance\s*\+\s*EXCLUDED\.balance/i)
      }
    })

    test('Snapshot 守护：三端 UPSERT 文本归一化后字面同义', () => {
      const adminSql = normalizeSql(extractBacktickContaining(adminSrc, MARKER))
      const staffSql = normalizeSql(extractBacktickContaining(staffSrc, MARKER))
      const payNotifySql = normalizeSql(extractBacktickContaining(payNotifySrc, MARKER))

      // staff/payNotify 在 INSERT 列表里多带 created_at, updated_at = NOW()；
      // admin 表层依赖 DB DEFAULT NOW()，不显式写。这里只守护关键 UPSERT 子句字面一致。
      expect(staffSql).toBe(payNotifySql)
      // admin vs staff 因 created_at/updated_at 显式列存在差异；改用关键字段子串匹配
      expect(adminSql).toContain('INSERT INTO prepaid_cards')
      expect(adminSql).toMatch(/balance\s*=\s*prepaid_cards\.balance\s*\+\s*EXCLUDED\.balance/i)
    })
  })

  describe('card_transactions 充值流水插入（admin Drizzle ORM insert / pg INSERT SQL）', () => {
    test('admin 必须通过 tx.insert(cardTransactions) 写入 type=充值 行（face value + ref_order_id）', () => {
      // admin 用 Drizzle ORM insert（非 sql 模板），守护 insert 调用 + 关键字段
      // 注：applyRechargeOnOrderPaid 内只有一处 tx.insert(cardTransactions)
      expect(adminSrc).toMatch(/tx\.insert\s*\(\s*cardTransactions\s*\)[\s\S]{0,300}?type:\s*['"]充值['"]/)
      expect(adminSrc).toMatch(/tx\.insert\s*\(\s*cardTransactions\s*\)[\s\S]{0,400}?refOrderId:\s*saleOrderId/)
    })

    test('staff 必须 INSERT INTO card_transactions type=充值 + external_ref=card-recharge-{sale_item_id}', () => {
      // staff/payNotify 端用 INSERT SQL；找含 '充值' 字面量的那条
      const inserts = [...staffSrc.matchAll(/INSERT INTO card_transactions[\s\S]{0,400}/g)]
      const rechargeInsert = inserts.find((m) => m[0].includes("'充值'"))
      expect(rechargeInsert).toBeDefined()
      expect(rechargeInsert![0]).toMatch(/card-recharge-/)
    })

    test('payNotify 必须 INSERT INTO card_transactions type=充值 + external_ref=card-recharge-{sale_item_id}', () => {
      const inserts = [...payNotifySrc.matchAll(/INSERT INTO card_transactions[\s\S]{0,400}/g)]
      const rechargeInsert = inserts.find((m) => m[0].includes("'充值'"))
      expect(rechargeInsert).toBeDefined()
      expect(rechargeInsert![0]).toMatch(/card-recharge-/)
    })
  })

  describe('双路径面值识别（virtual SKU → product_name 解析 / real SKU → sku.price）', () => {
    // 历史漂移点：admin 2026-04-26 重构时漏改，直到 2026-05-19 才补上。
    test('admin 必须含 RECHARGE_VIRTUAL_SKU_ID 分支（虚拟 SKU 走 parseRechargeFaceValue）', () => {
      expect(adminSrc).toMatch(/RECHARGE_VIRTUAL_SKU_ID/)
      expect(adminSrc).toMatch(/parseRechargeFaceValue/)
    })

    test('admin 必须含 sku.price 真实 SKU 分支（Number(rechargeRow.sku_price)）', () => {
      // 与 staff order.js L1086 + payNotify index.js L378 字面对应：faceValue = Number(row.sku_price)
      expect(adminSrc).toMatch(/Number\(\s*rechargeRow\.sku_price\s*\)/)
    })

    test('staff 必须双路径（virtual SKU 走 product_name regex / real SKU 走 sku_price）', () => {
      expect(staffSrc).toMatch(/RECHARGE_VIRTUAL_SKU_ID/)
      expect(staffSrc).toMatch(/Number\(\s*row\.sku_price\s*\)/)
    })

    test('payNotify 必须双路径（virtual SKU 走 product_name regex / real SKU 走 sku_price）', () => {
      expect(payNotifySrc).toMatch(/RECHARGE_VIRTUAL_SKU_ID/)
      expect(payNotifySrc).toMatch(/Number\(\s*row\.sku_price\s*\)/)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §2.2 confirmOfflinePayment 储值卡抵扣扣款 6 段守护（admin ↔ staff 字面对齐）
// ─────────────────────────────────────────────────────────────────────────────
describe('admin confirmOfflinePayment ↔ staff confirmOffline 储值卡扣款 6 段一致性', () => {
  let adminSrc: string
  let staffSrc: string

  beforeAll(() => {
    adminSrc = readFile(FILES.adminOrdersTs)
    staffSrc = readFile(FILES.staffOrderJs)
  })

  describe('1. 锁原单读 prepaid_card_amount + client_user_id（admin 独立加锁，staff 复用早期查询）', () => {
    // admin 端独立 SELECT FOR UPDATE；staff 端在 confirmOffline 入口已 SELECT * FROM sale_orders。
    // 两端都必须读 prepaid_card_amount 字段（capability 守护）。
    test('admin 必须 SELECT prepaid_card_amount + client_user_id FROM sale_orders FOR UPDATE', () => {
      // admin 端的独立锁块
      expect(adminSrc).toMatch(
        /SELECT\s+prepaid_card_amount,\s*client_user_id\s+FROM\s+sale_orders[\s\S]{0,200}FOR\s+UPDATE/i,
      )
    })
    test('staff 必须读 order.prepaid_card_amount + order.client_user_id', () => {
      // staff 在 confirmOffline 内通过外层 order 行（早先 SELECT *）拿到这两列
      expect(staffSrc).toMatch(/order\.prepaid_card_amount/)
      expect(staffSrc).toMatch(/order\.client_user_id/)
    })
  })

  describe("2. 扣款幂等检查：SELECT 1 FROM card_transactions WHERE ref_order_id AND type='扣款'", () => {
    const guardRe = /SELECT\s+1\s+FROM\s+card_transactions[\s\S]{0,200}ref_order_id[\s\S]{0,100}type\s*=\s*'扣款'/i
    test('admin 必须有扣款幂等 SELECT', () => {
      expect(adminSrc).toMatch(guardRe)
    })
    test('staff 必须有扣款幂等 SELECT', () => {
      expect(staffSrc).toMatch(guardRe)
    })
  })

  describe("3. 锁余额：SELECT card_id, balance FROM prepaid_cards WHERE user_id FOR UPDATE", () => {
    const lockRe = /SELECT\s+card_id,\s*balance\s+FROM\s+prepaid_cards\s+WHERE\s+user_id\s*=\s*[\$?\d{}\w]+\s+FOR\s+UPDATE/i
    test('admin 必须锁卡读余额', () => {
      const adminSql = normalizeSql(extractBacktickContaining(adminSrc, 'SELECT card_id, balance FROM prepaid_cards'))
      expect(adminSql).toMatch(/SELECT card_id, balance FROM prepaid_cards WHERE user_id = \? FOR UPDATE/i)
    })
    test('staff 必须锁卡读余额', () => {
      // staff 用 client.query(`SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE`, ...)
      expect(staffSrc).toMatch(lockRe)
    })
  })

  describe('4. UPDATE prepaid_cards SET balance = balance - ? WHERE card_id', () => {
    test('admin 必须 UPDATE balance 扣减（同事务）', () => {
      const adminSql = normalizeSql(
        extractBacktickContaining(adminSrc, 'UPDATE prepaid_cards'),
      )
      expect(adminSql).toMatch(/UPDATE prepaid_cards/i)
      expect(adminSql).toMatch(/balance\s*=\s*balance\s*-\s*\?/i)
      expect(adminSql).toMatch(/WHERE card_id\s*=\s*\?/i)
    })
    test('staff 必须 UPDATE balance 扣减（同事务）', () => {
      // staff 端有多处 UPDATE prepaid_cards（confirmOffline + refund），守护 confirmOffline 那处
      // 通过匹配上下文 (balance - $1 + updated_at = NOW() + WHERE card_id = $2)
      expect(staffSrc).toMatch(
        /UPDATE\s+prepaid_cards\s+SET\s+balance\s*=\s*balance\s*-\s*\$\d+,\s*updated_at\s*=\s*NOW\(\)\s+WHERE\s+card_id\s*=\s*\$\d+/i,
      )
    })
  })

  describe("5. INSERT card_transactions type='扣款' + external_ref=card-deduct-{saleOrderId}", () => {
    test('admin 必须 INSERT 扣款流水 + external_ref 幂等键 + ON CONFLICT DO NOTHING', () => {
      // admin 端写法：sql`INSERT INTO card_transactions ... VALUES (${cardId}, '扣款', ${-prepaidAmount}, ...)`
      const inserts = [...adminSrc.matchAll(/INSERT INTO card_transactions[\s\S]{0,500}/g)]
      const deductInsert = inserts.find((m) => m[0].includes("'扣款'"))
      expect(deductInsert).toBeDefined()
      expect(deductInsert![0]).toMatch(/card-deduct-/)
      expect(deductInsert![0]).toMatch(/ON CONFLICT\s*\(external_ref\)[\s\S]{0,100}DO NOTHING/i)
    })

    test('staff 必须 INSERT 扣款流水 + external_ref 幂等键 + ON CONFLICT DO NOTHING', () => {
      const inserts = [...staffSrc.matchAll(/INSERT INTO card_transactions[\s\S]{0,500}/g)]
      const deductInsert = inserts.find((m) => m[0].includes("'扣款'"))
      expect(deductInsert).toBeDefined()
      expect(deductInsert![0]).toMatch(/card-deduct-/)
      expect(deductInsert![0]).toMatch(/ON CONFLICT\s*\(external_ref\)[\s\S]{0,100}DO NOTHING/i)
    })
  })

  describe("6. INSERT sale_order_payments change_type='储值卡抵扣' payment_method='储值卡'", () => {
    test('admin 必须写 储值卡抵扣 payments 行（与扣卡同事务）', () => {
      const inserts = [...adminSrc.matchAll(/INSERT INTO sale_order_payments[\s\S]{0,800}/g)]
      const cardDeductPayment = inserts.find((m) => m[0].includes("'储值卡抵扣'"))
      expect(cardDeductPayment).toBeDefined()
      expect(cardDeductPayment![0]).toMatch(/'储值卡'/)
      expect(cardDeductPayment![0]).toMatch(/'已支付'/)
    })
    test('staff 必须写 储值卡抵扣 payments 行（与扣卡同事务）', () => {
      const inserts = [...staffSrc.matchAll(/INSERT INTO sale_order_payments[\s\S]{0,800}/g)]
      const cardDeductPayment = inserts.find((m) => m[0].includes("'储值卡抵扣'"))
      expect(cardDeductPayment).toBeDefined()
      expect(cardDeductPayment![0]).toMatch(/'储值卡'/)
      expect(cardDeductPayment![0]).toMatch(/'已支付'/)
    })
  })

  describe('Snapshot 守护：admin 6 段 SQL 文本快照（任一漂移立即可见）', () => {
    test('admin confirmOfflinePayment 储值卡扣款 6 段 SQL 文本快照', () => {
      // 提取 admin 端 6 段关键 SQL 的归一化文本，做整体快照
      const lockOrder = normalizeSql(
        extractBacktickContaining(adminSrc, 'SELECT prepaid_card_amount, client_user_id FROM sale_orders'),
      )
      const dupGuard = normalizeSql(
        extractBacktickContaining(adminSrc, "SELECT 1 FROM card_transactions"),
      )
      const lockCard = normalizeSql(
        extractBacktickContaining(adminSrc, 'SELECT card_id, balance FROM prepaid_cards'),
      )
      const updBalance = normalizeSql(
        extractBacktickContaining(adminSrc, 'UPDATE prepaid_cards'),
      )

      expect({
        lockOrder,
        dupGuard,
        lockCard,
        updBalance,
      }).toMatchSnapshot()
    })
  })
})
