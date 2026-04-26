# 审计报告：组织架构 (org_nodes 邻接表 + stores 1:1) (21)

**审计时间**：2026-04-25
**域 ID**：21
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟
**关联 PR/Ticket**：—

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/org.ts:17-70`（org_nodes + stores） | ↑ | ↑ |
| Schema (FK) | `db/schema/permission.ts:22-24`（scope_id → org_nodes.id） | — | — |
| Schema (FK) | `db/schema/operation-log.ts:23`（org_node_id → org_nodes.id） | — | — |
| Schema (FK) | `db/schema/user.ts:113`（staff.org_node_id → org_nodes.id） | — | — |
| Schema (FK) | `db/schema/store-unbind.ts:11-13`（from_store_id → stores.store_id） | — | — |
| Action/Route | `src/actions/org.ts`（getOrgNodes/createOrgNode/updateOrgNode/deleteOrgNode） | `routes/store.js:14-34`（list） | `routes/store.js:14-56`（list）`62-121`（detail） |
| Action/Route | `src/actions/stores.ts`（getStores/getStoreById/createStore/updateStore/getMarketStoreIds） | `utils/scope.js`（expandScopeStoreIds 关键路径） | — |
| 前端 | `app/(main)/org/page.tsx` + `_components/org-page.tsx`；`app/(main)/stores/page.tsx` + `[id]/edit` + `create/_components/store-create-page.tsx` | `pages/store/select`（仅展示） | `pages/store/list` `pages/store/detail` |
| 测试 | `src/actions/org.test.ts`、`src/actions/stores.test.ts` | — | — |

## 2. 数据流图

```
admin org.create  → orgNodes.insert (无 cycle 检测除约束 unique(parent_id,name))
admin store.create → tx{ orgNodes.insert(type='门店',id='store-{ts}') + stores.insert }
                    ↓ 双写：org_nodes.name 与 stores.store_name 同时初值，但永久脱钩
