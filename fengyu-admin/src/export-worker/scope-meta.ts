import { db } from '@/db'
import { orgNodes, stores } from '@db/org'
import { eq, inArray } from 'drizzle-orm'
import { scopeMetaLabel } from '@/lib/data-center/scope-meta'
import type { DataCenterScope } from '@/lib/data-center/types'
import { isDataCenterActiveStore } from '@/lib/store-status'
import type { ExportContextMeta } from './export-meta'

/**
 * 仅在对应取数 action 成功（已完成权限/范围校验）后调用。
 * 多店短名与页面一致，完整所选名单另列；停用按组织节点，关店不等于停用。
 */
export async function scopeExportMeta(
  scope: DataCenterScope,
  name: string,
): Promise<Pick<ExportContextMeta, 'scope' | 'extra'>> {
  const label = scopeMetaLabel(scope, name)
  if (scope.type !== 'stores') return { scope: label }
  const rows = await db
    .select({ id: stores.storeId, name: stores.storeName, nodeType: orgNodes.type, isActive: orgNodes.isActive })
    .from(stores)
    .leftJoin(orgNodes, eq(stores.orgNodeId, orgNodes.id))
    .where(inArray(stores.storeId, scope.ids))
  const byId = new Map(rows.map(row => [row.id, row]))
  const selected = scope.ids.map(id => {
    const row = byId.get(id)
    // 完整范围是导出自证的前提，门店不存在/组织映射异常时不能编造名称或停用状态。
    if (!row || row.nodeType !== '门店' || row.isActive === null) {
      throw new Error('INVALID_STATE: 所选门店的组织信息不完整，请刷新后重试')
    }
    return { ...row, isActive: row.isActive }
  })
  const inactiveCount = selected.filter(row => !isDataCenterActiveStore({ isActive: row.isActive })).length
  return {
    scope: label,
    extra: [
      { label: '所选门店', value: selected.map(row => row.name).join('、') },
      ...(inactiveCount ? [{ label: '范围提示', value: `${inactiveCount} 家已停用未计入` }] : []),
    ],
  }
}
