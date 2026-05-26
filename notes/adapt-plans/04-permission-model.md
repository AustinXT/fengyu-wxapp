# 权限双维度模型 — 需求变更适配报告

> ⚠️ **本报告已被 [`00-decisions.md`](./00-decisions.md) 部分覆盖（2026-04-10）**
> - `orgNodeTypeEnum` **不收窄**，`"部门"` 值保留；业务层面不再创建 `type='部门'` 节点即可
> - Q6 答：**sync-workfine 硬编码"财智部" → `finance+store` scope 符合预期**，不改同步脚本
> - 仅执行：员工端 `ctx.auth.roles` 结构化（scopeId/scopeType）+ staff.dashboard 市场级聚合
> - Q7 区域经理 3.5 层仍登记为**待讨论遗留事项**

> **适配计划编号**: 04
> **来源会议**: [2026-03-12](../meetings/meeting-20260312/article.md) §六 权限设计、[2026-04-07](../meetings/meeting-20260407/article.md) §四 权限管理
> **产出日期**: 2026-04-09
> **关联 skill**: `.claude/skills/wx-requirement-adapt/SKILL.md` §3 + §4 + §5.2
> **作者**: Claude (Opus 4.6)
> **状态**: 待评审

---

## 0. 需求摘要

### 0.1 会议决议（原文对齐）

20260312 §六 权限设计确立了**双维度权限模型**：

| 维度 | 取值 |
|------|------|
| 地理层级（Scope） | 总部 → 市场 → 门店 |
| 职能角色（Role） | 经理 / 财务 / 人事 / 产品 / 员工 |

权限 = 层级 × 角色。例如"市场·财务"指该人在所属市场范围内拥有财务权限。

典型映射：

| 实际岗位 | 层级 × 角色 |
|---------|------------|
| 基层美容师 | 门店·员工 |
| 门店经理/店长 | 门店·经理 |
| 市场总监 | 市场·经理 |
| 总部人事 | 总部·人事 |
| 总部财务 | 总部·财务 |
| 商学院/运营 | 总部·产品 |
| 后台管理员 | 小程序后台独立角色（`admin`） |

20260407 §四 权限管理补充：

- 三层组织（**总部 / 市场 / 门店**）确认，**部门层级已移除**
- 同一"店长"角色可分配给不同层级，权限范围跟随所在组织节点
- **员工端小程序应展示「职位」而非角色名称**（避免店长等内部标签直接暴露，特别是市场总监/总经理登录时看到"店长"会显得不雅）
- 多门店管理者（市场级）首页展示**管辖范围汇总数据**，支持按门店切换查看明细

### 0.2 遗留事项

- **3.5 层区域经理问题（南昌场景）**：部分大市场设"区域经理"，管 3-5 家店，高于门店经理、低于市场总监。当前决议"暂不支持，需另行讨论"——**本次适配计划不出方案**，仅在 §8 风险点中明确登记为待定事项。

---

## 1. 差异报告：当前 vs 期望

### 1.1 当前行为（代码事实）

#### 1.1.1 数据库层

**权限角色表** (`db/schema/permission.ts:12-35`)：

```text
permission_roles
  ├── id           bigserial PK
  ├── employee_id  → staff_wechat_users.employee_id
  ├── role         text     -- 无枚举约束，运行时取值 'admin' | 'manager' | 'finance' | 'hr' | 'product' | 'staff' | 'customer_mgr'
  ├── scope_id     → org_nodes.id
  ├── created_by / updated_by text
  └── unique(employee_id, role, scope_id)
```

- 已经是**双维度**结构：`role` + `scope_id`。一人可有多行，同一 role 可分配多个 scope（多门店管理）。
- `role` 为自由 text，没有 pg_enum，通过应用层 `RoleType` 联合类型约束 (`fengyu-admin/src/lib/types.ts:127`)。
- 硬删除机制（`db/migrations/0016_permission_roles_hard_delete.sql`），已移除 `is_void`/`voided_at`。

**组织架构节点类型** (`db/schema/enums.ts:50`)：

```ts
export const orgNodeTypeEnum = pgEnum("org_node_type", ["总部", "市场", "门店", "部门"]);
```

- **仍保留"部门"枚举值**，与 20260407 会议"已移除部门层级"决议不符。
- `db/schema/org.ts:8-15` 注释仍描述部门可挂在任意非部门节点下。
- `fengyu-admin/src/actions/org.ts:15,84-89` 的 `VALID_NODE_TYPES = ['总部','市场','门店','部门']`，并有"部门不可嵌套"、"门店下只能建部门"等业务校验。
- 权限页面已主动过滤部门节点（`fengyu-admin/src/app/(main)/permissions/_components/permissions-page.tsx:121`）：`orgNodes.filter(n => n.isActive && n.type !== "部门")`。
- `fengyu-admin/src/lib/types.ts:6` 中 `OrgNode.type` 仍为 `'总部' | '市场' | '门店' | '部门'`。
- `AuthSession.roles[i].scopeType` (`fengyu-admin/src/lib/types.ts:449`) 声明为 `'总部' | '市场' | '门店'`——前端模型**已不含部门**，但底层枚举还有。

**职位枚举** (`db/schema/enums.ts:56`)：

```ts
export const positionScopeEnum = pgEnum("position_scope", ["总部", "市场", "门店"]);
```

- `positions` 表 (`db/schema/lookup.ts:10-20`) 用 `positionScopeEnum` 分类，与 `orgNodeTypeEnum` 一致（无部门）。该表本身就是按双维度（scope）组织的职位字典。
- 从 `db/migrations/manual-applied/0011_seed_positions_skill_tags.sql` 可见：
  - 市场总监、片区经理 → `market` scope
  - 门店经理、美容师、高级美容师、资深美容师、美容顾问、美容学徒 → `store` scope
  - 其他 → `headquarters` scope

#### 1.1.2 后端逻辑层

**角色常量与中文标签** (`fengyu-admin/src/lib/types.ts:127-138`)：

```ts
export type RoleType = 'admin' | 'manager' | 'finance' | 'hr' | 'product' | 'customer_mgr' | 'staff'

export const ROLE_LABELS: Record<RoleType, string> = {
  admin: '系统管理员',
  manager: '店长',        // ← 与会议"经理"不一致；员工端若直接展示会被误读
  finance: '财务',
  hr: '人事',
  product: '商品管理员',
  customer_mgr: '顾客管理员',
  staff: '员工',
}
```

**PERMISSION_MATRIX** (`fengyu-admin/src/lib/permissions.ts:15-68`)：