admin store.update → 仅更新 stores 表；org_nodes.name 不同步 ← P1 漂移
admin org.update  → 接受 parentId 字段但不校验目标 → 父节点环路 / 跨 type / 越权 ← P0
permission_roles.scope_id → org_nodes.id（FK）
staff scope.expandScopeStoreIds → 把 text id 强制 cast 为 uuid[] ← P0 运行时
staff/client store.list → 直接 SELECT WHERE is_closed=false（不读 isActive 也不带 scope）
```

## 3. 自身漏洞

### 3.1 P0（阻断/资损/越权）

- **[P0-21-01]** `staff/utils/scope.js` 把 `text` 列强制 cast 为 `uuid[]`，业务 SQL 100% 报错
  - 文件：`fengyu-staff/cloudfunctions/staffApi/utils/scope.js:108-122`
  - 现象：`SELECT … WHERE o.parent_id = ANY($1::uuid[])` / `WHERE org_node_id = ANY($1::uuid[])`，但 `org_nodes.id`、`org_nodes.parent_id`、`stores.org_node_id` 三个列在 schema 与 baseline migration 中均为 `text`（见 `db/schema/org.ts:20,23,46`、`db/migrations/0000_baseline.sql:27,30,41`）
  - 风险：所有走 `expandScopeStoreIds` 的市场/门店级管理员**首次登录直接 22P02 invalid input syntax for type uuid**，进而 staffLevel 无 scopeStoreIds，retain audit-12 P0 同模式（路由全失效）。注：当前节点 ID 形如 `store-{ts}` 或 `org-部门-{ts}` 字面量，绝非 UUID。
  - 复现：1) 给某员工赋 manager+市场 scope 角色 2) 该员工 staffApi 任意接口 3) 中间件链路调用 `expandScopeStoreIds` 抛 22P02
  - 修复：(L3) 把两处 `::uuid[]` 改为 `::text[]`
- **[P0-21-02]** `updateOrgNode` 接受 `parentId` 但完全无校验：父节点环路 / 跨类型违规 / 越权
  - 文件：`fengyu-admin/src/actions/org.ts:122-171`
  - 现象：函数签名 `data: Partial<{ name; type; parentId; sortOrder; isActive }>` 包含 parentId，但 122-156 行只校验 `data.type`、`isNodeInScope(id)`，从不校验目标 `data.parentId` 是否：(a) 在自身后代子树中（产生环路）(b) 类型组合合法（市场不能挂在门店下）(c) 在用户 scope 内
  - 风险：(a) 设 `parentId = self.id` 或子孙 id 即制造邻接表环路，所有走 `isNodeInScope`（最多 5 层向上回溯）的地方将进入近似无限循环或直接漏判（5 层后 false 但环本身仍存在）。`scopeCondition` / `expandScopeStoreIds` 也会陷入无限自循环。(b) 把"门店"挪到"门店"下、"市场"挪到"市场"下，破坏 `getMarketStoreIds`（`stores.ts:220-231` 同市场拉取门店 SQL）的层级假设。(c) 普通 hr 可把任意节点挪进自己 scope 制造越权。
  - 复现：1) 选择"市场 A"节点 2) 调 updateOrgNode(marketAId, { parentId: marketAId }) 即可；或 parentId 设为该市场下任意子节点 id
  - 修复：(L7) 与 createOrgNode 同款校验：父节点存在性 + 类型组合 + isNodeInScope(newParent) + 后代检测（递归 CTE 或递归遍历）
- **[P0-21-03]** `client/store.requestUnbind` 写入不存在的 `from_store_name` 列（retain audit-12 P0-12-01）
  - 文件：`fengyu-client/cloudfunctions/clientApi/routes/store.js:155-159`
  - 现象：`INSERT INTO store_unbind_requests (request_id, user_id, from_store_name, status, note) …`。`store_unbind_requests` 实际仅有 `from_store_id`（见 `db/schema/store-unbind.ts:11`、`migrations/0000_baseline.sql:350`），`from_store_name` 列完全不存在。
  - 风险：顾客解绑申请链路 100% 失效；与 audit-21 同域因为 `stores 1:1 org_nodes` 的 `store_name` 与 `org_nodes.name` 双写存在而被二次依赖。
  - 复现：clientApi 调 `store.requestUnbind` → 42703 column "from_store_name" does not exist
  - 修复：(L3) 改为 `INSERT … (request_id, user_id, from_store_id, status, note) VALUES ($1,$2,$3,'待处理',$4)`，第三个参数用 `boundStoreId`
- **[P0-21-04]** `stores.ts:createStore` 与 `org.ts:createOrgNode` 不同事务，存在 type/parent 隐式越权
  - 文件：`fengyu-admin/src/actions/stores.ts:103-152`
  - 现象：createStore 用 `db.transaction` 一次写 org_nodes(type='门店',parentId=marketId) + stores（OK）。但**不校验** marketId 对应的 org_node 实际 type 是否 = '市场'：调用方只要传任意已存在的 org_node id 即可挂上来（甚至 type='总部' 或 type='部门'），破坏邻接表"门店只能挂市场"的层级约束。`db/schema/org.ts:9-14` 注释明确层级约束，但靠应用层校验，stores.createStore 跳过了这一步。
  - 风险：admin / hr 角色可越权造出"总部 → 门店"或"部门 → 门店"非法链；getMarketStoreIds（`stores.ts:220-231`）把 store 当作"market_node 下的门店"假设破坏，跨市场提成/scope 计算产生漂移
  - 修复：(L7) tx 内先 SELECT type FROM org_nodes WHERE id = marketId，type !== '市场' 直接拒绝
- **[P0-21-05]** `client/store.list` & `staff/store.list` 完全无 scope 隔离（retain CC3 通模式）
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/store.js:16-34`、`fengyu-client/cloudfunctions/clientApi/routes/store.js:14-56`
  - 现象：staff 端 store.list 不在中间件后过 `requireStaffBound`，也不按 ctx.auth.scopeStoreIds 限制，直接全量返回所有营业中门店。client 端 store.list 默认拉全国所有门店，靠 `city` 模糊筛选。
  - 风险：staff 端市场/门店级管理员可看到非自己 scope 的门店列表（用作下拉选择跨域）；client 端是合理设计（顾客需要选门店），但 staff 端违反 §real.md "组织域数据隔离"。注意：`mgmt-dashboard.scopeOptions` 是另一条路径不受影响，但选择器场景下 staff/store.list 与 admin getStores（`stores.ts:48-63` 已用 scopeCondition）口径不一致。
  - 修复：(L3) staff store.list 加 `requireStaffBound()` + WHERE `s.store_id = ANY($1::text[])` 用 ctx.auth.scopeStoreIds 过滤

