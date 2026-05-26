# Ticket：staff 端登录层级切换 + 权限 4 层归并 + 管理层独立视图

> 生成日期：2026-04-24
> 最后更新：2026-04-24（决策对齐后）
> 严重级别：P1
> 端：fengyu-staff（前端 + staffApi）
> 影响面：db（不改）+ staffApi.auth + 中间件 + 前端 tabBar 结构 + `utils/role.ts` + 现有 5 个 tab 页 + 2 个新 tab 页（数据中心/排行榜）
> 预计工作量：**5~6 天**，拆分为 **PR-A（基础）+ PR-B（管理层 tab 视图）**

---

## 0 一句话背景

staff 端当前只做了"店长/员工"二分判定（`globalData.roles.includes('manager')`），无法承载"总部/市场员工以管理层身份登录"的场景。admin 侧的权限模型是 `(7 角色) × (3 scope 类型 = 总部/市场/门店)`，粒度合适但对 staff 端过重。

本 ticket 做 3 件事：
1. **登录界面**按员工权限能力动态展示「门店/管理层」radio，默认门店
2. 把 admin 的 `(role, scopeType)` 组合**归并为 4 个 staff 层级**：总部 / 市场 / 店长 / 员工
3. **管理层视图**独立 tabBar：首页（数据中心）/ 排行榜 / 顾客 / 我的；门店视图保持现有 5 tab 但**首页新增多门店下拉切换**

---

## 1 现状快照

### 1.1 数据模型（不改）

- `db/schema/permission.ts` `permission_roles(employee_id, role, scope_id)`
  - 一人可多角色多 scope
  - 角色：`admin / manager / finance / hr / product / customer_mgr / staff`
  - `scope_id` FK `org_nodes.id`，节点 `type ∈ {headquarters, market, store, department}`
- admin 端 `PERMISSION_MATRIX` 见 `fengyu-admin/src/lib/permissions.ts:15`（本 ticket **不改 admin**）

### 1.2 staff 端现状

- `staffApi/routes/auth.js`：`login` / `bindPhone` 仅返回 `roles: string[]`，丢失 scope
- `staffApi/middleware/auth.js`：`ctx.auth.roles = string[]`
- `utils/role.ts` 只有 `isManager()` / `isBeautician()`
- `pages/login/login.*`：单纯"授权手机号登录"按钮
- `app.json` tabBar 5 项硬编码，`dashboard` 在 `packageOrder` 分包

---

## 2 目标模型

### 2.1 staffLevel 归并规则

给定员工全部 `(role, scopeType)` 对，派生单一 `staffLevel`（取最高）：

```
staffLevel =
  if 任一 (role, scopeType='总部')                        → 'headquarters'
  elif 任一 (role, scopeType='市场')                      → 'market'
  elif 任一 (role='manager', scopeType='门店')            → 'store_manager'
  elif 任一 (role ∈ 其他, scopeType='门店')               → 'store_staff'
  else                                                   → null
```

部门级（`scopeType='department'`）忽略，不影响 staffLevel。

### 2.2 登录模式（loginLevel）

两个取值：`store` / `management`。显示逻辑：

| staffLevel | 可选 loginLevel | radio 行为 |
|------------|------------------|------------|
| `headquarters` / `market`（有绑定门店） | `['store', 'management']` | 显示 2 选 1，默认 `store` |
| `headquarters` / `market`（无绑定门店） | `['management']` | **隐藏 radio**，直接进管理层 |
| `store_manager` / `store_staff` | `['store']` | **隐藏 radio**，直接进门店 |
| `null` | `[]` | 登录拒绝（保持原有"员工档案未关联"链路） |

> **决策 1（已定）**：只有两种模式都可选时才渲染 radio-group；单选场景整组隐藏，避免无效 UI。

### 2.3 视图结构（两套 tabBar）

**门店视图**（`loginLevel='store'`）— **保持现有 5 tab**：

| tab | 页面 |
|-----|------|
| 工作台 | `pages/workbench/workbench` |
| 开单 | `pages/order-create/order-create` |
| 护理 | `pages/service/service` |
| 顾客 | `pages/customer-list/customer-list` |
| 我的 | `pages/profile/profile` |