- 7 个角色：`admin | manager | finance | hr | product | customer_mgr | staff`
- 比会议原文（经理/财务/人事/产品/员工 5 角色）**多出 2 个**：`admin`（后台独立角色，会议允许）、`customer_mgr`（补丁式顾客管理员角色）
- 会议"经理（全部权限）"在代码中被拆成 `admin` 和 `manager`：admin 管基础数据 + 系统；manager 管业务数据 + scope 内经营看板，刻意解耦"系统管理"与"业务操作"
- `manager` 无 hr/product 能力（员工/商品 CRUD），与会议"经理=全部权限"有偏差，但技术上合理——管理后台的"经理"实际对应 manager 业务角色，而不是含员工/商品/提成的超集

**scope 展开逻辑** (`fengyu-admin/src/lib/permissions.ts:91-133`)：

- `expandScopeStoreIds(roles)` 已实现三级 scope → storeIds 展开：
  - `总部` scope → 全部门店
  - `市场` scope → `parent_id = scope & type = 门店` 的门店节点 → stores
  - `门店` scope → `orgNodeId = scope` 的 store
- `scopeCondition(session, table.storeId)` (`fengyu-admin/src/lib/permissions.ts:167-179`) 基于 `scopeStoreIds` 生成 `inArray` 过滤；admin 完全跳过过滤。

**admin 端 Session 构造** (`fengyu-admin/src/actions/auth.ts:188-214`)：

```ts
const roleRows = await db.select({
  role: permissionRoles.role,
  scopeId: permissionRoles.scopeId,
  scopeType: orgNodes.type,           // ← 来自 org_nodes.type
})
.from(permissionRoles)
.leftJoin(orgNodes, eq(permissionRoles.scopeId, orgNodes.id))
.where(eq(permissionRoles.employeeId, employeeId))

const roles = roleRows.map(r => ({
  role: r.role as RoleType,
  scopeId: r.scopeId,
  scopeType: (r.scopeType ?? '门店') as '总部' | '市场' | '门店',   // ← 向下兼容空值
}))

const actions = computeActions(roles)
const scopeStoreIds = await expandScopeStoreIds(roles)
```

- 构造的 `AuthSession.roles` 是**双维度**（role + scopeId + scopeType）——与会议模型匹配。
- `scopeType` 默认回退 '门店'，对 'headquarters/market/store' 之外的值（如历史数据里的"部门"）会静默归为门店，存在**静默失真**风险。

**员工端云函数 auth 中间件** (`fengyu-staff/cloudfunctions/staffApi/middleware/auth.js:39-56, 79-98`)：

```js
const roleRows = await pg.query(
  'SELECT role FROM permission_roles WHERE employee_id = $1',
  [user.employee_id]
)
roles = roleRows.map(r => r.role)

authData = {
  ...
  roles,          // ← 只有 string[]，不含 scope 信息
  position: isActive ? user.position_name : null,
  ...
}
```

- 员工端 `ctx.auth.roles` 是**单维度** `string[]`，**丢失了 scopeId/scopeType**。
- 员工端完全没有 scope 过滤能力；数据范围靠 `ctx.auth.storeId`（=员工自己绑定的门店）硬编码为"本店"。

**员工端业务分流** (`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:314-315, 588-598`)：

```js
// todoList
const isManager = roles.includes('manager')
if (isManager) {
  // 门店级待办（store_id = ctx.auth.storeId）
} else {
  // 个人待办（assigned_employee_id = ctx.auth.staffWfId）
}

// dashboard
if (isManagerRole) {
  scopeFilter = 'so.store_id = $1'
  scopeParams = [storeId]        // ← 单门店
} else {
  scopeFilter = 'so.assigned_employee_id = $1'
  scopeParams = [employeeId]
}
```

**这里是与会议决议最大的 gap**：

1. **二元分流**：整个员工端只区分"manager（=店长，看整店）"和"其他（=美容师，看自己）"，**没有市场级/总部级**的数据聚合模式。
2. **单门店假设**：`ctx.auth.storeId` 只有一个值，市场总监即使挂了 `manager + scope=market`，员工端依然只看到 ta 被绑定的那一家 store 的数据。
3. **缺少 scope 展开**：云函数没有类似 admin 端 `expandScopeStoreIds` 的辅助函数，无法把 market scope 变成门店 ID 列表。

**staffApi login 返回** (`fengyu-staff/cloudfunctions/staffApi/routes/auth.js:47-111`)：

```js
async function queryRoles(employeeId) {
  const roleRows = await pg.query(
    'SELECT role FROM permission_roles WHERE employee_id = $1',
    [employeeId]
  )
  return roleRows.map(r => r.role)    // ← 同样只返回字符串数组
}

ctx.result = {
  ...
  position: isActive ? user.position_name : null,
  roles,
  ...
}
```

- login 同样返回 `roles: string[]`，**前端从未拿到 scopeType/scopeId**。
- `position` 来自 `staff_wechat_users.position_name`（一个自由 text 字段，由 WorkFine 同步或后台维护）。

**sync-workfine 权限推导** (`db/scripts/sync-workfine.js:436-468`)：

```js
if (pos.includes('代理')) {
  role = 'staff'
} else if (pos === '门店经理') {
  role = 'manager'                     // scopeId = store
} else if (pos === '市场总监' || pos === '片区经理') {
  role = 'manager'
  scopeId = marketScope || storeScope  // scopeId = market
} else if (dept === '财智部') {
  role = 'finance'                     // scopeId = store（注意：未提升到 market）
}
```

- "片区经理"在同步里被当作**市场级 manager**（其实片区经理就是会议提到的"区域经理 3.5 层"——目前系统已经用"市场级 manager"近似它了，只是粒度上小于市场）。
- "财智部"员工被硬编码为 `finance`+store scope，**与会议"财务可看汇总"的 scope 不一致**（财务通常应该挂在 market 或 headquarters 层）。
- 没有任何员工被自动推导为 `hr` / `product`（总部职能角色），这些只能通过管理后台手动分配。

#### 1.1.3 前端渲染层

**admin 权限管理页** (`fengyu-admin/src/app/(main)/permissions/_components/permissions-page.tsx`)：

- 左侧：组织树（已过滤 `部门` 节点，第 121 行）
- 右侧：按 role 分组列出该 scope 下的角色分配
- 角色下拉：`allRoles.filter(r => r !== 'staff')` 即 6 个可分配角色
- **admin 角色硬绑定总部**（第 404-407 行）：`const hq = orgNodes.find(n => n.type === "总部")`
- scope 选择器：`OrgTreeSelect` 传 `excludeTypes={["部门"]}`

该页面**已经是双维度交互**：选组织节点 → 分配"角色 × 该节点"，符合会议要求。

**admin 菜单** (`fengyu-admin/src/lib/menu.ts:49-83`)：

- 基于 `requiredRoles: RoleType[]` 做显隐，**只看 role，不看 scopeType**。
- 缺失能力：菜单无法按 scopeType 差异化（例如市场·manager 和 门店·manager 看到的菜单一样）——目前系统通过数据层过滤（scopeCondition）而非菜单层差异化，这是可以接受的选择，但就是没有"市场级看板"和"门店级看板"的路由级分离。

