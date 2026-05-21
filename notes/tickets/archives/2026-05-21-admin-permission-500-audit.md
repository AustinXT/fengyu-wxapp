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
| /allocations 分配 | sale_order:list **且** service:list | ✓ | ✓(只读)✅ | ✗ | ✗ | ✗ |
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

## ✅ finance × /allocations（原唯一 menu-vs-page 不一致 → 已修）

**finance × /allocations**：`menu.ts` 把营业额分配以 `readonlyRoles:["finance"]` 暴露给 finance，但 `/allocations` 页 SSR 同时调 `getServiceOrdersPaginated`（需 `service:list`），而 finance 原先无 `service:list` → 点「营业额分配」触发 `PERMISSION_DENIED`。

**已采纳候选 A**：给 `finance` 补 `service:list`（只读列表权限，scope 仍兜底）——符合 finance 对账定位，最小改动让页面可看全。落地于 `permissions.ts:108`（`DEFAULT_PERMISSION_MATRIX.finance` 含 `service:list`）。

> 其它角色（hr/product/customer_mgr）的 ✗ 均为「menu 本就不暴露」，属正常隔离，非 bug。

## 深度核实（全 SSR 闸门 + 子页 + scope）—— 2026-05-21 补充

原矩阵只取每个列表页的「主 action」，未穷举页面 SSR 实际触发的全部权限闸门，也未覆盖按钮/行点击可达的子页。本次做深做全，逐页 grep 核实。

### 审计方法
1. **可达性 = menu 可见（`requiredRoles ∪ readonlyRoles`）∪ 列表页按钮/行点击可达的子页**（`/orders/[id]`、`/allocations/[orderId]`、`*/create` 等）。
2. **逐 action 解析真实 `withPermission` 闸门，必读 import 来源**：同名函数在不同模块闸门不同——`getMarkets` 有三份：`commission.ts`→`commission:list`、`products.ts`→`product:list`、`coupons.ts`→`coupon:list`。**故"/coupons / /products/[id] 需 commission:list"是误读**：它们走的是 products/coupons 自己那份（product 角色持 `product:list`+`coupon:list`，打得开）。
3. **只数无条件且未被吞错的闸门**。代码两类防御不计入：
   - 条件加载 `hasPermission(s,X) ? loadX() : Promise.resolve([])`（`/orders/[id]` 的 allocations/logs/payments、`/customers/[id]` 的 stores/employees）；
   - 吞错加载 `getRates().catch(() => [])`（`/allocations/[orderId|serviceOrderId]` 的提成比例）。

### 关键防御点（逐文件核实）
- **`/customers/[id]`**：`getCustomerById/Orders/Appointments/PhoneChangeLogs/OrphanProfiles` **全部 gated by `customer:list`**（customers.ts:233/251/358/583/684，**刻意不用 `sale_order:list`/`appointment:list`**）→ `customer_mgr`（无这两权限）也打得开。
- **`/orders/[id]`**：唯一无条件 `getOrderById`（`withAny(sale_order:list|refund_create|refund_approve)`）；其余 4 项 `hasPermission` 守卫 → manager/finance 持 `sale_order:list`，OK。
- **`/allocations/[orderId]` / `/allocations/service/[…]`**：`getOrderById`/`getServiceOrderById`、`getOrderAllocations`/`getServiceOrderCommissions`(`allocation:list`)、`getEmployees`(`employee:list`)、`getMarketStoreIds`(`store:list`) 无条件，`getRates` 已 `.catch` → manager/finance 全持，OK。
- **product × /products·/mall·/coupons（含 [id]/create）**：getMarkets/getCategories/getMallCategories/getProductKinds/getSkuById/getProductById/getProjectSeries/resolveManageScope 全 `product:list`；getTemplates/getCategoriesForCoupon/getTemplateById/getIssuedCoupons 全 `coupon:list` → product 持两者，OK。

### scope 维度与「页面能否打开」正交
`role × scope` 中 scope（总部/市场/门店）只影响 `scopeCondition` / `expandVisibleMarketIds` 的**数据行过滤**（无可见门店时返回 ``sql`FALSE` `` 或 `[]`，**从不 throw**），action 集合不随 scope 变。故页面**能否打开只由 role 决定**，scope 至多让列表为空，永不 403/500。

### 结论
逐页核实后，**所有 menu 可达页面及其子页，可见角色均持有全部无条件 SSR 闸门，无残留跨权限 403/500**（原 finance×allocations 已修）。

### 守护加深（防未来漂移）
`fengyu-admin/src/lib/page-permission-coverage.test.ts` 从「每页一个主 action」升级为**穷举每页全部无条件 SSR 闸门 + 纳入子页 + 区分 AND/OR 语义**，并新增「menu 新增页必须登记闸门」断言。已验证：故意给某页注入一个可见角色缺失的闸门，测试会 fail（drift 可被抓住），还原后 6/6 通过。

> 注：跑全套时 `org.test.ts`/`stores.test.ts` 有 27 个失败，源自工作区**未提交的 pg-error 重构 WIP**（`org.ts`/`stores.ts`/`pg-error.ts` 改动后 test mock 未同步 `stores.ts:135` 新查询），**与本次权限审计无关**，未触碰。

## 部署/数据环境提示（本次不改，仅记录）

- 部署的 47.113.202.7:3000 实际连 **5433**（空库），而 `db/CLAUDE.md` 规定 admin 应连 **5434**（真实业务库，14.6 万订单）。属 env drift。
- 5434 的 `permission_matrix` 覆盖里 admin 同样**缺 6 项业务权限**（与 5433 修前一致）；若要 admin 在 5434 上正常进业务页，需把 5434 的 admin 覆盖也补全（或 resetMatrix 让其回退到已修的代码默认）。
