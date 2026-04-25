# Ticket: admin 所有列表默认按 updated_at / created_at 逆序（规范化）

> 生成日期：2026-04-24
> 严重级别：P2（一致性 / 可预测性 / 列表行为规范化）
> 端：fengyu-admin（管理后台，**唯一影响面**）
> 影响面：`fengyu-admin/src/actions/*.ts` 中所有返回列表的 Server Action（约 20+ 个文件、40+ 个 query）
> 前置：无；可单独合并
> 并行：与 Ticket 1/2/3（多次回款 / 退款对齐）互不干扰
>
> **一句话目标**：admin 端所有"列表类"请求如果没有明确的业务排序规则，一律按 `ORDER BY updated_at DESC NULLS LAST, created_at DESC`（若表有 `updated_at`）或 `ORDER BY created_at DESC`（若仅有 `created_at`）排列；把这条规则写进 `.42cog/dev/sys.spec.md`，同时把违反该默认的已存在代码盘点出来、分级修复。

---

## 0 一句话背景

管理员操作一个 admin 列表（订单、顾客、员工、券、退款单、消息、积分流水、提货记录……）时，**最自然的期望是"最近动过的在最上面"**：

- 新建一行 → 它应出现在最顶部
- 修改一行 → 它应浮到顶部
- 不动 → 它沉下去

但目前 admin 端 40+ 个列表 action 的 `ORDER BY` 分布不均：一部分是 `desc(createdAt)`、一部分是 `asc(name)`、一部分是 `asc(id)`、还有若干 `asc(sortOrder)`；**且没有任何一个列表用到 `updated_at`**。这导致：

1. 用户在 admin 里编辑了一行顾客/员工/门店/角色后，必须去翻页或搜索才能找到刚改过的行
2. 同类页面（"管理列表"）行为不一致：订单按创建时间倒序、员工按 name 字母序、角色按 id 升序
3. 新人开发者写 action 时不知道该用什么默认 `ORDER BY`，只能抄上一份

**本 ticket 的目标是立规矩 + 盘点现状 + 分级回填。** 不新增业务能力。

---

## 1 默认规则

### 1.1 规则文本（将写入 `.42cog/dev/sys.spec.md`）

> **admin 列表默认排序规则**
>
> admin 端所有通过 Server Action 返回的"列表类"数据，除非有明确的业务语义要求其他顺序，一律按以下优先级排序：
>
> 1. 若表有 `updated_at` 列：`ORDER BY updated_at DESC NULLS LAST, created_at DESC, id DESC`
> 2. 若表仅有 `created_at` 列：`ORDER BY created_at DESC, id DESC`
> 3. 若表只有业务时间列（如 `sale_order_datetime`、`appointment_time`、`paid_at`）：优先业务时间 `DESC`，再 `created_at DESC`
>
> **`id DESC` 作为最后 tiebreaker，保证分页稳定。**
>
> **例外（"特别规定"）必须在 action 旁边写一行注释，说明原因：**
>
> - 有 `sort_order` 字段的配置型列表（品类、规格、技能标签、组织节点、职位等）→ 按 `sort_order ASC` + 名称 ASC
> - 下拉选择器 / 搜索弹层 / 批量选择列表 → 可按 `name ASC`（人眼字母序更友好）
> - 有业务语义的时间排序（即将过期券按 `expire_at ASC`）→ 保留
> - 枚举型短列表（角色、权限等）→ 可保留 `id ASC`，但必须标注"短列表 + 枚举稳定"理由

### 1.2 决策边界：列表 vs. 非列表

只约束"面向用户浏览的列表"，以下**不受此规则约束**：