**员工端 `utils/role.ts`** (`fengyu-staff/miniprogram/utils/role.ts:1-22`)：

```ts
export function isManager(): boolean {
  return getApp<IAppOption>().globalData.roles?.includes('manager') ?? false;
}
```

- 二元判定：`isManager` / `isBeautician`，没有 market/headquarters 分支。
- `globalData.roles` 是 `string[]`，与 auth 中间件返回格式一致。

**员工端 `app.ts` globalData** (`fengyu-staff/miniprogram/app.ts:5-13`)：

```ts
globalData: {
  staffWfId: '',
  staffName: '',
  position: '',       // ← 这里就是"职位"数据源
  roles: [],          // ← string[]，无 scope
  boundStoreName: '',
  boundStoreId: '',
  phone: '',
}
```

- 已经保存了 `position` 字段（来自 login / bindPhone 返回的 `position`，最终来源 `staff_wechat_users.position_name`）。
- **没有 scopeType / scopeStoreIds 字段**。多门店管理者无法在前端表达"我管哪几家店"。

**员工端 Profile "我的" 页** (`fengyu-staff/miniprogram/pages/profile/profile.ts:27-29`, `profile.wxml:12`)：

```wxml
{{position || '未绑定'}}
```

- **已经在展示 `position` 而不是 role 名称**，与 20260407 决议一致。注意：这行代码本身是历史产物，在会议决议之前就已经这样写，但恰好满足了新要求。
- 本处无改动需求，仅需确认后续不要回退。

**员工端工作台首页** (`fengyu-staff/miniprogram/pages/workbench/workbench.ts:58-65, workbench.wxml:15-20`)：

```ts
const { staffName, position, boundStoreName } = app.globalData;
this.setData({
  storeName: boundStoreName,
  staffName,
  position,
  isManager: isManager(),
});
```

```wxml
<text class="commission-staff-name">{{staffName}}</text>
<text class="commission-store-name">{{storeName || '未绑定门店'}}</text>
<view class="role-badge role-badge--{{isManager ? 'manager' : 'beautician'}}">
  <text class="role-text">{{position || '未绑定'}}</text>
</view>
```

- 工作台 **也已经展示 position 而非 role 名称**；但 CSS class 仍以 `manager/beautician` 二值切换样式。
- `boundStoreName` 是**单值**，市场级管理者展示将显示"单个门店"而非"管辖市场汇总"。

**员工端数据看板** (`fengyu-staff/miniprogram/packageOrder/dashboard/dashboard.ts:1-80`)：

- 调用 `staff.dashboard`，只传 `{ startDate, endDate }`，**不传 storeId**
- 云函数内按 `ctx.auth.storeId` + `isManager` 二元分流
- **无法按门店切换**；会议明确要求的"市场级先看汇总 → 点进某门店看明细"根本没有入口

#### 1.1.4 横切关注点现状

| 项 | 现状 |
|---|------|
| 权限检查点 | admin `requirePermission(session, action)` 完整；staff `requireManager()` 二值；没有 scope 层权限校验 |
| 审计日志 `operation_logs.operator_employee_id` | 已就位（v3.3） |
| seed 测试数据 | `fengyu-admin/src/db/seed.ts` 生成各类角色 + 典型 scope（需二次确认映射） |
| WorkFine 同步 | sync-workfine 按 position 硬编码推导 manager/finance/staff（见 §1.1.2） |
| 数据迁移 | org_nodes 若存在 type='部门' 的历史行，删除前需先检查 permission_roles.scope_id 和 staff_wechat_users.org_node_id 引用 |

### 1.2 期望行为（会议目标态）

#### 1.2.1 数据模型层

1. **组织架构三层固化**：`orgNodeTypeEnum` 去掉"部门"，只保留 `总部 / 市场 / 门店`。
2. **角色语义澄清**：保留 7 个角色（admin/manager/finance/hr/product/customer_mgr/staff），但在产品文档中明确"manager = 经理（业务操作）"与会议"经理=全部权限"的映射关系；在 ROLE_LABELS 调整或在员工端隐藏角色名。
3. **permission_roles 结构已足够**：`role × scope_id` 正是双维度；不需要新字段。只需保证每次写入时 `scope_id` 指向的 `org_nodes.type ∈ {总部, 市场, 门店}`。

#### 1.2.2 逻辑层

1. **员工端 auth 中间件必须返回 scope 信息**：
   - `ctx.auth.roles` 升级为 `Array<{ role, scopeId, scopeType }>`（与 admin 对齐）
   - 新增 `ctx.auth.scopeStoreIds`（云函数版 `expandScopeStoreIds`）
2. **员工端云函数数据查询引入 scope 展开**：
   - `staff.dashboard` / `staff.todoList` / `staff.todayCommission` 等接口按 `scopeStoreIds` 过滤，而非硬编码单 `storeId`。
   - 支持 `payload.storeId` 参数做"在市场范围内切到某门店"的下钻，但必须校验传入 storeId ∈ `scopeStoreIds`。
3. **多门店切换策略**：市场级 manager 首页展示聚合数据（跨门店 UNION），点击"切换门店"后带 `storeId` 参数复用同一接口。
4. **3.5 层区域经理**：**本次不实现**，仍以"市场·manager"近似（片区经理目前就是这样推导的）。
5. **sync-workfine 权限推导**：
   - "财智部"员工应提升到 market 或 headquarters scope（由业务确认，本报告不擅自决定）
   - 保持现有 position 到 role 的映射，但加入注释提示与会议"双维度"语义的对应关系

#### 1.2.3 渲染层

1. **员工端显示职位而非角色名**（已满足，无改动）
2. **工作台：多门店管理者的标题/副标题**
   - 市场级：副标题显示"管辖 N 家门店"或市场名
   - 提供"切换门店"入口 → 弹出 scopeStoreIds 对应门店列表
3. **数据看板：支持按门店过滤**
   - 增加门店切换 Tab 或 Picker（仅 scopeStoreIds.length > 1 时显示）
   - 传 `storeId` 参数到 `staff.dashboard`
4. **role.ts 升级**：新增 `getScopeType()`、`isMarketScope()`、`getScopeStoreIds()` 辅助函数
5. **admin 菜单（可选）**：无需变更，因为菜单按 role 显隐、数据按 scope 过滤的现有范式已经能同时服务门店级和市场级 manager
6. **admin 权限页面**：部门过滤改为后端保证（枚举不再有"部门"）而非前端 filter

---

## 2. 差异分析表