### 3.2 P1（数据一致 / 状态错乱）

- **[P1-21-01]** `org_nodes.name` 与 `stores.store_name` 双写永久脱钩
  - 文件：`fengyu-admin/src/actions/stores.ts:154-217`（updateStore）
  - 现象：updateStore 仅更新 stores 表，从不同步 `org_nodes.name`。createStore 时同步初值（`name: data.storeName` 与 `storeName: data.storeName`），后续编辑就此漂移。前端 staff/client 端 list 用 `s.store_name`（`fengyu-client/.../store.js:30,82` 用 store_name），admin 端混用（store_unbind 列表用 `s.store_name`，`isNodeInScope` / org tree UI 用 `org_nodes.name`）。
  - 风险：admin 改门店名后，组织树中该门店仍显示旧名；权限分配 UI 走 `org_nodes.name` 也错乱
  - 修复：(L7) updateStore 在 tx 内同步 `UPDATE org_nodes SET name = $newName WHERE id = $orgNodeId` 当 storeName 变化时
- **[P1-21-02]** 邻接表无环约束完全靠应用层 + 类型校验仅看一层父节点
  - 文件：`fengyu-admin/src/actions/org.ts:79-94`、`db/schema/org.ts:17-34`
  - 现象：DB 层只有 `unique(parent_id, name)` 约束，没有 cycle prevention（无 trigger / 无 path 列 / 无 level 列）。createOrgNode 仅校验"直接父节点 type"，不校验 ancestor 链是否合规（如部门挂在市场下，再用 updateOrgNode 把它移到该市场的另一门店下其实合法，但若移到本市场的下属部门下就会触发 P0-21-02）。
  - 风险：见 P0-21-02。规模小（公司一般 ≤4 层）勉强能用 5 层向上扫描兜底，但缺一道防线。
  - 修复：(L0) 加 trigger 或 (L7) 在 create/update 都做 ancestor 扫描；考虑加 `path` 物化列（ltree）或 closure-table
- **[P1-21-03]** `org_nodes.is_active=false` 不级联到 stores / staff / 业务查询
  - 文件：`db/schema/org.ts:25`、各 store.list 路由
  - 现象：org_nodes 有 isActive 列，admin org tree 默认隐藏停用节点；但 stores 表没有联动概念（用 `is_closed`），staff 路由也只看 `s.is_closed=false` 不看 `org_node.is_active`。store_unbind / customer 也按 store_id 过滤。
  - 风险：把"市场 A" `is_active=false` 后，A 下的门店仍正常营业可见，但权限/scope 解析中市场 A 是否还展开为下属门店行为不确定（`expandScopeStoreIds` 没看 isActive）
  - 修复：(L7) 业务侧文档化 isActive 的语义并在权限展开时一并过滤；或 (L0) 把 isActive 收敛为 stores.is_closed 的派生字段
- **[P1-21-04]** `stores.org_node_id` 是 nullable，孤儿门店不会被 createStore 路径产生但旧数据存在
  - 文件：`db/schema/org.ts:46`、`db/migrations/0000_baseline.sql:41`
  - 现象：`org_node_id text`（无 NOT NULL）。createStore（`stores.ts:111-141`）始终写值，但旧数据/同步路径可能留空。审计 SQL：`SELECT count(*) FROM stores WHERE org_node_id IS NULL` 应为 0。
  - 风险：staff/client store.list LEFT JOIN org_nodes，store_name 出现但 market_name 为空；scope 展开（`expandScopeStoreIds` 走 stores.org_node_id IN）漏掉孤儿门店
  - 修复：(L0) 加 `NOT NULL` 约束 + 数据回填
- **[P1-21-05]** type='门店' 与 stores 1:1 完整性无 schema 强制
  - 文件：`db/schema/org.ts:36-70`
  - 现象：`org_nodes.type='门店'` 行不一定有 stores 行，反之 stores.org_node_id 也不一定指向 type='门店'。无 partial unique / FK 类型约束。
  - 风险：admin createStore 写 org_node + stores 是事务原子，但 admin 在 org tree 直接 createOrgNode(type='门店') 完全合法（不会带出 stores 行），产生孤儿 org_node
  - 修复：(L0) `CREATE UNIQUE INDEX uq_stores_org_node_id ON stores(org_node_id) WHERE org_node_id IS NOT NULL`；(L7) 阻止 admin 在组织树创建 type='门店'，引导走 /stores/create
