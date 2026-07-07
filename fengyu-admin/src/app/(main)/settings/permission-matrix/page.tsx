import { getMatrix } from '@/actions/permission-matrix'
import { DEFAULT_PERMISSION_MATRIX } from '@/lib/permissions'
import PermissionMatrixPage from './_components/permission-matrix-page'
import type { RoleType } from '@/lib/types'

export const dynamic = 'force-dynamic'


function flattenAllActions(): string[] {
  const set = new Set<string>()
  for (const role of Object.keys(DEFAULT_PERMISSION_MATRIX) as RoleType[]) {
    for (const a of DEFAULT_PERMISSION_MATRIX[role]) set.add(a)
  }
  return Array.from(set).sort()
}

export default async function Page() {
  
  
  const matrix = await getMatrix()
  const allActions = flattenAllActions()
  return <PermissionMatrixPage initialMatrix={matrix} allActions={allActions} />
}