| # | 维度 | 当前 | 期望 | 影响范围 | 变更类型 |
|---|------|------|------|---------|---------|
| D1 | `org_node_type` 枚举 | 含"部门" | 只有"总部/市场/门店" | `db/schema/enums.ts` → types.ts → actions/org.ts → permissions-page filter → seed → WorkFine 同步 | **结构性**（枚举收窄） |
| D2 | `OrgNode.type` TS 联合类型 | 含 `'部门'` | 不含 `'部门'` | `fengyu-admin/src/lib/types.ts:6` | **结构性**（联合类型） |
| D3 | permission_roles 结构 | role + scope_id | role + scope_id（不变） | — | 无变更 |
| D4 | 员工端 `ctx.auth.roles` 类型 | `string[]` | `Array<{role, scopeId, scopeType}>` | `staffApi/middleware/auth.js`, `routes/auth.js`, 所有 `roles.includes(...)` 调用点 | **结构性**（后端契约） |
| D5 | 员工端 scope 展开能力 | 无 | 新增 `expandScopeStoreIds(roles)` 工具 | `staffApi/utils/scope.js` (新文件), 各业务路由 | 逻辑新增 |
| D6 | `staff.dashboard` 数据范围 | 二元分流（整店 / 个人） | 按 `scopeStoreIds` + 可选 storeId 过滤 | `staffApi/routes/staff.js:573-693` | 逻辑变更 |
| D7 | `staff.todoList` 数据范围 | 同 D6 | 同 D6 | `staffApi/routes/staff.js:311-378` | 逻辑变更 |
| D8 | `staff.todayCommission` 店长分支 | 单 `storeId` 查询店内业绩 | 支持多 storeId 或 scope 内 UNION | `staffApi/routes/staff.js:146-233` | 逻辑变更 |
| D9 | `globalData.roles` 前端类型 | `string[]` | `Array<{role, scopeId, scopeType}>` 或保留 string[] + 新增 `scopeType`/`scopeStoreIds` | `fengyu-staff/miniprogram/app.ts:5-13`, typings | **结构性**（类型）+ 逻辑 |
| D10 | `utils/role.ts` API | `isManager()/isBeautician()` | 新增 `getScopeType()`、`isMarketScope()`、`getScopeStoreIds()` | `fengyu-staff/miniprogram/utils/role.ts` | 逻辑新增 |
| D11 | 员工端职位展示 | 已展示 position | 保持 | — | 无变更（对齐） |
| D12 | 工作台多门店入口 | 单门店 | 市场级显示聚合 + 切换门店 | `pages/workbench/workbench.ts/.wxml` | 逻辑新增 |
| D13 | 数据看板门店切换 | 无 | 市场级可下钻到门店 | `packageOrder/dashboard/*.{ts,wxml}` | 逻辑新增 |
| D14 | `ROLE_LABELS.manager` | `'店长'` | （admin 端内部仍用"店长"；员工端已不展示 role 名）→ 不改 | `fengyu-admin/src/lib/types.ts:132` | 无变更 |
| D15 | PERMISSION_MATRIX | 7 角色 | 保持 | — | 无变更 |
| D16 | admin 权限页部门过滤 | 前端 `filter(n.type !== '部门')` | 删除过滤（枚举已不含部门） | `permissions-page.tsx:121` | 逻辑简化 |
| D17 | admin OrgTreeSelect `excludeTypes` | `["部门"]` | `[]` 或删除参数 | `permissions-page.tsx:421` 等 | 逻辑简化 |
| D18 | admin actions/org.ts 部门校验 | "不可嵌套"、"门店下只能建部门" | 删除 | `fengyu-admin/src/actions/org.ts:15, 84-89` | 逻辑删除 |
| D19 | `staff_wechat_users.org_node_id` 语义 | 指向任意节点（含部门） | 指向 store 或更高层节点 | schema 注释 + `auth.js` 的 `d.name AS department` JOIN | 逻辑调整 |
| D20 | sync-workfine 部门→角色映射 | `dept === '财智部' → finance+store` | 由业务确认 finance 应落哪个 scope | `db/scripts/sync-workfine.js:455-457` | **业务决策项** |
| D21 | `staff.departments` 云函数接口 | 按 `org_nodes.type='部门'` 分组 | 降级为按 `position_name` 分组 或 整体废弃 | `staffApi/routes/staff.js:58-141` | 逻辑变更 |
| D22 | `positions` 表 scope 字段 | `total/market/store`（已用中文 positionScopeEnum） | 保持 | — | 无变更 |
| D23 | 区域经理 3.5 层 | 无专门支持，用"市场·manager"近似 | 待定 | — | **遗留事项** |
| D24 | operation_logs.org_node_id | 存在 | 保留，但部门相关日志需 ETL 处理历史数据 | 审计日志老数据 | 数据迁移 |

---

## 3. 修改计划（按执行顺序）

### 阶段 A：数据模型收窄（交接 /wx-change-propagation）

> **先扫描后执行**：以下改动涉及枚举收窄，必须先走 `/wx-change-propagation` 的 10 层传播扫描。

#### A1. 移除 `orgNodeTypeEnum` 的"部门"值

**结构性变更（D1）** → 交接 `/wx-change-propagation org_node_type 移除"部门"`

扫描目标（最小集合，实际由 propagation 工具补齐）：
- `db/schema/enums.ts:50` 定义
- `db/schema/org.ts:8-15` 注释
- `fengyu-admin/src/lib/types.ts:6` TS 联合类型
- `fengyu-admin/src/actions/org.ts:15,84-89` VALID_NODE_TYPES 常量与业务校验
- `fengyu-admin/src/app/(main)/permissions/_components/permissions-page.tsx:121` 前端过滤
- `fengyu-admin/src/components/ui/org-tree-select.tsx` 若有 excludeTypes 默认值
- `db/scripts/sync-workfine.js` 同步脚本中涉及部门节点创建/读取
- `db/seed.ts`（admin seed 与 db seed）
- 任何 `where type = '部门'` 的查询
- `docs/` 与 `.42cog/` 文档

**前置检查**（propagation 执行前）：

```sql
-- 1. 查询是否存在 type='部门' 的历史行
SELECT id, name, parent_id FROM org_nodes WHERE type = '部门';

-- 2. 查询这些部门节点是否被 permission_roles 或 staff_wechat_users 引用
SELECT pr.id, pr.employee_id, pr.role, pr.scope_id, n.name
FROM permission_roles pr
JOIN org_nodes n ON pr.scope_id = n.id
WHERE n.type = '部门';

SELECT u.employee_id, u.name, u.org_node_id, n.name
FROM staff_wechat_users u
JOIN org_nodes n ON u.org_node_id = n.id
WHERE n.type = '部门';
```

**迁移决策**（需业务确认）：
- 选项 A：把部门节点下的员工重新挂到其父节点（store / market / headquarters），部门节点软删除（`is_active = false`），**然后**再从枚举删除"部门"值
- 选项 B：把 `staff_wechat_users.org_node_id` 直接置空，保留 `position_name` 作为部门信息（本质上员工端 `auth.js` 的 `d.name AS department` 需要改为另找数据源）