- **[P1-21-06]** scope_id FK 删 `org_nodes` 时只看子节点不看 permission_roles
  - 文件：`fengyu-admin/src/actions/org.ts:215-222`
  - 现象：deleteOrgNode 已显式检查 permissionRoles.scopeId、staff_wechat_users.orgNodeId、stores.orgNodeId、子节点 → OK；但 `operation_logs.org_node_id` 也是 FK 却未检查（`db/schema/operation-log.ts:23`）
  - 风险：删除节点时 23503 报错出错信息暴露
  - 修复：(L7) 增加 operation_logs 引用检查或改用软删除
- **[P1-21-07]** staff `auth.js` JOIN `org_nodes d ON u.org_node_id = d.id` 不限定 type
  - 文件：`fengyu-staff/cloudfunctions/staffApi/middleware/auth.js:161`
  - 现象：员工的 `org_node_id` 期望挂"部门"节点，但应用层无强制；若挂到市场或门店下，department 字段会显示市场名/门店名
  - 风险：UI department 字段语义模糊
  - 修复：(L3) 加 `AND d.type = '部门'`
- **[P1-21-08]** `staff/store.list` & `client/store.list` 排序口径不一致
  - 文件：staff `routes/store.js:27` `ORDER BY m.name, s.store_name`；client `routes/store.js:48` 同；admin `actions/stores.ts:60` 注释例外 `asc(stores.storeName)`（不带市场）
  - 风险：UX 不一致，三端显示同一组数据顺序漂移；不算资损但跨端体验割裂

### 3.3 P2

- **[P2-21-01]** `staff/store.list` 不包含 staff_count / customer_count，与 `client/store.detail`（`routes/store.js:107-118`）口径不同
  - 风险：选择器与详情语义割裂；非 P1
- **[P2-21-02]** `client/store.list` 用 `LIKE $1` 拼接 city 参数前缀匹配，能注入 `%` 通配符
  - 文件：`clientApi/routes/store.js:22-24`
  - 现象：`params.push(\`${city}%\`)` 把用户输入直接 + `%`；用户传 `%` 即匹配所有
  - 风险：低（仅扩大匹配集，无注入资损），但破坏 city 精确语义
  - 修复：先 escape 用户传入的 `%` `_`
- **[P2-21-03]** admin org-page 客户端 `validateType` 与 server `createOrgNode` 类型规则**只对 create 重叠，update 走 server 仅类型字符串校验**
  - 文件：`org-page.tsx:39-54` vs `actions/org.ts:138-140`
  - 现象：客户端校验市场/门店父类型，server updateOrgNode 不校验 type 与 parent 关系
  - 风险：绕过前端直接调 server action 即破坏层级（联动 P0-21-02）
- **[P2-21-04]** `stores.create` 用 `Date.now()` 生成 storeId，无 advisory lock；并发情况下毫秒粒度可重号（极小概率但理论存在）
  - 文件：`store-create-page.tsx:41`
  - 现象：`const storeId = \`store-${Date.now()}\``
  - 风险：极低；建议改 `crypto.randomUUID()` 或 `crypto.randomBytes(8)`
- **[P2-21-05]** geocode 路由无 `requirePhone` 限频（retain audit-12 P0 同款）
  - 文件：`clientApi/routes/store.js:225-261`
