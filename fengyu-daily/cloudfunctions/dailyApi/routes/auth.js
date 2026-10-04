const pg = require("../db/pg");
const {
  expandScopeStoreIds,
  expandScopeOrgNodeIds,
  deriveStaffLevel,
  deriveAvailableLoginLevels,
} = require("../utils/scope");
const { hasDataCenterDashboard } = require("../utils/permission-matrix");
const { resolvePhone } = require("../utils/phone-auth");
async function identity(wxContext) {
  const { APPID, OPENID } = wxContext || {};
  if (APPID !== "wx4da3e1e9ad861396" || typeof OPENID !== "string" || !OPENID)
    throw new Error("UNAUTHORIZED: 请通过日报小程序访问");
  return { appid: APPID, openid: OPENID };
}
async function load(id) {
  const [user] = await pg.query(
    `SELECT u.employee_id, u.name, u.is_resigned, u.store_id, s.store_name, u.position_name, o.name AS org_name
    FROM daily_wechat_bindings b JOIN staff_wechat_users u ON u.employee_id=b.employee_id
    LEFT JOIN stores s ON s.store_id=u.store_id LEFT JOIN org_nodes o ON o.id=COALESCE(u.org_node_id,s.org_node_id) WHERE b.appid=$1 AND b.openid=$2`,
    [id.appid, id.openid],
  );
  if (!user) return null;
  return loadEmployee(user);
}
async function loadEmployee(user) {
  if (user.is_resigned)
    throw new Error("PERMISSION_DENIED: 员工已离职，请联系管理员");
  const roles = await pg.query(
    `SELECT pr.role,pr.scope_id,o.type AS scope_type,o.name AS scope_name,
      rd.name AS role_name,rd.is_store_manager,rd.is_super_admin,rd.actions
    FROM permission_roles pr JOIN permission_role_definitions rd ON rd.role_key=pr.role
    LEFT JOIN org_nodes o ON o.id=pr.scope_id WHERE pr.employee_id=$1`,
    [user.employee_id],
  );
  const roleBindings = roles.map((r) => ({
    role: r.role,
    roleName: r.role_name,
    isStoreManager: !!r.is_store_manager,
    isSuperAdmin: !!r.is_super_admin,
    actions: r.actions || [],
    scopeId: r.scope_id,
    scopeType: r.scope_type,
    scopeName: r.scope_name,
  }));
  const staffLevel = deriveStaffLevel(roleBindings);
  const [scopeStoreIds, scopeOrgNodeIds, hasDashboard] = await Promise.all([
    expandScopeStoreIds(roleBindings, pg),
    expandScopeOrgNodeIds(roleBindings, pg),
    hasDataCenterDashboard(roleBindings),
  ]);
  const storeIds = await expandScopeStoreIds(
    roleBindings.filter((r) => r.isStoreManager),
    pg,
  );
  const managerStores = storeIds.length
    ? await pg.query(
        "SELECT store_id,store_name FROM stores WHERE store_id=ANY($1::text[]) ORDER BY store_name",
        [storeIds],
      )
    : [];
  const scopedStores = scopeStoreIds.length
    ? await pg.query(
        "SELECT store_id,store_name,org_node_id FROM stores WHERE store_id=ANY($1::text[]) ORDER BY store_name",
        [scopeStoreIds],
      )
    : [];
  const availableLoginLevels = deriveAvailableLoginLevels(
    staffLevel,
    scopeStoreIds,
    hasDashboard,
    roleBindings,
  );
  const availableWorkspaces = ["employee"];
  if (managerStores.length) availableWorkspaces.push("manager");
  if (availableLoginLevels.includes("management"))
    availableWorkspaces.push("management");
  return {
    employeeId: user.employee_id,
    name: user.name || user.employee_id,
    storeId: user.store_id,
    storeName: user.store_name || "",
    positionName: user.position_name || "",
    orgName: user.org_name || "",
    managerStores,
    roleBindings,
    staffLevel,
    availableWorkspaces,
    scopedStores,
    scopeOrgNodeIds,
  };
}
async function requireTestUser(employeeId) {
  const [user] = await pg.query(
    `SELECT u.employee_id,u.name,u.is_resigned,u.store_id,s.store_name,u.position_name,o.name AS org_name
     FROM staff_wechat_users u LEFT JOIN stores s ON s.store_id=u.store_id
     LEFT JOIN org_nodes o ON o.id=COALESCE(u.org_node_id,s.org_node_id)
     WHERE u.employee_id=$1`,
    [employeeId],
  );
  if (!user) throw new Error("NOT_FOUND: 测试员工不存在");
  return loadEmployee(user);
}
async function requireUser(id) {
  const user = await load(id);
  if (!user) throw new Error("PHONE_REQUIRED: 请先授权手机号绑定员工身份");
  return user;
}
async function login(ctx) {
  ctx.result = {
    user: ctx.testEmployeeId
      ? await requireTestUser(ctx.testEmployeeId)
      : await load(ctx.identity),
  };
}
async function bindPhone(ctx) {
  const phone = await resolvePhone(ctx.cloud, ctx.event.payload);
  await pg
    .transaction(async (client) => {
      const {
        rows: [employee],
      } = await client.query(
        "SELECT employee_id,is_resigned FROM staff_wechat_users WHERE phone=$1 FOR UPDATE",
        [phone],
      );
      if (!employee || employee.is_resigned)
        throw new Error(
          "PERMISSION_DENIED: 该手机号未关联在职员工，请联系管理员核对档案",
        );
      const { rows: existing } = await client.query(
        `SELECT employee_id,openid FROM daily_wechat_bindings WHERE appid=$1 AND (openid=$2 OR employee_id=$3) FOR UPDATE`,
        [ctx.identity.appid, ctx.identity.openid, employee.employee_id],
      );
      if (
        existing.some(
          (b) =>
            b.employee_id !== employee.employee_id ||
            b.openid !== ctx.identity.openid,
        )
      )
        throw new Error("CONFLICT: 微信或员工已绑定其他身份，请联系管理员处理");
      await client.query(
        `INSERT INTO daily_wechat_bindings(appid,openid,employee_id) VALUES($1,$2,$3)
      ON CONFLICT (appid,openid) DO UPDATE SET updated_at=NOW()`,
        [ctx.identity.appid, ctx.identity.openid, employee.employee_id],
      );
    })
    .catch((e) => {
      if (e.code === "23505") throw new Error("CONFLICT: 该员工已绑定其他微信");
      throw e;
    });
  ctx.result = { user: await requireUser(ctx.identity) };
}
async function bindTestCode(ctx) {
  ctx.result = { user: await requireTestUser(ctx.testEmployeeId) };
}
module.exports = {
  identity,
  requireUser,
  login,
  bindPhone,
  bindTestCode,
  testIdentity: (...args) => require("../utils/test-binding").testIdentity(...args),
  requireTestUser,
};