⚠️ **注意 feedback_no_legacy_compat**（开发阶段不需要历史数据兼容）——但 permission_roles 的 FK 不可为空，若存在引用必须先迁移再删枚举，否则 `scope_id → org_nodes.id` 外键会报错。

**迁移迁移文件草稿**（示意，由 propagation 工具生成）：

```sql
-- db/migrations/00XX_drop_department_from_org_node_type.sql

-- 1. 把部门员工 org_node_id 置空
UPDATE staff_wechat_users
SET org_node_id = NULL
WHERE org_node_id IN (SELECT id FROM org_nodes WHERE type = '部门');

-- 2. 删除部门节点（硬删）
DELETE FROM org_nodes WHERE type = '部门';

-- 3. 收窄枚举（postgres 需要 rename + add new + drop old 流程）
ALTER TYPE org_node_type RENAME TO org_node_type_old;
CREATE TYPE org_node_type AS ENUM ('总部', '市场', '门店');
ALTER TABLE org_nodes
  ALTER COLUMN type TYPE org_node_type USING type::text::org_node_type;
DROP TYPE org_node_type_old;
```

#### A2. 删除 OrgNode TS 类型中的 `'部门'`

**结构性变更（D2）** → 与 A1 同批执行

- `fengyu-admin/src/lib/types.ts:6` → `type: '总部' | '市场' | '门店'`
- `AuthSession.roles[i].scopeType` 已经是这三个值，无变更
- 删除后 `permissions-page.tsx:121` 的 `filter` 和 `OrgTreeSelect excludeTypes` 都可以简化

#### A3. 删除 admin actions/org.ts 的部门业务规则

**逻辑变更（D18）**

- 删除 `VALID_NODE_TYPES = [..., '部门']` 中的 `'部门'`
- 删除 "部门不可嵌套"、"门店下只能建部门" 校验分支
- 新增校验："门店节点不可再有子节点"（即门店是叶子节点）

### 阶段 B：员工端后端契约升级（关键变更）

#### B1. `staffApi/middleware/auth.js` 返回带 scope 的 roles

**结构性变更（D4）**

将查询从：

```js
const roleRows = await pg.query(
  'SELECT role FROM permission_roles WHERE employee_id = $1',
  [user.employee_id]
)
roles = roleRows.map(r => r.role)
```

改为：

```js
const roleRows = await pg.query(`
  SELECT pr.role, pr.scope_id, n.type AS scope_type
  FROM permission_roles pr
  LEFT JOIN org_nodes n ON n.id = pr.scope_id
  WHERE pr.employee_id = $1
`, [user.employee_id])

roles = roleRows.map(r => ({
  role: r.role,
  scopeId: r.scope_id,
  scopeType: r.scope_type,   // '总部' | '市场' | '门店'
}))
```

并在 `ctx.auth` 中同时暴露：
- `roles: Array<{ role, scopeId, scopeType }>`（新）
- `scopeStoreIds: string[]`（新，预计算好）
- 为了向下兼容，可保留 `roleNames: string[]`（即原 `roles.map(r => r.role)`），或直接全量改造所有调用点

**调用点清单（需同步修改）**：

使用 Grep 扫描 `ctx.auth.roles.includes` / `roles.includes('manager')`：

- `staffApi/routes/staff.js:149,314,416,577` — 全部是 `roles.includes('manager')` 判定
- `staffApi/routes/allocation.js` — `requireManager` 中间件内已通过 `ctx.auth.roles.includes('manager')` 判定
- `staffApi/middleware/auth.js:139` — `requireManager` 中间件
- `staffApi/__tests__/middleware/auth.test.js` — 测试 mock 数据

**迁移策略建议**：
保留 `roles: string[]`（简单字符串数组）继续供 `requireManager` 等使用，另加 `scopedRoles: Array<{role, scopeId, scopeType}>` 和 `scopeStoreIds: string[]` 给新逻辑用。避免一次性改动全部调用点，降低变更面。

#### B2. 新增 `staffApi/utils/scope.js` 工具模块

**逻辑新增（D5）**

参考 `fengyu-admin/src/lib/permissions.ts:91-133` 的 `expandScopeStoreIds` 移植到云函数：

```js
// staffApi/utils/scope.js
async function expandScopeStoreIds(pgClient, scopedRoles) {
  const ids = new Set()
  for (const r of scopedRoles) {
    if (r.scopeType === '总部') {
      const { rows } = await pgClient.query('SELECT store_id FROM stores')
      rows.forEach(row => ids.add(row.store_id))
      return Array.from(ids)
    }
    if (r.scopeType === '市场') {
      const { rows } = await pgClient.query(`
        SELECT s.store_id FROM stores s
        JOIN org_nodes n ON n.id = s.org_node_id
        WHERE n.parent_id = $1 AND n.type = '门店'
      `, [r.scopeId])
      rows.forEach(row => ids.add(row.store_id))
    }
    if (r.scopeType === '门店') {
      const { rows } = await pgClient.query(
        'SELECT store_id FROM stores WHERE org_node_id = $1',
        [r.scopeId]
      )
      rows.forEach(row => ids.add(row.store_id))
    }
  }
  return Array.from(ids)
}

module.exports = { expandScopeStoreIds }
```

**调用时机**：`auth.js` 中间件在查到 `scopedRoles` 后立即调用，结果挂到 `ctx.auth.scopeStoreIds`。缓存 5 分钟（沿用现有 `AUTH_CACHE`）。

#### B3. `staffApi/routes/auth.js` login/bindPhone 返回 scope 信息

**结构性变更**

- `queryRoles()` 同 B1 升级，返回 `{role, scopeId, scopeType}[]`
- `ctx.result` 新增 `scopedRoles`、`scopeStoreIds`、`isMultiStore`（便捷布尔）
- 为了前端兼容，同时保留 `roles: string[]`（从 scopedRoles 派生）
- 前端 `app.ts` 的 `globalData` 接收新字段

### 阶段 C：员工端数据接口 scope 化（D6-D8）

#### C1. `staff.dashboard` 支持 scope 和门店切换

**逻辑变更**

- payload 新增可选 `storeId`
- 若 `storeId` 传入，校验 `storeId ∈ ctx.auth.scopeStoreIds`，否则 403
- 若不传 `storeId`：
  - manager + scopeStoreIds.length > 1 → 按 `scopeStoreIds` 全部 UNION 聚合（管辖范围汇总）
  - manager + scopeStoreIds.length == 1 → 传统单店查询
  - 非 manager → 按 `assigned_employee_id = staffWfId`（保持原逻辑）
- SQL 示例：

```sql
WHERE (
  CASE WHEN $useStoreFilter THEN so.store_id = ANY($storeIds)
  ELSE TRUE END
)
  AND so.status = '已完成'
  AND so.service_date BETWEEN $start AND $end
```

#### C2. `staff.todoList` 同 C1 处理