**管理层视图**（`loginLevel='management'`）— **新增 4 tab，本 ticket 仅占位**：

| tab | 页面 | 本 ticket 范围 |
|-----|------|-----------------|
| 首页（数据中心） | `pages/mgmt-dashboard/mgmt-dashboard`（新建） | 空白占位页："功能建设中" |
| 排行榜 | `pages/mgmt-ranking/mgmt-ranking`（新建） | 空白占位页 |
| 顾客 | `pages/mgmt-customers/mgmt-customers`（新建） | 空白占位页 |
| 我的 | `pages/mgmt-profile/mgmt-profile`（新建） | 空白占位页（可复用 profile 展示基础信息 + 退出登录按钮） |

> **决策 2（已定）**：管理层走独立 tabBar，不复用门店视图页面。
> **决策 7（已定）**：本 ticket 管理层 4 tab **仅搭骨架**，内容全部留空占位，具体业务功能由后续 ticket 逐个补齐。

**占位页统一样式**：居中显示 logo + "功能建设中，敬请期待" + 若有必要加「返回门店视图」按钮（仅 `availableLoginLevels.length === 2` 时显示，点击 = 退出重登切换模式）。

### 2.4 门店下拉切换（门店视图首页）

若员工 `scopeStoreIds.length > 1`（多店店长 / 总部临时切"门店"模式看某店），workbench 顶部显示门店切换器：

- 下拉列表 = `ctx.auth.scopeStoreIds`（不含无权门店）
- 切换后 `globalData.currentStoreId` 更新 + 触发各 tab 数据刷新
- 若 `scopeStoreIds.length === 1`，**不显示下拉**，保持现有布局

> **决策 3（已定）**：P1 落地。接口侧把 `ctx.auth.effectiveStoreId` 作为查询门店的唯一来源，所有 storeId 相关 route 改为读 `effectiveStoreId`。

---

## 3 实现拆解

### 3.1 DB

**无变更**。不新增表、不新增列、不写 migration。

### 3.2 staffApi（云函数）

#### 3.2.1 auth 中间件扩展（`middleware/auth.js`）

角色查询改写（JOIN `org_nodes` 拿 scopeType）：

```sql
SELECT pr.role, pr.scope_id, o.type AS scope_type
FROM permission_roles pr
JOIN org_nodes o ON o.id = pr.scope_id
WHERE pr.employee_id = $1
```

`ctx.auth` 新结构：

```js
ctx.auth = {
  // 旧字段保留 …
  roles,                  // string[] — 兼容
  roleBindings,           // [{role, scopeId, scopeType}]
  staffLevel,             // 'headquarters' | 'market' | 'store_manager' | 'store_staff' | null
  scopeStoreIds,          // string[] — 展开后的有权门店（参考 admin expandScopeStoreIds）
  loginLevel,             // 从 event.payload._loginLevel 传入，中间件校验合法性
  currentStoreId,         // 从 event.payload._currentStoreId 传入；若无则 fallback 到 staff_wechat_users.store_id
  effectiveStoreId,       // 派生：门店模式取 currentStoreId（校验在 scopeStoreIds 内），管理层模式 null
}
```

**校验规则**：
- `loginLevel='management'` 但 `staffLevel ∉ {headquarters, market}` → 抛 `PERMISSION_DENIED`
- `currentStoreId ∉ scopeStoreIds` → 抛 `PERMISSION_DENIED: 无权访问该门店`
- `loginLevel='store'` 且 `effectiveStoreId=null` → 抛 `INVALID_PARAMS: 未指定门店`

#### 3.2.2 expandScopeStoreIds（新增 util）

照搬 admin 的 `fengyu-admin/src/lib/permissions.ts:108` 逻辑，在 staffApi 侧实现一份纯 JS 版（不引 Drizzle）：

- 总部 scope → 全部 stores
- 市场 scope → 该市场下所有门店
- 门店 scope → 通过 `stores.org_node_id` 反查自身

