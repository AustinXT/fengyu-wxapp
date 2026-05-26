import { getMatrix } from '@/actions/permission-matrix'
import { DEFAULT_PERMISSION_MATRIX } from '@/lib/permissions'
import PermissionMatrixPage from './_components/permission-matrix-page'
import type { RoleType } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * ALL_ACTIONS：从 DEFAULT_PERMISSION_MATRIX flatten 出全部已知 action key，去重排序。
 * 矩阵编辑表格的行数 == ALL_ACTIONS.length，避免 DB 矩阵漂移导致行缺失。
 */
function flattenAllActions(): string[] {
  const set = new Set<string>()
  for (const role of Object.keys(DEFAULT_PERMISSION_MATRIX) as RoleType[]) {
    for (const a of DEFAULT_PERMISSION_MATRIX[role]) set.add(a)
  }
  return Array.from(set).sort()
}

export default async function Page() {
  // withPermission('system:config') 内部已 requirePermission，
  // 无权访问将被 throw / redirect，不需要在此重复鉴权。
  const matrix = await getMatrix()
  const allActions = flattenAllActions()
  return <PermissionMatrixPage initialMatrix={matrix} allActions={allActions} />
}
