/**
 * #292：客量板与品项板的会员门槛同源（system_configs.new_member_threshold → getMemberThreshold）。
 *
 * 改配置值后，两个板块发出的 SQL 必须**同时**带上新门槛：
 *   - 客量板：会员经营人数 KPI（spend >= 门槛）+ 明细 6 档分桶的最低档下界 + operated_total
 *   - 品项板：进入 / 复购达标（>= threshold）
 * 且客量板 SQL 文本里不得再出现写死的 1990。
 *
 * 取数不连库：mock @/db 捕获 sql 对象，用 PgDialect 渲染成真实 SQL + 参数再断言。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

const thresholdState = { value: 1990 }

vi.mock('@/lib/member-threshold', () => ({
  getMemberThreshold: vi.fn(async () => thresholdState.value),
}))

/** 渲染前的粗文本，只用于路由 mock 返回形状（明细/骨架类返回空集，标量类返回 0 行） */
function roughText(q: unknown): string {
  const chunks = (q as { queryChunks?: Array<{ value?: unknown }> })?.queryChunks ?? []
  return chunks
    .map((c) => {
      const v = c?.value
      if (Array.isArray(v)) return v.join(' ')
      return typeof v === 'string' ? v : ''
    })
    .join(' ')
}

vi.mock('@/db', () => ({
  db: {
    execute: vi.fn(async (q: unknown) => {
      const t = roughText(q)
      if (/WITH skel|o_store|DISTINCT pc\.product_kind|store_ids|GROUP BY so\.store_id|GROUP BY c\.bound_store_id/.test(t)) {
        return []
      }
      return [{ v: 0, count: 0, revenue: 0, total_count: 0, total_spend: 0 }]
    }),
  },
}))

const fakeSession = {
  employeeId: 'e1',
  name: '测试',
  phone: '13900000000',
  roles: [{ role: 'admin', scopeType: '总部' }],
  permissions: { actions: ['data_center:dashboard'], scopeStoreIds: [] as string[] },
} as unknown
vi.mock('@/lib/auth', () => ({ getSession: vi.fn(async () => fakeSession) }))
vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAnyPermission: vi.fn(),
  isAdminScope: () => true,
}))
vi.mock('@/lib/data-center/context', () => ({
  prepareBoardContext: vi.fn(async () => ({
    scope: { type: 'all' as const },
    meta: {
      scope: { type: 'all' as const, id: null, name: '全部' },
      timeRange: { start: '2026-09-01', end: '2026-09-24', presetLabel: '本月' },
    },
    comparison: { current: { start: '2026-09-01', end: '2026-09-24' }, previous: null, lastYear: null },
    enabled: false,
  })),
}))

import { db } from '@/db'
import { getCustomerBoard } from '../customer'
import { getProductBoard } from '../product'

const dialect = new PgDialect()
const PARAMS = { scope: { type: 'all' as const }, timeRange: { preset: 'month' as const }, withComparison: false }

async function renderedQueries(board: 'customer' | 'product'): Promise<Array<{ sql: string; params: unknown[] }>> {
  const exec = db.execute as unknown as { mock: { calls: unknown[][] }; mockClear: () => void }
  exec.mockClear()
  if (board === 'customer') await getCustomerBoard(PARAMS)
  else await getProductBoard(PARAMS)
  return exec.mock.calls.map((c) => dialect.sqlToQuery(c[0] as SQL))
}

/** 客量板里用到门槛的查询：会员经营人数 KPI + 明细分桶（按 SQL 形态识别） */
function customerThresholdQueries(qs: Array<{ sql: string; params: unknown[] }>) {
  const operated = qs.filter((q) => /FILTER \(WHERE spend >= \$\d+\) AS v\b/.test(q.sql))
  const buckets = qs.filter((q) => /AS bucket_d\b/.test(q.sql))
  return { operated, buckets }
}

