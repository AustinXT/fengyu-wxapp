---
title: 员工端（staff）vs 管理后台（admin）权限模型对比
date: 2026-08-08
status: 现状记录（reference）
scope: fengyu-staff/cloudfunctions/staffApi · fengyu-admin
---

# staff vs admin 权限模型对比

> 本文记录员工端云函数（staffApi）与管理后台（admin）两套**互相独立**的权限模型，
> 解释它们为何在架构上不同、各自的设计取舍，以及跨端一致性的检验清单。
> 所有 `file:line` 引用均直接取自当前代码实现，非推测。

---

## 1. 概述：为什么两端权限模型不同

两端的权限模型差异是**架构级别的、有意为之**的，不是缺陷或漂移。根因在于运行形态与角色定位不同：

| | staff 端（小程序 B 端） | admin 端（Next.js 后台） |
|---|---|---|
| 身份载体 | 微信 **OPENID**（`cloud.getWXContext()`，`middleware/auth.js:102`） | **JWT** cookie（`fy-admin-token`，手机号+密码登录） |
| 服务形态 | CloudBase 云函数 action 网关（纯 JS） | Server Actions / RSC（TypeScript） |
| 多角色处理 | 门店模式归并为**单一 staffLevel**；管理层准入从全部 roleBindings 判断 `data_center:dashboard` | 权限**并集**（矩阵制，多角色 actions 摊平合并） |
| 权限定义位置 | 门店模式沿用代码级层级规则；管理层 action 独立读取 DB 矩阵（`system_configs[key='permission_matrix']`，30s 缓存） | DB 可配（`system_configs[key='permission_matrix']`，30s 缓存，admin Web 可改） |
| 设计目标 | 现场操作（开单/服务/顾客），强调"以什么身份登录" | 后台管理（CRUD/对账/审批），强调"能执行什么动作" |

**核心区别一句话**：

- **staff = 门店层级 + 管理层 action 双轨制**——门店模式仍把角色绑定归并为一个 `staffLevel`（总部 > 市场 > 门店店长 > 门店其他）；但管理层模式只看权限矩阵是否授予任一绑定角色 `data_center:dashboard`，并使用全部 `scopeStoreIds` 过滤数据。它同时回答"**你以什么门店身份操作**"和"**你能否进入数据中心**"。
- **admin = 矩阵制**——不归并，把账号所有角色在权限矩阵里查到的 `actions` 取**并集**（`computeActions`），逐 action 判定 `hasPermission`。它回答的是"**你能做什么**"。

两端云函数/后台代码**零共享**（项目硬规则：禁止 cloudfunctions-shared），各自保留独立实现，一致性靠 snapshot 测试守护（见 §3）。

---

## 2. 对比表：级联制（staff）× 矩阵制（admin）

| 维度 | staff（级联制） | admin（矩阵制） |
|---|---|---|
| **一人多角色处理** | 门店模式归并为单一 `staffLevel`；管理层模式对全部 `roleBindings` 查 `data_center:dashboard`，不会因最高职级或 `managerStoreIds` 丢弃其它角色的 scope | 权限并集：`computeActions` 遍历每个角色取矩阵 actions 并入 `Set`（`permissions.ts:221-231`） |
| **级别 / 角色数** | **4 级**：`LEVEL_HEADQUARTERS` / `LEVEL_MARKET` / `LEVEL_STORE_MANAGER` / `LEVEL_STORE_STAFF`（`scope.js:12-15`） | **6 角色**矩阵 + admin：admin / manager / finance / hr / product / customer_mgr（staff 角色为空数组）（`permissions.ts:23-152`） |
| **权限定义位置** | 门店行为由 LEVEL_* / 守卫控制；管理层由独立的 `utils/permission-matrix.js` 读取同一 DB 矩阵，失败回退 admin 当前默认角色，**30s 进程缓存** | DB 权威：`system_configs[key='permission_matrix']`，`getPermissionMatrix()` 读 DB 优先、失败回退 `DEFAULT_PERMISSION_MATRIX`，**30s 进程缓存**（`permissions.ts:172-213`），admin Web 可视化编辑 |
| **scope 展开（store 集合）** | `expandScopeStoreIds(roleBindings, pg)`：总部→全部 stores；市场/门店→绑定组织节点及递归后代的 stores；部门忽略。所有角色绑定取并集，管理层不再只取 manager 绑定 | `expandScopeStoreIds(roles)`：同三档规则，但用 **Drizzle ORM**（`permissions.ts:240-282`）。两端**实现独立、规则等价** |
| **SQL 门店过滤** | `buildStoreScopeCondition`：管理层模式 `column = ANY($n::text[])`（按 `scopeStoreIds`）；门店模式 `column = $n`（单值 `effectiveStoreId`）；空集合 → `FALSE`（`scope.js:139-159`） | `scopeCondition`：admin 角色 → `undefined`（**完全免过滤**）；其余角色有 scope → `inArray(column, ids)`；无 scope → `sql\`FALSE\``（`permissions.ts:358-370`） |
| **loginLevel / effectiveStoreId** | **有**。`loginLevel`（store/management）由请求 `payload._loginLevel` 选定；只有 `hasDataCenterDashboard && scopeStoreIds.length > 0` 才可选 management。管理层 `effectiveStoreId = null`，各路由按完整 `scopeStoreIds` 校验/过滤 | **无**。admin 无"以哪个身份登录"的运行时切换；统一按 `scopeStoreIds` 并集过滤，admin 角色全局可见 |
| **store_staff 顾客收紧** | **有**。`restrictToBoundEmployee(auth)` 仅对 `LEVEL_STORE_STAFF` 返回 true（`scope.js:214-216`），顾客档案 SQL 额外加 `bound_employee_id = 自己`（`buildProfileScopeCondition` `scope.js:227-235`） | **无员工级收紧**。最细粒度是门店（`scopeStoreIds`），无"只看分配给本人的顾客"概念 |
| **managerStoreIds 写授权** | **有**。仅展开 `role='manager'` 绑定得到 `managerStoreIds`，`requireManager` 在门店模式下用它防止店长写越权；**管理层数据绝不使用此集合** | **无独立写授权集**。写操作同样按 `scopeStoreIds` + `hasPermission(action)` 判定，无 manager 专属门店子集 |
| **角色 × scope 合法配对** | 门店层级由 role binding 展开；部门级仍不参与 staff 视图 | 显式表：`ROLE_SCOPE_TYPES`（`role-scope-rules.ts`）：`admin` 仅总部，除 `admin` 外的所有权限角色均允许门店（`staff` 仍仅门店） |
| **节点 scope 判定** | 纯内存 `isStoreInScope`（不查 DB，`scope.js:171-178`）+ 一组 `assert*InScope`（查 DB 反查 store_id 再判） | `isInScope`（内存判 store，`permissions.ts:377-380`）+ `isNodeInScope`（沿 `parentId` 向上**最多 5 层**遍历命中祖先，`node-scope.ts:16-32`），admin 始终 true |
| **缓存** | OPENID → 员工基础信息缓存 **TTL 5 分钟**；`data_center:dashboard` 在基础缓存外独立读取，矩阵缓存 **TTL 30s**，因此矩阵改动最多约 30 秒生效 | 权限矩阵进程缓存 **TTL 30s**，写矩阵主动 invalidate（`permissions.ts:172-178`） |

