'use server'
import { db } from '@/db'
import { withPermission } from '@/lib/with-permission'
import {
  workspace,
  query,
  queryWith,
  resolve,
  type Filters,
} from '@/lib/operating/workspace'
import { expand, writeTarget } from '@/lib/operating/target-write'
import { logOperation } from '@/lib/operation-log'
import { revalidatePath } from 'next/cache'

export const getOperatingProgress = withPermission(
  'data_center:dashboard',
  async (session, filters: Filters = {}) => workspace(session, filters),
)
export const getOperatingPk = withPermission(
  'data_center:dashboard',
  async (session, filters: Filters = {}) => workspace(session, filters, true),
)
export const getOwnOperatingTarget = withPermission(
  'data_center:dashboard',
  async (
    session,
    input: { periodId?: string; scope?: string; scopeId?: string } = {},
  ) => {
    const data = await workspace(
      session,
      { periodId: input.periodId },
      false,
      true,
    )
    const scope = data.ownScopes.find(
      (s) =>
        s.scope === (input.scope || 'personal') &&
        s.scopeId === (input.scopeId || session.employeeId),
    )
    if (!scope) throw Error('PERMISSION_DENIED: 只能填写本人或本人管理范围目标')
    const resolved = await resolve(query, { periodId: input.periodId })
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
      version: number
      periodVersion: number
      sales: string
      consumption: string
      visits: string
      newCustomers: string
      projects: string
      penalty: string
    },
  ) => {
    if (!['month', 'week'].includes(input.kind))
      throw Error('INVALID_PARAMS: 无效目标操作')
    const { ownScopes } = await workspace(
      session,
      { periodId: input.periodId },
      false,
      true,
    )
    const result = await db.transaction(async (tx) => {
      const transact = async (fn: (q: typeof query) => Promise<any>) =>
        fn(queryWith(tx))
      const data = await writeTarget(
        transact,
        ownScopes,
        input,
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
          periodId: input.periodId,
          kind: input.kind,
          version: data.target.version,
        },
        tx,
      )
      return data
    })
    revalidatePath('/data-center/operating-targets')
    return result
  },
)
