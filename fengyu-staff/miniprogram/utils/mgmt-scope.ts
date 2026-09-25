// utils/mgmt-scope.ts — 管理层看板 scope 的「已停用门店」空态（#400，口径与文案对齐 admin #293）
//
// 「在营」只看门店组织节点 org_nodes.is_active（云函数判定，见 staffApi utils/store-active.js）。
// 取数 SQL 会滤掉停用门店的全部数据，照常取数只会满屏 0，与「在营门店本期无业绩」分不开；
// 所以 scope 落在停用门店时整段出空态，在营门店无业绩仍照常显示 0。
//
// hub（mgmt-dashboard）→ 子页（客量 / 销售 / 品项 / 顾客）经 query 继承 scope，
// 停用标记同样走 query：`scopeInactive=1`。

/** 子页 query 里的停用标记键 */
export const SCOPE_INACTIVE_QUERY_KEY = 'scopeInactive'

/** 空态主文案（与 admin ScopeEmptyState 同句） */
export function inactiveScopeText(storeName: string): string {
  return `「${storeName || '该门店'}」已停用，无可展示数据`
}

/** 子页 onLoad：query 带停用标记 → 空态主文案；否则空串（照常取数） */
export function inactiveTextFromQuery(query: Record<string, string | undefined> | undefined, scopeName: string): string {
  return query?.[SCOPE_INACTIVE_QUERY_KEY] === '1' ? inactiveScopeText(scopeName) : ''
}