- **[P2-21-06]** staff 路由 `approveUnbind`/`rejectUnbind` 全程 0 operation_logs（retain audit-12 P0 同模式，但本域 list 路径同样不写）

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| 门店 list 排序 | `ORDER BY storeName` | `ORDER BY m.name, s.store_name` | `ORDER BY pm.name, s.store_name` | UI 漂移 | P1 |
| store_name 名称源 | 编辑后只改 stores 表 | 列表 SELECT s.store_name | 列表 SELECT s.store_name | 改名后组织树/permission UI 走 org_nodes.name 不同步 | P1 |
| scope 隔离 | scopeCondition(stores.storeId) 强制 | store.list 全量返回（不过滤） | 全量返回（合理，C 端） | staff 选择器跨域 | P0 |
| org_node 创建鉴权 | createOrgNode 校验 isNodeInScope(parent) | — | — | updateOrgNode 不校验 → 越权 | P0 |
| `org_nodes.id` cast | text（schema 一致） | scope.js 误 cast `::uuid[]` | — | 22P02 报错 | P0 |
| store_unbind 列名 | actions.ts 用 fromStoreId | store.js:51-58 SELECT from_store_id（OK） | store.js:155-159 INSERT 写 from_store_name（不存在） | client unbind 失效 | P0 |
| 节点类型枚举 | 4 值（总部/市场/门店/部门）一致 | 一致 | 一致 | OK | — |

## 5. 横切检查（套用 §3 模板，仅记录有问题的项）

- [x] CC1 数值：N/A（org 域无金额）
- [x] CC2 并发幂等：admin createStore 用事务 + ON DELETE no action；P2-21-04 storeId 用毫秒；createOrgNode 靠 unique(parent_id,name) 兜底
- [ ] CC3 组织域数据隔离：**违反** — staff store.list 全量返回（P0-21-05）；admin createStore 不校验 marketId 类型 + scope（P0-21-04）；admin updateOrgNode 不校验 newParent scope（P0-21-02）
- [ ] CC4 后端鉴权：**违反** — staff store.list 缺 requireStaffBound（P0-21-05）；client requestUnbind 走 ctx.auth 但不校验 boundStoreId 是否仍在营业
- [x] CC5 错误码：admin actions 全部走 `{ success, message }` 格式 + 异常抛 PERMISSION_DENIED；staff/client 路由错误前缀符合 4 项约定
- [ ] CC6 PII：staff unbindRequests 已脱敏（`phoneMasked`, `routes/store.js:65`），但 admin store-unbind 列表展示客户姓名 + 手机号原文（`stores-page.tsx:254-255`）— 需要看 admin scope 守卫
- [x] CC7 时间字段：created_at / updated_at 都走 DEFAULT now() + $onUpdate(() => new Date())
- [x] CC8 WXML/Vant：N/A（admin Web，staff/client list 都是普通 SELECT）
- [ ] CC9 测试与残留：`stores.test.ts` 覆盖 createStore/updateStore（OK）；但 `org.test.ts` 覆盖 createOrgNode/deleteOrgNode 但**不覆盖 updateOrgNode 的 parentId 路径**（恰好漏过 P0-21-02）

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/org.ts` | stores.org_node_id NOT NULL + UNIQUE partial index | P1-21-04 / P1-21-05 |
| L0 schema | `db/schema/org.ts` | 加 cycle 检测 trigger 或物化 path 列 | P1-21-02 |
| L3 staff/utils | `fengyu-staff/cloudfunctions/staffApi/utils/scope.js:108-122` | `::uuid[]` → `::text[]` | P0-21-01 |
| L3 staff route | `fengyu-staff/cloudfunctions/staffApi/routes/store.js:14-34` | 加 requireStaffBound + scopeStoreIds 过滤 | P0-21-05 |
| L3 staff middleware | `fengyu-staff/cloudfunctions/staffApi/middleware/auth.js:161` | JOIN org_nodes d 加 AND d.type='部门' | P1-21-07 |
| L3 client route | `fengyu-client/cloudfunctions/clientApi/routes/store.js:155-159` | from_store_name → from_store_id | P0-21-03 |
| L7 admin actions | `fengyu-admin/src/actions/org.ts:122-171` | updateOrgNode 加 newParent 校验（type / scope / cycle） | P0-21-02 |
| L7 admin actions | `fengyu-admin/src/actions/stores.ts:103-152` | createStore tx 内 SELECT type='市场' 校验 | P0-21-04 |
| L7 admin actions | `fengyu-admin/src/actions/stores.ts:154-217` | updateStore tx 内同步 org_nodes.name | P1-21-01 |
| L7 admin actions | `fengyu-admin/src/actions/org.ts:215-222` | deleteOrgNode 检查 operation_logs.org_node_id 引用 | P1-21-06 |
| L9 admin UI | `fengyu-admin/src/app/(main)/org/_components/org-page.tsx` | 编辑节点时支持父节点修改 + 客户端 cycle 检查 | P2-21-03 |

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- 1. 验证 type='门店' 与 stores 1:1 完整性
SELECT o.id AS org_node_id, o.name, o.type, s.store_id
FROM org_nodes o
LEFT JOIN stores s ON s.org_node_id = o.id
WHERE o.type = '门店' AND s.store_id IS NULL; -- 期望 0 行（孤儿 org_node）

SELECT s.store_id, s.org_node_id, o.id, o.type
FROM stores s
LEFT JOIN org_nodes o ON o.id = s.org_node_id
WHERE s.org_node_id IS NULL OR o.id IS NULL OR o.type <> '门店'; -- 期望 0 行

-- 2. 验证邻接表无环（最多 5 层下抓取潜在环）
WITH RECURSIVE chain AS (
  SELECT id, parent_id, ARRAY[id] AS path, 1 AS depth FROM org_nodes WHERE parent_id IS NOT NULL
  UNION ALL
  SELECT c.id, o.parent_id, path || o.id, depth+1
  FROM chain c JOIN org_nodes o ON o.id = c.parent_id
  WHERE depth < 10 AND NOT (o.id = ANY(path))
)
SELECT id FROM chain WHERE parent_id = ANY(path); -- 期望 0 行

-- 3. 邻接表层级合法性（市场→总部 / 门店→市场 / 部门 != 部门）
SELECT child.id, child.type, parent.type AS parent_type
FROM org_nodes child JOIN org_nodes parent ON child.parent_id = parent.id
WHERE (child.type='市场' AND parent.type<>'总部')
   OR (child.type='门店' AND parent.type<>'市场')
   OR (child.type='部门' AND parent.type='部门'); -- 期望 0 行

-- 4. permission_roles.scope_id FK 完整性
SELECT pr.id FROM permission_roles pr
LEFT JOIN org_nodes o ON o.id = pr.scope_id
WHERE o.id IS NULL; -- 期望 0 行（FK 兜底）

-- 5. org_nodes.name 与 stores.store_name 漂移
SELECT s.store_id, s.store_name, o.name AS node_name
FROM stores s JOIN org_nodes o ON o.id = s.org_node_id
WHERE s.store_name <> o.name;

-- 6. id 是否符合"非 UUID"假设（验证 P0-21-01 cast 错误）
SELECT id FROM org_nodes WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' LIMIT 5;
```