| 场景 | 是否受约束 | 备注 |
|---|---|---|
| 主列表页（`/customers`、`/orders`、`/employees` 等）分页列表 | ✅ 受约束 | 主战场 |
| 下拉选择器 / 搜索弹层（录入顾客/员工时的 picker） | ⚠️ 例外：保留 `name ASC` | 字母序对选择更友好 |
| 详情页内的子列表（订单详情的 payments 流水、操作日志） | ⚠️ 因场景而异 | 流水类可 `createdAt ASC`（按时间正序阅读）；日志类 `desc` |
| 树形列表（组织架构、分类） | ⚠️ 例外：保留 `sort_order ASC` | 有人工排序权重 |
| 统计 / 聚合查询（非列表） | ❌ 不受约束 | 按业务分组 |

---

## 2 现状盘点（40+ 处）

所有 `fengyu-admin/src/actions/*.ts` 中的 `.orderBy(...)` 调用：

### 2.1 符合默认规则（17 处，保留）

| 文件 : 行 | 当前 orderBy | 状态 |
|---|---|---|
| `appointments.ts:49` | `desc(appointmentTime)` | ✅ 业务时间倒序 |
| `appointments.ts:155` | `desc(appointmentTime)` | ✅ 同上 |
| `card-transactions.ts:148` | `desc(createdAt)` | ✅ |
| `cards.ts:180` | `desc(paidAt), desc(createdAt)` | ✅ 业务时间 + 兜底 |
| `coupons.ts:224` | `desc(couponTemplates.createdAt)` | ✅ |
| `coupons.ts:599` | `desc(userCoupons.createdAt)` | ✅ |
| `customers.ts:268` | `desc(saleOrders.saleOrderDatetime)` | ✅ 详情页子列表 |
| `customers.ts:365` | `desc(appointments.appointmentTime)` | ✅ 详情页子列表 |
| `customers.ts:606` | `desc(operationLogs.createdAt)` | ✅ 详情页子列表 |
| `logs.ts:69` | `desc(createdAt)` | ✅ |
| `logs.ts:87` | `desc(createdAt)` | ✅ |
| `messages.ts:125` | `desc(createdAt)` | ✅ |
| `orders.ts:124` | `desc(saleOrderDatetime)` | ✅ |
| `orders.ts:258` | `desc(saleOrderDatetime)` | ✅ |
| `pickup-records.ts:125` | `desc(createdAt)` | ✅ |
| `points.ts:141` | `desc(createdAt)` | ✅ |
| `refunds.ts:783` | `desc(createdAt)` | ✅ |
| `store-unbind.ts:41` | `desc(createdAt)` | ✅ |

**注**：以上已满足"最近的在上面"，但均**未叠加 `updated_at` 作为第一排序键**。规范落地后：只要表有 `updatedAt`，应改为 `desc(updatedAt), desc(createdAt)`。

### 2.2 明确的"特别规定"（18 处，保留并注释）

#### 2.2.1 sortOrder 权重（12 处）

| 文件 : 行 | 当前 orderBy | 理由（待补注释） |
|---|---|---|
| `commission.ts:26` | `orgNodes.sortOrder` | 组织架构树排序 |
| `coupons.ts:70` | `asc(orgNodes.sortOrder)` | 同上 |
| `coupons.ts:91` | `asc(productCategories.sortOrder)` | 分类手工排序 |
| `coupons.ts:849` | `asc(orgNodes.sortOrder)` | 同上 |
| `employees.ts:233` | `orgNodes.sortOrder` | 同上 |
| `messages.ts:290` | `asc(orgNodes.sortOrder)` | 同上 |
| `org.ts:44` | `asc(orgNodes.sortOrder)` | 组织架构本身 |
| `positions.ts:32` | `positions.scope, positions.sortOrder` | 职位配置 |
| `positions.ts:46` | `positions.scope, positions.sortOrder` | 同上 |
| `products.ts`（多处） | `sortOrder` 相关 | 商品 / 规格 / 套餐 / 分类 |
| `skill-tags.ts:31` | `skillTags.sortOrder` | 技能标签 |
| `skill-tags.ts:45` | `skillTags.sortOrder` | 同上 |

