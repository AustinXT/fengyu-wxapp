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

describe('退款 Bug Q 子集级联守护（通道1/2 仅全退 item 作废）', () => {
  test('staff cascade：fullItemIds 派生 + 长度门控 + 通道1/2 按 ANY(fullItemIds) 过滤', () => {
    // 仅「全退」item 进入 fullItemIds
    expect(staffCascade).toMatch(/fullItemIds\s*=\s*effItems\.filter\(\(it\)\s*=>\s*it\.isFullItemRefund\)/)
    expect(staffCascade).toMatch(/if\s*\(fullItemIds\.length\s*>\s*0\)/)
    // 通道1 分配：sale_item_id = ANY($2)，不得是 sale_order_id 整单
    expect(staffCascade).toMatch(/UPDATE sale_allocations[\s\S]{0,200}sale_item_id = ANY\(\$2\)/)
    // 通道2 提成：经 service_items 子查询按 sale_item_id = ANY($3)
    expect(staffCascade).toMatch(/service_commissions[\s\S]{0,260}sale_item_id = ANY\(\$3\)/)
    // 防回归：通道1/2 不得整单作废（WHERE sale_order_id 直接清分配/提成）
    expect(staffCascade).not.toMatch(/UPDATE sale_allocations[\s\S]{0,200}WHERE sale_order_id/)
  })

  test('admin cascade：同样 fullItemIds 门控 + 通道1/2 按 ANY(fullItemIds) 过滤', () => {
    expect(adminCascade).toMatch(/fullItemIds\s*=\s*effItems\.filter\(\(it\)\s*=>\s*it\.isFullItemRefund\)/)
    expect(adminCascade).toMatch(/if\s*\(fullItemIds\.length\s*>\s*0\)/)
    expect(adminCascade).toMatch(/UPDATE sale_allocations[\s\S]{0,200}sale_item_id = ANY\(\$\{fullItemIds\}\)/)
    expect(adminCascade).toMatch(/service_commissions[\s\S]{0,320}sale_item_id = ANY\(\$\{fullItemIds\}\)/)
    expect(adminCascade).not.toMatch(/UPDATE sale_allocations[\s\S]{0,200}WHERE sale_order_id/)
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
  test('两端店长解析：permission_roles JOIN stores + role=manager + store_id', () => {
    const mgrResolve = /permission_roles[\s\S]{0,120}JOIN stores[\s\S]{0,120}role = 'manager'[\s\S]{0,80}store_id/
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
