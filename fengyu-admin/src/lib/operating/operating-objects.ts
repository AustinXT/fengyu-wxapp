export async function directory(query: any, allowedStores: any) {
  const stores = await query(`WITH RECURSIVE lineage AS (
    SELECT s.store_id,n.id,n.name,n.type,n.parent_id FROM stores s JOIN org_nodes n ON n.id=s.org_node_id
    UNION ALL SELECT l.store_id,n.id,n.name,n.type,n.parent_id FROM lineage l JOIN org_nodes n ON n.id=l.parent_id
  ) SELECT s.store_id AS id,s.store_name AS name,s.org_node_id,
    (SELECT id FROM lineage l WHERE l.store_id=s.store_id AND l.type='市场' LIMIT 1) AS market_id,
    (SELECT name FROM lineage l WHERE l.store_id=s.store_id AND l.type='市场' LIMIT 1) AS area
    FROM stores s ORDER BY s.store_name,s.store_id`)
  const visible = stores.filter((s: any) => allowedStores.includes(s.id))
  const marketIds = [
    ...new Set<string>(visible.map((s: any) => s.market_id).filter(Boolean)),
  ]
  const people = await query(
    `SELECT u.employee_id AS "employeeId",u.name,u.store_id AS "storeId",u.org_node_id,u.position_name AS position,
    EXISTS(SELECT 1 FROM permission_roles pr JOIN permission_role_definitions rd ON rd.role_key=pr.role
      WHERE pr.employee_id=u.employee_id AND rd.is_store_manager AND pr.scope_id IN (
        WITH RECURSIVE ancestors AS (SELECT n.id,n.parent_id FROM org_nodes n JOIN stores s ON s.org_node_id=n.id WHERE s.store_id=u.store_id
          UNION ALL SELECT n.id,n.parent_id FROM org_nodes n JOIN ancestors a ON n.id=a.parent_id) SELECT id FROM ancestors)) AS manager,
    (SELECT pr.scope_id FROM permission_roles pr JOIN permission_role_definitions rd ON rd.role_key=pr.role JOIN org_nodes n ON n.id=pr.scope_id
      WHERE pr.employee_id=u.employee_id AND n.type='市场' AND 'data_center:dashboard'=ANY(rd.actions)
      AND pr.scope_id IN (WITH RECURSIVE ancestors AS (SELECT n.id,n.parent_id FROM org_nodes n WHERE n.id=COALESCE(u.org_node_id,(SELECT org_node_id FROM stores WHERE store_id=u.store_id))
        UNION ALL SELECT n.id,n.parent_id FROM org_nodes n JOIN ancestors a ON n.id=a.parent_id) SELECT id FROM ancestors)
      ORDER BY pr.scope_id LIMIT 1) AS market_id
    FROM staff_wechat_users u WHERE NOT u.is_resigned AND (u.store_id=ANY($1::text[]) OR u.org_node_id IN (WITH RECURSIVE descendants AS (SELECT id FROM org_nodes WHERE id=ANY($2::text[]) UNION ALL SELECT n.id FROM org_nodes n JOIN descendants d ON n.parent_id=d.id) SELECT id FROM descendants))
    ORDER BY u.name,u.employee_id`,
    [allowedStores, marketIds],
  )
  const fullMarkets = marketIds.filter((id: any) =>
    stores
      .filter((s: any) => s.market_id === id)
      .every((s: any) => allowedStores.includes(s.id)),
  )
  return { stores: visible, fullMarkets, people }
}
export function participantObjects(dir: any, assignments: any) {
  return dir.people.flatMap((person: any) => {
    const store = dir.stores.find((s: any) => s.id === person.storeId)
    const market = person.market_id || store?.market_id
    const marketRole =
      person.market_id && dir.fullMarkets.includes(person.market_id)
    if (person.market_id && !marketRole) return []
    const ownAssignment = assignments.find(
      (a: any) => a.store_id === person.storeId,
    )
    const assignment = ownAssignment
    if (marketRole && store?.market_id !== market) return []
    if (!assignment) return []
    const scope = marketRole
      ? 'market'
      : person.manager && store
        ? 'store'
        : 'personal'
    const scopeId =
      scope === 'market'
        ? market
        : scope === 'store'
          ? person.storeId
          : person.employeeId
    return [
      {
        employeeId: person.employeeId,
        name: person.name,
        position: person.position || '',
        scope,
        scopeId,
        scopeName:
          scope === 'market'
            ? dir.stores.find((s: any) => s.market_id === market)?.area
            : scope === 'store'
              ? store.name
              : person.name,
        storeId: person.storeId,
        storeName: store?.name || '未分配门店',
        marketId: market,
        area:
          store?.area ||
          dir.stores.find((s: any) => s.market_id === market)?.area ||
          '',
        classId: assignment.class_id,
        legion: assignment.legion,
        mentor: assignment.mentor_name,
      },
    ]
  })
}