#### 2.2.2 选择器字母序（6 处）

| 文件 : 行 | 当前 orderBy | 理由 |
|---|---|---|
| `coupons.ts:824` | `clientWechatUsers.name` | 发券时选顾客 |
| `customers.ts:109` | `clientWechatUsers.name` | 选择弹层 |
| `customers.ts:125` | `clientWechatUsers.name` | 选择弹层 |
| `customers.ts:216` | `clientWechatUsers.name` | 选择弹层 |
| `messages.ts:346` | `clientWechatUsers.name` | 消息接收人选择 |
| `stores.ts:57` | `stores.storeName` | 门店选择（也用作管理列表，待确认） |

#### 2.2.3 业务语义时间（1 处）

| 文件 : 行 | 当前 orderBy | 理由 |
|---|---|---|
| `coupons.ts:172` | `userCoupons.expireAt` | 即将过期的券靠前显示 |

### 2.3 违反默认 ? 逐项评审（8 处）

核对调用方后，8 处分三档：**必改 4 处**、**保留 3 处**（实际是选择器或短列表）、**可讨论 1 处**。

---

#### 必改（4 处）—— 这些是真正的"主管理列表"，管理员期望编辑后浮顶

##### ①  `commission.ts:51` `getRates()` —— 提成矩阵主列表（/commission 页）
- **现状**：`.orderBy(commissionRateMatrix.id).limit(1000)`
- **场景判断**：配置型管理列表；一条规则有 `市场 + 订单类型 + 角色 + 商品大类 + 金额区间 + 提成比例` 6 维度；admin 会频繁 `createRate` / `updateRate`（带乐观锁）
- **问题**：`id ASC` 无业务语义；管理员改完一条规则找不到，只能靠搜索/筛选定位
- **建议**：`desc(updatedAt), desc(id)`
- **次级语义风险**：UI 可能期望按"市场 → 角色 → 金额区间"分组展示；若这样，改动应**限定为同组内按 updatedAt**，UI 分组逻辑不动。读完 commission 页组件确认后执行。

##### ②  `permissions.ts:43` `getRoles()` —— 权限管理主列表（/permissions 页）
- **现状**：`.orderBy(permissionRoles.id).limit(500)` + scope 隔离
- **场景判断**：admin 在权限页频繁 `assignRole` / `revokeRole`；新增一条分配后显然应该浮到最上
- **建议**：`desc(updatedAt), desc(createdAt), desc(id)`
- **注**：`permission_roles` 表**无** `updated_at` 列（只有 `createdAt`），需先 grep 确认；若没有则用 `desc(createdAt), desc(id)`

##### ③  `permissions.ts:86` `getRolesByScope(scopeId)` —— 按 scope 过滤的列表
- **现状**：`.orderBy(permissionRoles.id)`
- **场景判断**：点击组织架构某节点查看"这里有哪些角色分配"
- **建议**：同 ②，`desc(createdAt), desc(id)`

##### ④  `employees.ts:188` `getEmployeesPaginated()` —— 员工管理主列表（/employees 页）
- **现状**：`.orderBy(staffWechatUsers.name).limit(pageSize).offset(offset)` + 筛选 + 分页
- **场景判断**：**这是员工管理的主战场**，有完整的筛选器、分页、乐观锁编辑；`updateEmployee` 修改后，管理员期望刚改的员工在顶部
- **问题**：按 name 字母序 + offset 分页 → 编辑员工信息后必须翻回那一页才能核对
- **建议**：`desc(staffWechatUsers.updatedAt), desc(staffWechatUsers.createdAt), asc(staffWechatUsers.employeeId)`
- **关键点**：该表有 `updatedAt`；已有"员工调店"等高频编辑动作，浮顶反馈非常必要
- **注**：需同步修改 `employees.test.ts` 中依赖 name 顺序的快照/断言

---