- manager 分支用 `scopeStoreIds` 替代 `storeId`
- 聚合类目（待确认预约/服务单/线下收款/开单/解绑/提成分配）的 SQL 从 `store_id = $1` 改为 `store_id = ANY($scopeStoreIds)`

#### C3. `staff.todayCommission` 店长专属数据

- `storeTodayRevenue` 分支在 market scope 场景下展示"管辖门店合计"
- 可增加 `perStoreRevenue: [{ storeId, storeName, revenue }]` 便于前端展示 breakdown

#### C4. `staff.performanceDetail` 无需改动

绩效明细是**按员工本人**查询（`sa.employee_id = targetEmployeeId`），不按门店过滤，不受双维度影响。

### 阶段 D：员工端前端交互升级（D9-D13）

#### D1. `app.ts` globalData 结构扩展

- 新增 `scopedRoles: Array<{role, scopeId, scopeType}>`
- 新增 `scopeStoreIds: string[]`
- 新增 `scopeType: '总部' | '市场' | '门店'`（取最高级别，用于 UI 分支）
- 新增 `isMultiStore: boolean`
- 从 wx.storage 读写持久化

#### D2. `utils/role.ts` 扩展

```ts
export function getScopeType(): '总部' | '市场' | '门店' | null {
  return getApp<IAppOption>().globalData.scopeType ?? null;
}
export function isMarketScope(): boolean {
  return getScopeType() === '市场';
}
export function isHeadquartersScope(): boolean {
  return getScopeType() === '总部';
}
export function getScopeStoreIds(): string[] {
  return getApp<IAppOption>().globalData.scopeStoreIds ?? [];
}
export function isMultiStore(): boolean {
  return getScopeStoreIds().length > 1;
}
```

`isManager()` 保持二元语义不变（只看是否有 manager role）。

#### D3. 工作台首页多门店展示

- 顶部 `commission-store-name` 在市场级 manager 场景改为市场名（需要从 scopedRoles 中找 `scopeType='市场'` 的 scope 对应名称）
- 加一个"切换门店"按钮（`isMultiStore()` 时显示），弹出 vant Popup 显示 scopeStoreIds 对应门店列表
- 切换后 `app.setSelectedStoreId(storeId)` → 重新调用 `loadWorkbench()` 传 storeId

#### D4. 数据看板按门店切换

- 页面顶部增加门店 Tab 或 Picker（`isMultiStore()` 时显示），默认"全部（管辖汇总）"
- 调用 `staff.dashboard` 时传 `{ storeId }`（空=汇总）
- UI 显示"当前范围：XX 市场 · 全部 N 家门店" / "XX 门店"

#### D5. Profile "我的" 页：无改动

- 继续展示 `position`（已正确）
- 可选改进：在市场/总部 scope 时显示"所辖范围：X 市场 / 全国"副标题

### 阶段 E：admin 端清理（D16-D18）

#### E1. 删除部门相关前端过滤

- `permissions-page.tsx:121`：`orgNodes.filter(n => n.isActive && n.type !== "部门")` → `orgNodes.filter(n => n.isActive)`
- `permissions-page.tsx:421` 及其他 `excludeTypes={["部门"]}` 可删除

#### E2. 删除 `fengyu-admin/src/actions/org.ts` 的部门校验

- 删除 `VALID_NODE_TYPES` 中的 `'部门'`
- 删除 "部门不可嵌套"、"门店下只能建部门" 分支
- 新增（或改为）"门店是叶子节点，不可再建子节点"

#### E3. `fengyu-admin/src/actions/dashboard.ts` 可选增强

- 当前 `scopeStoreIds` 已经正确展开 market → stores，无需改动
- 可考虑给 `adminStats` 分类，对 market 级 manager 也返回 adminStats（但会议未明确要求，本次不做）

### 阶段 F：WorkFine 同步脚本审视（D20）

#### F1. 权限推导重新对齐

`db/scripts/sync-workfine.js:436-468` 当前映射：

| position/dept | → role | → scope |
|---|---|---|
| 含"代理" | staff | store |
| 门店经理 | manager | store |
| 市场总监/片区经理 | manager | market |
| 财智部 | finance | store |
| 其他 | staff | store |

**待业务确认**：
1. 财智部员工的 scope 应是 store、market 还是 headquarters？会议原文说"市场·财务可看所属市场的财务汇总数据"暗示至少 market 级。
2. 是否需要自动推导"总部·财务"（例如总部财务部门员工）？
3. "片区经理"（3.5 层）保持当前"市场·manager"推导，不新增专属 scope 类型。

**本次不擅自修改同步脚本**，只在报告中登记为待决策项，等业务方给出映射表后再走 `/wx-change-propagation` 修改。

### 阶段 G：测试与文档

#### G1. 单元测试

- `fengyu-admin/src/lib/permissions.test.ts` — 已测 scope 展开，补充"删除部门类型后"的测试断言
- `staffApi/__tests__/middleware/auth.test.js` — 新增带 scopedRoles 的测试 case
- `staffApi/__tests__/utils/scope.test.js` — 新增 `expandScopeStoreIds` 的单测（3 种 scopeType 各 1 例）
- `staffApi/__tests__/routes/staff.test.js` — dashboard/todoList scope 过滤测试

#### G2. E2E 测试

- admin e2e：分配 `manager + 市场 scope` → 登录 → 看到 scope 内所有门店的订单（现有测试应已覆盖）
- staff 人工验证：用市场总监账号登录员工端 → 工作台看到管辖门店汇总 → 切换到某店看明细

#### G3. 文档更新

- `.42cog/cog.md` §权限设计：补充双维度图示
- `.42cog/pm/admin.pr.spec.md` §2：澄清"manager（业务经理）"与会议"经理（全部权限）"的关系
- `.42cog/pm/staff.pr.spec.md`：新增 scope 概念章节，说明多门店管理者流程
- `fengyu-staff/miniprogram/CLAUDE.md`：globalData 新字段说明
- `fengyu-staff/cloudfunctions/staffApi/CLAUDE.md`：`ctx.auth` 字段扩展说明
- `db/CLAUDE.md`：org_nodes 层级约束更新（去部门）

---

## 4. 结构性变更 vs 逻辑变更分类

### 4.1 必须交接 `/wx-change-propagation` 的结构性变更

| 变更 | 原因 |
|---|------|
| A1: `orgNodeTypeEnum` 收窄 | 枚举值变更，涉及 10 层传播图 |
| A2: `OrgNode.type` TS 联合类型 | TS 联合类型变更 |
| B1: `ctx.auth.roles` 字段类型 | 云函数契约变更，影响所有路由的 `roles.includes()` 调用 |

### 4.2 本技能可直接指导的逻辑变更

