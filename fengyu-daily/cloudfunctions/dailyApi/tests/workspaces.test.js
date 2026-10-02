const { test } = require("node:test");
const assert = require("node:assert/strict");
const { reportStores, requireManagement } = require("../utils/report-scope");
const {
  deriveStaffLevel,
  deriveAvailableLoginLevels,
} = require("../utils/scope");
test("多身份层级和管理入口沿用员工端，管理层必须具备看板权限和门店范围", () => {
  assert.equal(
    deriveStaffLevel([
      { role: "staff", scopeType: "门店" },
      { role: "admin", scopeType: "总部" },
    ]),
    "headquarters",
  );
  assert.equal(
    deriveStaffLevel([
      { role: "custom-manager", isStoreManager: true, scopeType: "门店" },
    ]),
    "store_manager",
  );
  assert.deepEqual(deriveAvailableLoginLevels("market", ["S1"], false), [
    "store",
  ]);
  assert.deepEqual(deriveAvailableLoginLevels("market", ["S1"], true), [
    "store",
    "management",
  ]);
  assert.deepEqual(deriveAvailableLoginLevels("headquarters", [], true), []);
});
test("普通员工不能调用管理总览，店长查看范围不会扩展为所有角色门店", () => {
  const auth = {
    managerStores: [{ store_id: "S1" }],
    scopedStores: [{ store_id: "S1" }, { store_id: "S2" }],
    availableWorkspaces: ["employee", "manager"],
  };
  assert.throws(() => requireManagement(auth), /PERMISSION_DENIED/);
  assert.deepEqual(reportStores(auth), [{ store_id: "S1" }]);
  assert.deepEqual(
    reportStores({
      managerStores: [],
      scopedStores: auth.scopedStores,
      availableWorkspaces: ["employee"],
    }),
    [],
  );
  const management = {
    ...auth,
    availableWorkspaces: ["employee", "management"],
  };
  assert.doesNotThrow(() => requireManagement(management));
  assert.deepEqual(reportStores(management), auth.scopedStores);
});
test("门店参数越权在查询数据库之前被拒绝", async () => {
  const manager = require("../routes/manager");
  await assert.rejects(
    manager.list({
      auth: {
        managerStores: [{ store_id: "S1" }],
        availableWorkspaces: ["employee", "manager"],
      },
      event: { payload: { storeId: "S2", date: "2026-10-02" } },
    }),
    /PERMISSION_DENIED/,
  );
  const management = require("../routes/management");
  await assert.rejects(
    management.read({
      auth: { availableWorkspaces: ["employee"] },
      event: { payload: {} },
    }),
    /PERMISSION_DENIED/,
  );
});