#### 保留为例外（3 处）—— 加一行注释即可，改动反而伤害体验

##### ⑤  `employees.ts:56` `getEmployees()` —— 命名误导，实际是 picker
- **现状**：`.orderBy(staffWechatUsers.name).limit(500)` + scope
- **调用方 grep 结果（7 处）**：
  - `customers/[id]/page.tsx` — 顾客详情里选分配员工
  - `permissions/page.tsx` — 给员工分配角色
  - `allocations/[orderId]/page.tsx` + `allocations/service/[id]/page.tsx` — 营业额分配选参与员工
  - `orders/create/page.tsx` — 开单选店员
  - `services/create/page.tsx` — 服务单选技师
- **结论**：**全部是"选择器/picker 数据源"，零主列表用途**。字母序恰恰是 picker 最友好的排序
- **建议**：**保留 `asc(name)`**；但 action 命名"误导"（看起来像主列表），建议配合注释：
  ```ts
  // 选择器数据源：7 处 picker 场景；主列表请用 getEmployeesPaginated
  // 例外：picker 字母序
  .orderBy(staffWechatUsers.name)
  ```
- **可选强化**：改名为 `listEmployeesForPicker()`（连带改 7 处 import，diff 较大；非必须）

##### ⑥  `employees.ts:90` `searchEmployees(keyword)` —— 显式搜索下拉
- **现状**：`.orderBy(staffWechatUsers.name).limit(20)` + `ilike(name|phone)` + `isResigned = false`
- **场景判断**：函数名和 limit 20 都直接说明是"搜索推荐人"下拉
- **建议**：**保留**，加注释 `// 例外：搜索选择器字母序`

##### ⑧  `stores.ts:57` `getStores()` —— 下拉占 30/31，主列表仅 1 处
- **现状**：`.orderBy(stores.storeName).limit(200)` + scope
- **调用方 grep 结果（31 处）**：
  - 30 处是**筛选下拉**（orders / appointments / customers / cards / points / card-transactions / pickup-records / messages / services / allocations … 页面的"按门店筛选"下拉）
  - **仅 1 处**是 `/stores` 管理主列表
- **权衡**：
  - 门店是**极低变更频率**实体（一年新开几家），"浮顶"价值有限
  - 门店数量**总量少**（十几个），字母序便于人眼扫视
  - **30 处 picker 改成 updatedAt 会让用户选门店时顺序忽明忽暗**
- **结论**：**保留 `asc(storeName)`**，加注释 `// 例外：选择器场景占主导（31 处调用中 30 处是筛选下拉），字母序更稳定`
- **不做拆分**：成本>收益（拆完要改 30 处 import，且主列表也没那么频繁被编辑）

---

#### 可讨论（1 处）

##### ⑦  `permissions.ts:152` `getEmployeeRoles(employeeId)` —— 员工详情页子列表
- **现状**：`.orderBy(permissionRoles.id)`（无 limit）
- **场景判断**：员工详情页的"角色 tab"，单个员工通常有 1~3 条角色分配
- **两种思路**：
  - **A（保留，推荐）**：按插入顺序（即 `id ASC`）展示，对用户最稳定；一个员工的角色变动本就很少；加注释 `// 例外：详情页子列表，数量极少，按插入顺序保持稳定`
  - **B（改）**：`desc(createdAt), desc(id)`，与全局默认一致；但对这种 1~3 条的列表其实没区别
- **建议**：**选 A 保留**

---

#### 修改汇总