#### 3.2.3 新增/改造的中间件

- `requireManagementLevel()`（新）— `staffLevel ∈ {headquarters, market}` 且 `loginLevel='management'`
- `requireManager()`（保留）— `roleBindings.some(r => r.role === 'manager' && r.scopeType === '门店')`；**语义不变**

#### 3.2.4 auth.login / auth.bindPhone 响应

新增响应字段：

```json
{
  "roles": ["manager"],                              // 兼容
  "roleBindings": [{"role": "manager", "scopeId": "...", "scopeType": "门店"}],
  "staffLevel": "store_manager",
  "availableLoginLevels": ["store"],
  "scopedStores": [                                  // 供门店切换下拉使用
    {"storeId": "ST-001", "storeName": "广州花城店"}
  ]
}
```

#### 3.2.5 业务路由改造

所有读 `ctx.auth.storeId` 的 route 改为读 `ctx.auth.effectiveStoreId`。grep 清单（PR-A 审核项）：

- `routes/staff.js`（todayCommission / monthlyCalendar / todoList / dashboard / performanceDetail）
- `routes/order.js`（create / list / qrcode / confirmOffline 等）
- `routes/allocation.js`
- `routes/service.js`
- `routes/customer.js`
- `routes/appointment.js`

管理层模式（`effectiveStoreId=null`）下，查询应基于 `scopeStoreIds` 做 `IN (…)` 过滤。新增一个 helper `buildStoreScopeCondition(ctx.auth)` 返回 SQL 片段或参数数组。

#### 3.2.6 管理层专属 route

本 ticket 范围内**不新增**管理层业务 route。`requireManagementLevel()` 中间件定义好但暂无消费点，待后续业务 ticket 接入。

### 3.3 staff 前端

#### 3.3.1 登录页（`pages/login/login.*`）

- 先跑 `auth.login` 拿 `availableLoginLevels`
- `availableLoginLevels.length === 2` → 渲染 radio-group，默认选中 `'store'`
- `availableLoginLevels.length === 1` → 不渲染 radio，保存 `loginLevel = availableLoginLevels[0]`
- 登录通过后：
  - 持久化 `loginLevel` 到 storage
  - 根据 loginLevel 切换 tabBar 结构（见 §3.3.2）
  - `wx.switchTab` 到对应首页

#### 3.3.2 自定义 tabBar（新增）

微信原生 tabBar 不支持条件渲染，改用 **custom tab-bar**：

1. `app.json` 新增：
   ```json
   "tabBar": {
     "custom": true,
     "list": [ /* 两套 tabBar 的并集 */ ]
   }
   ```
   说明：`list` 仍需写满以通过小程序校验，但实际渲染走自定义组件。并集里所有 `pagePath` 都要在 `pages` 里存在。

2. 新建 `custom-tab-bar/index.{js,wxml,wxss,json}`：
   - 读取 `getApp().globalData.loginLevel`
   - 根据 loginLevel 渲染两套不同的 item 数组
   - 点击 item → `wx.switchTab`

3. 主包 `pages` 新增 4 个占位页：
   - `pages/mgmt-dashboard/mgmt-dashboard`
   - `pages/mgmt-ranking/mgmt-ranking`
   - `pages/mgmt-customers/mgmt-customers`
   - `pages/mgmt-profile/mgmt-profile`

4. 4 个页面共享一个占位组件 `components/placeholder-page/`，减少重复代码。`packageOrder/dashboard/dashboard` **保持原位置不动**，后续业务 ticket 决定迁移方案时再处理。

#### 3.3.3 门店下拉切换（workbench）

- `scopedStores.length > 1` 时 workbench 顶部加 `van-dropdown-menu`
- 切换后：
  - `app.globalData.currentStoreId = newStoreId`
  - `wx.setStorageSync('currentStoreId', newStoreId)`
  - 广播事件 `'store-changed'`（自建事件总线或 `app.emit`）供其他 tab 页监听刷新
  - 所有云函数调用统一在 `utils/cloud.ts` 的 `callStaffApi` 里自动附加 `_currentStoreId` 到 payload

