# 员工提成模型重构 — 需求变更适配计划

> ⚠️ **本报告已被 [`00-decisions.md`](./00-decisions.md) 部分覆盖（2026-04-10）**
> - `salesCategoryEnum` **不重命名**，保留当前 `[自采自销, 他销自耗, 他销他耗, 生态合作]`
> - Q5 答：**美容师/养生师/推广师三角色独立校验；更准确地按 `staff_wechat_users.skills` 中的有效技能标签独立校验**
> - 业绩分配算法按 `skillTags` 维度池独立校验，每池 `SUM ≤ 商品金额`，池间不互相约束
> - 废除 `DEPT_TO_ROLE = { '美容部':'美容师' }` 从部门推断，改为读 `skills`
> - 无结构性变更，全部为算法层重写

> 来源会议: meeting-20260312 §三 + meeting-20260324 §四/§五
> 方法论: `.claude/skills/wx-requirement-adapt/SKILL.md` §3 §4 §5.3
> 生成日期: 2026-04-09
> 状态: 待评审，未开工

---

## 0 执行摘要（TL;DR）

本次重构牵涉的是**"员工如何从一次销售/服务中赚钱"** 这一业务核心逻辑。变更点分布在 4 层：

| 层级 | 变更性质 | 规模 |
|------|---------|------|
| **数据库 schema / enum** | 结构性（交接 /wx-change-propagation） | 5 处 |
| **云函数业务算法** | 逻辑性 | 3 个文件 |
| **管理后台提成矩阵维护** | 逻辑性 + UI 重写 | 2 个文件 |
| **前端业绩分配交互** | 逻辑性 + 交互重写 | 3 个文件 |

**最关键的 3 个矛盾点：**

1. **提成 = 比例 × 金额** 这一假设已经不成立。会议明确指出"固定手工费 + 消耗比例"双字段并存，必须双字段都快照到 `product_skus`（已有 `service_fee`）和 `sale_items`（**未快照**）。
2. `salesCategoryEnum` 当前 4 值**全部错误**（自采自销/他销自耗/他销他耗/生态合作），会议新定义是（自销自耗/自销他耗/他销自耗/他销他耗），这是一次 4→4 的**同数量但语义全换**的枚举重命名，触发 `wx-change-propagation` 10 层传播。
3. 服务单 `complete` 目前**完全没有**写入 `service_commissions` 表，该表仅被历史迁移脚本 `migrate-presale-services.js` 使用（见 `db/scripts/migrate-presale-services.js:368-389`）。人效指标"划卡数"从未实现。

---

## 1 需求分解

| 要素 | 内容 |
|------|------|
| **变更概念** | 员工提成计算模型（销售提成 + 服务提成） + 业绩分配规则 + 员工管理职位下拉 |
| **当前行为** | 1) sale_allocations.total_amount 直接由分配人手填/前端 received×rate 计算；2) service_commissions 表存在但运行时未写入；3) salesCategoryEnum 为旧 4 值；4) 前端分配页按部门名映射角色；5) product_skus.service_fee 存在但 sale_items 未快照 |
| **期望行为** | 1) 销售提成按 role_type × 4 新 salesCategory 矩阵计算；2) 服务提成 = 固定手工费 + 划卡金额 × 消耗比例，服务单 complete 时写入 service_commissions；3) salesCategoryEnum 换 4 值；4) 业绩分配与提成比例完全解耦，分配从"整十百分比固定选项"选择，按角色独立校验；5) 职位下拉基于组织 scope；6) 人效指标新增"划卡数" |
| **受影响角色** | manager（店长，开单+分配）、employee（美容师/养生师/推广师，被分配）、admin（提成矩阵维护） |
| **受影响端** | staff（小程序+cloudfn）、admin（web） |

---

## 2 当前行为追踪（三层 × 多模块）

### 2.1 数据库层现状

#### 2.1.1 `db/schema/enums.ts:44` — salesCategoryEnum

```ts
export const salesCategoryEnum = pgEnum("sales_category",
  ["自采自销", "他销自耗", "他销他耗", "生态合作"]);
```

- **问题**: 4 值命名与会议新需求"自销自耗/自销他耗/他销自耗/他销他耗"不匹配（缺 "自销自耗"，多了 "生态合作"，并且 "自采自销" 与 "自销自耗" 语义不同）。
- **引用点**:
  - `db/schema/product.ts:15` — `product_categories.sales_category` 列
  - `db/schema/order.ts:139` — `sale_items.sales_category` 列快照
  - `db/schema/commission.ts:19` — 注意这里是 `varchar(20)` 而不是 enum，**允许写入任意值**（一个"宽松约束"的历史遗留）

#### 2.1.2 `db/schema/commission.ts:9-38` — commission_rate_matrix

当前维度：`(org_id, order_type, role_type, sales_category, amount_tier_min, amount_tier_max)` + `commission_rate`。

- `order_type` 当前存 "销售单" / "服务单" 两种（在 allocation.js:237/238 的 pivot 逻辑可见）
- `role_type` 存角色名（美容师/养生师/推广师）
- `sales_category` 存 4 值（语义层）
- `amount_tier_*` 用于阶梯
- **缺失**: 没有品牌维度——会议说"按商品品牌/类别分"四种，但当前 `sales_category` 这一个字段就承载了品牌语义。会议原文的 4 分类**不是 4 种品牌**，而是 **自己(凤御) vs 外部(安吉丽/医美)** × **自己做 vs 别人做** 的 2×2，这其实就是 `sales_category`。
- **缺失**: 没有"固定手工费"字段。提成矩阵只存"比例"。根据会议"固定手工费随商品（而非矩阵）"的表述，固定手工费应在 `product_skus` 层（已经有 `service_fee`，语义匹配但业务上未被使用）。

#### 2.1.3 `db/schema/product.ts:45` — product_skus.service_fee

```ts
serviceFee: numeric('service_fee', { precision: 10, scale: 2 }).notNull().default('0'),
```

- **现状**: 字段存在，但从未被运行时读取用于提成计算（`fengyu-staff/cloudfunctions/staffApi/routes/product.js:61-180` 只是透传到前端展示，且前端也只读到 `order-create.ts:46` 未继续使用）。
- **语义**: 根据会议，这**就是**"固定手工费"的承载字段，语义 OK，问题是未参与业务计算。

#### 2.1.4 `db/schema/order.ts:108-155` — sale_items

```ts
export const saleItems = pgTable("sale_items", {
  // ... 现有字段
  unitPrice: numeric(...),    // 原价快照
  unitRealPrice: numeric(...), // 优惠后单价快照
  salesCategory: salesCategoryEnum("sales_category"),  // 销售分类快照
  // 缺: service_fee 快照
})
```

- **问题**: 开单时未快照 `service_fee`。一旦后续 `product_skus.service_fee` 被 admin 改过，历史订单/服务单无法回溯当时的固定手工费。

#### 2.1.5 `db/schema/service-commission.ts` — service_commissions

```ts
export const serviceCommissions = pgTable('service_commissions', {
  serviceItemId, employeeId, roleType,
  allocationRatio, commissionRate, commissionAmount, isVoid
})
```

- **现状**: 表 + schema + admin action (`service-commissions.ts`) 都已存在
- **问题**: staffApi service.complete 未写入此表（`fengyu-staff/cloudfunctions/staffApi/routes/service.js:280+` 只做状态流转和次数扣减）。唯一写入来源是迁移脚本 `db/scripts/migrate-presale-services.js:368-389`，该脚本把 WorkFine 的 service_fee > 0 记录按 `rate = service_fee / unit_real_price` 回算为比例写入，**这不是新需求期望的"固定手工费 + 消耗比例"双字段合并模型**。

#### 2.1.6 `db/schema/order.ts:163-194` — sale_allocations

```ts
saleItemId, employeeId, allocationRatio, roleType, departmentName,
totalAmount, isVoid, voidedAt
```

- **现状**: 扁平表，每行=一个 (sale_item, 员工, 角色) 三元组。这是**好的基础**，会议新规则也要求扁平粒度分配，但会议强调以下几点当前未实现：
  1. `allocationRatio` 必须在 {0.10, 0.20, ..., 1.00} 整十档（admin actions/allocations.ts:161 有 VALID_RATIOS 白名单，**但 cloudfunction allocation.save 没有**）
  2. 同 item 按角色组独立校验（admin 有 `getRoleGroup` 将美容师/养生师合并为 beautician 组；推广师独立——**但会议要求美容师和推广师独立校验**，而非美容师和养生师合并。需要确认"美容师/养生师/推广师"三组是平行还是合并）
  3. `total_amount` 应该由后端从 `unit_real_price × ratio` 算出而不是前端传入；当前 `allocation.save` 直接采信 `Number(alloc.totalAmount)`。

### 2.2 后端逻辑层现状

#### 2.2.1 `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js`