| # | 位置 | 动作 | 目标 orderBy |
|---|---|---|---|
| ①  | `commission.ts:51` | **改** | `desc(updatedAt), desc(id)` |
| ②  | `permissions.ts:43` | **改** | `desc(createdAt), desc(id)`（无 updatedAt 列）|
| ③  | `permissions.ts:86` | **改** | `desc(createdAt), desc(id)` |
| ④  | `employees.ts:188` | **改** | `desc(updatedAt), desc(createdAt), asc(employeeId)` |
| ⑤  | `employees.ts:56` | 保留 + 注释 | `asc(name)` |
| ⑥  | `employees.ts:90` | 保留 + 注释 | `asc(name)` |
| ⑦  | `permissions.ts:152` | 保留 + 注释 | `asc(id)` |
| ⑧  | `stores.ts:57` | 保留 + 注释 | `asc(storeName)` |

**必改 4 处、保留 4 处**（原盘点结论收敛，避免过度改动）。

### 2.4 疑问 / 待决（1 处）

| 文件 : 行 | 备注 |
|---|---|
| `cards.ts:180` | 目前是 `desc(paidAt), desc(createdAt)`。若语义是"充值卡列表"则合规；若有"近期被编辑过的充值卡策略"需求，应考虑 `updatedAt` |

---

## 3 改造方案

### 3.1 规范落地（文档先行）

1. 在 `.42cog/dev/sys.spec.md`（或新增 `.42cog/dev/admin-listing.spec.md`）加入 §1.1 的规则文本
2. 在 `fengyu-admin/CLAUDE.md` 加一节"列表排序默认规则"，链接到 spec
3. 在 `db/schema/CLAUDE.md` 补一行：建表原则 — 业务表默认携带 `updated_at`（非流水型）

### 3.2 代码修复（分级）

**P2a（本 ticket 直接修，4 处）** — §2.3 「必改」清单：

```ts
// 修复前（permissions.ts:43）
.orderBy(permissionRoles.id)

// 修复后
.orderBy(desc(permissionRoles.createdAt), desc(permissionRoles.id))
```

注：`permission_roles` 无 `updated_at` 列（需 grep `db/schema/permission.ts` 确认）；其余 3 处按 §2.3 汇总表的目标 orderBy 执行。

**P2b（本 ticket 追加 updatedAt 作为第一键，§2.1 的 17 处中有 updatedAt 列的表）** — 统一升级：

```ts
// 修复前
.orderBy(desc(couponTemplates.createdAt))

// 修复后
.orderBy(desc(couponTemplates.updatedAt), desc(couponTemplates.createdAt))
```

**影响范围核对**：表有 `updated_at` 列的包括 `coupon_templates`、`user_coupons`、`sale_orders`、`appointments`、`client_wechat_users`、`staff_wechat_users`、`stores`、`permission_roles`、`commission_rate_matrix`、`product_categories`、`products`、`product_skus`、`service_orders`、`prepaid_cards`、`store_unbind_requests`、`system_config`（详见 §2.1 查询结果）。

表**无** `updated_at` 的：`operation_logs`、`messages`、`point_transactions`、`card_transactions`、`pickup_records`（流水型，`createdAt DESC` 保留不动）。

**P3（例外加注释）** — §2.2 的 18 处：每一处加一行 `// 例外：sortOrder 权重` 或 `// 例外：选择器字母序` 或 `// 例外：业务时间（即将过期优先）`。

### 3.3 拆 action（只在必要时）

`employees.ts` / `stores.ts` 现状可能"一个 list action 两用"。若排查后发现复用：

```ts
// 拆成两个
export async function listEmployeesForManagement() { /* desc(updatedAt) */ }
export async function listEmployeesForPicker() { /* asc(name) */ }
```

若不复用，直接改原 action。

---

## 4 测试与验收

### 4.1 单元测试（扩充）

目前 admin 有 `*.test.ts` 覆盖了大部分 action（见 `fengyu-admin/src/actions/*.test.ts`）。补充：

- 每个被修复的 action 新增 1 个测试：**插入 2 行 → 更新第 1 行的 updated_at → 查询 → 断言第 1 行排第一**
- 对 `permissions` / `commission`：补测"按 updatedAt 后仍能稳定分页"

### 4.2 手动验收（QA 剧本）

