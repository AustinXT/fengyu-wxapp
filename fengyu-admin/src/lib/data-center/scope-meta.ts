import type { DataCenterScope } from './types'

/** 导出范围文案单源（#296）：仅使用 action 已解析的名称。 */
export function scopeMetaLabel(scope: Pick<DataCenterScope, 'type'>, name: string): string {
  if (scope.type === 'market') return `市场 · ${name}`
  if (scope.type === 'store' || scope.type === 'stores') return `门店 · ${name}`
  return name
}