**`save` (line 31-144)**:
- 前端传入 `{ saleItemId, employeeId, departmentName, allocationRatio, totalAmount }`
- 直接信任前端 totalAmount（line 126）
- 无整十档校验，无角色独立校验，无"最多 3 人"校验，无 roleType 写入（line 120 INSERT 未写 role_type 列——这与 admin allocations.ts 写入 role_type 不一致）
- `departmentName` 与新"角色"概念混淆

**`getCommissionRates` (line 200-242)**:
- 查询 commission_rate_matrix，pivot 为 { orderRates, serviceRates } 两组，每组按 4 值 salesCategory 拆开（line 231-232）
- 硬编码的 4 值就是旧枚举值：`'自采自销': 0, '他销自耗': 0, '他销他耗': 0, '生态合作': 0`
- **当 salesCategoryEnum 切换后，这里的对象键全部失效**

**`suggest` (line 310-428)**:
- line 377：再次硬编码 `'自采自销': 0, '他销自耗': 0, '他销他耗': 0, '生态合作': 0`
- line 386：`beautyDepts = ['美容师', '养生师']` — 这里把两个角色**当成一组**处理，相当于**隐性合并角色**
- line 399：回退默认值 `'自采自销'` — 旧枚举值
- 没有"推广师"分组的处理，只对美容师/养生师处理

**`resolveStaffDepartment` (line 272-293)**:
- `DEPT_TO_ROLE = { '美容部': '美容师', '养生部': '养生师', '推广部': '推广师' }` (line 16)
- 通过**员工所属部门名**映射成角色。会议新规则要求改为**基于技能标签 `staff_wechat_users.skills`** 决定角色，而非部门。
- 会议 §四"选人后角色自动填入（基于员工技能标签）"明确禁用"部门→角色"的反向推断。

#### 2.2.2 `fengyu-staff/cloudfunctions/staffApi/routes/staff.js`

**`todayCommission` (line 146-233)**:
- line 161: `SUM(sa.total_amount)` — 只统计 sale_allocations 金额，未包含 service_commissions
- **缺失**: 服务提成（固定手工费 + 消耗比例）从未被纳入"今日分成"

**`performanceDetail` (line 412-566)**:
- line 437: 销售提成从 sale_allocations 读（OK）
- line 472: 服务提成从 service_items 读，计算方式 `unit_real_price × session_used`（**这不是提成金额**，这是"消耗业绩金额"，相当于口径混淆）
- line 509: `fee = Number(r.service_price) * (r.session_used || 1)` 被当成"服务费"累加到 `totalServiceFee`
- **缺失**: 未读取 service_commissions 表；service_fee 固定手工费完全未出现

**`monthlyCalendar` (line 238-306)**:
- 同样只从 sale_allocations 查；服务提成维度缺失

**`dashboard` (line 573-693)**:
- 5 个指标：footfall / headcount / revenue / consume / newMembers
- **缺失会议要求的"划卡数"** —— 会议 §三"人效指标（英雄榜）" 明确要求 3 个指标：业绩/消耗/划卡数。
- "consume" 是消耗**金额**(line 650 `unit_real_price × session_used`)，"划卡数"应该是**次数**（COUNT(service_items) 或 SUM(session_used)）

#### 2.2.3 `fengyu-staff/cloudfunctions/staffApi/routes/service.js:280-387`

`complete` 函数的精确行为：

1. **行 289-302**: 加载 service_order，校验归属本门店 + 操作者权限
2. **行 304-312**: 幂等检查（已完成返回成功）
3. **行 314-316**: 状态机校验（必须"服务中"）
4. **行 318-321**: 加载本服务单所有 service_items（`service_item_id, sale_item_id, session_used`）
5. **事务块（行 325-380）**:
   - 行 327-362: 对每个 item 原子扣减 `sale_items.remaining_sessions`
   - 行 347-361: 若 remaining_sessions 归零则关闭相关 appointments
   - 行 364-371: UPDATE service_orders SET status='已完成', completed_at=NOW(), **WHERE status='服务中'**（防并发竞态）
   - 行 373-379: 若有关联预约则同步标"已完成"

**未做**（新需求要求）:
1. 从 sale_items 读取 service_fee 快照（当前 sale_items 也没这列）
2. 查员工技能标签决定 roleType
3. 从 commission_rate_matrix 查消耗提成比例（按员工角色 × sales_category × 阶梯）
4. 计算 commission_amount = service_fee × session_used + unit_real_price × session_used × commission_rate
5. 写入 service_commissions（含 fixed_fee/consume_amount 拆分）
6. UPDATE service_orders SET commission_status='已分配'（字段已存在，见 `db/schema/service.ts:38`，但从未被写入）

#### 2.2.4 `fengyu-staff/cloudfunctions/staffApi/routes/order.js:443-458` 以及其他 4 处 INSERT

经过 Grep 精确定位，staffApi order.js 中 INSERT INTO sale_items 的 5 处语句：

| 位置 | 场景 | 已写入列数 | 缺少 service_fee |
|------|------|------------|------------------|
| `order.js:443-458` | 正常开单 create | 14 列 | 是 |
| `order.js:1005-1018` | 退款单 createRefund（'退出'方向） | 14 列 | 是 |
| `order.js:1184-1194` | 回款单 createRepayment（'购买'方向） | 13 列 | 是 |
| `order.js:1329-1340` | 转换单 createConversion（'转出'方向） | 14 列 | 是 |
| `order.js:1358-1370` | 转换单 createConversion（'转入'方向） | 14 列 | 是 |

**全部 5 处都需要**在 INSERT 时补 `service_fee` 列。正常开单从 `product_skus` JOIN 取值；退款/转换从原 `ref_sale_item` 读取已快照的值（即原来单据的 service_fee 值传递下去）。回款由于不新增服务次数，service_fee 可以置 0 或复用原值（**需澄清**，建议 0 因为回款属于纯现金流入不涉及服务消耗）。

**额外检查**: `fengyu-admin/src/actions/orders.ts` 是否有 INSERT sale_items？如有，admin 端开单向导同样需要加。

### 2.3 Admin 层现状

#### 2.3.1 `fengyu-admin/src/actions/commission.ts`

- `getRates` (line 31-67): 一次查全部记录，按 `commission_rate_matrix.id` 排序
- `createRate` (line 69-108): 检查 (org_id, order_type, role_type, sales_category, amount_tier) 重叠
- 没有品牌维度、没有"固定手工费"字段
- 会议要求的 4 分类"自销自耗/自销他耗/他销自耗/他销他耗"在 UI 层可能有硬编码的下拉选项（待确认 `/commission` 页面组件）

#### 2.3.2 `fengyu-admin/src/actions/allocations.ts`

**批量保存 `batchSaveAllocations` (line 164-281)**:
- line 161: `VALID_RATIOS = {0.10...1.00}` 整十档白名单 ✅ 已实现
- line 156-158: **`getRoleGroup` 将美容师/养生师合并为 beautician 组，推广师为 promoter 组** — 这是**两组**而非会议说的"美容师独立 + 推广师独立 + 养生师独立"的三组。需要产品方澄清。
- line 218: 每角色组最多 3 人 ✅
- line 224: ratioSum ≤ 1.01 ✅
- **缺失**: `total_amount` 从前端传入而不是后端算（line 252），可能被篡改
- **缺失**: 按 sku 或 item 分别校验"加起来 ≤ received" 的金额上限。会议 §五.2 明确："加起来不超过总金额即可"（金额上限，不是比例上限）——admin 的比例上限对但**没有金额上限校验**（因为比例总和 ≤1.00 等价于金额 ≤1.00×received，理论上可行但没法对"差 1 分可接受"这条规则直接落地）。

#### 2.3.3 `fengyu-admin/src/actions/service-commissions.ts`

- `batchSaveServiceCommissions` 已经存在，逻辑与 allocations 平行
- 但这是**admin 端**的手动维护入口；**staffApi service.complete 没有自动触发**
- 前端页面待确认是否接入

#### 2.3.4 `fengyu-admin/src/actions/employees.ts`

- `createEmployee` (line 239-336): 接受 `positionName` 和 `skills` 数组
- `employee-create-page.tsx:203-217`: 职位已是 Select 下拉，按 `positionScope` 筛选 — **会议要求已满足** ✅
- `skills` 字段在 DB schema 存在 (`user.ts:100`)，但：
  - 前端 UI 是否有技能标签编辑器？（需要进一步确认）
  - staffApi auth.login 是否回传 skills 到 ctx.auth 以供 allocation.suggest 使用？（未确认，应该没有）

### 2.4 前端渲染层现状

#### 2.4.1 `fengyu-staff/miniprogram/packageOrder/revenue-allocation/revenue-allocation.ts`

- `onStaffSelected` (line 239-289): 选中员工后，读取 `staff.department`（部门名），然后 `lookupRate(department, salesCat, received)`。
- line 264: `const salesCat = item.sales_category || '自采自销'` — **硬编码旧枚举值作为 fallback**
- line 266: `lookupRate(department, salesCat, received)` — 入参是**部门名**"美容部"/"养生部"，不是角色名
- `allocation-calc.ts:32`: `const beautyDepts = ['美容部', '养生部']` — 前端把部门映射成提成维度
- **核心问题**: 前端把部门当角色用，而会议新规则是"按技能标签决定角色"。这需要云函数 `staff.departments` 接口改返结构，返回每个员工的 `skills` 数组，前端按 skills 决定角色。

