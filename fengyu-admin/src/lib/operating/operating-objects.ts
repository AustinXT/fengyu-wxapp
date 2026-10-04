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
  const marketRepresentatives = new Map<string, any>()
  for (const person of dir.people) {
    if (
      person.market_id &&
      dir.fullMarkets.includes(person.market_id) &&
      !marketRepresentatives.has(person.market_id)
    ) {
      marketRepresentatives.set(person.market_id, person)
    }
  }
  const marketParticipants = [...marketRepresentatives].flatMap(
    ([marketId, person]: [string, any]) => {
      const marketStores = dir.stores.filter(
        (store: any) => store.market_id === marketId,
      )
      const storeIds = new Set(marketStores.map((store: any) => store.id))
      const marketAssignments = assignments.filter((assignment: any) =>
        storeIds.has(assignment.store_id),
      )
      const classIds = new Set(
        marketAssignments.map((assignment: any) => assignment.class_id),
      )
      // 市场目标覆盖整个市场；只有市场内所有门店都属于同一个班级时，才把市场目标放进该班 PK。
      if (
        !marketStores.length ||
        marketAssignments.length !== marketStores.length ||
        classIds.size !== 1
      ) {
        return []
      }
      const store = marketStores[0]
      return [
        {
          employeeId: person.employeeId,
          name: person.name,
          position: '市场目标',
          scope: 'market',
          scopeId: marketId,
          scopeName: store.area,
          storeId: null,
          storeName: `${store.area || '市场'}合计`,
          marketId,
          area: store.area || '',
          classId: marketAssignments[0].class_id,
          legion: '',
          mentor: null,
        },
      ]
    },
  )
  const storeParticipants = dir.people.flatMap((person: any) => {
    const store = dir.stores.find((s: any) => s.id === person.storeId)
    if (person.market_id) return []
    const assignment = assignments.find((a: any) => a.store_id === person.storeId)
    if (!assignment) return []
    const scope = person.manager && store ? 'store' : 'personal'
    const scopeId = scope === 'store' ? person.storeId : person.employeeId
    return [
      {
        employeeId: person.employeeId,
        name: person.name,
        position: person.position || '',
        scope,
        scopeId,
        scopeName: scope === 'store' ? store.name : person.name,
        storeId: person.storeId,
        storeName: store?.name || '未分配门店',
        marketId: store?.market_id || null,
        area: store?.area || '',
        classId: assignment.class_id,
        legion: assignment.legion,
        mentor: assignment.mentor_name,
      },
    ]
  })
  return [...storeParticipants, ...marketParticipants]
}