---

## 3. 跨端一致性检验清单 + 已核结论

以下为已核对的跨端一致性点：

### 3.1 库存调拨单双向可见 —— 已核一致

调拨单（transfer）对**发出店**和**接收店**双方都应可见。两端均实现 `store_id OR counterpart_store_id` 双列过滤：

- **staff**：`routes/inventory.js:72-77`，`storeFilterMode === 'transfer'` 分支生成
  `(m.store_id = ANY($n) OR m.counterpart_store_id = ANY($n))`；列表与 detail 一致。
- **admin**：`actions/inventory/transfer.ts:83-93`，Drizzle `or(storeId IN ..., counterpartStoreId IN ...)` 双向。

**结论：双向可见口径一致。** 修改/删除权限的差异（admin 侧由**接收店确认收货**、**发出店删除**）属业务设计，非权限模型缺陷。

### 3.2 退款级联多主体 —— 已对齐

退款涉及储值卡回冲、积分回退、订单状态等多主体级联（参见迁移计划场景 9）。staff 端多项退款已对齐 admin 的拆分口径（`floor(prepaid/total × refund, 2)` 比例拆分）。

### 3.3 错误码 9 前缀白名单 —— snapshot 守护

9 项官方前缀（`UNAUTHORIZED` / `PHONE_REQUIRED` / `INVALID_PARAMS` / `PERMISSION_DENIED` /
`NOT_FOUND` / `INSUFFICIENT_BALANCE` / `CONFLICT` / `INVALID_STATE` / `CLIENT_NOT_REGISTERED`）三端 + admin 共用单源，由
`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js` +
`fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts` 任一漂移即失败。

---

## 4. 新增「多主体可见」业务单据时的核对清单

当新增一种需要**多门店主体共同可见**的单据（类似调拨单的 发出方/接收方）时，**两端都要改**，按下表逐项核对：

**staff 端（staffApi）**：

1. 在该单据的 `CATEGORY_CONFIG`（或等价路由配置）上加 `storeFilterMode` 标记（参考 `inventory.js:39-52` transfer 的写法）。
2. `buildStoreFilter` / `buildStoreScopeCondition` 调用处生成 **OR 双列**条件：
   `(m.store_id = ANY($n) OR m.<对方列> = ANY($n))`（参考 `inventory.js:72-77`）。
3. 门店模式（单值 `effectiveStoreId`）与管理层模式（`ANY(array)`）两条路径都要覆盖 OR。
4. detail 接口与 list 接口口径保持一致（避免列表能看、详情 403）。

**admin 端**：

5. 在对应 action 里**自建 `or()` 条件**（Drizzle `or(storeId IN ..., counterpartStoreId IN ...)`，参考 `transfer.ts:83-93`），不能直接复用 `scopeCondition`（它只过滤单列 `storeId`）。
6. 保留 `isAdminScope → 免过滤` 分支（参考 `transfer.ts` 的 `isAdminLike` 短路）。
7. `scopeStoreIds` 为空时回退 `sql\`FALSE\``，与 staff 的空集合 `FALSE` 行为对齐。

**通用**：两端实现独立、规则需等价；建议补一条 cross-end snapshot 或 e2e 断言双向可见，防止单端漂移。

---

## 5. 关联文档

- `.42cog/dev/staff.sys.spec.md` §3「认证与权限模型」（RBAC + Scope，§3.2 一人多角色 + buildScopeWhere/buildStaffFilter）
- `.42cog/dev/admin.sys.spec.md` §7「权限模型」（6 角色权限矩阵表 + scopeStoreIds 递归展开 + scope 传递约束）
- memory 主题 `role-scope-pairing`（`project_role_scope_pairing.md`）—— 7 种角色 × `org_nodes.type` 合法配对表（2026-05-18 拍板），对应 admin `role-scope-rules.ts:5-13`
- 项目硬规则 `feedback_no_shared_cloudfunctions.md` —— 三端云函数 + admin 各自独立副本，禁止抽 shared，一致性靠 snapshot