#### 2.4.2 `fengyu-staff/miniprogram/packageOrder/dashboard/dashboard.ts`

- 5 个指标，**没有划卡数**
- 需要补"划卡数"指标 tile

#### 2.4.3 `fengyu-staff/miniprogram/packageOrder/staff-performance/`

- 已存在页面（`fengyu-staff/miniprogram/packageOrder/staff-performance/staff-performance.ts`）
- 绩效明细表按 `salesCategory` 分组汇总 — **新枚举值切换后该页面所有标签都会错位**

### 2.5 关键 Bug 深度解析 — performanceDetail 服务提成口径错误

> ✅ **已修复（2026-04-10）**：迁移 `0018_green_rogue.sql` 新增 `sale_items.service_fee` + `service_commissions.fixed_fee/consume_amount` 列；`service.complete` 自动写 service_commissions（skills[0] 自动推断 roleType，rate 缺失写 operation_logs）；`performanceDetail` 改查 `service_commissions.commission_amount`；前端 staff-performance 展示固定手工费/消耗提成拆分；新增 10 个单元测试（7 performanceDetail + 3 service.complete）。详见 plan `/Users/nv/.claude/plans/tranquil-singing-clover.md`。**多员工手动分成流程留给后续 Phase**（本次 out of scope）。

**严重性**: 高 — 员工在绩效明细页看到虚高的"服务提成"数字，与实际工资单强烈不一致，直接破坏团队信任；`totalCommission` 汇总字段基于错误加总，任何依赖该字段的上游看板/报表都被污染。

**Bug 一句话概括**: `performanceDetail` 用 `unit_real_price × session_used`（= **消耗业绩金额**，即"这位员工今天消耗掉了多少客户已付的服务卡次数金额"）当成了"服务提成"累加返回。前者是**业绩口径**（衡量劳动负荷/业务量），后者是**薪资口径**（固定手工费 + 消耗比例），两者数值差可达 3-5 倍。

#### 2.5.1 Bug 精确定位（一次计算错误，6 处耦合暴露）

文件: `fengyu-staff/cloudfunctions/staffApi/routes/staff.js`（`performanceDetail` 函数内）

| # | 行号 | 代码 | 角色 |
|---|------|------|------|
| 1 | L474 | `sit.unit_real_price AS service_price` | SELECT 别名把"销售快照单价"起名为"service_price"，为下游误读埋雷 |
| 2 | L498 | `let totalServiceFee = 0` | 累加器命名暗示"服务费/手工费"，对外输出时被误解为"服务提成" |
| 3 | L509 | `const fee = Number(r.service_price) * (r.session_used || 1)` | 公式本身：**单价 × 使用次数 = 消耗业绩金额**，不是提成 |
| 4 | L510 / L513 | `totalServiceFee += fee` / `categorySummary[cat].service += fee` | 错误值被累加进"总服务提成"和"按分类服务提成"两个汇总字段 |
| 5 | L537 | `amount: Number(r.service_price) * (r.session_used || 1)` | serviceItems 明细列表中每条记录的 `amount` 字段（前端列表直接渲染） |
| 6 | L558 | `totalServiceFee: Math.round(totalServiceFee * 100) / 100` | 返回字段命名直接把错误语义暴露给前端 |
| 7 | L559 | `totalCommission: ...(totalSalesAlloc + totalServiceFee)` | 总提成 = 销售提成 + **消耗金额**（应为 + 服务提成），结构性错误 |

#### 2.5.2 数值对照（示例）

假设员工 A 本月完成 10 次"面部护理"服务，每次：
- `sale_items.unit_real_price` = 500（单次售价快照）
- `sale_items.service_fee` = 80（固定手工费，**Phase 1.2 新增的快照列**）
- 对应 commission_rate_matrix 消耗提成比例 = 10%
- `session_used` = 1

| 指标 | 正确口径 | 当前 `performanceDetail` 返回 | 偏差 |
|------|---------|------------------------------|------|
| 固定手工费 | 80 × 10 = **800** | — | — |
| 消耗提成 | 500 × 10 × 0.10 = **500** | — | — |
| **应得服务提成** | **1300** | — | — |
| **totalServiceFee** 返回值 | — | 500 × 10 = **5000** | **+3700（+285%）** |
| categorySummary.护理.service | 1300 | 5000 | +3700 |
| totalCommission（销售 0 + 服务） | 1300 | 5000 | +3700 |

**实质危害**: 员工看到 "本月服务提成 ¥5000"，实际到手只有 ¥1300 — 4 倍差距。每月 1 号财务发薪时爆发矛盾。

#### 2.5.3 根因拆解（为何当初会写成这样）

1. **历史占位**: 函数编写时 `service_commissions` 表虽已建好，但运行时零写入（唯一写入来源是迁移脚本 `db/scripts/migrate-presale-services.js`），作者**没有 Ground Truth 可读**，只能用 `service_items` 现有字段凑一个"近似值"，选了 `unit_real_price × session_used` 作为临时占位。
2. **命名漂移**: SELECT 里写 `sit.unit_real_price AS service_price`，掩盖了字段的真实语义（销售单价快照）。下游看到 `service_price * session_used`，直觉理解为"服务费总额"，实际是消耗业绩金额。
3. **快照缺失**: 当时 `sale_items` 还没有 `service_fee` 快照列（Phase 1.2 待加），作者即便想按 "固定手工费 + 消耗比例" 正确计算也做不到（product_skus.service_fee 修改后历史无法回溯）。
4. **占位变产品**: 对外返回字段名直接叫 `totalServiceFee`（而非 `totalServiceConsumedAmount`），前端也就这样展示 — 占位逻辑永久化为 API 契约。

#### 2.5.4 同类错误检索结果（核查其他 3 个读服务数据的位置）

| 位置 | 行号 | 是否有相同错误 | 结论 |
|------|------|---------------|------|
| `staff.js` todayCommission | L146-233 | 否 | 仅查 `sale_allocations`，**未覆盖服务维度**（见 §3 差异表第 11 行）。不是本 Bug，但是"口径缺失"，需要 Phase 2.6 补 |
| `staff.js` monthlyCalendar | L238-306 | 否 | 同上，仅 sale_allocations，无服务提成聚合 |
| `staff.js` dashboard.consume | L573-693 | **不是 Bug** | 这里 `unit_real_price × session_used` 作为 `consume` 指标 — **语义正确**：consume 本就是"消耗业绩金额"，命名匹配用途。**修复时不要误删 dashboard 的计算** |
| `staff-performance.ts/wxml` | 前端 | 无二次计算 | 直接接收 `totalServiceFee` 并渲染。修复后端 = 修复前端展示，但字段重命名时前端需同步 |

**结论**: 本 Bug **只在 performanceDetail 内部**，修复范围限定在 staff.js 约 60 行代码 + staff-performance 前端字段名。

#### 2.5.5 修复依赖（按顺序完成前置项）

修复本 Bug 需要先落地以下 Phase 条目：

- **(A)** Phase 1.2 ✅ — `sale_items` 新增 `service_fee` 快照列（migration 0018）
- **(B)** Phase 1.4 ✅ — `service_commissions` 新增 `fixed_fee` / `consume_amount` 两列（migration 0018）
- **(C)** Phase 2.1 ✅ — `order.create` / createRefund / createRepayment / createConversion 5 处 + admin/orders.ts 1 处 INSERT 写入 service_fee 快照
- **(D)** Phase 2.5 ✅ — `service.complete` 自动写入 `service_commissions`（含 fixed_fee + consume_amount + commission_amount，skills[0] 自动推断 roleType，rate 缺失兜底 0 + 写 operation_logs）

**无 A-D 则本 Bug 无法根治**（只能走 §2.5.7 临时方案）。

#### 2.5.6 根治修复步骤

1. **重写 svcRows 查询**（L472-494），数据源切换到 `service_commissions`：

```sql
SELECT
  sc.commission_amount,
  sc.fixed_fee,
  sc.consume_amount,
  sc.role_type,
  sit.session_used,
  sit.unit_real_price AS service_unit_price,  -- 保留供前端参考，但不参与提成计算
  si.product_name,
  si.sku_spec_name,
  si.sales_category,
  so.service_order_id,
  so.service_date,
  so.store_id,
  cu.name AS customer_name,
  cu.phone AS client_phone
FROM service_commissions sc
JOIN service_items sit ON sit.service_item_id = sc.service_item_id
JOIN service_orders so ON so.service_order_id = sit.service_order_id
JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
LEFT JOIN client_wechat_users cu ON cu.user_id = so.client_user_id
WHERE sc.employee_id = $1
  AND sc.is_void = false
  AND so.status = '已完成'
  AND so.service_date >= $2
  AND so.service_date <= $3
  ${svcWhere}
ORDER BY so.service_date DESC
```