**设计原则**：切换只改 `currentStoreId`，不重登、不清缓存（各 tab `onShow` 比较 storeId 决定是否刷新）。

#### 3.3.4 `app.ts` / globalData 扩展

新增字段：
- `staffLevel: StaffLevel | null`
- `loginLevel: 'store' | 'management'`
- `currentStoreId: string | null`
- `scopedStores: Array<{storeId, storeName}>`

持久化 key：`staffLevel` / `loginLevel` / `currentStoreId`。恢复顺序：先 storage → `syncLoginState` 回填。

#### 3.3.5 `utils/role.ts` 重构

```ts
export type StaffLevel = 'headquarters' | 'market' | 'store_manager' | 'store_staff' | null

export function getStaffLevel(): StaffLevel
export function getLoginLevel(): 'store' | 'management'
export function isManagementMode(): boolean
export function isHeadquartersLevel(): boolean
export function isMarketLevel(): boolean
export function canAccessManagement(): boolean
export function canAccessStore(): boolean

// 兼容旧 API
export function isManager(): boolean  // = staffLevel === 'store_manager'
export function isBeautician(): boolean  // = staffLevel === 'store_staff'
export function requireManager(...): boolean  // 语义不变
export function getCurrentStoreId(): string   // 新增：供业务层取用
```

### 3.4 兼容性

- `ctx.auth.roles`、`globalData.roles` 字段保留，内容不变
- `isManager()` 语义改为"门店店长层级"：对单店店长等价；对"HQ admin + 门店 manager"组合（罕见）会变 —— 此时判为 `headquarters`，不再走店长分支。**有意改动**，回归时关注
- 旧版小程序客户端（未带 `_loginLevel` / `_currentStoreId` 的请求）：后端 fallback 到 `staff_wechat_users.store_id` + `loginLevel='store'`，保证不崩

---

## 4 PR 拆分

### PR-A：权限归并 + 登录 radio + 门店下拉（基础）

- staffApi 中间件 + `expandScopeStoreIds` + `auth.login/bindPhone` 响应扩展
- 所有 route 把 `ctx.auth.storeId` 迁到 `ctx.auth.effectiveStoreId`
- 登录页 radio 动态显隐
- `app.ts` / `utils/role.ts` / `utils/cloud.ts` 改造
- workbench 顶部门店切换器（仅 `scopedStores.length > 1` 显示）
- 回归：`isManager()` 所有消费点

**验收后合并，可独立上线。** 管理层用户此时 `availableLoginLevels=['store','management']` 但选 management 会走 P2 stub 页（"功能建设中"）。

### PR-B：管理层独立 tabBar（仅骨架 + 占位页）

- `app.json` 改 custom tabBar
- `custom-tab-bar/index.*` 组件（按 loginLevel 渲染两套 item）
- 4 个占位页：`pages/mgmt-dashboard` / `mgmt-ranking` / `mgmt-customers` / `mgmt-profile`
- `components/placeholder-page/` 共享占位组件（含"功能建设中"文案 + 可选的"返回门店视图"按钮）
- 不含任何业务逻辑、不新增后端 route

---

## 5 验收标准

### AC-01 登录界面

- [ ] 门店层级（`store_manager` / `store_staff`）登录 → 不显示 radio，自动进门店视图
- [ ] 管理层且有绑定门店 → 显示 radio 2 选 1，默认"门店"
- [ ] 管理层无绑定门店 → 不显示 radio，自动进管理层视图
- [ ] 无任何角色 → 登录拒绝，文案"员工档案未关联"

### AC-02 权限归并

- [ ] `staffApi.auth.login` 响应含 `staffLevel` + `roleBindings` + `availableLoginLevels` + `scopedStores`
- [ ] 归并单测（`staffApi/tests/auth-level.test.js`）覆盖 §2.1 所有规则：
  - `(admin, 总部)` → `headquarters`
  - `(manager, 门店)` → `store_manager`
  - `(hr, 市场)` → `market`
  - `(customer_mgr, 门店)` → `store_staff`
  - `(admin, 总部) + (manager, 门店)` → `headquarters`
  - `(hr, 市场) + (manager, 门店)` → `market`
  - `(hr, 部门)` → `null`（部门不参与）
  - `[]` → `null`

