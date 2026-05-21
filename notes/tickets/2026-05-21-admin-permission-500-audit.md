# 手册截图「服务异常」根因 + 角色×页面权限审计

日期：2026-05-21

## 根因（已确证）

`docs/assets/手册` 7 张业务页截图显示 **500 服务异常**（订单/营业额分配/服务单/预约/顾客/疗程卡/提货）。

- 截图采集（今日 10:11–10:19）用 谢廷（单一 `admin` 角色）登录 47.113.202.7:3000（连 **5433**）。
- 当时 5433 的 `system_configs.permission_matrix` 里 admin **无业务权限**（用户 10:41 才补全）。
- 各业务页 SSR 调 `getXxxPaginated`，入口 `requirePermission` 抛 `PERMISSION_DENIED`。
- **Next.js 生产构建脱敏 Server Component 的 `error.message`**，`error.tsx` 的 `message.includes("PERMISSION_DENIED")` 判定失效 → 兜底渲染 **500**（截图「错误编号」=Next 的 digest）。
- 旁证：失败页 SQL 直接打 5433 全部成功（没走到查询）；5433/5434 列集合逐表一致、迁移对齐——schema/数据/迁移均为干扰项。

## 已实施修复（代码）

1. `error.tsx` 判定改 **digest 优先**；新增 `PermissionError extends Error { digest='PERMISSION_DENIED' }`，`requirePermission/requireAnyPermission` 改抛它 → 生产环境权限不足正确显示 **403**。
2. `DEFAULT_PERMISSION_MATRIX.admin` 改为**全部权限**（= `ALL_ACTIONS`，各角色并集）；新增 `ALL_ACTIONS` 导出。
3. 测试：`permissions.test.ts` 反转 admin 断言 + digest 断言；新增 `page-permission-coverage.test.ts` 守护「无 admin 专属业务页」。全套 1184 测试通过。

## 角色 × 页面 可访问性矩阵（修复后；admin=全开）

页面所需 action 取自各列表页 SSR 调用的 `withPermission` 串；menu 可见性取自 `menu.ts`（按角色）。
✓=可进，✗=无权（修复后显示 403），(只读)=menu 标 readonlyRoles。

| 页面 | 所需 action | manager | finance | hr | product | customer_mgr |
|------|------------|:--:|:--:|:--:|:--:|:--:|
| /orders 订单 | sale_order:list | ✓ | ✓(只读) | ✗ | ✗ | ✗ |
| /allocations 分配 | sale_order:list **且** service:list | ✓ | **✗⚠**(只读) | ✗ | ✗ | ✗ |
| /services 服务单 | service:list | ✓ | ✗ | ✗ | ✗ | ✗ |
| /appointments 预约 | appointment:list | ✓ | ✗ | ✗ | ✗ | ✗ |
| /customers 顾客 | customer:list | ✓ | ✓(只读) | ✗ | ✗ | ✓ |
| /cards 疗程卡 | sale_item:list | ✓ | ✓(只读) | ✗ | ✗ | ✓ |
| /pickup-records 提货 | pickup_record:list | ✓ | ✓(只读) | ✗ | ✗ | ✗ |
| /points 积分 | point_transaction:list | ✓ | ✓(只读) | ✗ | ✗ | ✗ |
| /card-transactions 充值卡流水 | card_transaction:list | ✓ | ✓(只读) | ✗ | ✗ | ✗ |
| /inventory 库存 | inventory:list | ✓ | ✓(只读) | ✗ | ✓(只读) | ✗ |
| /refunds 退款 | refund_create **或** approve | ✓ | ✓ | ✓ | ✓ | ✓ |

> 数据/系统管理页（org/stores/employees/products/mall/commission/coupons/permissions/logs/settings/member-benefits）menu 与 page action 一致，无 mismatch。

## ⚠ 唯一 menu-vs-page 不一致（潜在 500/403 bug）

**finance × /allocations**：`menu.ts` 把营业额分配以 `readonlyRoles:["finance"]` 暴露给 finance，但 `/allocations` 页 SSR 同时调 `getServiceOrdersPaginated`（需 `service:list`），而 **finance 无 `service:list`**。
→ finance 点「营业额分配」会触发 `PERMISSION_DENIED`（修复前 500、修复后 403）。

**候选修复（需产品拍板）：**
- A. 给 `finance` 加 `service:list`（只读列表权限，scope 仍兜底）——符合 finance 对账定位，最小改动让页面可看全。
- B. 从 allocations 菜单移除 `finance`（finance 不再看营业额分配）。
- C. 改 `/allocations` 页：finance 时跳过 `getServiceOrdersPaginated`（只看营业额部分）。

> 其它角色（hr/product/customer_mgr）的 ✗ 均为「menu 本就不暴露」，属正常隔离，非 bug。

## 部署/数据环境提示（本次不改，仅记录）

- 部署的 47.113.202.7:3000 实际连 **5433**（空库），而 `db/CLAUDE.md` 规定 admin 应连 **5434**（真实业务库，14.6 万订单）。属 env drift。
- 5434 的 `permission_matrix` 覆盖里 admin 同样**缺 6 项业务权限**（与 5433 修前一致）；若要 admin 在 5434 上正常进业务页，需把 5434 的 admin 覆盖也补全（或 resetMatrix 让其回退到已修的代码默认）。