2. **重写累加逻辑**（L497-514）：

```js
let totalSalesAlloc = 0
let totalServiceCommission = 0   // 重命名：不再是 totalServiceFee
const categorySummary = {}

for (const r of allocRows) {
  totalSalesAlloc += Number(r.alloc_amount)
  const cat = r.sales_category || '未分类'
  if (!categorySummary[cat]) categorySummary[cat] = { sales: 0, service: 0 }
  categorySummary[cat].sales += Number(r.alloc_amount)
}

for (const r of svcRows) {
  const amount = Number(r.commission_amount)  // ← 从 service_commissions 读
  totalServiceCommission += amount
  const cat = r.sales_category || '未分类'
  if (!categorySummary[cat]) categorySummary[cat] = { sales: 0, service: 0 }
  categorySummary[cat].service += amount
}
```

3. **重写 serviceItems 映射**（L532-544）：

```js
const serviceItems = svcRows.map(r => ({
  type: 'service',
  productName: r.product_name,
  specName: r.sku_spec_name,
  salesCategory: r.sales_category,
  roleType: r.role_type,                        // 新增：标明该条是哪个角色的提成
  amount: Number(r.commission_amount),          // 不再是 unit_real_price × session_used
  fixedFee: Number(r.fixed_fee),                // 新增：供前端拆分展示
  consumeAmount: Number(r.consume_amount),      // 新增：供前端拆分展示
  sessionUsed: r.session_used,
  servicePrice: Number(r.service_unit_price),   // 保留：用户想知道"单次卡价"还是可以看
  customerName: r.customer_name,
  clientPhone: r.client_phone,
  orderId: r.service_order_id,
  date: r.service_date,
}))
```

4. **重命名返回字段**（L556-565）：

```js
ctx.result = {
  totalSalesAlloc: Math.round(totalSalesAlloc * 100) / 100,
  totalServiceCommission: Math.round(totalServiceCommission * 100) / 100,  // ← 重命名
  totalCommission: Math.round((totalSalesAlloc + totalServiceCommission) * 100) / 100,
  categorySummary,
  items: paged,
  total: allItems.length,
  page,
  pageSize,
}
```

5. **前端同步**: `fengyu-staff/miniprogram/packageOrder/staff-performance/staff-performance.ts` 把读 `totalServiceFee` 的地方改为 `totalServiceCommission`；wxml 的展示文案"服务费"改"服务提成"；可选展示 `fixedFee / consumeAmount` 拆分 cell 提升透明度（例："固定手工费 ¥80 + 消耗提成 ¥50 = ¥130"）。

#### 2.5.7 临时缓解方案（若 Phase 2.5 暂不能落地）

如果 `service.complete` 自动写入 `service_commissions` 这一步因其他依赖推迟，业务方仍希望先修复展示错误，有三个临时选项：

| 选项 | 做法 | 优点 | 缺点 |
|------|------|------|------|
| **A（推荐）** | performanceDetail 内部"**实时重算**"：`fixed_fee = sale_items.service_fee × session_used`（依赖 Phase 1.2），`consume_amount = unit_real_price × session_used × lookupRate(roleType, salesCategory, unit_real_price)`，实时查 commission_rate_matrix | 只依赖 Phase 1.2，不依赖 Phase 2.5；业务方能立刻看到正确数值 | 代码重复了 service.complete 的计算逻辑，Phase 2.5 落地后必须立刻切换到 service_commissions 读取，否则就有两份"真相"漂移 |
| **B** | 把字段 `totalServiceFee` **改名**为 `totalServiceConsumedAmount`（消耗业绩金额），前端文案改"服务消耗业绩"；暂不展示服务提成 | 改动小，语义诚实 | 员工在绩效页看不到"服务提成"，需要等根治方案 |
| **C** | 直接**删除** svcRows 返回字段，performanceDetail 只返回销售维度 | 改动最小 | 员工看不到服务记录，体验退化 |

**决策**: 选项 A。Phase 1.2 是独立低风险变更，应当优先落地；在 Phase 2.5 未完成前用"实时查矩阵"兜底；Phase 2.5 落地后切换到"直接读 service_commissions"，同时删除临时计算代码（留 TODO 注释标记）。

#### 2.5.8 回归测试用例

**单元测试**（新增在 `fengyu-staff/cloudfunctions/staffApi/__tests__/staff.performanceDetail.test.js`）：

1. **test_service_commission_reads_from_commission_amount** — Mock service_commissions 表 10 行，commission_amount=130，断言 `totalServiceCommission === 1300`，且**不等于** `unit_real_price × session_used × 10 = 5000`
2. **test_category_summary_service_uses_correct_field** — 断言 `categorySummary['护理项目'].service === 1300`
3. **test_total_commission_is_additive_of_correct_fields** — 断言 `totalCommission === totalSalesAlloc + totalServiceCommission`
4. **test_service_items_expose_fixed_fee_and_consume_amount** — 断言 `serviceItems[0]` 包含 `fixedFee` 和 `consumeAmount` 字段，且 `amount === fixedFee + consumeAmount`
5. **test_void_service_commission_excluded** — 断言 `is_void = true` 的 service_commissions 不计入汇总
6. **test_cross_category_isolation** — 两个不同 salesCategory 的服务单，categorySummary 分类下的 service 金额互不污染
7. **test_role_type_exposed_per_row** — serviceItems 每行 `roleType` 字段存在（用于前端显示"美容师/推广师"等）

**E2E 回归**:

- 准备数据：员工完成 2 个不同 salesCategory 的服务单（护理项目 3 次 + 家居产品 2 次），提成矩阵已配置
- 执行：调 performanceDetail 云函数
- 断言：
  - `totalServiceCommission === SUM(service_commissions.commission_amount)`（可用 psql 直接验证）
  - `categorySummary` 两个分类的 service 分别等于各自 SUM
  - 前端绩效页展示的"服务提成"数字 = 上述 totalServiceCommission

#### 2.5.9 与 AC-05 的关系

§6 AC-05 原文："员工绩效明细页的'服务提成'金额显示为 `service_commissions.commission_amount`，而非 `unit_real_price × session_used`" —— 即为本 Bug 的验收断言。按 §2.5.6 根治后 AC-05 自动满足。

#### 2.5.10 修复优先级建议

本 Bug 属于**可见性高、危害直接、修复路径清晰**的类型，建议在 Phase 1.2 + Phase 2.5 落地后**作为 Phase 2.6 的第一项**执行（先于 todayCommission / monthlyCalendar 的服务维度补全），原因：

1. 错误数值每天都在给员工看，每多一天就多一份信任损失
2. 修复范围集中（仅 performanceDetail 一个函数 + 前端一个页面）
3. 依赖链最短（只需 Phase 1.2 + Phase 2.5，不需要 Phase 1.1 枚举换值落地）
4. 可以作为 service_commissions 运行时写入正确性的**首个端到端验证点**

---

## 3 差异报告

### 3.1 差异表

| 维度 | 当前 | 期望 | 影响范围 |
|------|------|------|---------|
| **salesCategoryEnum 4 值** | 自采自销/他销自耗/他销他耗/生态合作 | 自销自耗/自销他耗/他销自耗/他销他耗 | L0 enum → L1 schema → L3 SQL → L6 api → L9 UI + 所有 SUM BY salesCategory 语句 |
| **固定手工费** | product_skus.service_fee 仅静态存储，未快照到 sale_items，未参与 complete 计算 | 快照到 sale_items；service.complete 时作为 commission_amount 一部分写入 service_commissions | sale_items schema + order.create SQL + service.complete 逻辑 + admin 提成矩阵页 UI |
| **消耗提成比例来源** | 前端 allocation-calc.ts 按 received × rate 计算，rate 从 beautyRates[dept][salesCat] 查 | service.complete 内部 JOIN commission_rate_matrix WHERE role_type=? AND sales_category=? AND amount_tier_min ≤ unit_real_price 计算 | 后端 service.complete + commission.ts admin 维护页面 |
| **销售提成 4 分类配置** | commission_rate_matrix.sales_category 是 varchar(20) 但 UI 和代码使用 4 旧值 | 4 新值，每个员工的每个销售单分类独立配置比例 | 同上 salesCategoryEnum 传播 |
| **业绩分配 vs 提成比例** | 前端分配页 lookupRate 用 received × rate 自动填金额，导致用户感觉"金额随比例变" | 分配页只让用户选"整十档的分配比例"，金额 = unit_real_price × ratio 由后端算；提成比例矩阵不在分配 UI 出现 | revenue-allocation.ts + allocation-calc.ts + cloudfn allocation.save |
| **角色校验独立性** | admin 端合并美容师+养生师为 beautician 组共同限 3 人 | 三角色（美容师/养生师/推广师）**独立**校验：会议 §五.3"不同角色之间不互相约束" | admin allocations.ts:156 getRoleGroup + cloudfn allocation.save 新增校验 |
| **角色决定依据** | 前端通过员工所属部门（美容部→美容师）推断 | 通过员工技能标签 `staff_wechat_users.skills` 数组决定 | staff.departments / staff.list cloudfn + revenue-allocation.ts 前端 |
| **每个 item 最多 3 人** | cloudfn allocation.save 无此校验（admin 已有） | cloudfn 也需要加 | allocation.js save 新增校验 |
| **service_commissions 写入** | 仅迁移脚本写入，运行时零写入 | service.complete 时自动写入 = fixed_fee + consume_rate × unit_real_price | service.complete 重写 |
| **人效指标"划卡数"** | dashboard 未返回 | 新增第 6 个指标 | staff.dashboard cloudfn + dashboard.ts/wxml 前端 |
| **todayCommission 含服务提成** | 仅 sale_allocations | sale_allocations + service_commissions | staff.todayCommission SQL |
| **performanceDetail 服务提成口径** | unit_real_price × session_used 当成"服务费"（实际是消耗业绩） | commission_amount from service_commissions | staff.performanceDetail SQL |
| **职位下拉** | admin 已有 scope 下拉 ✅ | 无需改动（验证一遍） | — |
| **员工注册入口** | staffApi auth.bindPhone 按 phone 找已同步行并写 openid ✅ | 无需改动 | — |

