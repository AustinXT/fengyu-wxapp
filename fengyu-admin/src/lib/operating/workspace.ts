import { db } from '@/db'
import { sql } from 'drizzle-orm'
import { dailyPeriodInput } from '@/lib/daily-config'
import { isAdminScope } from '@/lib/session-role-guards'
import type { AuthSession } from '@/lib/types'
import { directory, participantObjects } from './operating-objects'
import { series, marketNewCustomers } from './operating-series'
import { buildRows } from './operating-rows'
import { expand } from './target-write'
export const today = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
export const metrics = [
  'sales',
  'consumption',
  'visits',
  'newCustomers',
  'projects',
] as const
export type Metric = (typeof metrics)[number]
export type Query = (text: string, args?: unknown[]) => Promise<any[]>
export function queryWith(executor: { execute: typeof db.execute }): Query {
  return async (text, args = []) => {
    const parts = text
      .split(/(\$\d+)/g)
      .filter(Boolean)
      .map((part) => {
        if (!/^\$\d+$/.test(part)) return sql.raw(part)
        const value = args[Number(part.slice(1)) - 1]
        const bound = Array.isArray(value)
          ? '{' + value.map((v) => JSON.stringify(String(v))).join(',') + '}'
          : value
        return sql`${bound}`
      })
    return Array.from(await executor.execute(sql.join(parts, sql.raw('')))).map(
      (row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            [
              'sales',
              'consumption',
              'visits',
              'new_customers',
              'newCustomers',
              'projects',
            ].includes(key) && typeof value === 'string'
              ? Number(value)
              : value,
          ]),
        ),
    )
  }
}
export const query = queryWith(db)
export async function resolve(
  query: Query,
  payload: { periodId?: string; date?: string } = {},
) {
  const date = payload.date || today()
  const rows = payload.periodId
    ? await query('SELECT * FROM daily_operating_periods WHERE id=$1', [
        payload.periodId,
      ])
    : await query(
        'SELECT * FROM daily_operating_periods WHERE start_date<=$1 AND end_date>=$1',
        [date],
      )
  if (rows.length > 1) throw Error('INVALID_STATE: 经营周期配置重叠')
  const row = rows[0]
  const period = row
    ? dailyPeriodInput.parse({
        id: row.id,
        name: row.name,
        start: row.start_date,
        end: row.end_date,
        weeks: row.weeks,
        version: row.version,
      })
    : null
  return {
    date,
    period,
    week: period?.weeks.find((w) => w.start <= date && date <= w.end) || null,
  }
}
export interface Filters {
  periodId?: string
  regionId?: string
  storeId?: string
  employeeId?: string
  classId?: string
  weekId?: string
  dimension?: 'personal' | 'store' | 'market'
  metric?: Metric
}
export interface Value {
  monthTarget: number | null
  monthDone: number
  weekTarget: number | null
  weekDone: number
  days: { date: string; done: number }[]
  weeks: { id: string; done: number }[]
}
export interface OperatingRow {
  employeeId?: string
  name: string
  position?: string
  scope: string
  scopeId: string
  scopeName: string
  storeName?: string
  storeId?: string
  marketId?: string
  area?: string
  classId?: string
  legion?: string
  mentor?: string
  values: Record<Metric, Value>
}
export async function workspace(
  session: AuthSession,
  filters: Filters = {},
  pk = false,
  metadataOnly = false,
) {
  const { period, week } = await resolve(query, filters)
  const periods = await query(
    'SELECT id,name FROM daily_operating_periods ORDER BY start_date DESC',
  )
  const all = await query('SELECT store_id FROM stores')
  const allowed =
    isAdminScope(session) || session.roles.some((r) => r.scopeType === '总部')
      ? all.map((s) => s.store_id)
      : session.permissions.scopeStoreIds
  const dir = await directory(query, allowed)
  if (!dir.people.some((p: any) => p.employeeId === session.employeeId)) {
    const own = await query(
      'SELECT employee_id AS "employeeId",name,store_id AS "storeId",position_name AS position FROM staff_wechat_users WHERE employee_id=$1 AND store_id IS NULL AND NOT is_resigned',
      [session.employeeId],
    )
    dir.people.push(...own)
  }
  const regions = [
    ...new Set<string>(dir.stores.map((s: any) => s.market_id).filter(Boolean)),
  ].map((id: string) => ({
    id,
    name: dir.stores.find((s: any) => s.market_id === id)?.area || id,
  }))
  if (
    filters.regionId === undefined &&
    !isAdminScope(session) &&
    !session.roles.some((r) => r.scopeType === '总部')
  )
    filters = { ...filters, regionId: regions[0]?.id }
  if (
    filters.regionId &&
    !dir.stores.some((s: any) => s.market_id === filters.regionId)
  )
    throw Error('PERMISSION_DENIED: 无此区域查看权限')
  if (filters.storeId && !allowed.includes(filters.storeId))
    throw Error('PERMISSION_DENIED: 无此门店查看权限')
  const selectedStores = dir.stores.filter(
    (s: any) =>
      (!filters.regionId || s.market_id === filters.regionId) &&
      (!filters.storeId || s.id === filters.storeId),
  )
  const ownScopes = [
    { scope: 'personal', scopeId: session.employeeId, name: '我的目标' },
  ]
  for (const role of session.roles) {
    if (role.isStoreManager)
      for (const store of dir.stores.filter(
        (s: any) =>
          role.scopeStoreIds?.includes(s.id) || role.scopeId === s.org_node_id,
      ))
        if (
          !ownScopes.some((o) => o.scope === 'store' && o.scopeId === store.id)
        )
          ownScopes.push({
            scope: 'store',
            scopeId: store.id,
            name: store.name,
          })
    if (
      role.scopeType === '市场' &&
      dir.fullMarkets.includes(role.scopeId) &&
      !ownScopes.some((o) => o.scope === 'market' && o.scopeId === role.scopeId)
    )
      ownScopes.push({
        scope: 'market',
        scopeId: role.scopeId,
        name:
          regions.find((r: any) => r.id === role.scopeId)?.name || role.scopeId,
      })
  }
  const empty = {
    canConfigure:
      isAdminScope(session) &&
      session.permissions.actions.includes('system:config'),
    filters,
    periods,
    period,
    week,
    regions,
    stores: dir.stores,
    classes: [] as any[],
    ownScopes,
    rows: [] as OperatingRow[],
  }
  if (!period || metadataOnly) return empty
  const classes = await query(
    'SELECT DISTINCT c.id,c.name FROM daily_pk_classes c JOIN daily_pk_stores ps ON ps.class_id=c.id AND ps.period_id=c.period_id WHERE c.period_id=$1 AND ps.store_id=ANY($2::text[]) ORDER BY c.name',
    [period.id, selectedStores.map((s: any) => s.id)],
  )
  if (filters.classId && !classes.some((c) => c.id === filters.classId))
    throw Error('PERMISSION_DENIED: 无此班级查看权限')
  const assignments = await query(
    'SELECT * FROM daily_pk_stores WHERE period_id=$1 AND store_id=ANY($2::text[]) ORDER BY store_id',
    [period.id, selectedStores.map((s: any) => s.id)],
  )
  let objects: any[]
  const selectedDir = {
    ...dir,
    fullMarkets: dir.fullMarkets.filter((id: string) =>
      dir.stores
        .filter((s: any) => s.market_id === id)
        .every((s: any) => selectedStores.some((v: any) => v.id === s.id)),
    ),
    stores: selectedStores,
    people: dir.people.filter(
      (p: any) =>
        selectedStores.some(
          (s: any) => s.id === p.storeId || (!p.storeId && dir.fullMarkets.includes(p.market_id) && s.market_id === p.market_id),
        ) ||
        (!p.storeId &&
          p.employeeId === session.employeeId &&
          !filters.regionId &&
          !filters.storeId),
    ),
  }
  if (pk)
    objects = participantObjects(selectedDir, assignments).filter(
      (p: any) => !filters.classId || p.classId === filters.classId,
    )
  else if (filters.dimension === 'store')
    objects = selectedStores.map((s: any) => ({
      scope: 'store',
      scopeId: s.id,
      name: s.name,
      scopeName: s.name,
      storeId: s.id,
      marketId: s.market_id,
      area: s.area,
    }))
  else if (filters.dimension === 'market') {
    if (filters.storeId) throw Error('INVALID_PARAMS: 区域统计不能仅选单店')
    objects = regions
      .filter(
        (r: any) =>
          dir.fullMarkets.includes(r.id) &&
          (!filters.regionId || r.id === filters.regionId),
      )
      .map((r: any) => ({
        scope: 'market',
        scopeId: r.id,
        name: r.name,
        scopeName: r.name,
        marketId: r.id,
        area: r.name,
      }))
  } else
    objects = selectedDir.people.map((p: any) => ({
      scope: 'personal',
      scopeId: p.employeeId,
      employeeId: p.employeeId,
      name: p.name,
      scopeName: p.name,
      position: p.position,
      storeId: p.storeId,
      storeName:
        selectedStores.find((s: any) => s.id === p.storeId)?.name ||
        '未分配门店',
      marketId: selectedStores.find((s: any) => s.id === p.storeId)?.market_id,
      area: selectedStores.find((s: any) => s.id === p.storeId)?.area,
    }))
  if (filters.employeeId) {
    if (!objects.some((o) => o.employeeId === filters.employeeId))
      throw Error('PERMISSION_DENIED: 无此员工查看权限')
    objects = objects.filter((o) => o.employeeId === filters.employeeId)
  }
  const cutoff = today() < period.end ? today() : period.end
  const ids = selectedStores.map((s: any) => s.id)
  const [events, targets, first] = await Promise.all([
    series(query, {
      storeIds: ids,
      employeeIds: objects.map((o) => o.employeeId).filter(Boolean),
      start: period.start,
      end: cutoff,
    }),
    query('SELECT * FROM daily_operating_targets WHERE period_id=$1', [
      period.id,
    ]),
    marketNewCustomers(query, ids, period.start, cutoff),
  ])
  for (const region of regions) {
    const inRegion = (id: string) =>
      selectedStores.some((s: any) => s.id === id && s.market_id === region.id)
    for (const date of new Set(
      events
        .filter((e: any) => e.scope === 'store' && inRegion(e.id))
        .map((e: any) => e.date),
    )) {
      const rows = events.filter(
        (e: any) => e.scope === 'store' && e.date === date && inRegion(e.id),
      )
      events.push({
        scope: 'market',
        id: region.id,
        date,
        ...Object.fromEntries(
          metrics.map((k) => [
            k,
            k === 'newCustomers'
              ? new Set(
                  first
                    .filter((r: any) => r.date === date && inRegion(r.store_id))
                    .map((r: any) => r.client_user_id),
                ).size
              : rows.reduce((n: number, r: any) => n + Number(r[k] || 0), 0),
          ]),
        ),
      })
    }
  }
  const active = filters.weekId
    ? period.weeks.find((w) => w.id === filters.weekId)
    : week || (today() < period.start ? period.weeks[0] : period.weeks[3])
  if (filters.weekId && !active) throw Error('INVALID_PARAMS: 无效经营周')
  return {
    ...empty,
    classes,
    week: active || null,
    rows: buildRows(
      objects,
      events,
      targets,
      period,
      active,
      cutoff,
      expand,
    ) as OperatingRow[],
  }
}