## 8. 回归测试用例（建议）

1. **updateOrgNode cycle**：把节点 A 的 parentId 设为自己 → 期望返回 `{success:false, message:'不能将节点设为自身或子孙节点的子节点'}`
2. **updateOrgNode 跨类型**：把 type='市场' 的节点挂到 type='部门' 下 → 期望拒绝
3. **createStore marketId 错类型**：传 type='总部' 的 org_node id 作 marketId → 期望返回错误
4. **staff store.list scope**：市场级管理员调 → 仅返回该市场下营业中门店
5. **client requestUnbind**：调 → 应正常写入 store_unbind_requests，from_store_id 列为 boundStoreId
6. **scope.expandScopeStoreIds 数据类型**：mock pg.query 接收 `text[]` 入参，断言 SQL 参数 cast 为 `::text[]`
7. **updateStore 改名同步**：修改 storeName → 验证 org_nodes.name 与 stores.store_name 同步更新

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑
- 涉及历史数据：☑（org_nodes / stores 1:1 完整性回扫，孤儿 org_node 治理）
- 修复成本：M（schema NOT NULL/UNIQUE + 5 处代码 + 1 处 cast 修正）

## 10. 后续待办

- [ ] 与 audit-12（store-binding）合并 retain：from_store_name 列错误 / staff approveUnbind 漏 op log（已纳入 retain 表）
- [ ] 写补丁迁移：stores.org_node_id NOT NULL + UNIQUE partial + 可选 cycle prevention trigger
- [ ] scope.js `::uuid[]` cast 修复后，跑一次 staff/store.list / mgmt-dashboard.scopeOptions / staff.list 三端冒烟
- [ ] 推动 audit-22 权限矩阵审计时验证 scope_id FK 完整性 + admin createOrgNode/updateOrgNode 的 cycle 检测同步进 PERMISSION_MATRIX 文档