### 3.2 关键矛盾与澄清请求

以下 3 点在进入编码前**必须向产品方澄清**，否则做错需要返工：

#### Q1. 销售提成 4 分类的主语是"销售单"还是"订单项"？

会议 §三"销售类单据按商品品牌/类别分四种提成"——"商品"是 item 粒度，"品牌/类别"也是 item 粒度。当前 `sale_items.sales_category` 列就是 item 级快照，方向正确。

但 `commission_rate_matrix.order_type` 当前存"销售单"/"服务单"两种，这是**单据类型**而非"是哪个人分配到的四分类"。需要确认：
- 选项 A: salesCategory 属于销售提成的维度；服务提成维度仅有 (role_type, amount_tier)，不细分品牌
- 选项 B: 服务提成也按 4 分类细分（比如"他销自耗"的护理项目消耗提成 vs "自销自耗"的消耗提成）

**建议**: 选项 B，与"自销他耗 vs 他销他耗"的语义对称（两种"耗"的提成差异本质上就是矩阵上不同的分类行）。

#### Q2. "美容师/养生师独立"还是"合并到 beauty 组"？

- admin `getRoleGroup` 当前将美容师+养生师合并 (fengyu-admin/src/actions/allocations.ts:156-158)
- 会议 §五.3 原文："美容师的业绩分配独立校验（加起来 ≤ 商品金额），推广师的业绩分配独立校验"——**只提了美容师和推广师**，没提养生师
- 会议 §四.2 提到"当前标签：美容师、养生师、推广师，可按需增加" — 养生师是独立技能

**建议**: 三角色都独立校验（最大灵活性），admin `getRoleGroup` 改为 `roleType → roleType` 的恒等映射。

#### Q3. 固定手工费写死在 sku 还是可以按角色/阶梯配置？

- 会议原文："每个产品需要配置两个字段：固定手工费 + 消耗提成比例"
- "每个产品"暗示是 product_skus 级别
- 但不同角色（美容师 vs 养生师做同一个护理项目）是否固定手工费相同？

**建议**: 固定手工费仍存 `product_skus.service_fee`（单值）；如果未来需要按角色区分，再扩展到 commission_rate_matrix。当前按"每个 sku 一个固定手工费"实现。

---

## 4 修改计划（按执行顺序）

### Phase 0 — 澄清与设计冻结（必须在 Phase 1 前完成）

- [ ] 产品方回答 Q1 / Q2 / Q3
- [ ] 确认 `salesCategoryEnum` 新 4 值的官方中文用词（建议"自销自耗/自销他耗/他销自耗/他销他耗"）
- [ ] 确认 service_commissions 是否需要新增 `fixed_fee` 列（用于拆分固定手工费和消耗比例的金额）以便后续报表。建议新增，否则 `commission_amount` 无法逆推结构。

### Phase 1 — 结构性变更（交接 /wx-change-propagation）

#### 1.1 salesCategoryEnum 4 值全换 —— wx-change-propagation

旧: `["自采自销", "他销自耗", "他销他耗", "生态合作"]`
新: `["自销自耗", "自销他耗", "他销自耗", "他销他耗"]`

**传播链（10 层）**:
- L0 enum (`db/schema/enums.ts:44`)
- L1 schema 引用 (`db/schema/product.ts:15`, `db/schema/order.ts:139`)
- L2 迁移文件 `db/migrations/0035_rename_sales_category_enum.sql`，需要：
  1. `ALTER TYPE sales_category RENAME TO sales_category_old`
  2. `CREATE TYPE sales_category AS ENUM (...)`
  3. 数据映射：`自采自销 → 自销自耗`、`他销自耗 → 他销自耗`、`他销他耗 → 他销他耗`、`生态合作 → ???`（需澄清旧"生态合作"对应什么新值，可能是"自销他耗"或需要清空）
  4. ALTER TABLE 的各列 USING CAST
  5. DROP TYPE sales_category_old
- L3 云函数硬编码
  - `staffApi/routes/allocation.js:231-232, 377` — 4 值 key 改名
  - `staffApi/routes/allocation.js:399` — 默认值 `'自采自销'` 改 `'自销自耗'`
- L4 admin actions — `fengyu-admin/src/actions/commission.ts` 若有 UI 下拉硬编码需改
- L5 admin UI — `/commission` 页面 + `/allocations` 页面的分类 filter、标签渲染
- L6 admin 测试 — `commission.test.ts` / `allocations.test.ts` 所有 fixture
- L7 staff 前端硬编码
  - `revenue-allocation.ts:264` — 默认值
  - `allocation-calc.ts:32` — beautyDepts（其实是旧部门名，不涉及枚举但同场景）
  - `performance-detail` 页面 categorySummary 标签
- L8 staff 测试（若有 unit test 覆盖分类汇总）
- L9 WorkFine 同步脚本 `db/scripts/sync-workfine.js` / `sync-products-from-workfine.js` — 映射表调整
- L10 seed 数据 `fengyu-admin/src/db/seed.ts` 若有测试分类数据

**注意**: `commission_rate_matrix.sales_category` 是 `varchar(20)` 不是 enum 列（见 `db/schema/commission.ts:19`），意味着可以写入任意字符串。迁移时需要单独 UPDATE commission_rate_matrix SET sales_category = CASE ... END。

#### 1.2 sale_items 新增 service_fee_snapshot 列 —— wx-change-propagation 或直接小改

新增列：
```sql
ALTER TABLE sale_items
  ADD COLUMN service_fee numeric(10, 2) NOT NULL DEFAULT 0;
```