### AC-03 中间件

- [ ] `ctx.auth.staffLevel` / `scopeStoreIds` / `effectiveStoreId` 正确注入
- [ ] `requireManager()` 对单店店长行为不变（order.create / allocation.save / customer.assign 回归）
- [ ] `requireManagementLevel()` 新增，至少 1 接口使用（`staff.managementDashboard`）
- [ ] `currentStoreId` 不在 `scopeStoreIds` 内 → `PERMISSION_DENIED`

### AC-04 门店视图下拉切换

- [ ] `scopedStores.length === 1` → workbench 不显示下拉
- [ ] `scopedStores.length > 1` → 下拉可见；切换后 workbench / 顾客 / 护理 / 开单 / 分配相关数据按新 storeId 刷新
- [ ] 切换后所有云函数调用自动带 `_currentStoreId`

### AC-05 管理层视图骨架（PR-B）

- [ ] tabBar 按 loginLevel 切换两套（custom tab-bar 生效，门店 5 tab / 管理层 4 tab）
- [ ] 4 个管理层 tab 均可正常切换、不报错、显示占位组件
- [ ] 占位页包含基础信息（页面标题 + "功能建设中"文案）
- [ ] "我的"占位页保留「退出登录」按钮（复用 profile 退出逻辑）
- [ ] 具体业务功能由后续 ticket 补充，本 ticket **不验收业务行为**

### AC-06 回归

- [ ] 单店店长登录（门店模式）→ workbench 显示店长徽章 + 门店营业额卡 + 5 种店长待办
- [ ] 美容师登录（门店模式）→ 不显示店长功能
- [ ] 店长开单：内部单 / 转换单可用
- [ ] 退出登录后回到 login 页，radio 状态正确重置

---

## 6 测试矩阵

| 场景 | staffLevel | availableLoginLevels | 期望行为 |
|------|------------|------------------------|----------|
| 单店店长 | `store_manager` | `['store']` | 隐藏 radio，进门店视图；下拉不显 |
| 美容师 | `store_staff` | `['store']` | 隐藏 radio，进门店视图 |
| 多店店长 `(manager, A) + (manager, B)` | `store_manager` | `['store']` | 隐藏 radio；门店首页显示下拉 A/B |
| 单店 customer_mgr | `store_staff` | `['store']` | 隐藏 radio，进门店视图（美容师级 UI） |
| 总部 admin 有 store | `headquarters` | `['store', 'management']` | 显示 radio；选门店时走下拉（全部门店） |
| 总部 admin 无 store | `headquarters` | `['management']` | 隐藏 radio，进管理层视图 |
| 市场 hr 有 store | `market` | `['store', 'management']` | 显示 radio；选门店时下拉（该市场全店） |
| 市场 hr 无 store | `market` | `['management']` | 隐藏 radio，进管理层视图 |
| 组合 `(admin, 总部) + (manager, A)` | `headquarters` | `['store', 'management']` | staffLevel 取高为 headquarters |
| 离职员工 | `null` | `[]` | 登录拒绝 |
| 空角色 | `null` | `[]` | 登录拒绝 |

---

## 7 工作量

| 子任务 | PR | 估时 |
|--------|----|------|
| auth 中间件 + 归并算法 + 单测 | A | 1d |
| expandScopeStoreIds + effectiveStoreId + route 迁移 | A | 1d |
| 登录页 radio + app.ts + role.ts | A | 0.5d |
| workbench 门店下拉 + utils/cloud 自动附加 | A | 0.5d |
| 门店模式回归测试（6 页面） | A | 0.5d |
| **PR-A 小计** | A | **3.5d** |
| custom tab-bar 组件 + app.json 改造 | B | 0.5d |
| 4 个占位页 + 共享 placeholder 组件 | B | 0.3d |
| PR-B 回归（tabBar 切换、真机测试） | B | 0.2d |
| **PR-B 小计** | B | **1d** |
| **合计** | — | **4.5d** |