| 变更 | 原因 |
|---|------|
| B2: `staffApi/utils/scope.js` 新增 | 新文件、新函数 |
| B3: login/bindPhone 返回字段新增 | 向上兼容的加字段 |
| C1-C3: dashboard/todoList/commission scope 化 | 单文件内部逻辑改写 |
| D1-D4: 员工端前端交互 | 小程序页面/组件改造 |
| E1-E3: admin 部门过滤清理 | 删除废弃代码分支 |
| G1-G3: 测试和文档 | 周边工作 |

### 4.3 需业务决策的项目

| 项 | 待决策内容 |
|---|---|
| D20 / F1 | sync-workfine 中 `财智部` 员工 scope 应落在哪一层（store/market/headquarters） |
| 遗留 | 部门节点历史数据如何清理（选项 A 上推 vs 选项 B 置空） |
| 遗留 | 3.5 层区域经理是否立项（本次确认不做） |
| 遗留 | 是否需要自动推导 `hr`/`product` 角色（总部职能） |

---

## 5. 执行顺序与依赖

```
┌─ 阶段 A (枚举收窄) ─ /wx-change-propagation
│      │
│      ├── A1: orgNodeTypeEnum
│      ├── A2: TS 联合类型
│      └── A3: actions/org.ts 业务规则
│              │
│              ▼
├─ 阶段 E (admin 清理) ← A 完成后自然脱落
│      │
│      ▼
├─ 阶段 B (云函数契约) ─ 依赖 A1 完成
│      │
│      ├── B1: auth.js 中间件
│      ├── B2: utils/scope.js 新增
│      └── B3: auth.js 路由
│              │
│              ▼
├─ 阶段 C (staffApi 路由) ─ 依赖 B
│      │
│      ├── C1: dashboard
│      ├── C2: todoList
│      └── C3: todayCommission
│              │
│              ▼
├─ 阶段 D (前端改造) ─ 依赖 C
│      │
│      ├── D1-D2: globalData + role.ts
│      ├── D3: 工作台
│      └── D4: 数据看板
│              │
│              ▼
├─ 阶段 F (同步脚本) ─ 需业务决策，不阻塞前端
│              │
│              ▼
└─ 阶段 G (测试 + 文档) ─ 最后
```

关键路径：A → B → C → D → G
可并行：A 进行时 E 可提前 PR（因为 E 仅清理前端死代码，不影响枚举迁移）

---

## 6. 关键代码位置速查

### 6.1 数据库层
- 枚举定义：`db/schema/enums.ts:50`（orgNodeTypeEnum）
- 组织架构表：`db/schema/org.ts:17-34`
- 权限角色表：`db/schema/permission.ts:12-35`
- 职位字典：`db/schema/lookup.ts:10-20`
- 迁移：`db/migrations/0016_permission_roles_hard_delete.sql`（软删除→硬删除）
- 同步脚本权限推导：`db/scripts/sync-workfine.js:403-478`

### 6.2 Admin 后端层
- 权限矩阵：`fengyu-admin/src/lib/permissions.ts:15-68`
- scope 展开：`fengyu-admin/src/lib/permissions.ts:91-133`
- scopeCondition 辅助：`fengyu-admin/src/lib/permissions.ts:167-179`
- Session 构造：`fengyu-admin/src/actions/auth.ts:164-218`
- 类型定义：`fengyu-admin/src/lib/types.ts:6, 93-103, 127-138, 341-352, 442-455`
- 菜单配置：`fengyu-admin/src/lib/menu.ts:39-85`
- 权限 Server Actions：`fengyu-admin/src/actions/permissions.ts:14-283`
- 仪表板：`fengyu-admin/src/actions/dashboard.ts:36-123`
- 组织架构 actions：`fengyu-admin/src/actions/org.ts:15,84-89`
- 权限管理 UI：`fengyu-admin/src/app/(main)/permissions/_components/permissions-page.tsx:115-482`

### 6.3 员工端云函数层
- 认证中间件：`fengyu-staff/cloudfunctions/staffApi/middleware/auth.js:20-144`
- login/bindPhone：`fengyu-staff/cloudfunctions/staffApi/routes/auth.js:62-220`
- dashboard：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:573-693`
- todoList：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:311-378`
- todayCommission：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:146-233`
- performanceDetail：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:412-566`
- requireManager 校验：`fengyu-staff/cloudfunctions/staffApi/middleware/auth.js:134-144`

### 6.4 员工端前端层
- 全局状态：`fengyu-staff/miniprogram/app.ts:5-108`
- 角色工具：`fengyu-staff/miniprogram/utils/role.ts:1-22`
- 工作台页面：`fengyu-staff/miniprogram/pages/workbench/workbench.ts:43-77`
- 工作台 WXML：`fengyu-staff/miniprogram/pages/workbench/workbench.wxml:12-20`
- Profile 页面：`fengyu-staff/miniprogram/pages/profile/profile.ts:22-42`
- Profile WXML：`fengyu-staff/miniprogram/pages/profile/profile.wxml:12`
- 数据看板：`fengyu-staff/miniprogram/packageOrder/dashboard/dashboard.ts:29-80`

---

## 7. 横切关注点检查清单

| 项 | 状态 | 说明 |
|---|---|---|
| ☑ 权限检查 | 需新增 | `requireScope(scopeType)` 类似 `requireManager` 的中间件（可选） |
| ☑ 审计日志 | 已就位 | `operation_logs.operator_employee_id` 已记录；scope 变更可在 logOperation detail 中写 scopeId |
| ☑ 数据完整性 | 需前置检查 | 删除"部门"枚举前必须清理 `permission_roles.scope_id` / `staff_wechat_users.org_node_id` 的外键引用 |
| ☑ WorkFine 同步 | 待业务决策 | 财智部 finance scope 映射需确认（§F1） |
| ☑ seed 测试数据 | 需更新 | `fengyu-admin/src/db/seed.ts` 若创建部门节点需删除；增加 market 级 manager 典型 seed |
| ☑ 现有数据迁移 | 需前置检查 | 查询生产 `type='部门'` 的节点数量，决定选项 A/B |
| ☑ 测试覆盖 | 需新增 | 云函数 scope 过滤单测 + E2E 市场级 manager 流程 |
| ☑ 文档同步 | 需新增 | `.42cog` + `CLAUDE.md` 三处 |

---

## 8. 风险点

### 8.1 结构性风险

**R1. 部门枚举移除可能破坏生产数据**
- 现状：`staff_wechat_users.org_node_id` 可能指向部门节点，同步脚本依赖 `d.name AS department` JOIN (`staffApi/middleware/auth.js:54`)
- 缓解：执行 A1 前必须 SQL 查询确认生产库部门节点数量；如有非零行，走选项 A（员工上推挂到父节点）做迁移
- 影响面：若有历史 `permission_roles.scope_id` 指向部门节点，直接删枚举会 FK 违约

