/**
 * 退款「子集级联 / 待审批冻结 / 通知」跨端守护
 *
 * 补 cross-end-sql-snapshot.test.js 的三处缺口（2026-06-08 退款审计）：
 *   1. Bug Q 子集级联：cascade 通道1/2 必须按 fullItemIds（仅全退 item）作废分配/提成，
 *      若有人改回「整单 WHERE sale_order_id」清掉未退明细 → 本守护 fail。
 *   2. 待审批退款冻结：staff utils/refund.js 的 assertNoPendingRefund 谓词
 *      ↔ admin lib/refund-cascade.ts 的 hasPendingRefund 谓词，两端同义。
 *      （staff 副本在 utils/refund.js，主 snapshot 的 FILES 映射未覆盖该文件 → 此处独立守护。）
 *   3. 退款通知：两端店长解析（permission_roles JOIN stores role=manager + store_id）
 *      + 幂等键（refund-created / refund-approved / refund-rejected）+ ON CONFLICT(idempotency_key)。
 *
 * 独立于 cross-end-sql-snapshot.test.js，直接 readFileSync 比对源文件，互不耦合。
 */
const fs = require('node:fs')
const path = require('node:path')

const read = (rel) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')

const staffCascade = read('../../helpers/refund-cascade.js')
const adminCascade = read('../../../../../fengyu-admin/src/lib/refund-cascade.ts')
const staffRefundUtil = read('../../utils/refund.js')
const staffCardRoute = read('../../routes/card.js')

