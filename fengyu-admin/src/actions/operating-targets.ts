'use server'
import { db } from '@/db'
import { withPermission } from '@/lib/with-permission'
import {
  workspace,
  query,
  queryWith,
  today,
  type Filters,
} from '@/lib/operating/workspace'
import { expand, writeTarget } from '@/lib/operating/target-write'
import { logOperation } from '@/lib/operation-log'
import { revalidatePath } from 'next/cache'
import { isAdminScope } from '@/lib/session-role-guards'

export const getOperatingProgress = withPermission(
  'data_center:dashboard',
  async (session, filters: Filters = {}) => workspace(session, filters),
)
export const getBeautyOperatingProgress = withPermission(
  'data_center:dashboard',
  async (session, filters: Filters = {}) => {
    const data = await workspace(session, { ...filters, dimension: 'personal' })
    return { ...data, rows: data.rows.filter((row) => row.position?.includes('美容师')) }
  },
)
export const getOperatingPk = withPermission(
  'data_center:dashboard',
  async (session, filters: Filters = {}) => workspace(session, filters, true),
)
export const getOwnOperatingTarget = withPermission(
  'data_center:dashboard',
  async (
    session,
    input: { periodId?: string; scope?: string; scopeId?: string; regionId?: string | null } = {},
  ) => {
    const date = today()
    const metadata = await workspace(session, { periodId: input.periodId, regionId: input.regionId || undefined }, false, true)
    // 管理员可填写多个组织对象，初次进入时要求明确选择，避免把授权列表首项误当作默认对象。
    if (!input.scope && isAdminScope(session))
      return {
        date,
        period: metadata.period,
        week: metadata.week,
        periods: metadata.periods,
        scopes: metadata.ownScopes,
        scope: null,
        target: null,
      }
    const [employee] = await query(
      'SELECT store_id AS "storeId" FROM staff_wechat_users WHERE employee_id=$1 AND NOT is_resigned',
      [session.employeeId],
    )
    const defaultScope =
      metadata.ownScopes.find(
        (s) => s.scope === 'personal' && s.scopeId === session.employeeId,
      ) ||
      metadata.ownScopes.find(
        (s) => s.scope === 'store' && s.scopeId === employee?.storeId,
      ) ||
      metadata.ownScopes.find((s) => s.scope === 'store') ||
      metadata.ownScopes[0]
    const scope = input.scope
      ? metadata.ownScopes.find(
          (s) =>
            s.scope === input.scope &&
            s.scopeId === (input.scopeId || session.employeeId),
        )
      : defaultScope
    if (!scope) throw Error('PERMISSION_DENIED: 只能填写本人或本人管理范围目标')
    const data = await workspace(session, { periodId: input.periodId, regionId: input.regionId || scope.regionId || undefined, storeId: scope.storeId }, false, true)
    const resolved = { date, period: data.period, week: data.week }
    const rows = resolved.period
      ? await query(
          'SELECT * FROM daily_operating_targets WHERE period_id=$1 AND scope=$2 AND scope_id=$3',
          [resolved.period.id, scope.scope, scope.scopeId],
        )
      : []
    return {
      ...resolved,
      periods: data.periods,
      scopes: data.ownScopes,
      scope,
      target: resolved.period ? expand(rows[0], resolved.period) : null,
    }
  },
)
export const saveOwnOperatingTarget = withPermission(
  'data_center:dashboard',
  async (
    session,
    input: {
      kind: 'month' | 'week'
      periodId: string
      scope: string
      scopeId: string
      regionId?: string | null
      version: number
      periodVersion: number
      sales: string
      consumption: string
      visits: string
      newCustomers: string
      projects: string
      penalty: string
      weekPlan?: Record<string, Record<string, string>>
    },
  ) => {
    if (!['month', 'week'].includes(input.kind))
      throw Error('INVALID_PARAMS: 无效目标操作')
    const { ownScopes } = await workspace(
      session,
      { periodId: input.periodId, regionId: input.regionId || undefined },
      false,
      true,
    )
    const result = await db.transaction(async (tx) => {
      const transact = async (fn: (q: typeof query) => Promise<any>) =>
        fn(queryWith(tx))
      const targetScope = ownScopes.find((s) => s.scope === input.scope && s.scopeId === input.scopeId)
      if (!targetScope) throw Error('PERMISSION_DENIED: 无此目标填写权限')
      const data = await writeTarget(
        transact,
        ownScopes,
        { ...input, regionId: input.regionId || targetScope.regionId, storeId: targetScope.storeId },
        input.kind === 'month',
      )
      await logOperation(
        session,
        'daily.target.' + input.kind,
        'daily_operating_targets',
        `${input.periodId}:${input.scope}:${input.scopeId}`,
        {
          scope: input.scope,
          scopeId: input.scopeId,
          operatorEmployeeId: session.employeeId,
          targetEmployeeId: input.scope === 'personal' ? input.scopeId : null,
          delegated: input.scope === 'personal' ? input.scopeId !== session.employeeId : targetScope.delegated === true,
          periodId: input.periodId,
          kind: input.kind,
          version: data.target.version,
          values: data.target ? {
            sales: data.target.sales,
            consumption: data.target.consumption,
            visits: data.target.visits,
            newCustomers: data.target.newCustomers,
            projects: data.target.projects,
            penalty: data.target.penalty,
            weeks: data.target.weeks,
          } : null,
        },
        tx,
      )
      return data
    })
    revalidatePath('/data-center/operating-targets')
    return result
  },
)