---

## 8 决策记录（已定，不再讨论）

| # | 决策 | 说明 |
|---|------|------|
| 1 | radio 仅在 2 选 1 时显示 | 单选场景整组隐藏 |
| 2 | 管理层独立 tabBar | 首页（数据中心）/ 排行榜 / 顾客 / 我的 4 项 |
| 3 | 多门店员工在门店模式下可下拉切换，限有权门店 | P1 落地，不留 P2 |
| 4 | 不动 admin | staff 4 层归并只在 staff 端，admin 保留 7×3 粒度 |
| 5 | 不允许 session 内切换 loginLevel | 必须退出重登 |
| 6 | operation_logs 暂不记录 loginLevel | P1 不扩展 schema |
| 7 | 管理层 4 tab 本 ticket 仅占位 | 业务功能由后续 ticket 补充 |

---

## 9 剩余待确认

本 ticket 所有关键决策已敲定，无阻塞项。后续补充管理层业务功能时，以下问题需要在**子 ticket** 中逐个解决：

1. 数据中心页：是否复用 `packageOrder/dashboard` 的数据源？按 scope 聚合的 SQL 方案
2. 排行榜页：上榜维度（员工/门店）、时间粒度、展示条数、"我的名次"展示
3. 管理层"顾客"tab：是否独立于门店视图的顾客列表，或共用组件
4. 管理层"我的"tab：菜单项配置（权限管理、员工管理等管理层专属入口）

---

## 10 风险与回滚

- **风险 1**：`isManager()` 语义变化 — 全仓 grep 审核（§1.3 清单）
- **风险 2**：custom tab-bar 兼容性 — 真机测试 iOS/Android + 微信版本 ≥ 7.0.0
- **风险 3**：dashboard 迁包可能改动 `packageOrder` 加载路径，其他分包页面引用要逐个确认
- **风险 4**：`effectiveStoreId` 贯穿所有业务 route，遗漏点会导致"看到别人门店数据"或"看不到自己数据"。PR-A review 必须逐 route 核对
- **回滚**：PR-A 可独立回滚（登录页隐藏 radio + 后端忽略新字段）；PR-B 回滚只需 `app.json` 去掉 `custom: true`

---

## 11 交付物清单

**DB**：无

**staffApi**（PR-A + PR-B）：
- `middleware/auth.js` — JOIN + 派生 staffLevel/scopeStoreIds/effectiveStoreId
- `middleware/auth.js` — 新增 `requireManagementLevel`
- `utils/scope.js` — `expandScopeStoreIds` + `buildStoreScopeCondition`
- `routes/auth.js` — 响应扩展
- `routes/*.js` — storeId → effectiveStoreId 全量迁移
- `routes/staff.js` — 新增 `managementDashboard` + `ranking`
- `tests/auth-level.test.js` — 归并单测（≥ 8 case）

**staff 前端**（PR-A）：
- `pages/login/login.{wxml,ts}` — radio 动态显隐
- `app.ts` — globalData 扩展 + 持久化
- `utils/role.ts` — 新旧 API
- `utils/cloud.ts` — 自动附加 `_loginLevel` / `_currentStoreId`
- `pages/workbench/workbench.{wxml,ts}` — 门店下拉

**staff 前端**（PR-B，仅骨架）：
- `app.json` — custom tabBar + 主包新增 4 页
- `custom-tab-bar/index.{js,wxml,wxss,json}`
- `components/placeholder-page/index.{js,wxml,wxss,json}`
- `pages/mgmt-dashboard/*`（占位）
- `pages/mgmt-ranking/*`（占位）
- `pages/mgmt-customers/*`（占位）
- `pages/mgmt-profile/*`（占位，含退出按钮）

**文档**：
- 更新 `fengyu-staff/miniprogram/CLAUDE.md`
- 更新 `fengyu-staff/cloudfunctions/staffApi/CLAUDE.md`
- ticket 完工后归档至 `notes/tickets/archives/`
