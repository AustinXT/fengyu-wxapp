/**
 * 寄存单退款单不计入「消耗业绩」统计 — 两端过滤一致性守护
 *
 * 寄存单退款专用服务单（备注 = DEPOSIT_REFUND_REMARK）走正常服务单流程扣次数但非真实消耗，
 * 须从所有「消耗金额 / 项目数」聚合中剔除（实耗 / 生美实耗 / 项目数 / 门店榜·员工榜消耗&项目 /
 * 品类拆分实耗 / salesData 分客型实耗 / trafficSessions），但**不**剔除客流·到店·服务人次·
 * 保有会员·提成（寄存退款是真到店、假消耗）。参考 notes/memory/project_deposit_refund_remark。
 *
 * 守护对象（项目禁止跨端共享代码目录，各端独立副本）：
 *   - admin: src/lib/service-remark.ts（常量）+ src/lib/data-center/consume-filter.ts（Drizzle helper）
 *            + data-center/{sales,efficiency,customer}.ts（调用方）
 *   - staff 读端: cloudfunctions/staffApi/utils/consume-filter.js（常量 + helper）
 *            + routes/{mgmt-dashboard,mgmt-traffic}.js（调用方）
 *   - staff 写入端: miniprogram/packageService/service-create/service-create.ts（常量；真正落库
 *            service_orders.remark 的那一端，admin/staffApi 的 === DEPOSIT_REFUND_REMARK 拦截完全依赖此字面量）
 *   - clientApi: cloudfunctions/clientApi/utils/deposit-refund-remark.js（常量；M8 起 finalize 拦截
 *            寄存退款单提成写入用，字面量须与上三端一致）
 *
 * 守护策略（仿同目录 consistency.*.test.ts 源码字面量匹配）：
 *   1. 常量两端逐字节一致，且 == 期望契约字面量（防两端一起漂走）
 *   2. 两端 helper 均用 NULL 安全的 `remark IS DISTINCT FROM`
 *      （禁用裸 `!=` / `<>`：NULL 备注行会被误排除——绝大多数服务单备注为 NULL）
 *   3. 各调用方 helper 调用数 == 期望（强制「全量统一」，漏改一处即失败 →
 *      headline 与排名/拆分对不上的根因守卫）
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'

/** 数据契约：标准化备注（含半角空格 + em-dash「—」+ 全角逗号，逐字节锁定） */
const EXPECTED_REMARK = '寄存单退款专用 — 老系统寄存疗程卡退款核销，不计消耗业绩'

const A = (rel: string) => path.resolve(__dirname, rel)
const STAFF = (rel: string) =>
  path.resolve(__dirname, '../../../../../fengyu-staff/cloudfunctions/staffApi', rel)

const PATHS = {
  adminConst: A('../../../lib/service-remark.ts'),
  adminHelper: A('../../../lib/data-center/consume-filter.ts'),
  adminSales: A('../sales.ts'),
  adminEfficiency: A('../efficiency.ts'),
  adminCustomer: A('../customer.ts'),
  staffHelper: STAFF('utils/consume-filter.js'),
  staffDashboard: STAFF('routes/mgmt-dashboard.js'),
  staffTraffic: STAFF('routes/mgmt-traffic.js'),
  // 写入端第 3 份副本（miniprogram 落库 service_orders.remark 的字面量）。
  // 与 STAFF() 同根（fengyu-staff/），仅子路径不同，跨包 fs 读取在 vitest 已被前两份验证可行。
  staffWriteSide: A('../../../../../fengyu-staff/miniprogram/packageService/service-create/service-create.ts'),
  // 第 4 份副本（clientApi finalize 拦截用，M8）：跨包 fs 读取，与 staffWriteSide 同根层数。
  clientConst: A('../../../../../fengyu-client/cloudfunctions/clientApi/utils/deposit-refund-remark.js'),
}

/** 抽取 DEPOSIT_REFUND_REMARK 的单引号字面量值 */
function extractRemark(src: string): string | null {
  const m = src.match(/DEPOSIT_REFUND_REMARK\s*=\s*'([^']*)'/)
  return m ? m[1] : null
}

