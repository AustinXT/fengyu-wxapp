import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AuthSession } from '@/lib/types'
const state = vi.hoisted(() => {
  const url = process.env.DAILY_TEST_DATABASE_URL
  if (url) {
    const u = new URL(url)
    if (
      !['localhost', '127.0.0.1'].includes(u.hostname) ||
      u.pathname != '/test'
    )
      throw Error('Only localhost/test is allowed')
    process.env.E2E_DATABASE_URL = url
  }
  return { url, session: null as AuthSession | null }
})
vi.mock('@/lib/auth', () => ({ getSession: async () => state.session }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
import { query, today, workspace } from '@/lib/operating/workspace'
import {
  getOwnOperatingTarget,
  saveOwnOperatingTarget,
  getOperatingProgress,
} from './operating-targets'
import { expand } from '@/lib/operating/target-write'
import { series } from '@/lib/operating/operating-series'
import { count, weeklyTargets } from '@/lib/operating/operating-target'
describe.skipIf(!state.url)('Web五项目标真实PG与范围守卫', () => {
  it('同一目标被两端读取，金额锁定、计数补充和跨员工拒绝', async () => {
    const id = 'web5' + randomUUID().slice(0, 8),
      now = today(),
      date = (n: number) =>
        new Date(Date.parse(now + 'T12:00:00Z') + n * 86400000)
          .toISOString()
          .slice(0, 10)
    const weeks = [0, 1, 2, 3].map((i) => ({
      id: 'w' + (i + 1),
      name: '第' + (i + 1) + '周',
      start: date(i * 7),
      end: date(i * 7 + 6),
    }))
    state.session = {
      employeeId: id,
      name: '测试',
      phone: '',
      roles: [
        {
          role: 'admin',
          scopeType: '总部',
          scopeId: id,
          isSuperAdmin: true,
          actions: ['data_center:dashboard'],
        },
      ],
      permissions: {
        actions: ['data_center:dashboard'],
        scopeStoreIds: [],
        scopeOrgNodeIds: [],
      },
    }
    try {
      await query(
        'INSERT INTO staff_wechat_users(employee_id,name) VALUES($1,$2)',
        [id, '测试'],
      )
      await query(
        'INSERT INTO daily_operating_periods(id,name,start_date,end_date,weeks) VALUES($1,$1,$2,$3,$4::jsonb)',
        [id, now, date(27), JSON.stringify(weeks)],
      )
      const input = {
        kind: 'month' as const,
        periodId: id,
        periodVersion: 1,
        version: 0,
        scope: 'personal',
        scopeId: id,
        sales: '100.01',
        consumption: '200',
        visits: '8',
        newCustomers: '0',
        projects: '12',
        penalty: '复盘',
      }
      await saveOwnOperatingTarget(input)
      const result = await getOwnOperatingTarget({ periodId: id })
      expect(result.target.sales).toBe(10001)
      expect(result.target.newCustomers).toBe(0)
      expect(result.target.counts_month_confirmed).toBe(true)
      await expect(
        saveOwnOperatingTarget({ ...input, scopeId: 'other', version: 1 }),
      ).rejects.toThrow('PERMISSION_DENIED')
      await expect(
        saveOwnOperatingTarget({ ...input, version: 1 }),
      ).rejects.toThrow('不可修改')
      await saveOwnOperatingTarget({
        ...input,
        kind: 'week',
        version: 1,
        sales: '25',
        consumption: '30',
        visits: '2',
        projects: '3',
      })
      expect(
        (await getOwnOperatingTarget({ periodId: id })).target.weeks.w1.visits,
      ).toBe(2)
      await query(
        "INSERT INTO org_nodes(id,name,type) VALUES($1,'测试总部','总部')",
        [id + 'hq'],
      )
      await query(
        "INSERT INTO org_nodes(id,name,type,parent_id) VALUES($1,'测试市场','市场',$2)",
        [id + 'market', id + 'hq'],
      )
      await query(
        "INSERT INTO org_nodes(id,name,type,parent_id) VALUES($1,'测试店','门店',$2)",
        [id + 'node', id + 'market'],
      )
      await query(
        'INSERT INTO stores(store_id,store_name,org_node_id) VALUES($1,$2,$3)',
        [id, '测试店', id + 'node'],
      )
      await query(
        'INSERT INTO client_wechat_users(user_id,name) VALUES($1,$2)',
        [id, '测试顾客'],
      )
      await query(
        "INSERT INTO service_orders(service_order_id,status,market_name,store_id,service_date,client_user_id,assigned_employee_id) VALUES($1,'已完成','测试市场',$1,$2,$1,$1)",
        [id, now],
      )
      const actual = await series(query, {
        storeIds: [id],
        employeeIds: [],
        start: now,
        end: now,
      })
      expect(actual[0].visits).toBe(1)
      expect(actual[0].newCustomers).toBe(1)
      expect(actual[0].date).toBe(now)
      const empty = await series(query, {
        storeIds: [],
        employeeIds: [],
        start: now,
        end: now,
      })
      expect(empty).toEqual([])
      state.session = {
        ...state.session,
        roles: [
          {
            role: 'manager',
            scopeId: 'none',
            scopeType: '门店',
            actions: ['data_center:dashboard'],
          },
        ],
        permissions: { actions: ['data_center:dashboard'], scopeStoreIds: [] },
      }
      await expect(
        getOperatingProgress({ periodId: id, storeId: 'outside' }),
      ).rejects.toThrow('PERMISSION_DENIED')
      await expect(
        workspace(state.session, { periodId: id, regionId: 'outside' }),
      ).rejects.toThrow('PERMISSION_DENIED')
    } finally {
      await query('DELETE FROM service_orders WHERE service_order_id=$1', [id])
      await query('DELETE FROM client_wechat_users WHERE user_id=$1', [id])
      await query('DELETE FROM inventory_locations WHERE store_id=$1', [id])
      await query('DELETE FROM stores WHERE store_id=$1', [id])
      await query('DELETE FROM inventory_locations WHERE org_node_id=$1', [
        id + 'market',
      ])
      for (const suffix of ['node', 'market', 'hq']) {
        await query('DELETE FROM inventory_locations WHERE org_node_id=$1', [
          id + suffix,
        ])
        await query('DELETE FROM org_nodes WHERE id=$1', [id + suffix])
      }
      await query('DELETE FROM operation_logs WHERE target_id LIKE $1', [
        id + '%',
      ])
      await query('DELETE FROM daily_operating_targets WHERE period_id=$1', [
        id,
      ])
      await query('DELETE FROM daily_operating_periods WHERE id=$1', [id])
      await query('DELETE FROM staff_wechat_users WHERE employee_id=$1', [id])
    }
  })
})
describe('整数与旧目标展开', () => {
  it('零目标与未设置分开、第四周精确余额', () => {
    expect(count('0')).toBe(0)
    expect(() => count('1.5')).toThrow()
    expect(weeklyTargets(0, [0, 0, 0], true)).toEqual([0, 0, 0, 0])
    expect(
      expand(
        { sales: 100, consumption: 200, weeks: {} },
        { weeks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] },
      ).weeks.d.visits,
    ).toBe(null)
  })
})