describe('退款级联守护（2026-06-24：通道1 记负数冲销逐被退 item + 通道2 仅全退 item 软删）', () => {
  test('staff cascade：通道1 逐被退 item INSERT 负数冲销（挂退款流水 id）+ 通道2 ANY($3) 仅全退 item', () => {
    // 仅「全退」item 进入 fullItemIds（通道2/3 门控）
    expect(staffCascade).toMatch(/fullItemIds\s*=\s*effItems\.filter\(\(it\)\s*=>\s*it\.isFullItemRefund\)/)
    expect(staffCascade).toMatch(/if\s*\(fullItemIds\.length\s*>\s*0\)/)
    // 通道1：逐被退 item（effItems）写负数 receipt；若有原正向分配，再 INSERT 负数子分配。
    expect(staffCascade).toMatch(/for \(const it of effItems\)/)
    expect(staffCascade).toMatch(/INSERT INTO sale_payment_item_receipts/)
    expect(staffCascade).toMatch(/\(-refundAmt\)\.toFixed\(2\)/)
    expect(staffCascade).toMatch(/INSERT INTO sale_payment_item_allocations[\s\S]{0,700}ON CONFLICT \(sale_payment_item_receipt_id, employee_id, role_type\) WHERE is_void = false[\s\S]{0,120}DO UPDATE SET/)
    expect(staffCascade).toMatch(/\(-voidTotal\)\.toFixed\(2\)/)
    expect(staffCascade).toMatch(/refundPaymentId/)
    // 通道2 提成：经 service_items 子查询按 sale_item_id = ANY($3)（仅全退 item，保持软删）
    expect(staffCascade).toMatch(/service_commissions[\s\S]{0,260}sale_item_id = ANY\(\$3\)/)
    // 防回归：通道1 不得回退为整单作废（WHERE sale_order_id 直接清分配）
    expect(staffCascade).not.toMatch(/UPDATE sale_payment_item_allocations[\s\S]{0,200}WHERE sale_order_id/)
  })

  test('admin cascade：通道1 逐被退 item INSERT 负数冲销 + 通道2 IN(fullItemIds) 仅全退 item', () => {
    expect(adminCascade).toMatch(/fullItemIds\s*=\s*effItems\.filter\(\(it\)\s*=>\s*it\.isFullItemRefund\)/)
    expect(adminCascade).toMatch(/if\s*\(fullItemIds\.length\s*>\s*0\)/)
    expect(adminCascade).toMatch(/for \(const it of effItems\)/)
    expect(adminCascade).toMatch(/INSERT INTO sale_payment_item_receipts/)
    expect(adminCascade).toMatch(/\$\{\(-refundAmt\)\.toFixed\(2\)\}/)
    expect(adminCascade).toMatch(/INSERT INTO sale_payment_item_allocations[\s\S]{0,700}ON CONFLICT \(sale_payment_item_receipt_id, employee_id, role_type\) WHERE is_void = false[\s\S]{0,120}DO UPDATE SET/)
    expect(adminCascade).toMatch(/\$\{\(-voidTotal\)\.toFixed\(2\)\}/)
    expect(adminCascade).toMatch(/refundPaymentId/)
    // 通道2：service_commissions 软删按 fullItemIds——admin 用 IN(sql.join) 规避 drizzle ANY(array) 42809
    expect(adminCascade).toMatch(/service_commissions[\s\S]{0,400}sale_item_id IN \(\$\{sql\.join\(fullItemIds/)
    expect(adminCascade).not.toMatch(/UPDATE sale_payment_item_allocations[\s\S]{0,200}WHERE sale_order_id/)
  })
})

describe('待审批退款冻结跨端镜像（assertNoPendingRefund ↔ hasPendingRefund）', () => {
  const freezePredicate = /change_type = '退款' AND status = '待审批'/

  test('staff utils/refund.js assertNoPendingRefund 谓词 + REFUND_IN_PROGRESS', () => {
    expect(staffRefundUtil).toMatch(/assertNoPendingRefund/)
    expect(staffRefundUtil).toMatch(freezePredicate)
    expect(staffRefundUtil).toMatch(/REFUND_IN_PROGRESS/)
  })

  test('admin lib/refund-cascade.ts hasPendingRefund 同谓词', () => {
    expect(adminCascade).toMatch(/hasPendingRefund/)
    expect(adminCascade).toMatch(freezePredicate)
  })

  test('两端「按服务单反查」冻结谓词同义（service_items→sale_items→sale_order_payments）', () => {
    const byServicePred = /service_items[\s\S]{0,160}sale_items[\s\S]{0,160}sale_order_payments[\s\S]{0,160}change_type = '退款' AND[\s\S]{0,40}status = '待审批'/
    expect(staffRefundUtil).toMatch(byServicePred)
    expect(adminCascade).toMatch(byServicePred)
  })
})

describe('退款通知跨端镜像（店长解析 + 幂等键）', () => {
  test('两端店长解析：permission_roles JOIN 角色定义 + is_store_manager + store_id', () => {
    const mgrResolve = /permission_roles[\s\S]{0,180}permission_role_definitions[\s\S]{0,180}JOIN stores[\s\S]{0,120}is_store_manager = TRUE[\s\S]{0,80}store_id/
    expect(staffRefundUtil).toMatch(mgrResolve)
    expect(adminCascade).toMatch(mgrResolve)
  })

  test('两端通知幂等键 + ON CONFLICT(idempotency_key)', () => {
    for (const [label, src] of [['staff', staffRefundUtil], ['admin', adminCascade]]) {
      expect(src, `${label} 缺 refund-created 幂等键`).toMatch(/refund-created-/)
      expect(src, `${label} 缺 refund-approved 幂等键`).toMatch(/refund-approved-/)
      expect(src, `${label} 缺 refund-rejected 幂等键`).toMatch(/refund-rejected-/)
      expect(src, `${label} 缺 ON CONFLICT(idempotency_key)`).toMatch(/ON CONFLICT \(idempotency_key\)/)
    }
  })

  test('两端自审降噪：operator 与收件店长相同时跳过', () => {
    expect(staffRefundUtil).toMatch(/employee_id === operatorId/)
    expect(adminCascade).toMatch(/employee_id === p\.operatorId/)
  })
})

describe('充值卡退款旁路守护（scope + 充值单类型 + 线下退款 + 通知）', () => {
  test('card.createRefund 必须校验订单 scope，且退款流水固定线下/无 external_txn_id', () => {
    expect(staffCardRoute).toMatch(/isStoreInScope\(ctx\.auth, order\.store_id\)/)
    expect(staffCardRoute).toMatch(/PERMISSION_DENIED: 订单不在当前门店范围内/)
    expect(staffCardRoute).toMatch(/payment_method[\s\S]{0,160}VALUES[\s\S]{0,160}'线下'/)
    expect(staffCardRoute).not.toMatch(/refund-pending-/)
  })

  test('card.approveRefund/rejectRefund 只能处理充值单退款流水', () => {
    expect(staffCardRoute).toMatch(/pay\.change_type !== '退款'/)
    expect(staffCardRoute).toMatch(/pay\.sale_order_type !== '充值单'/)
    expect(staffCardRoute).toMatch(/非充值单不可走充值卡退款审批/)
  })

  test('card.create/approve/reject 复用退款消息通知', () => {
    expect(staffCardRoute).toMatch(/notifyRefundCreated\(pg/)
    expect(staffCardRoute).toMatch(/notifyRefundResult\(client/)
    expect(staffCardRoute).toMatch(/approved: true/)
    expect(staffCardRoute).toMatch(/approved: false/)
  })
})