/** 统计 excludeDepositRefundSql('...') 调用次数（import/require 的解构不含左括号，自动排除） */
function countCalls(src: string): number {
  return (src.match(/excludeDepositRefundSql\('/g) || []).length
}

describe('寄存单退款单不计入消耗业绩 — 两端过滤一致性守护', () => {
  const src: Record<string, string> = {}

  beforeAll(() => {
    for (const [k, p] of Object.entries(PATHS)) src[k] = fs.readFileSync(p, 'utf-8')
  })

  describe('数据契约常量四端逐字节一致', () => {
    it('admin service-remark.ts 常量 == 期望契约字面量', () => {
      expect(extractRemark(src.adminConst)).toBe(EXPECTED_REMARK)
    })
    it('staff consume-filter.js 常量 == 期望契约字面量', () => {
      expect(extractRemark(src.staffHelper)).toBe(EXPECTED_REMARK)
    })
    it('staff 写入端 service-create.ts 常量 == 期望契约字面量（落库字面量守护）', () => {
      expect(extractRemark(src.staffWriteSide)).toBe(EXPECTED_REMARK)
    })
    it('clientApi deposit-refund-remark.js 常量 == 期望契约字面量（M8 finalize 拦截用）', () => {
      expect(extractRemark(src.clientConst)).toBe(EXPECTED_REMARK)
    })
    it('四端常量互等（防任意一端漂移到非期望值）', () => {
      const admin = extractRemark(src.adminConst)
      const staffRead = extractRemark(src.staffHelper)
      const staffWrite = extractRemark(src.staffWriteSide)
      const clientApi = extractRemark(src.clientConst)
      expect(admin).toBe(staffRead)
      expect(admin).toBe(staffWrite)
      expect(admin).toBe(clientApi)
      expect(staffRead).toBe(staffWrite)
      expect(staffRead).toBe(clientApi)
    })
  })

  describe('两端 helper 用 NULL 安全的 IS DISTINCT FROM', () => {
    it('admin consume-filter.ts 含 remark IS DISTINCT FROM', () => {
      expect(src.adminHelper).toMatch(/remark\s+IS\s+DISTINCT\s+FROM/i)
    })
    it('staff consume-filter.js 含 remark IS DISTINCT FROM', () => {
      expect(src.staffHelper).toMatch(/remark\s+IS\s+DISTINCT\s+FROM/i)
    })
    it('两端 helper 禁用裸 != / <> 比较 remark（NULL 备注行会被误排除）', () => {
      expect(src.adminHelper).not.toMatch(/remark\s*(!=|<>)/i)
      expect(src.staffHelper).not.toMatch(/remark\s*(!=|<>)/i)
    })
  })

  describe('调用方全量统一 — helper 调用数 == 期望（漏改一处即失败）', () => {
    // 消耗金额族 + 项目数族站点数（2026-06-24 精确清点，详见 memory）。
    // 改动消耗/项目聚合数量时必须同步更新此处期望值（强制 code review 意识到口径变更）。
    it('admin sales.ts = 4（实耗/生美实耗 × KPI+byStore）', () => {
      expect(countCalls(src.adminSales)).toBe(4)
    })
    it('admin efficiency.ts = 11（消耗 6 + 项目 5：KPI/byStore/门店榜/员工榜/品类拆分）', () => {
      expect(countCalls(src.adminEfficiency)).toBe(11)
    })
    it('admin customer.ts = 4（queryProjectCount/queryShengmeiConsume + proj_agg/sm_consume）', () => {
      expect(countCalls(src.adminCustomer)).toBe(4)
    })
    it('staff mgmt-dashboard.js = 9（消耗 6 + 项目 3：summary/salesData/门店榜/员工榜）', () => {
      expect(countCalls(src.staffDashboard)).toBe(9)
    })
    it('staff mgmt-traffic.js = 1（trafficSessions 项目数）', () => {
      expect(countCalls(src.staffTraffic)).toBe(1)
    })
  })

  describe('调用方正确引用各端 helper', () => {
    it('admin 三调用方 import @/lib/data-center/consume-filter', () => {
      for (const k of ['adminSales', 'adminEfficiency', 'adminCustomer']) {
        expect(src[k]).toMatch(/from\s+'@\/lib\/data-center\/consume-filter'/)
      }
    })
    it('staff 两调用方 require ../utils/consume-filter', () => {
      for (const k of ['staffDashboard', 'staffTraffic']) {
        expect(src[k]).toMatch(/require\('\.\.\/utils\/consume-filter'\)/)
      }
    })
  })
})
