import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * settleServiceCommissions（admin confirmServiceOrder 的提成写入 helper）单测。
 *
 * 重点守护 M1/M8：寄存单退款单（service_orders.remark === DEPOSIT_REFUND_REMARK，真扣次数、
 * 假消耗）须跳过 service_commissions 写入（镜像 staff finalizeServiceOrder service.js:494 /
 * client service-finalize.js:105 的 per-item `continue`），但仍无条件置 commission_status='已分配'。
 *
 * services.test.ts 的全局 drizzle-orm mock 让 sql\`...\` 返回 {}（丢失 SQL 文本），无法断言
 * 「是否真发了 INSERT」——其 M1 用例因此退化为只断言「settle 被调过」。本文件改用保留文本的
 * sql mock + 自定义 executor 直接驱动 helper，能精确断言「未发起某类 SQL」。
 */

// 保留 SQL 文本：sql`...` 返回 { __strings, __vals }，便于按关键字断言「未发起某类 SQL」
vi.mock('drizzle-orm', () => ({
  sql: Object.assign(
    vi.fn((strings: readonly string[], ...vals: unknown[]) => ({ __strings: strings, __vals: vals })),
    { raw: vi.fn() },
  ),
}))

import { settleServiceCommissions } from '../service-commission-settle'
import { DEPOSIT_REFUND_REMARK } from '../service-remark'

type SqlObj = { __strings: readonly string[]; __vals: unknown[] }

/** 提取 sql 对象的字面文本（拼接字面段，用于关键字 includes 断言） */
function textOf(sqlObj: unknown): string {
  const s = (sqlObj as SqlObj)?.__strings
  return Array.isArray(s) ? s.join(' ') : ''
}

const ITEM = {
  service_item_id: 'sit-1',
  sale_item_id: 'sli-1',
  session_used: 2,
  employee_id: 'EMP-1',
  unit_real_price: '100',
  service_fee: '0',
  sales_category: '自销自耗',
  session_count: 10,
  skills: ['美容师'],
}

const OPERATOR = { employeeId: 'ADMIN-1', name: '管理员', role: 'admin' }

/**
 * 构造 executor：按 SQL 关键字路由返回值；记录全部调用，供断言「是否发了某类 SQL」。
 * 路由顺序：service_items 明细 → 费率矩阵 → remark（service_orders）→ 默认（INSERT/UPDATE）。
 */
function makeExecutor(opts: { remark: string | null; rate: string; priceThreshold?: string | null; item?: Partial<Omit<typeof ITEM, 'unit_real_price'>> & { unit_real_price?: string | null } }) {
  const calls: unknown[] = []
  const itemsRows = [{ ...ITEM, ...opts.item }]
  const remarkRows = [{ remark: opts.remark }]
  const rateRows = [{ commission_rate: opts.rate, price_threshold: opts.priceThreshold ?? null }]
  const execute = vi.fn(async (sqlObj: unknown) => {
    calls.push(sqlObj)
    const t = textOf(sqlObj)
    if (t.includes('FROM service_items sit')) return itemsRows
    if (t.includes('commission_rate_matrix')) return rateRows
    if (t.includes('FROM service_orders')) return remarkRows
    return [] // INSERT / UPDATE
  })
  return { execute, calls }
}

function sent(calls: unknown[], kw: string): boolean {
  return calls.some((c) => textOf(c).includes(kw))
}

describe('settleServiceCommissions — 寄存退款单跳过提成（M8 镜像 staff/client）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('寄存退款单（remark=DEPOSIT_REFUND_REMARK）→ 不写 service_commissions / 不查费率矩阵 / 不写 rate_missing，仍置 commission_status=已分配', async () => {
    const exec = makeExecutor({ remark: DEPOSIT_REFUND_REMARK, rate: '0.1' })

    await settleServiceCommissions(exec as unknown as Parameters<typeof settleServiceCommissions>[0], 'svc-deposit-refund', OPERATOR)

    // 循环体整体跳过：rate 查询、rate_missing 告警、提成 INSERT 均不发
    expect(sent(exec.calls, 'commission_rate_matrix')).toBe(false)
    expect(sent(exec.calls, 'INSERT INTO operation_logs')).toBe(false)
    expect(sent(exec.calls, 'INSERT INTO service_commissions')).toBe(false)
    // commission_status='已分配' 仍无条件置（与 staff/client 一致）
    expect(sent(exec.calls, "commission_status = '已分配'")).toBe(true)
  })

  it('正常消耗单（remark=null）→ 查费率矩阵 + 写 service_commissions + 置 commission_status=已分配', async () => {
    const exec = makeExecutor({ remark: null, rate: '0.1' })

    await settleServiceCommissions(exec as unknown as Parameters<typeof settleServiceCommissions>[0], 'svc-normal', OPERATOR)

    expect(sent(exec.calls, 'commission_rate_matrix')).toBe(true)
    expect(sent(exec.calls, 'INSERT INTO service_commissions')).toBe(true)
    expect(sent(exec.calls, "commission_status = '已分配'")).toBe(true)
  })

  // 回归守护（2026-09-04）：CAS 曾写成 `AND commission_status = '待分配'`，而建单初值是 NULL
  // （无 DB default，三端 INSERT 都不写），导致 admin 代确认永远 0 行、状态留 NULL —— staff 端
  // 列表渲染 "null"、保存报「服务单提成状态异常」，admin 服务提成导出两段双双漏单。
  it('commission_status CAS 必须放行 NULL 初值（IS NULL OR = 待分配）', async () => {
    const exec = makeExecutor({ remark: null, rate: '0.1' })

    await settleServiceCommissions(exec as unknown as Parameters<typeof settleServiceCommissions>[0], 'svc-null-status', OPERATOR)

    const casSql = exec.calls.map(textOf).find((t) => t.includes("commission_status = '已分配'")) ?? ''
    expect(casSql).toContain('commission_status IS NULL')
    expect(casSql).toContain("commission_status = '待分配'")
  })

  it('rate=0 且有消耗金额（正常单）→ 写 rate_missing 告警 + 仍写 service_commissions（rate=0 行）', async () => {
    const exec = makeExecutor({ remark: null, rate: '0' })

    await settleServiceCommissions(exec as unknown as Parameters<typeof settleServiceCommissions>[0], 'svc-rate-missing', OPERATOR)

    expect(sent(exec.calls, 'INSERT INTO operation_logs')).toBe(true)
    expect(sent(exec.calls, 'INSERT INTO service_commissions')).toBe(true)
  })
})

// #379 划卡单价阈值：单次实价 < 命中行 price_threshold → 按阈值 × 比例；选档仍用原始 consumeBase；手工费叠加
describe('settleServiceCommissions — #379 消耗提成阈值保底', () => {
  beforeEach(() => vi.clearAllMocks())

  async function settle(opts: Parameters<typeof makeExecutor>[0]) {
    const exec = makeExecutor(opts)
    await settleServiceCommissions(exec as unknown as Parameters<typeof settleServiceCommissions>[0], 'svc-379', OPERATOR)
    const rateSql = exec.calls.find((c) => textOf(c).includes('commission_rate_matrix')) as SqlObj
    const insert = exec.calls.find((c) => textOf(c).includes('INSERT INTO service_commissions')) as SqlObj
    // INSERT 值序：service_item_id, employee_id, role_type, rate, commission_amount, fixed_fee, consume_amount
    const [, , , , commissionAmount, fixedFee, consumeAmount] = insert.__vals
    return { tierBase: rateSql.__vals[2], commissionAmount, fixedFee, consumeAmount }
  }

  it.each([
    ['单价 80 < 阈值 → 100 × 2 次 × 15%', { unit_real_price: '80' }, '100.00', '0.15', 160, 30],
    ['赠送单价 NULL → 按阈值', { unit_real_price: null }, '100.00', '0.15', 0, 30],
    ['单价 ≥ 阈值 → 与改动前一致', { unit_real_price: '150' }, '100.00', '0.15', 300, 45],
    ['阈值 NULL（非自销行）→ 不保底', { unit_real_price: '80' }, null, '0.02', 160, 3.2],
  ] as const)('%s', async (_n, item, priceThreshold, rate, tierBase, consumeAmount) => {
    const r = await settle({ remark: null, rate, priceThreshold, item })
    expect(r.tierBase).toBe(tierBase)
    expect(r.consumeAmount).toBe(consumeAmount)
  })

  it('手工费叠加：fixed_fee 不受阈值影响', async () => {
    const r = await settle({ remark: null, rate: '0.15', priceThreshold: '100.00', item: { unit_real_price: '80', service_fee: '5' } })
    expect(r.fixedFee).toBe(10)
    expect(r.consumeAmount).toBe(30)
    expect(r.commissionAmount).toBe(40)
  })
})
