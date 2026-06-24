import { describe, it, expect } from "vitest";
import { getVisibleMenuGroups, MENU_CONFIG } from "./menu";
import { DEFAULT_PERMISSION_MATRIX } from "./permissions";
import type { AuthSession, RoleType } from "./types";

/**
 * 构造 session：actions 由角色经 DEFAULT_PERMISSION_MATRIX 摊平（与运行时 computeActions 同口径）。
 * 菜单 2026-06-24 改为权限点驱动后，可见性取决于 session.permissions.actions，而非 roles。
 */
function makeSession(
  ...roles: Array<{ role: RoleType; scopeType?: "总部" | "市场" | "门店" }>
): AuthSession {
  const actions = [
    ...new Set(roles.flatMap((r) => DEFAULT_PERMISSION_MATRIX[r.role] ?? [])),
  ];
  return {
    employeeId: "test",
    name: "测试",
    phone: "13800000000",
    roles: roles.map((r) => ({
      role: r.role,
      scopeId: "test-scope",
      scopeType: r.scopeType ?? "门店",
    })),
    permissions: { actions, scopeStoreIds: [] },
  };
}

function getMenuLabels(session: AuthSession): string[] {
  return getVisibleMenuGroups(session).flatMap((g) => g.items.map((i) => i.label));
}

const TOTAL_ITEMS = MENU_CONFIG.reduce((n, g) => n + g.items.length, 0);