- `db/schema/order.ts` saleItems 表新增 `serviceFee` 列
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js` 的 4 处 INSERT INTO sale_items 都需要新增 service_fee 参数，从 product_skus JOIN 读取快照
- admin actions/orders.ts 如果有 INSERT sale_items 也同步
- 用户开发阶段无历史数据需要兼容（MEMORY.md: feedback_no_legacy_compat）

#### 1.3 commission_rate_matrix 宽化到 enum —— 可选

将 `commission_rate_matrix.sales_category` 从 varchar(20) 改为 `salesCategoryEnum`，让 DB 层强制约束。

- 优点：防止写入非法值（当前代码里硬编码的 4 值如果漏改会在 DB 层直接报错）
- 缺点：如果未来要扩展分类，需要 ALTER ENUM

**建议**: 在 phase 1.1 同一批次一起做。

#### 1.4 service_commissions 表扩展（可选，建议做）

新增列：
```sql
ALTER TABLE service_commissions
  ADD COLUMN fixed_fee numeric(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN consume_amount numeric(10, 2) NOT NULL DEFAULT 0;
```

其中 `commission_amount = fixed_fee + consume_amount`，让双字段可追溯。

---

### Phase 2 — 云函数逻辑变更（直接执行）

#### 2.1 `fengyu-staff/cloudfunctions/staffApi/routes/order.js` — create 新增 service_fee 快照

- **文件**: `fengyu-staff/cloudfunctions/staffApi/routes/order.js:443-458` 以及其他 4 处 INSERT sale_items 语句
- **改动**:
  1. 查询 product_skus 时 SELECT service_fee（可能需要修改 validateProducts 子函数）
  2. INSERT sale_items 时新增 service_fee 列，值 = 对应 sku 的 service_fee × quantity
  3. 退款/转换/回款单的衍生 sale_items 复用原 ref_sale_item 的 service_fee 快照值

#### 2.2 `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js` — save 严格化 + role 语义

- **文件**: `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:31-144`
- **改动**:
  1. 新增 VALID_RATIOS 白名单 + 校验 allocationRatio 在整十档内
  2. 新增 roleType 参数必传
  3. 按 (saleItemId, roleType) 分组，每组最多 3 人
  4. 按 roleType **独立**校验比例合计 ≤ 1.00（确认 Q2 后实施）
  5. totalAmount 由后端计算：从 DB 查 sale_items.unit_real_price × allocationRatio，忽略前端传入值
  6. INSERT sale_allocations 时写入 `role_type` 列（与 admin 对齐）
  7. 删除 DEPT_TO_ROLE 常量映射，全部基于员工 skills

#### 2.3 `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js` — suggest 改基于 skills

- **文件**: `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:272-428`
- **改动**:
  1. `resolveStaffDepartment` 改名 `resolveStaffRoles`，返回该员工的技能标签数组（从 `staff_wechat_users.skills`）
  2. `suggest` 函数对每个 item × 每个技能标签生成一条 allocLine 建议
  3. 硬编码的 4 值对象 key 全部改新值
  4. 前端接收的 `beauticianInfo` 改为 `employeeRoles: string[]`

#### 2.4 `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js` — getCommissionRates 重构

- **文件**: `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:200-242`
- **改动**: 返回结构直接按新 4 值 pivot；orderRates + serviceRates 都用新 key

#### 2.5 `fengyu-staff/cloudfunctions/staffApi/routes/service.js` — complete 写入 service_commissions

- **文件**: `fengyu-staff/cloudfunctions/staffApi/routes/service.js:280+` (complete 函数)
- **新增步骤**（在现有原子扣减之后、COMMIT 之前）:
  ```js
  // 1. 加载该服务单所有 service_items + 对应 sale_items.service_fee
  const items = await client.query(`
    SELECT sit.service_item_id, sit.employee_id, sit.unit_real_price, sit.session_used,
           si.service_fee, si.sales_category
    FROM service_items sit
    JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
    WHERE sit.service_order_id = $1
  `, [serviceOrderId])

  // 2. 查员工的技能标签列表（用于角色判定）
  // 3. 查 commission_rate_matrix 消耗提成比例（按 role_type + sales_category + amount_tier）
  // 4. 对每个 service_item × 员工角色组合：
  //    fixed_fee = si.service_fee × session_used
  //    consume_amount = sit.unit_real_price × session_used × commission_rate
  //    commission_amount = fixed_fee + consume_amount
  // 5. INSERT INTO service_commissions
  // 6. UPDATE service_orders SET commission_status = '已分配'
  ```
- **幂等性**: 现有 complete 已用 WHERE status='服务中' 锁定，插入 service_commissions 时用 `ON CONFLICT (service_item_id, employee_id, role_type) WHERE is_void = false DO NOTHING`

#### 2.6 `fengyu-staff/cloudfunctions/staffApi/routes/staff.js` — 统计口径统一

**`todayCommission` (line 146-233)**:
- SQL 1: 从 sale_allocations 查销售提成总额（保留）
- **新增 SQL 2**: 从 service_commissions 查服务提成总额
- 返回 `todayAmount = salesComm + serviceComm`；拆两个字段给前端（`todaySalesCommission` / `todayServiceCommission`）以便分别展示

**`monthlyCalendar` (line 238-306)**:
- 增加 service_commissions 日聚合 UNION 到 dailyRows

**`performanceDetail` (line 412-566)**:
- line 465-494: 服务提成改从 service_commissions 读，字段包括 commission_amount, fixed_fee, consume_amount
- categorySummary 按 sales_category 维度统计，来源改为 service_commissions

**`dashboard` (line 573-693)**:
- 新增第 6 个指标 `serviceCount`（划卡数）:
  ```sql
  SELECT COALESCE(SUM(sit.session_used), 0) AS strokes
  FROM service_items sit
  JOIN service_orders so ON so.service_order_id = sit.service_order_id
  WHERE ${scopeFilter} AND so.status = '已完成' AND so.service_date BETWEEN ...
  ```
- 返回值新增 `strokes: number`

#### 2.7 `fengyu-staff/cloudfunctions/staffApi/routes/auth.js` — login/bindPhone 回传 skills

- 在 ctx.auth 注入 `skills: string[]`
- 前端 globalData 补字段（见 Phase 4）

---

### Phase 3 — Admin 逻辑变更

#### 3.1 `fengyu-admin/src/actions/allocations.ts`

- **文件**: `fengyu-admin/src/actions/allocations.ts:156-158`
- **改动**:
  1. `getRoleGroup` 改为恒等映射（Q2 确认后）
  2. 新增"金额合计 ≤ received" 的元数据校验（补上会议 §五.2 的 "差 1 分可接受" 语义，使用 0.02 容差）
  3. `batchSaveAllocations` 的 totalAmount 改为服务端重算（忽略前端传入），防止篡改

#### 3.2 `fengyu-admin/src/actions/service-commissions.ts`

- **文件**: `fengyu-admin/src/actions/service-commissions.ts:72-182`
- **改动**:
  1. 与 allocations 对齐 getRoleGroup 三角色独立
  2. 新增 `fixed_fee` / `consume_amount` 入参（依赖 Phase 1.4）
  3. 保留此 action 作为"手动补录/修正"入口；自动写入由 staffApi 承担

#### 3.3 `fengyu-admin/src/actions/commission.ts` + `/commission` 页面

- **文件**: `fengyu-admin/src/actions/commission.ts:69-108`
- **改动**:
  1. `createRate` / `updateRate` 的 `salesCategory` 入参校验白名单改成新 4 值
  2. UI 下拉选项更新（具体组件文件为 `fengyu-admin/src/app/(main)/commission/_components/commission-page.tsx`）
  3. 考虑新增"服务提成消耗比例"专用入口（order_type='服务单' 已存在，只需补新 4 值）

---

### Phase 4 — 前端渲染层变更

#### 4.1 `fengyu-staff/miniprogram/packageOrder/revenue-allocation/revenue-allocation.ts`

- **文件**: 主文件 + `allocation-calc.ts` 辅助函数 + `revenue-allocation.wxml`
- **改动**:
  1. line 264: 硬编码默认值 `'自采自销'` → `'自销自耗'`
  2. `staff.departments` 返回的 members 对象补 `skills: string[]`，前端分组按 skills 而非 departmentName
  3. 选人后的 `onStaffSelected` 不再调用 `lookupRate` 自动填金额——改为让用户选"整十档分配比例"（Vant Dropdown 10/20/.../100 十个选项）
  4. 金额 = received × allocationRatio，只读显示（保留用户心理预期）
  5. 按 skills 拆分多行：同一员工 A 有 ['美容师','推广师'] 两个技能，则 A 会同时出现在"美容师角色"和"推广师角色"两个分组中，各自独立分配
  6. 提交时每个 allocLine 带上 `roleType` 字段
  7. 三角色独立校验（在 onSave 前本地校验），每角色组合计 ≤ 1.00

#### 4.2 `fengyu-staff/miniprogram/utils/allocation-calc.ts`

- **文件**: 整个文件
- **改动**:
  1. 删除 `lookupRate` 函数（提成比例不再参与前端展示；分配用"整十档选项"而非比例）
  2. `computeSummary` 保留，按 roleType 分组汇总

#### 4.3 `fengyu-staff/miniprogram/packageOrder/dashboard/dashboard.ts/wxml`

- **文件**: `dashboard.ts` + `dashboard.wxml`
- **改动**:
  1. data 新增 `strokes: 0`
  2. wxml 新增第 6 个指标 tile "划卡数"
  3. 会议 §三"人效指标（英雄榜）" → 这里是单人数据看板，"英雄榜"另一页是店长店内员工排行榜（可能需要新建）

#### 4.4 `fengyu-staff/miniprogram/packageOrder/staff-performance/staff-performance.ts/wxml`

- **文件**: 4 个文件
- **改动**:
  1. 接收 performanceDetail 新字段 `todayServiceCommission` / categorySummary 新 key
  2. 分类 Tab 的标签映射更新（旧 4 值 → 新 4 值）
  3. 服务提成明细展示 commission_amount（而非 unit_real_price × session_used）

#### 4.5 `fengyu-staff/miniprogram/pages/workbench/workbench.ts/wxml`

- **文件**: 工作台主页
- **改动**:
  1. "今日分成"卡片展示 todayAmount（总） + 拆分展示 salesCommission / serviceCommission 两个子金额（可选）
  2. "上月分成"同样

#### 4.6 `fengyu-staff/miniprogram/app.ts` globalData

- **文件**: app.ts
- **改动**: `globalData.skills: string[]`，登录时从 ctx.auth.skills 缓存

#### 4.7 员工技能标签编辑 UI（Admin）— 已实现验证

经过代码检查，以下已实现 ✅:
- `fengyu-admin/src/app/(main)/employees/create/_components/employee-create-page.tsx:45` data 含 `skills: []`
- `fengyu-admin/src/app/(main)/employees/create/_components/employee-create-page.tsx:230-231` 有 skills 字段组件
- `fengyu-admin/src/app/(main)/employees/[id]/_components/employee-detail-page.tsx:407-408` 编辑页也有 skills 字段
- `updateEmployee` action (`fengyu-admin/src/actions/employees.ts:349`) 已接受 skills 参数

**本计划无需对该模块做改动**，只需验证技能值的可选列表与 `suggest` 云函数里的角色映射逻辑一致（美容师/养生师/推广师），并确保 admin 下拉选项的官方用词一致。

**待确认**: TagSelect 组件具体位置和可选项常量来源（如果是硬编码枚举，需同步 salesCategoryEnum 一起扩展为从 DB 或 config 读取）。

---

### Phase 5 — 测试与回归

#### 5.1 单元测试

- [ ] `fengyu-admin/src/actions/commission.test.ts` — 更新 fixture 使用新 4 值
- [ ] `fengyu-admin/src/actions/allocations.test.ts` — 三角色独立校验用例
- [ ] `fengyu-admin/src/actions/service-commissions.test.ts` — fixed_fee / consume_amount 拆分
- [ ] 新增 cloudfn 集成测试（如果存在）验证 service.complete 写入 service_commissions

#### 5.2 数据校验 SQL

迁移后立即跑：
```sql
-- 1. 枚举分布检查
SELECT sales_category, COUNT(*) FROM sale_items GROUP BY 1;
SELECT sales_category, COUNT(*) FROM product_categories GROUP BY 1;
SELECT sales_category, COUNT(*) FROM commission_rate_matrix GROUP BY 1;

-- 2. 提成矩阵完备性检查（确保每市场 × 每角色 × 每分类都有规则）
SELECT crm.org_id, crm.role_type, crm.sales_category, COUNT(*)
FROM commission_rate_matrix crm
GROUP BY 1,2,3
HAVING COUNT(*) = 0;

-- 3. service_fee 快照对齐（所有新订单 sale_items.service_fee = sku.service_fee × quantity）
SELECT si.sale_item_id, si.service_fee, sk.service_fee * si.quantity
FROM sale_items si JOIN product_skus sk ON si.sku_id = sk.sku_id
WHERE si.created_at > '2026-04-09' AND si.service_fee != sk.service_fee * si.quantity;
```

#### 5.3 E2E 回归点

- admin `/commission` 新增一条新 4 值规则并保存
- admin `/allocations` 一个待分配订单的批量分配流程
- staff 小程序 revenue-allocation 页选人 → 选比例 → 保存
- staff 服务单 complete → 检查 service_commissions 写入 + todayCommission 是否含服务提成

---

## 5 风险点与缓解

### 5.1 风险清单

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| salesCategoryEnum 迁移数据丢失 | 高 | 迁移前备份 sale_items + commission_rate_matrix，迁移中用 CASE 映射而非 DROP/RECREATE；开发阶段数据可清空重种 (MEMORY: no-legacy-compat) |
| 前端云函数先后发版不一致 | 中 | 先部署 cloudfn（向后兼容：同时识别新旧 4 值），再发布前端，最后下线旧值识别 |
| service.complete 写入 service_commissions 失败导致服务单卡死 | 高 | 服务单状态已切换 "已完成" 后 commission_status 置 "待分配"，写入失败由 cronTask 补偿或提供 admin 手动入口 `batchSaveServiceCommissions` |
| 三角色独立校验改动可能被理解为"美容师+养生师可以重复分 200%" | 中 | 在会议纪要澄清后、修改前，在 `03-staff-commission.md` 的 Q2 明确产品方回答并冻结 |
| 提成矩阵缺失规则时分配建议返回 0 | 中 | `suggest` 函数在 rate 查不到时返回提示（"请先配置该分类的提成规则"），前端阻止保存 |
| 固定手工费被快照后，用户在 admin 改 sku.service_fee 对历史单无效，用户可能疑惑 | 低 | UI 文案明示"修改后仅对新开单生效" |
| 前端 globalData.skills 登录未覆盖老 session 的用户 | 低 | 添加兜底：allocation-page 进入时从 staff.list 返回的 skills 字段刷新本地缓存 |

### 5.2 与 member-level cronTask 重构（b471d70）的交互点

**交互点 1 — cronTask 职责扩展风险**:

b471d70 将 cronTask 扩展为多 STEP 任务（STEP 1 = 客户状态日重算；STEP 2 = 会员等级 + 权益发放）。本次需求**不需要**在 cronTask 新增 STEP 3，因为：
- 销售提成已经在 allocation.save 实时写入 sale_allocations
- 服务提成应该在 service.complete 实时写入 service_commissions（而不是延迟到日重算）
- 提成"日汇总"是**读取**操作，不需要写入

**但是**：若 service.complete 写入失败（见 5.1 风险），可考虑在 cronTask 新增 STEP 3 = "扫描 commission_status='待分配' 且超 24h 的 service_orders 重试计算"，作为自愈机制。这与 b471d70 的 cronTask 扩展模式一致。

**交互点 2 — member_level 字段依赖**:

b471d70 将会员等级下放为 `client_wechat_users.member_level` 单字段。本次提成重构**不直接读取** member_level，但有一个间接点：
- `suggest` 函数中的 `checkNewCustomer` (allocation.js:298-305) 判断是否新顾客——"新顾客"定义见 meeting-20260312 §二："当月消费首次达到会员标准的客人"。当前实现是"没有历史已支付订单"就算新顾客，这**与会议定义不一致**。
- 建议：checkNewCustomer 改为"本月内 member_level 从 NULL → 非 NULL 的事件" —— 可以通过 operation_logs 查（b471d70 cronTask 升级会写 operation_logs）或查 point_transactions 权益发放记录。

**交互点 3 — operation_logs 写入**:

b471d70 放宽了 `operation_logs.operator_employee_id` 为 nullable 以便 cronTask 写入系统级日志。本次 service.complete 若新增提成计算步骤，也可以写 operation_logs（operator = 当前员工），沿用现有 logOperation 机制。

**交互点 4 — system_configs 会员权益配置模式可复用**:

b471d70 将会员权益配置存到 `system_configs.member_level_benefits`，由 admin 界面维护。本次重构如果要支持"按员工职级动态调整提成比例"（即未来扩展），可复用同样模式：新增 `system_configs.commission_overrides` 存 admin 可动态调整的覆盖规则，避免每次改比例都要 ALTER。**但当前需求不需要**，仅记录备选方案。

### 5.3 与其他历史技术债的交互

#### 5.3.1 `salesCategoryEnum` 的旧值"生态合作"归口

旧 enum 第 4 值"生态合作"在会议 20260312 §三中并未出现，也不在新定义的 4 分类中。需要排查：
- `SELECT sales_category, COUNT(*) FROM sale_items WHERE sales_category = '生态合作'`
- `SELECT sales_category, COUNT(*) FROM product_categories WHERE sales_category = '生态合作'`
- `SELECT sales_category, COUNT(*) FROM commission_rate_matrix WHERE sales_category = '生态合作'`

若存在数据：
- 选项 A: 清零（开发阶段，MEMORY: no-legacy-compat）
- 选项 B: 映射到"自销他耗"（因为原"生态合作"可能指凤御代销合作品牌）
- 选项 C: 保留为第 5 值扩展枚举

**建议**: 选项 A，直接清空相关列并由业务方重填；同步更新 seed.ts 与所有 mock 数据。

#### 5.3.2 旧"自采自销"vs 新"自销自耗"的语义差

旧值"自采自销"强调的是**进货渠道**（自采），新值"自销自耗"强调的是**服务执行方**（自己做）。两者语义重叠但不完全一致——一个 SKU 可能是"自采"但实际是外部人员操作的。

**建议**: 迁移脚本中不做自动映射，要求产品方在 admin /products 页面逐条复核每个 product_category 的 sales_category。

#### 5.3.3 `commission_rate_matrix.order_type` 为 varchar(20) 的历史遗留

`db/schema/commission.ts:17` 该列为 `varchar(20)`，而非 enum。当前实际存储"销售单"/"服务单"两种中文值。本次如果要扩展至按 4 分类细分（Q1 选项 B），建议一并考虑：
- 新增 enum `commissionOrderTypeEnum` = ['销售', '服务消耗', '固定手工']
- 或保持 varchar 但补 CHECK 约束

---

## 6 验收标准（Acceptance Criteria）

- [ ] AC-01: 数据库迁移 0035 成功运行，所有 sale_items / commission_rate_matrix / product_categories 的 sales_category 值分布符合新 4 值集合
- [x] AC-02: 开单后 sale_items.service_fee 快照等于 product_skus.service_fee × quantity ✅（staffApi/order.js 5 处 INSERT + admin/orders.ts 1 处）
- [x] AC-03: 服务单 complete 后 service_commissions 被自动写入，fixed_fee + consume_amount = commission_amount ✅（service.complete 新增逻辑 + 3 个单元测试覆盖）
- [ ] AC-04: 员工当天完成一个服务单后，staff.todayCommission 的 todayAmount 包含该服务单的 commission_amount
- [x] AC-05: 员工绩效明细页的"服务提成"金额显示为 service_commissions.commission_amount，而非 unit_real_price × session_used ✅（performanceDetail 改查 service_commissions + 7 个单元测试覆盖 + 前端 wxml 展示拆分）
- [ ] AC-06: 数据看板新增"划卡数"指标，值 = SUM(service_items.session_used)
- [ ] AC-07: 业绩分配页对同一 sku，美容师/养生师/推广师三角色可以各自独立加人，每组最多 3 人、每组比例合计 ≤ 100%，跨角色不互相影响
- [ ] AC-08: 分配的员工角色由员工技能标签 `staff.skills` 决定，不再由部门推断
- [ ] AC-09: 云函数 allocation.save 拒绝非整十档比例，拒绝跨角色合并校验
- [ ] AC-10: Admin /commission 页面下拉选项显示新 4 值
- [ ] AC-11: Admin /allocations 页面 batchSave 的 totalAmount 由后端从 unit_real_price 重算（测试：前端传错误金额被忽略）
- [ ] AC-12: 员工创建/编辑页的"技能标签"字段可选 美容师/养生师/推广师 并保存
- [ ] AC-13: 所有单元测试通过；所有 E2E 测试通过；手动验证一次完整的 "开单 → 支付 → 分配 → 护理 → 完成 → 查看提成" 端到端链路

---

## 7 代码位置索引（加速后续执行）

| 层级 | 文件 | 关键行 | 作用 |
|------|------|--------|------|
| DB Enum | `/Users/nv/proj.xt.com/fengyu-wxapp/db/schema/enums.ts` | 44 | salesCategoryEnum 定义 |
| DB Schema | `/Users/nv/proj.xt.com/fengyu-wxapp/db/schema/commission.ts` | 9-38 | commission_rate_matrix 表 |
| DB Schema | `/Users/nv/proj.xt.com/fengyu-wxapp/db/schema/product.ts` | 29-60 | product_skus.service_fee |
| DB Schema | `/Users/nv/proj.xt.com/fengyu-wxapp/db/schema/product.ts` | 11-20 | product_categories.sales_category |
| DB Schema | `/Users/nv/proj.xt.com/fengyu-wxapp/db/schema/order.ts` | 108-155 | sale_items（需要加 service_fee 快照列） |
| DB Schema | `/Users/nv/proj.xt.com/fengyu-wxapp/db/schema/order.ts` | 163-194 | sale_allocations |
| DB Schema | `/Users/nv/proj.xt.com/fengyu-wxapp/db/schema/service-commission.ts` | 12-42 | service_commissions（需加 fixed_fee / consume_amount） |
| DB Schema | `/Users/nv/proj.xt.com/fengyu-wxapp/db/schema/user.ts` | 78-111 | staff_wechat_users.skills |
| Cloudfn | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/routes/allocation.js` | 31-144 | allocation.save（重写） |
| Cloudfn | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/routes/allocation.js` | 200-242 | getCommissionRates（换 key） |
| Cloudfn | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/routes/allocation.js` | 272-428 | suggest + resolveStaffDepartment（改基于 skills） |
| Cloudfn | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 443-458 | sale_items INSERT（+ service_fee 快照） |
| Cloudfn | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/routes/service.js` | 280+ | service.complete（新增提成写入） |
| Cloudfn | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/routes/staff.js` | 146-233 | todayCommission（+服务提成） |
| Cloudfn | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/routes/staff.js` | 238-306 | monthlyCalendar（+服务提成） |
| Cloudfn | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/routes/staff.js` | 412-566 | performanceDetail（口径修正） |
| Cloudfn | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi/routes/staff.js` | 573-693 | dashboard（+划卡数） |
| Admin | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/commission.ts` | 69-108 | createRate（白名单） |
| Admin | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/allocations.ts` | 156-281 | batchSaveAllocations（三角色独立） |
| Admin | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/service-commissions.ts` | 72-182 | batchSaveServiceCommissions（新字段） |
| Admin | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/actions/employees.ts` | 239-336 | createEmployee（已支持 skills ✅） |
| Admin UI | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/app/(main)/employees/create/_components/employee-create-page.tsx` | 203-217 | 职位下拉（已实现 ✅） |
| Admin UI | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/src/app/(main)/commission/_components/commission-page.tsx` | — | 4 值下拉（待改） |
| Staff FE | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/miniprogram/packageOrder/revenue-allocation/revenue-allocation.ts` | 239-289 | 选人流程（按 skills 重构） |
| Staff FE | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/miniprogram/packageOrder/revenue-allocation/revenue-allocation.ts` | 264 | 硬编码默认值"自采自销" |
| Staff FE | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/miniprogram/utils/allocation-calc.ts` | 32 | beautyDepts 硬编码 |
| Staff FE | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/miniprogram/packageOrder/dashboard/dashboard.ts` | 20-27 | 5 指标 data（+划卡数） |
| Staff FE | `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/miniprogram/packageOrder/staff-performance/staff-performance.ts` | — | 绩效明细（新口径） |

---

## 8 执行顺序（依赖图）

```
Phase 0 澄清 Q1/Q2/Q3
        │
        ▼
Phase 1.1 salesCategoryEnum 换值 ─┐
Phase 1.2 sale_items + service_fee │
Phase 1.3 commission_rate_matrix 强化 enum  ← wx-change-propagation
Phase 1.4 service_commissions 扩字段 ─┘
        │
        ▼
Phase 2.1 order.create 快照 service_fee
        │
        ▼
Phase 2.2-2.4 allocation.save/suggest/rates 重写
        │
        ▼
Phase 2.5 service.complete 写入 service_commissions
        │
        ▼
Phase 2.6 staff.js 4 个 SQL 口径统一（含新增划卡数）
        │
        ▼
Phase 2.7 auth.js 回传 skills
        │
        ▼
Phase 3.1-3.3 Admin actions 对齐
        │
        ▼
Phase 4 前端 UI 重写（并行，分页面）
        │
        ▼
Phase 5 单测 + 数据校验 + E2E
```

**预计工作量（基于会议"约 40 天 3 个迭代"的上下文）**：
- Phase 0: 0.5 天（沟通 + 文档冻结）
- Phase 1: 1-1.5 天（枚举传播 + 迁移）
- Phase 2: 3-4 天（cloudfn 算法重写）
- Phase 3: 1.5-2 天（admin actions + UI）
- Phase 4: 2-3 天（小程序 UI 重写 + 工作台/绩效/看板联动）
- Phase 5: 1-2 天（测试 + 数据校验）

**合计：约 9-13 个人天**（不含产品方沟通 + 测试反馈迭代）。

---

## 9 完成标志

本适配计划的**交付物**即本文件本身，不在本阶段执行代码修改。进入实际执行前需：

1. 产品方回答 §3.2 的三个问题
2. 本文档的 Phase 1 结构性变更交接 `/wx-change-propagation` 生成完整传播清单
3. 技术 lead 确认风险缓解方案（§5）
4. 在 `.42cog/cog.md` 或 `.42cog/real.md` 若涉及认知模型/硬约束变动需单独评审（**本次不改，仅涉及算法层**）

---

## 附录 A — 会议要点对照表

| 会议条目 | 会议原文位置 | 本计划覆盖章节 |
|---------|-------------|---------------|
| 提成结构双字段（固定手工费 + 消耗比例） | meeting-20260312 §三 | §3 差异表第 2 行；§4 Phase 1.2/1.4, 2.1, 2.5 |
| 销售提成 4 分类（自销自耗等） | meeting-20260312 §三 | §3 差异表第 1/4 行；§4 Phase 1.1 |
| 人效指标（业绩/消耗/划卡数） | meeting-20260312 §三 | §3 差异表第 10 行；§4 Phase 2.6, 4.3 |
| 业绩分配 vs 提成比例分离 | meeting-20260324 §五.1 | §3 差异表第 5 行；§4 Phase 4.1 |
| 整十百分比固定选项 | meeting-20260324 §五.2 | §4 Phase 2.2, 4.1 |
| 最多 3 人分配 | meeting-20260324 §五.2 | §4 Phase 2.2 |
| 美容师/推广师独立校验 | meeting-20260324 §五.3 | §3 Q2 + §4 Phase 2.2, 3.1 |
| 选人后角色自动填入（基于技能标签） | meeting-20260324 §五.4 | §4 Phase 2.3, 2.7, 4.1, 4.6, 4.7 |
| 人员范围按订单所属门店筛选 | meeting-20260324 §五.4 | 已实现（staff.departments 有 store_id 过滤）无需改动 |
| 职位字段改为下拉选择 | meeting-20260324 §四.1 | 已实现 ✅ |
| 技能标签驱动提成匹配 | meeting-20260324 §四.2 | §4 Phase 4.7 |
| 员工由后台添加（非自主注册） | meeting-20260324 §四.3 | 已实现 ✅ |

---

> **本文档为只读修改计划，执行前请先获得产品方 §3.2 澄清答复。**