describe('会员门槛：客量板与品项板同源（#292）', () => {
  beforeEach(() => {
    thresholdState.value = 1990
  })

  // 1980 = 真实 FALLBACK/DEFAULT、1990.5 = 小数：挡住「Math.max(门槛, 1990)」这类只在 ≥1990 时不显形的钳制（pr-ready P2）
  for (const th of [1980, 1990, 1990.5, 2990]) {
    it(`门槛 = ${th} 时，两个板块的 SQL 参数都带上 ${th}`, async () => {
      thresholdState.value = th

      const customer = await renderedQueries('customer')
      const { operated, buckets } = customerThresholdQueries(customer)
      expect(operated).toHaveLength(1)
      expect(buckets).toHaveLength(2) // byMarket + byStore
      for (const q of [...operated, ...buckets]) {
        expect(q.params).toContain(th)
        // 客量板 SQL 文本不再写死门槛
        expect(q.sql).not.toMatch(/(?<!\d)1990(?!\d)/)
      }
      // 分桶最低档：spend < 门槛 与 [门槛, 1w) 用的是同一个参数值
      for (const q of buckets) {
        const lt = q.sql.match(/spend < \$(\d+)\) AS bucket_d/)
        const ge = q.sql.match(/spend >= \$(\d+) AND spend < \$\d+\) AS bucket_c/)
        const op = q.sql.match(/spend >= \$(\d+)\) AS operated_total/)
        expect(lt && ge && op).toBeTruthy()
        for (const m of [lt!, ge!, op!]) expect(q.params[Number(m[1]) - 1]).toBe(th)
      }

      // 品项板：「新会员 / 进入」达标 day_received >= 门槛、复购 purchase_received >= 门槛。
      // 逐个谓词核对参数值 —— 只看「某个参数含门槛」的话，把 day_received 改回写死 1990 也会全绿（codex r1 P1）
      const product = await renderedQueries('product')
      for (const col of ['day_received', 'purchase_received']) {
        const withCol = product.filter((q) => q.sql.includes(`${col} >=`))
        // 标量 cycle（WITH daily_agg … cohort）与按店 cycle（store_ids）两个函数都要命中
        expect(withCol.some((q) => /cohort/.test(q.sql)), `${col}：标量 cycle 查询未命中`).toBe(true)
        expect(withCol.some((q) => /store_ids/.test(q.sql)), `${col}：按店 cycle 查询未命中`).toBe(true)
        for (const q of withCol) {
          const hits = [...q.sql.matchAll(new RegExp(`${col} >= (\\$\\d+|[^\\s]+)`, 'g'))]
          expect(hits.length).toBeGreaterThan(0)
          for (const h of hits) {
            expect(h[1], `${col} >= ${h[1]} 不是参数占位（写死了门槛？）`).toMatch(/^\$\d+$/)
            expect(q.params[Number(h[1].slice(1)) - 1]).toBe(th)
          }
        }
      }
    })
  }

  it('分桶固定档位取 SPEND_BUCKET_FLOORS（1w/3w/6w/10w），不随门槛变', async () => {
    thresholdState.value = 2990
    const { buckets } = customerThresholdQueries(await renderedQueries('customer'))
    for (const q of buckets) {
      const pairs = [...q.sql.matchAll(/spend >= \$(\d+) AND spend < \$(\d+)\) AS (bucket_\w+)/g)].map((m) => [
        m[3],
        q.params[Number(m[1]) - 1],
        q.params[Number(m[2]) - 1],
      ])
      expect(pairs).toEqual([
        ['bucket_c', 2990, 10000],
        ['bucket_b', 10000, 30000],
        ['bucket_a', 30000, 60000],
        ['bucket_v', 60000, 100000],
      ])
      const top = q.sql.match(/spend >= \$(\d+)\) AS bucket_vic/)
      expect(q.params[Number(top![1]) - 1]).toBe(100000)
    }
  })
})