**R2. `ctx.auth.roles` 类型变更可能破坏现有云函数**
- 现状：多个路由直接 `ctx.auth.roles.includes('manager')`
- 缓解：B1 建议保留 `roles: string[]` 字段，另加 `scopedRoles` / `scopeStoreIds` 新字段；避免破坏现有代码
- 测试：staffApi `__tests__/middleware/auth.test.js` 必须通过

### 8.2 逻辑风险

**R3. 市场级 manager 聚合查询性能**
- 现状：`staff.dashboard` 目前单店查询；改为多店 UNION 可能导致 `sale_orders`/`service_orders` 扫表
- 缓解：确认 `sale_orders.store_id` 有索引（已有）；SQL 用 `store_id = ANY($1)` 而非 `OR` 链；避免 JOIN 爆炸
- 监控：部署后观察 dashboard 接口 P95 响应时间

**R4. 多门店切换状态同步**
- 现状：`app.globalData.boundStoreId` 是单值；市场级切换门店后要保证所有页面感知
- 缓解：新增 `app.globalData.selectedStoreId`（与 boundStoreId 分开）+ 事件广播；下游页面监听 storeId 变化刷新

### 8.3 待定事项

**R5. 3.5 层区域经理（南昌场景）** 🔴
- **状态**：暂不支持，会议明确"需另行讨论"
- **近似方案**：sync-workfine 已把"片区经理"推导为 `market·manager`，即把区域等同市场一层看待
- **问题**：若同一市场内同时存在"市场总监（管全市场）"和"片区经理（只管 3-5 家店）"，当前代码无法区分——两人都有 `market scope` 的 manager 权限
- **后果**：片区经理能看到他本不该看的同市场其他门店的数据
- **本次不做**，记录为遗留事项，等专门会议出方案（可能需要引入 scope_id 的子集概念或 scope_store_ids 白名单字段）

**R6. 财智部 scope 归属** 🟡
- sync-workfine 当前把"财智部"员工推为 `finance+store` scope
- 会议"市场·财务"暗示至少应该是 market 级
- **本次不做**，等业务确认映射

**R7. hr/product 总部角色的数据来源** 🟡
- 目前 sync-workfine 完全不推导 hr/product 角色，只能通过 admin 手动分配
- 会议典型映射说"总部人事 → 总部·人事"，但 WorkFine 数据库里是否有字段能识别"总部人事"？
- **本次不做**，需业务提供数据源或沿用手动分配

---

## 9. 职位展示的数据源确认

根据 20260407 §四决议"员工端小程序展示职位而非角色名称"：

| 数据源 | 字段 | 来源 |
|---|---|---|
| 根源 | `staff_wechat_users.position_name` (text) | WorkFine 同步 + 管理后台维护 |
| 云函数输出 | `ctx.auth.position`, `login/bindPhone 返回 position` | `staffApi/middleware/auth.js:45, 96` + `routes/auth.js:67, 106, 187` |
| 前端存储 | `app.globalData.position` | `fengyu-staff/miniprogram/app.ts:8` |
| 前端展示 | `profile.wxml:12`, `workbench.wxml:19` | `{{position \|\| '未绑定'}}` |

**结论**：职位链路已完整，不需要改动。展示的是 `staff_wechat_users.position_name`（自由文本，通常是"门店经理"/"美容师"/"市场总监"等），不是 `permission_roles.role`（系统角色代号）。

**注意点**：`ROLE_LABELS.manager = '店长'`（`types.ts:132`）是 **admin 管理后台内部**使用的中文名，员工端不会拿到这个字符串——所以会议"店长二字不雅"的担忧只适用于员工端，而员工端本来就没用 ROLE_LABELS。修改 ROLE_LABELS 反而会影响 admin 端权限管理页面的显示（如图中"店长"badge）。

**建议**：
- ROLE_LABELS 保持 `'店长'`，因为这是业务方能理解的词
- 或者把 `manager: '业务经理'` 与会议"经理"对齐（更中性）
- 员工端坚持展示 `position_name`，不要回退到 role 名称

---

## 10. 会议决议与代码现状对应关系

| 会议决议 | 代码现状 | 差距 | 行动项 |
|---|---|---|---|
| 总部/市场/门店三层 | `orgNodeTypeEnum` 含部门 | 枚举有多余值 | §A1 |
| 部门层级已移除 | actions/org.ts 仍有部门规则 | 死代码 | §A3, §E2 |
| role × scope 双维度 | `permission_roles` 已双维度 | ✅ | 无 |
| 5 职能角色 | 代码有 7 角色 | 语义偏差但技术合理 | 文档澄清 |
| 同一店长分配不同层级 | `permission_roles` 支持多行 | ✅ | 无 |
| 员工端展示职位不展示角色 | workbench/profile 已用 position | ✅ | 无（保持） |
| 市场级看汇总 + 门店切换 | staff.dashboard 单店分流 | **核心缺失** | §B, §C, §D |
| 后台管理员独立角色 | `admin` 角色已定义 | ✅ | 无 |
| 3.5 层区域经理 | 片区经理 = 市场 manager（近似） | **不精确** | 遗留 |

---

## 11. 后续交接说明

### 11.1 交接给 `/wx-change-propagation` 的项

```
/wx-change-propagation 删除 org_node_type 枚举中的"部门"值
/wx-change-propagation 删除 OrgNode.type 联合类型中的 '部门'
```

执行时需要工具给出 10 层影响图并确认每层的修改点。

### 11.2 本技能直接指导的后续任务

阶段 B/C/D 所有变更，按 §5 执行顺序依次进行。每个阶段建议单独 PR，便于 review 和回滚。

### 11.3 需业务方确认的决策

1. 财智部 finance 的 scope 层级
2. 总部人事/产品是否自动推导（需 WorkFine 数据源确认）
3. 3.5 层区域经理立项时间
4. 部门历史数据处理方式（选项 A 或 B）

这些问题建议在下次张凯例会里集中确认，给出书面答案后再走对应变更。

---

## 12. 附录：关键术语对照表

| 会议术语 | 代码术语 | 备注 |
|---|---|---|
| 地理层级 | scope / scopeType / orgNodeType | pg enum 'org_node_type' |
| 总部 | headquarters / 总部 | 中文值 |
| 市场 | market / 市场 | 中文值 |
| 门店 | store / 门店 | 中文值 |
| 职能角色 | role / RoleType | permission_roles.role |
| 经理（全部权限） | manager (业务) + admin (系统) | 代码拆成两个 |
| 财务 | finance | |
| 人事 | hr | |
| 产品 | product | |
| 员工 | staff | |
| 顾客管理 | customer_mgr | 代码补丁角色 |
| 权限范围 | scope_id → org_nodes.id | |
| 典型岗位"店长" | position_name = '门店经理' | 员工档案的自由文本 |
| 区域经理 | position_name = '片区经理' | 当前被映射为市场·manager（不精确） |

---

**报告终**
