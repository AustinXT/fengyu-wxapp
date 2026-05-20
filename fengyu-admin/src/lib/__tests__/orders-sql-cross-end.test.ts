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
 *     1. 入口锁单 SELECT ... FROM sale_orders ... FOR UPDATE（含 prepaid_card_amount + client_user_id）
 *        (admin 端入口单锁读全部决策列；staff 端使用早先 SELECT 出的 order 行 + 后续 FOR UPDATE 锁余额)
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
// 充值卡剥离 SKU 化（2026-05-20）: applyRechargeOnOrderPaid 三端 SQL 一致性测试组删除

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

  describe('1. 锁原单读 prepaid_card_amount + client_user_id（admin 入口单锁，staff 复用早期查询）', () => {
    // admin 端在 confirmOfflinePayment 入口用单条 SELECT ... FOR UPDATE 锁单并读取全部决策列
    // （含 prepaid_card_amount + client_user_id）；staff 端在 confirmOffline 入口已 SELECT * FROM sale_orders。
    // 两端都必须在锁内读 prepaid_card_amount + client_user_id（capability + 扣卡守护）。
    test('admin 必须在 FOR UPDATE 锁单时读取 prepaid_card_amount + client_user_id', () => {
      const lockSql = normalizeSql(
        extractBacktickContaining(adminSrc, 'SELECT status, payment_method, store_id'),
      )
      expect(lockSql).toMatch(/FROM sale_orders/i)
      expect(lockSql).toMatch(/FOR UPDATE/i)
      expect(lockSql).toMatch(/prepaid_card_amount/)
      expect(lockSql).toMatch(/client_user_id/)
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
        extractBacktickContaining(adminSrc, 'SELECT status, payment_method, store_id'),
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