describe("getVisibleMenuGroups（权限点驱动）", () => {
  it("admin 看到全部菜单（持 ALL_ACTIONS）", () => {
    const labels = getMenuLabels(makeSession({ role: "admin" }));
    expect(labels).toHaveLength(TOTAL_ITEMS);
    // 权限点驱动下 admin 全权，不再隐藏业务操作菜单（开单/服务单等）
    expect(labels).toContain("开单");
    expect(labels).toContain("服务单管理");
    expect(labels).toContain("系统配置");
  });

  it("manager 看到业务操作 + 顾客/卡包，且含生产扩权的员工/商户/消息/日志", () => {
    const labels = getMenuLabels(makeSession({ role: "manager" }));
    expect(labels).toContain("开单");
    expect(labels).toContain("订单管理");
    expect(labels).toContain("营业额分配");
    expect(labels).toContain("服务单管理");
    expect(labels).toContain("预约管理");
    expect(labels).toContain("顾客管理");
    expect(labels).toContain("疗程卡管理");
    expect(labels).toContain("退款管理");
    expect(labels).toContain("员工管理"); // 生产扩权：manager 有 employee:create
    expect(labels).toContain("商户管理"); // manager 有 merchant:list
    expect(labels).toContain("消息中心"); // manager 有 message:list
    expect(labels).toContain("操作日志"); // manager 有 operation_log:list
    // 仍无：组织/门店/商品管理、提成、权限、系统配置（无对应门槛 action）
    expect(labels).not.toContain("组织架构");
    expect(labels).not.toContain("门店管理");
    expect(labels).not.toContain("商品管理");
    expect(labels).not.toContain("提成矩阵");
    expect(labels).not.toContain("权限管理");
    expect(labels).not.toContain("系统配置");
  });

  it("finance 看到对账类，且含生产扩权的提成矩阵/服务单", () => {
    const labels = getMenuLabels(makeSession({ role: "finance" }));
    expect(labels).toContain("订单管理");
    expect(labels).toContain("营业额分配");
    expect(labels).toContain("退款管理");
    expect(labels).toContain("顾客管理");
    expect(labels).toContain("充值卡流水");
    expect(labels).toContain("商户管理");
    expect(labels).toContain("提成矩阵"); // 生产扩权：finance 有 commission:list
    expect(labels).toContain("服务单管理"); // finance 有 service:list
    expect(labels).toContain("操作日志");
    // 无：开单（无 sale_order:create）、预约、员工管理、消息中心（无 message:list）
    expect(labels).not.toContain("开单");
    expect(labels).not.toContain("预约管理");
    expect(labels).not.toContain("员工管理");
    expect(labels).not.toContain("消息中心");
  });

  it("hr 看到组织/门店/员工/权限，且含生产扩权的订单/服务单/消息", () => {
    const labels = getMenuLabels(makeSession({ role: "hr" }));
    expect(labels).toContain("组织架构");
    expect(labels).toContain("门店管理");
    expect(labels).toContain("员工管理");
    expect(labels).toContain("权限管理");
    expect(labels).toContain("订单管理"); // 生产扩权：hr 有 sale_order:list
    expect(labels).toContain("服务单管理"); // hr 有 service:list
    expect(labels).toContain("消息中心"); // hr 有 message:list
    expect(labels).not.toContain("商品管理");
    expect(labels).not.toContain("提成矩阵");
    expect(labels).not.toContain("开单");
    expect(labels).not.toContain("充值卡流水");
  });

  it("product 看到商品/商城/优惠券/库存，且含生产扩权的订单", () => {
    const labels = getMenuLabels(makeSession({ role: "product" }));
    expect(labels).toContain("商品管理");
    expect(labels).toContain("商城管理");
    expect(labels).toContain("优惠券管理");
    expect(labels).toContain("门店库存");
    expect(labels).toContain("订单管理"); // 生产扩权：product 有 sale_order:list
    expect(labels).not.toContain("员工管理");
    expect(labels).not.toContain("权限管理");
    expect(labels).not.toContain("充值卡流水");
  });

  it("customer_mgr 看到顾客/卡包，且含生产扩权的预约/历史订单/库存", () => {
    const labels = getMenuLabels(makeSession({ role: "customer_mgr" }));
    expect(labels).toContain("顾客管理");
    expect(labels).toContain("疗程卡管理");
    expect(labels).toContain("预约管理"); // 生产扩权：customer_mgr 有 appointment:list
    expect(labels).toContain("历史订单核对"); // 有 legacy_order:list
    expect(labels).toContain("门店库存"); // 有 inventory:list
    expect(labels).not.toContain("订单管理"); // 无 sale_order:list
    expect(labels).not.toContain("充值卡流水");
    expect(labels).not.toContain("系统配置");
  });

  it("操作日志对所有管理角色可见（生产给各角色配了 operation_log:list）", () => {
    for (const role of ["admin", "manager", "finance", "hr", "product", "customer_mgr"] as RoleType[]) {
      expect(getMenuLabels(makeSession({ role }))).toContain("操作日志");
    }
  });

  it("多角色合并菜单（hr + product）", () => {
    const labels = getMenuLabels(makeSession({ role: "hr" }, { role: "product" }));
    expect(labels).toContain("组织架构"); // hr
    expect(labels).toContain("商品管理"); // product
    expect(labels).toContain("权限管理"); // hr
  });

  it("staff 无任何菜单（不可登录后台，矩阵为空）", () => {
    const labels = getMenuLabels(makeSession({ role: "staff" as RoleType }));
    expect(labels).toHaveLength(0);
  });

  it("空角色无菜单", () => {
    const session = makeSession();
    const emptySession: AuthSession = {
      ...session,
      roles: [],
      permissions: { actions: [], scopeStoreIds: [] },
    };
    expect(getMenuLabels(emptySession)).toHaveLength(0);
  });

  it("过滤空分组", () => {
    const groups = getVisibleMenuGroups(makeSession({ role: "product" }));
    groups.forEach((g) => {
      expect(g.items.length).toBeGreaterThan(0);
    });
  });
});

describe("MENU_CONFIG 完整性", () => {
  it("所有菜单项都有 href（以 / 开头）", () => {
    MENU_CONFIG.forEach((group) => {
      group.items.forEach((item) => {
        expect(item.href).toBeTruthy();
        expect(item.href.startsWith("/")).toBe(true);
      });
    });
  });

  it("所有菜单项都有图标", () => {
    MENU_CONFIG.forEach((group) => {
      group.items.forEach((item) => {
        expect(item.icon).toBeDefined();
      });
    });
  });

  it("所有菜单项都有非空 requiredActions", () => {
    MENU_CONFIG.forEach((group) => {
      group.items.forEach((item) => {
        expect(item.requiredActions.length).toBeGreaterThan(0);
      });
    });
  });

  it("门槛 action 均为 ALL_ACTIONS 内合法权限点（防 typo / 废弃）", () => {
    // admin == ALL_ACTIONS（permissions.test 守护），故用 admin 矩阵作全集
    const all = new Set(DEFAULT_PERMISSION_MATRIX.admin);
    MENU_CONFIG.forEach((group) => {
      group.items.forEach((item) => {
        item.requiredActions.forEach((a) => {
          expect(all.has(a), `菜单「${item.label}」门槛 ${a} 不在 ALL_ACTIONS`).toBe(true);
        });
      });
    });
  });
});