1. 打开 `/employees` → 编辑任意员工姓名 → 返回列表 → 该员工在第一行 ✓
2. 打开 `/permissions` → 编辑任意角色 → 返回列表 → 该角色在第一行 ✓
3. 打开 `/orders` / `/customers` / `/coupons` / `/refunds` / `/messages` → 同上
4. 打开顾客选择弹层（在发消息、发券场景）→ 仍按姓名字母序 ✓（例外生效）
5. 打开 `/products`、`/org`、`/skill-tags` → 仍按 sortOrder ✓（例外生效）

### 4.3 类型与构建

```bash
cd fengyu-admin && npx tsc --noEmit    # 无类型错误
cd fengyu-admin && pnpm test            # action 测试全绿
cd fengyu-admin && pnpm lint            # 无新增 warn
```

---

## 5 风险与权衡

| 风险 | 影响 | 缓解 |
|---|---|---|
| 分页稳定性：`updated_at` 相同的多行之间顺序漂移 | 翻页时重复/漏数据 | 必须叠加 `desc(createdAt), desc(id)` 作 tiebreaker |
| `updated_at` 未被 UPDATE 触发器维护 | 改了行却没浮顶 | 先 grep 所有表的 `$onUpdate` / trigger，确认每张业务表都有 auto-update 机制；没有的补 |
| 选择器被误改为 desc(updatedAt) | 人工找顾客变成"按最近编辑"反直觉 | §2.2.2 的 6 处明确标注例外；修改时必须 grep 调用方确认不是 picker |
| 老的前端代码依赖隐式顺序 | 前端列表假设"第一行是最新创建" | 改完后所有列表语义从"最新创建"变为"最近动过"；前端**不需要改**，表现更符合直觉；但需在 PR 描述中提示 QA |
| `id ASC` 的 `permissions` 改成 `updatedAt DESC` 后，某些测试断言依赖固定顺序 | 测试挂 | 修 action 时同步修相关 test 快照 |

---

## 6 交付物

- [ ] `.42cog/dev/sys.spec.md` 或 `.42cog/dev/admin-listing.spec.md` 加入默认排序规则
- [ ] `fengyu-admin/CLAUDE.md` 加入"列表排序默认"章节，指向 spec
- [ ] §2.3 「必改」4 处（commission:51 / permissions:43 / permissions:86 / employees:188）按汇总表 orderBy 执行
- [ ] §2.3 「保留」4 处（employees:56 / employees:90 / permissions:152 / stores:57）加一行 `// 例外：...` 注释说明原因
- [ ] §2.1 中 17 处 `desc(createdAt)` 在表有 `updatedAt` 时升级为 `desc(updatedAt), desc(createdAt)`
- [ ] §2.2 的 18 处例外旁加一行注释说明原因
- [ ] 相关单元测试新增"更新浮顶"断言
- [ ] `npx tsc --noEmit` + `pnpm test` + `pnpm lint` 全绿
- [ ] 手动验收 §4.2 QA 剧本

---

## 7 不在本 ticket 范围

- client / staff 两端的列表排序（小程序端有自己的交互模式，后续另开 ticket）
- 新增"手动排序"能力（拖拽调序）
- 给没有 `updated_at` 的业务表补列（流水型/日志型不需要）
- 列表分页的游标/cursor 改造（本次仍用 offset/limit，`id DESC` 作 tiebreaker 即可稳定）

---

## 8 实施顺序建议

1. **Step 1**：先写规范文档（§3.1）+ 拿 1~2 个 action 做示范（如 `permissions.ts`）→ PR1
2. **Step 2**：批量回填 §2.3 剩余 action + §2.1 的 updatedAt 升级 → PR2
3. **Step 3**：§2.2 注释补齐 + 测试补齐 → PR3

三个 PR 依赖顺序：PR1 → PR2 → PR3；也可合并为一个大 PR 但 diff 会较大（~40 处）。
