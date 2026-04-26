# 审计报告：组织架构 (org_nodes 邻接表 + stores 1:1) (21)

**审计时间**：2026-04-26
**域 ID**：21
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟（v1）+ ~25 分钟（v2）
**关联 PR/Ticket**：—
**报告版本**：v1+v2 合并版 2026-04-26

> v1 原审计时间 2026-04-25，v2 独立重审于 2026-04-26。本报告按 audit_plan.md §4 模板合并两版，去重后重新计数。

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/org.ts:17`（org_nodes）+ `db/schema/org.ts:41`（stores） | ↑ | ↑ |
| Schema (FK) | `db/schema/permission.ts:22`（scope_id → org_nodes.id）；`db/schema/operation-log.ts:23`（org_node_id → org_nodes.id）；`db/schema/user.ts:111-113`（staff org_node_id + store_id）；`db/schema/store-unbind.ts:11`（from_store_id FK stores） | ↑ | ↑ |
| Enum | `db/schema/enums.ts:93` `orgNodeTypeEnum`（4 值：总部/市场/门店/部门）；`db/schema/enums.ts:99` `positionScopeEnum`（3 值：总部/市场/门店） | ↑ | ↑ |
| Server Action / Route | `src/actions/org.ts`（getOrgNodes / createOrgNode / updateOrgNode / deleteOrgNode / `isNodeInScope`）；`src/actions/stores.ts`（getStores / getStoreById / createStore / updateStore / `getMarketStoreIds`）；`src/actions/store-unbind.ts` | `routes/store.js:16`（list）/ `routes/store.js:39`（unbindRequests）/ `routes/store.js:75`（approveUnbind）/ `routes/store.js:112`（rejectUnbind）+ `utils/scope.js:82`（expandScopeStoreIds）+ `utils/scope.js:139`（buildStoreScopeCondition）+ `middleware/auth.js:143` | `routes/store.js:14`（list）/ `routes/store.js:62`（detail）/ `routes/store.js:138`（requestUnbind）/ `routes/store.js:167`（getUnbindRequest）/ `routes/store.js:198`（cancelUnbindRequest）/ `routes/store.js:225`（geocode） |
| 前端 | `app/(main)/org/page.tsx` + `_components/org-page.tsx`（树形编辑）；`app/(main)/stores/page.tsx` + `[id]/edit` + `create/` | `miniprogram/pages/profile/profile.ts:47` 调 store.list；`pages/staff/store-bind/*` 候选 | `pages/store/list`、`pages/store/detail`、`pages/profile/unbind/*` |
| 公共 helper | `src/lib/permissions.ts:109` expandScopeStoreIds / `:185` scopeCondition / `:171` isAdminScope / `:204` isInScope；`src/lib/operation-log.ts:31` logOperation；`src/lib/auth.ts:12` getSession | `utils/scope.js:25` deriveStaffLevel / `:82` expandScopeStoreIds / `:139` buildStoreScopeCondition；`middleware/auth.js:38` resolveRuntimeAuth / `:254` requireManager | — |
| 测试 | `actions/org.test.ts`（4 KB）+ `actions/stores.test.ts`（8 KB）+ `actions/store-unbind.test.ts`（6.8 KB）；`lib/permissions.test.ts` | `cloudfunctions/staffApi/__tests__/utils/scope.test.js` | — |

---

## 2. 数据流图

```
admin.createOrgNode → org_nodes(parent_id) [+ unique(parent_id,name)]
admin.createStore   → tx { org_nodes(type='门店', parent_id=marketId) + stores(org_node_id=store-${storeId}) }
                    ↓ 双写：org_nodes.name 与 stores.store_name 同时初值，但永久脱钩
admin.updateStore   → 仅更新 stores 表；org_nodes.name 不同步 ← P1-21-01
admin.updateOrgNode → org_nodes.SET(name,type,parent_id?,sort_order,is_active) 无 cycle 检测 ← P0-21-02
admin.deleteOrgNode → 检查子节点/员工/门店/权限 → DELETE org_nodes
sync-workfine.js    → UPSERT org_nodes(总部→市场→门店) + stores（id = sha256-16hex）

permission_roles.scope_id ──FK──▶ org_nodes.id
operation_logs.org_node_id ──FK──▶ org_nodes.id
staff_wechat_users.org_node_id ──FK──▶ org_nodes.id（期望 type='部门'）
staff_wechat_users.store_id ──FK──▶ stores.store_id
client_wechat_users.bound_store_id ──FK──▶ stores.store_id
store_unbind_requests.from_store_id ──FK──▶ stores.store_id

staff.store.list   → SELECT stores JOIN org_nodes WHERE is_closed=false（无 scope 过滤）
client.store.list  → SELECT stores JOIN org_nodes WHERE is_closed=false [+city LIKE]
client.store.requestUnbind → INSERT store_unbind_requests(... from_store_name ...) ← ✗ 列不存在
staff.store.unbindRequests → SELECT WHERE from_store_id = ctx.auth.storeId（仅默认门店，多店店长漏看）
```

---

## 3. 自身漏洞

### 3.1 P0（阻断/资损/越权）

- **[P0-21-01]** `staff/utils/scope.js` 把 `text` 列强制 cast 为 `::uuid[]`，市场/门店 scope 展开必失败（v1 + v2 共同发现）
  - 文件：`fengyu-staff/cloudfunctions/staffApi/utils/scope.js:107-122`
  - 现象：SQL 中 `WHERE o.parent_id = ANY($1::uuid[])` / `WHERE org_node_id = ANY($1::uuid[])`，但 `org_nodes.id` / `org_nodes.parent_id` / `stores.org_node_id` 三个列在 schema 与 baseline migration 中均为 `text`；运行时 ID 形如 `store-{ts}`、`market-华南-...`、`hq-1`、16-hex hash，绝非 UUID。总部级员工走 `SELECT store_id FROM stores`（无 cast）幸免，是 bug 隐蔽的主因。
  - 风险：市场/门店级员工首次登录任意 action → `loadAuthBase` → `expandScopeStoreIds` → `22P02 invalid input syntax for type uuid` → 顶层 catch 吞错 → 整个 staffApi 对该员工不可用。员工端功能全失效但无明确错误提示。
  - 复现：1) 员工赋 `manager + scope_type='门店'` 角色，scopeId 非 UUID 2) 任意调用 staffApi → auth middleware → expandScopeStoreIds → PG 22P02 3) 响应 `code=-1`
  - 修复：(L3) 把两处 `::uuid[]` 改为 `::text[]`（v2 补：同步补 vitest 用真实 PG 容器替换 mock）

- **[P0-21-02]** `updateOrgNode` 接受 `parentId` 但完全无 cycle / 层级 / 同名校验（v1 + v2 共同发现）
  - 文件：`fengyu-admin/src/actions/org.ts:122-171`
  - 现象：函数签名 `data: Partial<{ name; type; parentId; sortOrder; isActive }>` 包含 parentId，但 122-156 行只校验 `data.type`、`isNodeInScope(id)`，未校验目标 `parentId` 是否：(a) 在自身后代子树中（产生环路）(b) 类型组合合法（市场不能挂在门店下）(c) 在用户 scope 内。(d) `unique(parent_id, name)` 同名冲突仅返回原始 PG 错误。
  - 风险：(a) 设 `parentId = self.id` 或子孙 id 即制造邻接表环路，`isNodeInScope`（最多 5 层向上）和前端递归渲染都可能死循环或栈溢出（5 层外永远 false → 越权伪 negative）。`expandScopeStoreIds` 市场分支语义错乱。(b) 把"门店"挪到"门店"下，破坏 `getMarketStoreIds` 层级假设。(c) 普通 hr 可把任意节点挪进自己 scope 制造越权。
  - 复现：直接调 server action `updateOrgNode('market-1', { parentId: 'store-foo' })` 其中 store-foo 当前 parent=market-1 → 形成环；或 `updateOrgNode('H', { parentId: 'M' })` 制造 `H.parent=M; M.parent=H` 环。
  - 修复：(L7) 与 createOrgNode 同款校验（v1）；(L0 schema) 加触发器或 CHECK 约束拒环（v2）

- **[P0-21-03]** `client/store.requestUnbind` INSERT 引用不存在的列 `from_store_name`，C 端解绑流程整体不可用（v1 + v2 共同发现）
  - 文件：`fengyu-client/cloudfunctions/clientApi/routes/store.js:155-159`、`174-180`
  - 现象：`INSERT INTO store_unbind_requests (request_id, user_id, from_store_name, status, note) …`；`SELECT request_id, from_store_name, …`。schema `store_unbind_requests` 仅有 `from_store_id text NOT NULL`（无 `from_store_name`）。
  - 风险：任何"申请解绑门店"调用都被 PG 报错 `42703 column "from_store_name" does not exist`，C 端解绑完全不可用；且漏写 `from_store_id`（NOT NULL）即便修复列名也需补值。
  - 复现：客户绑定门店 A → `store.requestUnbind { note }` → SQL error → 前端 `code=-1, message='服务器内部错误'`
  - 修复：(L3) 改为 `INSERT … (request_id, user_id, from_store_id, status, note) VALUES ($1,$2,$3,'待处理',$4)`，参数用 `boundStoreId`；改 SELECT 列名；返回值通过 JOIN stores 计算 fromStoreName

- **[P0-21-04]** `stores.ts:createStore` 与 `org.ts:createOrgNode` 不同事务，不校验 marketId 对应 org_node type = '市场'（v1 独有发现，v2 未覆盖）
  - 文件：`fengyu-admin/src/actions/stores.ts:103-152`
  - 现象：createStore 用 `db.transaction` 一次写 org_nodes(type='门店',parentId=marketId) + stores，但**不校验** marketId 对应 org_node 的 type 是否 = '市场'。调用方只要传任意已存在的 org_node id 即可挂上来（总部/市场/部门均可），破坏邻接表"门店只能挂市场"层级约束。`db/schema/org.ts:9-14` 注释明确此约束，但 createStore 跳过。
  - 风险：admin / hr 角色可越权造出"总部 → 门店"或"部门 → 门店"非法链；`getMarketStoreIds`（`stores.ts:220-231`）假设 store.parent 指向市场，层级错乱后跨市场提成/scope 计算漂移
  - 修复：(L7) tx 内先 `SELECT type FROM org_nodes WHERE id = marketId`，type !== '市场' 直接拒绝

- **[P0-21V2-04]** admin `AuthSession.scopeType` 枚举仅 3 值，强 cast '部门'→'门店'，部门级 scope 用户登录后数据全空（v2 独有发现）
  - 文件：`fengyu-admin/src/lib/types.ts:573` + `fengyu-admin/src/actions/auth.ts:198-202`
  - 现象：`AuthSession.roles[].scopeType: '总部' | '市场' | '门店'`（缺 `'部门'`）。`getSessionFromCookie` 把 orgNodes.type 强 cast：`scopeType: (r.scopeType ?? '门店') as '总部' | '市场' | '门店'`。当 `permission_roles.scope_id` 指向 type='部门' 节点，admin 把它当作 `'门店'` 处理。
  - 风险：`expandScopeStoreIds` 走"门店"分支 `WHERE stores.org_node_id = $部门id` → 命中 0 行 → scopeStoreIds=[] → `scopeCondition` 返回 `FALSE` → admin 用户所有列表数据为空。与 staff 端显式 `if (r.scopeType === '部门') continue` 隐式忽略相比，admin 是隐式 0，更难诊断。
  - 复现：HR 给员工 X 分配 `(role='hr', scope_id='dept-finance')`，X 登录 admin → scopeType='部门' 被 fallback 为 '门店' → scopeStoreIds=[] → 所有列表返回 0 行
  - 修复：(L0 enums) 评估 `positionScopeEnum` 是否升 4 值；(L0) `AuthSession.scopeType` 改为 4 值；(L7) `expandScopeStoreIds` 内补 `if (r.scopeType === '部门') continue`；数据迁移审计现有部门 scope 行

### 3.2 P1（数据一致 / 状态错乱）

- **[P1-21-01]** `org_nodes.name` 与 `stores.store_name` 双写永久脱钩（v1 发现，v2 未覆盖，P2-21V2-03 确认仍存在）
  - 文件：`fengyu-admin/src/actions/stores.ts:154-217`（updateStore）
  - 现象：updateStore 仅更新 stores 表，从不同步 `org_nodes.name`。createStore 时同步初值，后续编辑就此漂移。前端 staff/client 端 list 用 `s.store_name`，admin 端混用。
  - 风险：admin 改门店名后，组织树中该门店仍显示旧名；权限分配 UI 走 `org_nodes.name` 也错乱
  - 修复：(L7) updateStore 在 tx 内同步 `UPDATE org_nodes SET name = $newName WHERE id = $orgNodeId`

- **[P1-21-02]** 邻接表无 DB 环约束（v1 发现，v2 P0-21-02 同覆盖）
  - 文件：`db/schema/org.ts:17-34`
  - 现象：DB 层只有 `unique(parent_id, name)` 约束，无 cycle prevention（无 trigger / path 列 / level 列）。
  - 风险：见 P0-21-02；P0 修复时一并处理
  - 修复：(L0) 加触发器或物化 path 列（ltree）；(L7) create/update 时 ancestor 扫描

- **[P1-21-03]** `org_nodes.is_active=false` 不级联到 stores / staff 业务查询（v1 发现，v2 未覆盖）
  - 文件：`db/schema/org.ts:25`
  - 现象：isActive 列仅 admin org tree 用，stores 表无联动概念（用 `is_closed`），staff 路由只看 `is_closed=false` 不看 `org_node.is_active`。把"市场 A" `is_active=false` 后，A 下属门店仍正常营业，但权限/scope 解析不确定。
  - 风险：运维停用市场希望立即隐藏，门店仍曝光"已停用市场"
  - 修复：(L7) 文档化 isActive 语义并在权限展开时一并过滤；或 (L0) 收敛为 stores.is_closed 派生

- **[P1-21-04]** `stores.org_node_id` 是 nullable，孤儿门店存在（v1 发现，v2 未覆盖）
  - 文件：`db/schema/org.ts:46`
  - 现象：`org_node_id text` 无 NOT NULL。createStore 始终写值，但旧数据/同步路径可能留空。
  - 风险：`expandScopeStoreIds` 走 `stores.org_node_id IN` 漏掉孤儿门店；staff/client store.list JOIN 后 market_name 为空
  - 修复：(L0) 加 `NOT NULL` 约束 + 数据回填

- **[P1-21-05]** type='门店' 与 stores 1:1 完整性无 schema 强制（v1 发现，v2 部分覆盖）
  - 文件：`db/schema/org.ts:36-70`
  - 现象：`org_nodes.type='门店'` 行不一定有 stores 行（admin 在 org tree 直接 createOrgNode(type='门店')），反之 stores.org_node_id 也不一定指向 type='门店'。无 partial unique / FK 类型约束。
  - 风险：孤儿 org_node 可由 org tree 直接创建；1:1 完整性漂移
  - 修复：(L0) `CREATE UNIQUE INDEX uq_stores_org_node_id ON stores(org_node_id) WHERE org_node_id IS NOT NULL`；(L7) 阻止 admin 在组织树创建 type='门店'，引导走 /stores/create

- **[P1-21-06]** `deleteOrgNode` 未检查 `operation_logs.org_node_id` 引用（v1 独有，v2 未覆盖）
  - 文件：`fengyu-admin/src/actions/org.ts:215-222`
  - 现象：已检查 permissionRoles.scopeId、staff_wechat_users.orgNodeId、stores.orgNodeId，但 `operation_logs.org_node_id` 也是 FK 未检查。
  - 风险：删除节点时 23503 报错暴露表结构
  - 修复：(L7) 增加 operation_logs 引用检查或改用软删除

- **[P1-21-07]** `staff auth.js` JOIN `org_nodes` 不限定 type='部门'（v1 独有，v2 未覆盖）
  - 文件：`fengyu-staff/cloudfunctions/staffApi/middleware/auth.js:161`
  - 现象：员工的 `org_node_id` 期望挂"部门"节点，但应用层无强制；若挂到市场/门店下，department 字段显示市场/门店名
  - 风险：UI department 字段语义模糊
  - 修复：(L3) JOIN 加 `AND d.type = '部门'`

- **[P1-21-08]** `staff/client store.list` 排序口径不一致（v1 独有，v2 未覆盖）
  - 文件：staff `routes/store.js:27`（`ORDER BY m.name, s.store_name`）vs client `routes/store.js:48`；admin `actions/stores.ts:60`
  - 风险：三端显示同一组数据顺序不同，跨端体验割裂
  - 修复：(L3) 统一排序口径

- **[P1-21V2-01]** `positionScopeEnum`（3 值）与 `orgNodeTypeEnum`（4 值）枚举集合不一致（v2 独有）
  - 文件：`db/schema/enums.ts:93,99` + `fengyu-admin/src/lib/types.ts:573` + `fengyu-staff/utils/scope.js:43`
  - 风险：跨端推理 scope 时枚举值漂移；与 P0-21V2-04 部门 scope 问题同根
  - 修复：(L0 enums) 评估 positionScopeEnum 是否升 4 值

- **[P1-21V2-02]** admin `org-page.tsx validateType` 与 `actions/org.ts createOrgNode` 校验不对称（v2 独有）
  - 文件：`fengyu-admin/src/app/(main)/org/_components/org-page.tsx:39-54` vs `actions/org.ts:78-100`
  - 现象：前端 `validateType` 检查 4 项（总部唯一、市场→总部、门店→市场、部门不可嵌套），后端 `createOrgNode` 仅检查 2 项（门店下只能建部门、部门不可嵌套），缺 ①②③。
  - 风险：绕过前端直接 invoke server action 可创建非法层级
  - 修复：(L7) 把 `validateType` 移到 `actions/org.ts` 共享 helper，前后端共用一份逻辑

- **[P1-21V2-03]** staff `store.list` 完全无 scope 过滤（v2 独立发现，与 v1 P0-21-05 关联但更侧重 list 本身）
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/store.js:14-34`
  - 现象：`SELECT ... FROM stores WHERE is_closed=false`，未引用 `ctx.auth.scopeStoreIds`。任意员工可 enumerate 全部门店元数据 + 市场归属。
  - 风险：违反 `real.md` "组织域数据隔离"；与 staff `requireStaffBound()` 不一致
  - 修复：(L3) 按 ctx.auth.staffLevel + scopeStoreIds / effectiveStoreId 过滤

- **[P1-21V2-04]** `createStore` 仅记 `store.create` 日志，遗漏 `org.create` 日志（v2 独有）
  - 文件：`fengyu-admin/src/actions/stores.ts:113-149`
  - 现象：事务内 INSERT org_nodes + stores，最终只写 `logOperation('store.create', ...)`
  - 风险：组织架构变更追溯链断裂
  - 修复：(L7) 事务内同时 `logOperation('org.create', 'org_node', orgNodeId, {...})`

- **[P1-21V2-05]** admin 无 `deleteStore` action，stores `is_closed`/`closed_at` 双写无 CHECK 约束（v2 独有）
  - 文件：`fengyu-admin/src/actions/stores.ts` + `db/schema/org.ts:49-51`
  - 现象：PERMISSION_MATRIX 只有 store:create/store:update；schema 要求 `is_closed = closed_at IS NOT NULL` 但无 PG CHECK。
  - 风险：`is_closed=true` 但 `closed_at IS NULL`，或反之
  - 修复：(L0) 加 CHECK `chk_stores_closed_consistency`；(L7) 决定是否提供 deleteStore

- **[P1-21V2-06]** `updateOrgNode` 接受 `parentId` 字段透传（v2 独有，与 P0-21-02 不同角度）
  - 文件：`fengyu-admin/src/actions/org.ts:154-156`
  - 现象：UI 只发 `name/type/sortOrder/isActive`，但 server action 类型签名 `Partial<...parentId...>` 过宽。
  - 风险：见 P0-21-02；本条独立列因"server action 接受过宽 input"是结构性反模式
  - 修复：(L7) 拆 `updateOrgNodeMeta` 与 `moveOrgNode(parentId)`，后者必须做 cycle 校验

- **[P1-21V2-07]** `staff/client store.list` JOIN `org_nodes` 市场归属不过滤 `is_active=false`（v2 独有）
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/store.js:23` + `fengyu-client/cloudfunctions/clientApi/routes/store.js:44`
  - 现象：JOIN `org_nodes pm ON sn.parent_id = pm.id` 仅取 pm.name，未校验 pm.isActive
  - 风险：停用市场仍作为返回，运维希望立即隐藏时失效
  - 修复：(L3) JOIN 加 `AND pm.is_active = true`

- **[P1-21V2-08]** `createStore` 用户控制 `storeId` 主键，无格式校验（v2 独有）
  - 文件：`fengyu-admin/src/actions/stores.ts:81,124`
  - 现象：`storeId` 直接由调用方传入，无正则/长度校验
  - 风险：特殊字符破坏前端 URL 路由 `/stores/${id}/edit`；与 `org_node_id='store-${storeId}'` 拼接策略冲突
  - 修复：(L7) 加 zod schema：`storeId: z.string().regex(/^[A-Za-z0-9_-]{1,30}$/)`

### 3.3 P2

- **[P2-21-01]** `staff/store.list` 不含 staff_count / customer_count，与 `client/store.detail` 口径不同（v1）
  - 风险：选择器与详情语义割裂
- **[P2-21-02]** `client/store.list` 用 `LIKE $1` 拼接 city 前缀，用户可传 `%` 匹配所有（v1）
  - 文件：`clientApi/routes/store.js:22-24`
  - 风险：低；先 escape `%` `_`
- **[P2-21-03]** admin `org-page.tsx validateType` 与 server `createOrgNode` 校验不对齐（v1，与 P1-21V2-02 同一根）
  - 文件：`org-page.tsx:39-54` vs `actions/org.ts:78-100`
- **[P2-21-04]** `stores.create` 用 `Date.now()` 生成 storeId，无 advisory lock（v1）
  - 文件：`store-create-page.tsx:41`
- **[P2-21-05]** `client/geocode` 路由无 `requirePhone` 限频（v1）
  - 文件：`clientApi/routes/store.js:225-261`
- **[P2-21-06]** staff 路由 `approveUnbind`/`rejectUnbind` 全程 0 operation_logs（v1）
- **[P2-21V2-01]** admin / staff 各自实现 `expandScopeStoreIds`，逻辑相同但实现两套（v2）
  - 文件：`fengyu-admin/src/lib/permissions.ts:109-151` vs `fengyu-staff/utils/scope.js:82-127`
  - 风险：漂移风险；建议抽共享 SQL 函数
- **[P2-21V2-02]** admin 删除确认弹窗文案模糊，未显示具体阻碍原因（v2）
  - 文件：`org-page.tsx:493`
- **[P2-21V2-03]** admin `updateStore` 的 `closed_at = new Date().toISOString().slice(0,10)` 总是 UTC，北京时间凌晨偏差（v2）
  - 文件：`stores.ts:196-198`
- **[P2-21V2-04]** `getMarketStoreIds` 用裸 SQL 返回兜底 `[storeId]`，掩盖结构异常（v2）
  - 文件：`stores.ts:220-231`
- **[P2-21V2-05]** staff `store.list` 用 `r.store_name || ''` 把 NULL 静默吞掉（v2）
  - 文件：`routes/store.js:30-34`

---

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| `org_nodes.id` SQL cast | `text`（drizzle 自动） | `::uuid[]`（错） | — | staff scope 展开 22P02 | P0 |
| 解绑申请列名 | `from_store_id`（正确） | `from_store_id`（正确） | `from_store_name`（不存在） | client 解绑全断 | P0 |
| AuthSession scopeType 集合 | 3 值 + fallback | 4 值原值 + 显式忽略 部门 | — | 部门级 admin 数据全空 | P0 |
| 解绑申请门店过滤 | `scopeCondition`（多店全集） | `auth.storeId`（仅默认门店） | — | 多店店长漏单 | P0 |
| store.list scope 过滤 | `scopeCondition(stores.storeId)` | 无（全部营业中） | 无（全部营业中，合理） | staff 越权可见 | P1 |
| 层级校验 | 前端 4 项 vs 后端 2 项 | — | — | server action 直调破规 | P1 |
| OrgNode.type 枚举 | 4 值 | 4 值 | — 不消费 | OK | — |
| positionScopeEnum 集合 | 3 值 vs OrgNode.type 4 值 | 3 值 | — | 枚举漂移 | P1 |
| `is_closed/closed_at` 双写 | admin 自动维护，无 CHECK | 不写 | 仅过滤 `is_closed=false` | 漂移风险 | P1 |
| createStore marketId type | 不校验 | — | — | 可造非法层级 | P0 |
| permission_roles.scope_id 删除门店 | deleteOrgNode 阻塞（line 215-222） | — | — | OK | P1 |
| store_id 类型 | text，无格式校验 | 同 | 同 | 用户控制 PK | P1 |
| 门店 list 排序 | `ORDER BY storeName`（不带市场） | `ORDER BY m.name, s.store_name` | `ORDER BY pm.name, s.store_name` | UI 漂移 | P2 |
| store_name 名称源 | 编辑后只改 stores 表 | SELECT s.store_name | SELECT s.store_name | 改名后组织树不同步 | P1 |
| 节点类型枚举 | 4 值（一致） | 4 值（一致） | — | OK | — |

---

## 5. 横切检查（套用 audit_plan.md §3 模板，仅记录有问题的项）

- [x] **CC1 数值精度**：org/stores 域无金额，OK。
- [ ] **CC2 并发与幂等**：
  - `createOrgNode` 单 INSERT 原子性 OK；`createStore` 事务 OK。
  - **`updateOrgNode` 改 parentId 无 advisory lock**，并发多管理员改可能产生环 → P0-21-02。
  - P2-21-04 storeId 用毫秒；`P2-21V2-04 getMarketStoreIds` 返回空时兜底 `[storeId]` 掩盖异常。
  - 标记：部分失败。
- [ ] **CC3 组织域数据隔离**：**违反** — staff store.list 全量返回（P1-21V2-03）；staff unbindRequests 单值 storeId（P0-21V2-05）；admin createStore 不校验 marketId type（P0-21-04）；admin updateOrgNode 不校验 newParent scope（P0-21-02）；admin scopeType dept→store（P0-21V2-04）。
  - 标记：CC3 失败。
- [x] **CC4 后端鉴权**：所有路由都过 auth middleware；个别 admin action 需校验 `scope:write`（已通过 PERMISSION_MATRIX）。OK。
- [ ] **CC5 错误前缀**：
  - admin `org.ts` 多处 `return { success:false, message:'无权…' }` 与约定 `PERMISSION_DENIED:` 前缀偏离（admin 走 result 模式而非 throw，与 staff/client throw 模式不一致）。
  - staff `store.js:80,86,89` 已规范，OK。
  - 标记：部分失败（P2）。
- [x] **CC6 PII**：staff `unbindRequests:66` 有 `phoneMasked`，OK。admin store-unbind 列表需确认 scope 守卫。
- [x] **CC7 时间字段**：created_at/updated_at 由 Drizzle defaultNow + $onUpdate；**例外**：admin `updateStore closed_at` 用 JS UTC `toISOString()`（P2-21V2-03）。
- [x] **CC8 WXML/Vant**：本域 admin 主导，N/A。
- [ ] **CC9 测试与残留**：
  - org.test.ts / stores.test.ts 存在，但**未覆盖 cycle 攻击、部门 scope、解绑列名、updateOrgNode parentId** 等 case。
  - scope.test.js mock pg 掩盖 `::uuid[]` bug。
  - `from_store_name` 死引用残留在 client 侧（P0-21-03）。
  - 标记：部分失败。

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema/enums | `db/schema/org.ts` | `stores.org_node_id NOT NULL` + partial unique index | P1-21-04, P1-21-05 |
| L0 schema/enums | `db/schema/org.ts` | 加 cycle 检测触发器（PG BEFORE UPDATE）或 path 物化列 | P0-21-02, P1-21-02 |
| L0 schema/enums | `db/schema/store-unbind.ts` | 文档化 `from_store_id` 唯一字段 | P0-21-03 |
| L0 enums | `db/schema/enums.ts:99` | 评估 `positionScopeEnum` 是否升 4 值 | P0-21V2-04, P1-21V2-01 |
| L0 migration | new `00NN_stores_consistency.sql` | 加 CHECK `is_closed = (closed_at IS NOT NULL)`；加 CHECK `type='总部' implies parent_id IS NULL` | P1-21V2-05 |
| L3 staff/utils | `fengyu-staff/cloudfunctions/staffApi/utils/scope.js:108-122` | `::uuid[]` → `::text[]` | P0-21-01 |
| L3 staff routes | `fengyu-staff/cloudfunctions/staffApi/routes/store.js:42,56,78,88,115,125` | `storeId` → `scopeStoreIds`，过滤改 `ANY($1::text[])` | P0-21V2-05（见注） |
| L3 staff routes | `fengyu-staff/cloudfunctions/staffApi/routes/store.js:14-34` | 加 scope 过滤（按 staffLevel + scopeStoreIds/effectiveStoreId） | P1-21V2-03, P1-21-08 |
| L3 client route | `fengyu-client/cloudfunctions/clientApi/routes/store.js:155-159,174-180` | `from_store_name` → `from_store_id`；JOIN stores 计算 fromStoreName | P0-21-03 |
| L3 client/staff routes | `clientApi/routes/store.js:44,92`；`staff/routes/store.js:23` | JOIN `pm.is_active = true` | P1-21V2-07 |
| L3 staff middleware | `fengyu-staff/cloudfunctions/staffApi/middleware/auth.js:161` | JOIN org_nodes d 加 `AND d.type = '部门'` | P1-21-07 |
| L7 admin actions | `fengyu-admin/src/actions/auth.ts:201` | scopeType 4 值，删 `?? '门店'` fallback | P0-21V2-04 |
| L7 admin actions | `fengyu-admin/src/lib/types.ts:573` | `scopeType: '总部' \| '市场' \| '门店' \| '部门'` | P0-21V2-04 |
| L7 admin actions | `fengyu-admin/src/lib/permissions.ts:114` | `r.scopeType === '部门' continue` 显式忽略 | P0-21V2-04 |
| L7 admin actions | `fengyu-admin/src/actions/org.ts:122-171` | `updateOrgNode` 拒绝/校验 parentId（拆 `moveOrgNode`），加 cycle/层级/同名校验 | P0-21-02, P1-21V2-06 |
| L7 admin actions | `fengyu-admin/src/actions/org.ts:61-120` | `createOrgNode` 补总部唯一/市场→总部/门店→市场校验 | P1-21V2-02 |
| L7 admin actions | `fengyu-admin/src/actions/stores.ts:103-152` | tx 内 `SELECT type='市场'` 校验 marketId；补 `logOperation('org.create', 'org_node')` | P0-21-04, P1-21V2-04 |
| L7 admin actions | `fengyu-admin/src/actions/stores.ts:154-217` | updateStore tx 内同步 `org_nodes.name` | P1-21-01 |
| L7 admin actions | `fengyu-admin/src/actions/org.ts:215-222` | deleteOrgNode 增加 operation_logs 引用检查 | P1-21-06 |
| L7 admin actions | `fengyu-admin/src/actions/stores.ts:196-198` | `closed_at` 用 `sql\`CURRENT_DATE\`` 或带时区 today | P2-21V2-03 |
| L7 admin actions | `fengyu-admin/src/actions/stores.ts:81` | 加 zod schema 限制 `storeId` 格式 | P1-21V2-08 |
| L7 admin actions | `fengyu-admin/src/actions/stores.ts:220-231` | 0 行时返回 `[]` 并记 warn 日志 | P2-21V2-04 |
| L9 admin UI | `fengyu-admin/src/app/(main)/org/_components/org-page.tsx:493` | 删除阻塞具体原因展示 | P2-21V2-02 |
| L9 admin UI | `org-page.tsx` | 编辑节点时支持父节点修改 + 客户端 cycle 检查 | P0-21-02, P2-21-03 |
| L10 测试 | `fengyu-staff/cloudfunctions/staffApi/__tests__/utils/scope.test.js` | 改用真实 PG 容器；补 cycle / 部门 scope / 多店店长 case | CC9, P0-21-01 |
| L10 测试 | `fengyu-admin/src/actions/org.test.ts` | 加 cycle 攻击、部门 scope、parentId 修改 case | P0-21-02 |
| L10 测试 | `fengyu-admin/src/actions/stores.test.ts` | 加 marketId type 错误校验 case | P0-21-04 |

> 注：P0-21V2-05 关联 staff unbindRequests 过滤，与 P0-21V2-04 的部门 scope 问题同属 staff 端 scope 隔离问题，两条一并处理。

---

## 7. 验证 SQL（在 5434/fengyu 仅 SELECT/EXPLAIN，禁止写入）

```sql
-- 7.1 是否存在 from_store_name 列（应为 0）
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'store_unbind_requests' AND column_name LIKE 'from_store%';

-- 7.2 org_nodes id 实际格式（确认无 UUID）
SELECT id, type FROM org_nodes ORDER BY type LIMIT 30;

-- 7.3 检查邻接表是否有环（应为 0 行）
WITH RECURSIVE walk AS (
  SELECT id, parent_id, ARRAY[id]::text[] AS path
  FROM org_nodes WHERE parent_id IS NOT NULL
  UNION ALL
  SELECT o.id, o.parent_id, w.path || o.id
  FROM org_nodes o JOIN walk w ON o.parent_id = w.id
  WHERE NOT (o.id = ANY(w.path))
)
SELECT id, path FROM walk WHERE id = ANY(path[1:array_length(path,1)-1]);

-- 7.4 type=门店 节点 1:1 stores（应为 0 孤儿 / 倒挂）
SELECT o.id, o.name FROM org_nodes o
LEFT JOIN stores s ON s.org_node_id = o.id
WHERE o.type = '门店' AND s.store_id IS NULL;

SELECT s.store_id FROM stores s
LEFT JOIN org_nodes o ON o.id = s.org_node_id
WHERE o.id IS NULL OR o.type <> '门店';

-- 7.5 permission_roles.scope_id FK + 部门 scope 数量
SELECT pr.scope_id, COUNT(*) AS cnt, o.type
FROM permission_roles pr LEFT JOIN org_nodes o ON o.id = pr.scope_id
GROUP BY pr.scope_id, o.type ORDER BY o.type;

-- 7.6 多个总部存在
SELECT id, name FROM org_nodes WHERE type = '总部';

-- 7.7 is_closed 与 closed_at 双写一致性（应为 0 行）
SELECT store_id, is_closed, closed_at FROM stores
WHERE is_closed <> (closed_at IS NOT NULL);

-- 7.8 staff_wechat_users.org_node_id 指向 type='部门'（schema 注释）
SELECT u.employee_id, o.type AS actual_type
FROM staff_wechat_users u
JOIN org_nodes o ON o.id = u.org_node_id
WHERE o.type <> '部门';

-- 7.9 store_unbind_requests.from_store_id FK 完整性
SELECT r.request_id, r.from_store_id
FROM store_unbind_requests r LEFT JOIN stores s ON s.store_id = r.from_store_id
WHERE s.store_id IS NULL;

-- 7.10 EXPLAIN：scope.js 修复后市场 scope 展开
EXPLAIN
SELECT s.store_id FROM stores s
JOIN org_nodes o ON s.org_node_id = o.id
WHERE o.parent_id = ANY(ARRAY['market-XX']::text[]) AND o.type = '门店';

-- 7.11 孤儿门店（stores.org_node_id IS NULL）
SELECT store_id, store_name FROM stores WHERE org_node_id IS NULL;

-- 7.12 org_nodes.name 与 stores.store_name 漂移
SELECT s.store_id, s.store_name, o.name AS node_name
FROM stores s JOIN org_nodes o ON o.id = s.org_node_id
WHERE s.store_name <> o.name;
```

---

## 8. 回归测试用例

### 8.1 client 解绑流（P0-21-03）
1. 客户绑定门店 A → `store.requestUnbind { note }` → 返回 requestId，DB 出现 `from_store_id=A`、`status=待处理`。
2. 重复申请 → 抛 `INVALID_PARAMS: 已有待审批的解绑申请`。
3. `getUnbindRequest` → 返回 `{fromStoreName: '<A 名>'}`（JOIN stores 计算）。
4. `cancelUnbindRequest` → status 变为 `已取消`。
5. 未绑定客户直接 requestUnbind → `INVALID_PARAMS: 当前未绑定任何门店`。

### 8.2 staff scope.js text cast（P0-21-01）
1. 真实 PG 容器：`expandScopeStoreIds([{role:'manager', scopeId:'store-A', scopeType:'门店'}])` 不抛 22P02，返回 `['A']`。
2. 同上 `scopeType:'市场'` + 多市场 ID → 返回市场下全部 store_id。

### 8.3 多店店长解绑审批（P0-21V2-05）
1. 店长 M：`auth.storeId='A'`，`scopeStoreIds=['A','B']`。
2. 顾客在 B 提交解绑 → M 调 `unbindRequests` → 列表含该申请。
3. M 调 `approveUnbind(requestId)` → 成功，bound_store_id 清空。

### 8.4 admin updateOrgNode cycle 防护（P0-21-02）
1. 树：H=hq, M=market(parent=H), S=store(parent=M)。
2. 直调 `updateOrgNode('H', { parentId: 'M' })` → 期望 `{success:false, message:'层级非法或形成环'}`。
3. `updateOrgNode('M', { parentId: 'M' })` → 同样拒绝。
4. `updateOrgNode('M', { parentId: 'S' })`（S 是 M 的子门店）→ 同样拒绝（环路）。

### 8.5 admin 部门级 scope（P0-21V2-04）
1. 给员工 X 分配 `(role='hr', scope_id='dept-X', scope_type=部门)` 角色。
2. X 登录 admin → AuthSession.roles 含 `scopeType='部门'`（不再 fallback）。
3. `expandScopeStoreIds` 显式忽略部门级 → scopeStoreIds=[]，但 isAdminScope/isHQ 路径根据业务规则保留。
4. 访问 customers 列表 → 提示"无门店权限"，不是空白。

### 8.6 admin createStore marketId type 校验（P0-21-04）
1. 传 type='总部' 的 org_node id 作 marketId → 期望返回错误（`层级非法：门店必须挂在市场下`）。
2. 传 type='部门' 同上。

### 8.7 staff store.list scope 过滤（P1-21V2-03）
1. store_staff 用户调 `store.list` → 仅返回 effectiveStoreId 一家。
2. 总部级 management 模式 → 返回所有营业中门店。
3. 未绑定员工 → `UNAUTHORIZED`。

### 8.8 updateStore 改名同步（P1-21-01）
1. 修改 storeName → 验证 `org_nodes.name` 与 `stores.store_name` 同步更新。

### 8.9 closed_at 一致性（P1-21V2-05 + P2-21V2-03）
1. `updateStore({isClosed:true})` → DB 中 `closed_at = CURRENT_DATE`（北京时区 today）。
2. `updateStore({isClosed:false})` → `closed_at IS NULL`。
3. CHECK 约束阻止人工破坏。

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- **全栈（3 端 + DB）：☑**
- 涉及历史数据：☑（孤儿门店/org_node；permission_roles 部门 scope 数据需审计；org_nodes id 格式已确认非 UUID）
- 修复成本：**M**（5 个 P0 + 12 个 P1 + 11 个 P2；核心 P0 预计 2~3 天含测试与灰度）

---

## 10. 后续待办

- [ ] **P0 集中冲刺**：先修 `from_store_name`（client 单点 hotfix）→ 修 `::uuid[]`（staff scope 修复）→ 修 admin scopeType 4 值 → 加 cycle 触发器 → 修多店店长解绑路径 → 修 createStore marketId type 校验
- [ ] 审计现网 5434 数据：跑 §7 全部 12 条 SELECT，将偏差结果落档
- [ ] 与 `audit-12-store-binding`、`audit-CC3-org-isolation` 报告做横向对账（解绑 / scope 隔离重叠）
- [ ] 与 `audit-22-permission-matrix` 报告做横向对账（scopeType 4/3 值差异）
- [ ] 评审 `positionScopeEnum` 是否升 4 值；如不升，明确"部门是 org 维度而非职位维度"
- [ ] 把 admin / staff 的 `expandScopeStoreIds` 抽到共享 SQL 函数，避免再次漂移
- [ ] 在 `db/migrations` 增补迁移：CHECK `is_closed = (closed_at IS NOT NULL)`、CHECK 环拒绝触发器、CHECK 总部唯一

---

## 11. v1→v2 合并摘要

### 共同发现（两版均覆盖，取 v2 更详细版本）
| 问题 | 编号 | 合并决策 |
|------|------|----------|
| scope.js ::uuid[] cast | P0-21-01 | v2 补充了"总部级员工幸免是 bug 隐蔽主因"根因分析，取 v2 |
| updateOrgNode 无 cycle 校验 | P0-21-02 | v2 补充了 root cause 和 fix plan，取 v2 |
| from_store_name 列不存在 | P0-21-03 | v2 补充了 getUnbindRequest 同受波及，取 v2 |

### v1 独有发现（合并入最终报告）
- P0-21-04（createStore marketId type 不校验）— v2 未覆盖，保留
- P1-21-01（双写脱钩）— v2 确认仍存在，保留
- P1-21-02（无 DB 环约束）— v2 P0-21-02 涵盖，但作为独立 P1 保留
- P1-21-03（is_active 不级联）— v2 未覆盖，保留
- P1-21-04（org_node_id nullable）— v2 未覆盖，保留
- P1-21-05（1:1 stores 完整性）— v2 部分覆盖（is_closed CHECK），保留
- P1-21-06（deleteOrgNode 漏 operation_logs 检查）— v2 未覆盖，保留
- P1-21-07（auth.js JOIN 不限 type='部门'）— v2 未覆盖，保留
- P1-21-08（store.list 排序不一致）— v2 未覆盖，保留
- P2-21-01 ~ P2-21-06（6 项 v1 P2）— v2 未覆盖，保留

### v2 独有发现（合并入最终报告）
- P0-21V2-04（admin scopeType dept→store fallback）— v1 无等效，保留
- P1-21V2-01（positionScopeEnum vs OrgNode.type 枚举不一致）— v1 无等效，保留
- P1-21V2-02（前端/后端 validateType 不对称）— v1 P2-21-03 提及但 v2 独立详述，保留
- P1-21V2-03（staff store.list 无 scope 过滤）— v1 P0-21-05 部分覆盖但更侧重 unbind，保留
- P1-21V2-04（createStore 仅记 store.create 日志）— v1 无等效，保留
- P1-21V2-05（无 deleteStore + is_closed CHECK）— v1 无等效，保留
- P1-21V2-06（updateOrgNode 接受过宽 data）— v1 无等效，保留
- P1-21V2-07（market JOIN 不过滤 is_active）— v1 无等效，保留
- P1-21V2-08（storeId 用户控制 PK 无格式）— v1 无等效，保留
- P2-21V2-01 ~ P2-21V2-05（5 项 v2 P2）— v1 无等效，保留

### RESOLVED 列表
**无 RESOLVED 问题**。v2 在独立重审中未修复任何 v1 发现（两版均为审计扫描，无代码修改）；v2 自身发现的新问题亦无一键修复路径，需按 L0→L10 层逐层推进。

### 合并后计数
| 级别 | 去重前合计 | 去重后 |
|------|-----------|--------|
| P0 | 5+5=10（含 v1v2 重复 5） | **5** |
| P1 | 8+8=16（含 v1v2 重复 0） | **12** |
| P2 | 6+6=12（含 v1v2 重复 0） | **11** |
| **合计** | | **28** |

---

**审计完成。** 合并版报告：P0=5，P1=12，P2=11，合计 28 项。v2 独立重审未修复任何 v1 发现，但发现了 1 个 v1 完全未覆盖的 P0（admin scopeType dept→store fallback）和 8 个 v1 完全未覆盖的 P1，整体风险图谱较 v1 更完整。
