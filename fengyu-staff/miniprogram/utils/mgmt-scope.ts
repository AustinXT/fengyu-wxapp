// utils/mgmt-scope.ts — 管理层看板 scope 的「已停用门店」处理（#400，口径与文案对齐 admin #293）
//
// 「在营」只看门店组织节点 org_nodes.is_active（云函数判定，见 staffApi utils/store-active.js）。
// 首页 summary 与销售数据 salesData 的取数 SQL 会滤掉停用门店的全部数据（满屏 0，与「在营门店
// 本期无业绩」分不开）→ 以接口下发的 scope.inactive 为准出空态；在营门店无业绩照常显示 0。
//
// ⚠️ 客量 / 品项 / 顾客子页的接口不叠加启停过滤，停用门店的历史数据照常可查 —— 这三页不出空态，
// 只在范围标签上标「（已停用）」，标记经 hub 的 query（scopeInactive=1）继承。

/** 子页 query 里的停用标记键 */
export const SCOPE_INACTIVE_QUERY_KEY = 'scopeInactive'

/** 空态主文案（与 admin ScopeEmptyState 同句） */
export function inactiveScopeText(storeName: string): string {
  return `「${storeName || '该门店'}」已停用，无可展示数据`
}

/** 空态第二行：后端判定账号还有没有别的在营门店可切；未知（null / 旧云函数）不出第二行 */
export function inactiveScopeHint(hasActiveAlternative: boolean | null | undefined): string {
  if (hasActiveAlternative === true) return '请点击上方范围切换到在营门店'
  if (hasActiveAlternative === false) return '当前账号没有其它在营门店可查看'
  return ''
}

/** 子页 query 是否带停用标记（仅用于范围标签展示） */
export function isInactiveScopeQuery(query: Record<string, string | undefined> | undefined): boolean {
  return query?.[SCOPE_INACTIVE_QUERY_KEY] === '1'
}
