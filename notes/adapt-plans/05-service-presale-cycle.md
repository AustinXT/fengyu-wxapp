# 差异报告：服务单售前/售后 + 经营周期/会员门槛配置化

> 适配来源
> - `notes/meetings/meeting-20260324/article.md` §六 服务单
> - `notes/meetings/meeting-20260312/article.md` §五 经营周期
> 适配方法论：`.claude/skills/wx-requirement-adapt/SKILL.md` §3 + §4
> 生成时间：2026-04-09

---

## 0. 需求分解

| 要素 | 说明 |
|------|------|
| **变更概念 A** | 服务类型（serviceOrderType）的语义与承载层级 |
| **变更概念 B** | 售前/售后（documentType / isPresale）的承载层级，从订单主表下沉到订单子项 |
| **变更概念 C** | 服务类型枚举从"售前/售后"回退到"普通/体验" |
| **变更概念 D** | 经营周期先按自然月实现（这条已经隐式落地，需固化） |
| **变更概念 E** | 会员门槛 1980/1990 硬编码全部改走 `system_configs.new_member_threshold` |
| **受影响角色** | 店长（开单时可能需要选择）、美容师（服务单明细展示）、后台数据分析（导出） |
| **受影响端** | db / staffApi / clientApi / payNotify / cronTask / fengyu-admin / fengyu-staff 前端 |

---

## 1. 当前实现盘点

### 1.1 数据库层

**`db/schema/enums.ts`**
- 第 33 行：`serviceOrderTypeEnum = pgEnum('service_order_type', ['售前', '售后'])`
  - 历史脉络：migration 0024 (`0024_service_order_type_rename.sql`) 把枚举值从 `[普通, 体验]` 改为了 `[售前, 售后]`，回填逻辑为"会员客→售后，非会员客→售前"
- 第 66 行：`documentTypeEnum = pgEnum('document_type', ['售前', '售后'])`
  - 由 migration 0023 (`0023_document_type.sql`) 新增，用于订单主表

**`db/schema/order.ts`**
- `saleOrders.documentType` (第 42 行)：订单主表级售前/售后字段，值基于 `client_wechat_users.customer_type` + `total_amount` 对比门槛判定
- `saleItems` 表**没有** `business_type` / `is_presale` / `document_type` 字段

**`db/schema/service.ts`**
- `serviceOrders.serviceOrderType` (第 20 行)：服务单主表级，默认 `'售前'`
- `serviceItems.isPresale` (第 62 行)：**子项级布尔字段已经存在**，注释说"`sale_orders.sale_order_type = '体验' → true (售前), otherwise false`"——这注释对应 migration 0014 时期的"体验卡=售前"语义，与现状已不一致
- migration 0014 (`0014_service_items_is_presale.sql`) 是新字段 + 初始回填

**`db/schema/system-config.ts`**
- 已存在 `system_configs` 键值对表。当前已写入的 key：`new_member_threshold`、`order_timeout`、`banner_images`、`fengyuguan_image`、`member_level_benefits`、`banner_count`
- 默认 `new_member_threshold = '1980'`（见 `fengyu-admin/src/actions/settings.ts:54`）

### 1.2 后端逻辑层

**售前/售后判定（订单主表级）**

| 位置 | 行号 | 现有逻辑 |
|------|------|---------|
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 362-381 | 开单时根据 `customer_type === '会员客'` OR `totalAmount >= threshold` → documentType |
| `fengyu-client/cloudfunctions/clientApi/routes/order.js` | 316-335 | 同上（顾客端下单） |
| `fengyu-admin/src/actions/orders.ts` | 516-538 | 同上（admin 手工开单） |
| `db/migrations/0023_document_type.sql` | 8-34 | 历史回填 |

**服务单类型判定（服务单主表级）**

| 位置 | 行号 | 现有逻辑 |
|------|------|---------|
| `fengyu-staff/cloudfunctions/staffApi/routes/service.js` | 150-159 | 创建服务单时查顾客 `customer_type`，会员客→售后，其他→售前 |
| `fengyu-admin/src/actions/services.ts` | 460-466 | 同上 |

**服务明细 is_presale 写入（已“硬编码 false”）**

| 位置 | 行号 | 现有逻辑 |
|------|------|---------|
| `fengyu-staff/cloudfunctions/staffApi/routes/service.js` | 200 | `const isPresale = false // 体验单已合并为销售单，无法区分` |
| `fengyu-admin/src/actions/services.ts` | 491 | `isPresale: false, // TODO: 体验单已合并入销售单，需另行判断售前/售后` |

换句话说：子项级字段**存在但从未被真正写入有效值**。查询端（list/detail）读出来的 `is_presale` 永远是 `false`，WXML/TSX 展示的"售后"徽章是按 `!isPresale` 反推出来的误判。

**1980/1990 硬编码清单**

| # | 位置 | 值 | 用途 | 是否读取 system_configs |
|---|------|-----|------|------------------------|
| 1 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:38` | `1990` | `spending_tier` CASE 档位 | 否 |
| 2 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:72` | `1990` | recalcCustomerType fallback | 是（读取失败时） |
| 3 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:377` | `1990` | documentType 判定 fallback | 是 |
| 4 | `fengyu-staff/cloudfunctions/staffApi/routes/staff.js:676` | `1980` | dashboard "新会员" COUNT 阈值 | 否（裸字面量） |
| 5 | `fengyu-client/cloudfunctions/clientApi/routes/order.js:333` | `1990` | documentType 判定 fallback | 是 |
| 6 | `fengyu-client/cloudfunctions/payNotify/index.js:123` | `1990` | spending_tier CASE | 否 |
| 7 | `fengyu-client/cloudfunctions/payNotify/index.js:146` | `1990` | 支付回调后 customer_type 重算 fallback | 是 |
| 8 | `fengyu-client/cloudfunctions/cronTask/index.js:77,84` | `1990` | 会员等级 `determineMemberLevel(spend)` 初钻阈值 | 否 |
| 9 | `fengyu-admin/src/actions/orders.ts:534` | `1990` | documentType 判定 fallback | 是 |
| 10 | `fengyu-admin/src/actions/settings.ts:54` | `'1980'` | DEFAULT_SETTINGS.newMemberThreshold | 作为默认值 |
| 11 | `fengyu-admin/src/app/(main)/settings/_components/settings-page.tsx:117` | `1980` | Input placeholder 文案 | UI 提示 |
| 12 | `db/migrations/0023_document_type.sql:11` | `1990` | 历史回填 fallback（已执行，非热代码） | 读取 system_configs |

**关键数值不一致**：
- Admin 默认值写 `'1980'`；除它之外，所有云函数的 fallback 和 CASE 语句都用 `1990`。
- 若 `system_configs.new_member_threshold` 有值（已通过 admin 配置保存），代码里的 fallback 不会触发，但 `payNotify`、`staff.js:676`、`cronTask`、`staffApi/order.js:38` 是**完全未读取** `system_configs` 的裸字面量——运行时即使管理员改了后台配置，这几段仍按旧数字执行。

### 1.3 前端渲染层

**员工端 (fengyu-staff/miniprogram)**

| 位置 | 现状 |
|------|------|
| `pages/order-create/order-create.wxml` | orderType 4 选 1：`normal / experience / internal / promotion`；**没有**售前/售后录入，当前靠订单主表自动判定 |
| `pages/order-create/order-create.ts` | 默认 `orderType: 'normal'`，仅店长可切换到其他三种 |
| `pages/service/service.wxml:60` | 列表行显示徽章 `<text class="item-tag item-tag--{{si.isPresale ? 'presale' : 'postsale'}}">{{si.isPresale ? '售前' : '售后'}}</text>` |
| `packageService/service-detail/service-detail.wxml:35` | 详情页每行显示售前/售后徽章 |
| `packageService/service-detail/service-detail.ts:24` | Item 类型含 `isPresale: boolean` |

**管理后台 (fengyu-admin/src)**

| 位置 | 现状 |
|------|------|
| `app/(main)/services/_components/services-page.tsx:188` | 服务单列表按 `serviceOrder.serviceOrderType === '售前'` 渲染徽章（**主表级**） |
| `app/(main)/services/_components/service-detail-page.tsx:51` | 详情页顶部徽章（主表级） |
| `app/(main)/services/_components/service-detail-page.tsx:101,115` | 同时又在明细 table 展示 `item.isPresale ? '售前' : '售后'`（**子项级**）——形式上主表与子项两套信号同时存在 |
| `app/(main)/orders/...` | 订单管理无任何售前/售后 UI（即 `documentType` 存了但未渲染） |
| `app/(main)/settings/_components/settings-page.tsx:112-120` | 已有"新会员消费门槛"Input 配置 UI |

**客户端 (fengyu-client/miniprogram)**
- 顾客端 `packageService/service-detail` 不展示售前/售后标签，只看状态和明细。无影响。

### 1.4 横切关注点

| 关注点 | 当前状态 |
|--------|---------|
| 权限 | 无新角色要求。售前/售后为信息展示字段，不涉及权限扩展 |
| 审计日志 | `logs-page.tsx:124` 已把 `newMemberThreshold` 映射为"新客阈值"，saveSettings 走 `logUpdate`。门槛修改可被审计 |
| FK / 唯一约束 | 新增 `sale_items.is_presale` 不破坏约束 |
| WorkFine 同步 | `sync-workfine.js` 不同步订单/服务单，无影响 |
| seed.ts | `fengyu-admin/src/db/seed.ts:260-263` 构造了 `serviceOrderType: '售后'`/`'售前'` 的种子数据，需同步调整 |
| 存量数据 | 生产环境目前无真实订单（上线前清空计划）。但测试/开发数据库已有数据，迁移需要回填 |

---

## 2. 期望行为

### 2.1 概念重定义

| 概念 | 现状承载层 | 目标承载层 | 备注 |
|------|-----------|-----------|------|
| 订单"售前/售后" | `sale_orders.document_type` | `sale_orders.document_type`（保留，仍作整单快照） + `sale_items.document_type`（新增，开单时从主表继承） | 主表的值在开单时机就已经确定，子项只是复制一份；退款/转换子项按 `ref_sale_item_id` 继承原值 |
| 服务单"类型" | `service_orders.service_order_type = 售前/售后` | `service_orders.service_order_type = 普通/体验`（回滚到 migration 0024 之前的含义） | 由会议 §6.2 明确：保留"普通"和"体验"对应体验卡等业务 |
| 服务明细"售前/售后" | `service_items.is_presale`（字段存在但硬编码 false） | `service_items.is_presale` 或改为 `document_type`，写入时从对应的 `sale_items.document_type` 继承 | 子项级真实值，同一张服务单可以混合售前/售后 |
| 会员门槛 `1980` | 多处硬编码 `1980`/`1990` | 所有代码路径从 `system_configs.new_member_threshold` 读取，单一事实源 | 修正数字不一致问题（定下一个统一数字） |
| 经营周期 | 各处 `date_trunc('month')` + `new Date(year, month, 1)` 自然月 | 固化为自然月，在 spec 中写明 | 无代码大动作；只需 spec 补一句，顺便重命名变量/注释 |

### 2.2 用户故事层

1. **店长开单**
   - 不需要手动选择售前/售后
   - 系统按顾客类型 + 订单金额 × `system_configs.new_member_threshold` 算出 `document_type`，同时落到 `sale_orders.document_type` 和每条 `sale_items.document_type`
   - 对于"内部单""组合套餐"这类特殊类型，`document_type` 允许为 null 或按规则处理（待澄清）

2. **美容师创建服务单**
   - 点选 `sale_item`，服务明细行自动拿到 `sale_items.document_type`（= isPresale true/false 或直接存 '售前'/'售后'）
   - 服务单主表类型由店长选择（`普通` 或 `体验`），**不再与顾客类型挂钩**
   - 同一张服务单可以同时包含售前和售后子项

3. **后台导出服务单明细**
   - 子项级 CSV 含列：`服务单号 | 顾客姓名 | 服务日期 | 商品名 | 规格 | 售前/售后 | 消耗金额 | 员工`
   - 服务单主表列表筛选仍按 `serviceOrderType`（普通/体验），但**明细导出时**可按 `service_items.is_presale` 分组汇总

4. **管理员修改会员门槛**
   - 在 `settings` 页面修改 `新会员消费门槛`，保存后**立即生效**
   - 所有云函数的 documentType 判定、消费档位 CASE、"新会员" 统计、member_level `初钻` 阈值都从 system_configs 读取
   - cronTask 夜间重算 member_level 时，读取 system_configs 的最新值

5. **经营周期**
   - 统一按**自然月**（1 号 00:00 到月末 23:59）
   - 看板、绩效、客流、客量、新会员都使用这一口径
   - 在 spec 中写明"凤御真实经营周期为 26-25 号，当前先按自然月实现，未来引入 business_period_start 配置项时再迁移"

---

## 3. 差异分析总表

| 维度 | 当前 | 期望 | 影响范围 |
|------|------|------|---------|
| `serviceOrderTypeEnum` 值 | `['售前', '售后']` | `['普通', '体验']` | **结构性变更**：db schema + migration + seed + types.ts + admin UI + cloudfunctions |
| `service_orders.service_order_type` 默认值 | `'售前'` | `'普通'` | db schema + 所有 INSERT 语句 |
| `sale_items` 新增 `document_type` 列 | 不存在 | `document_type` (enum, nullable) | **结构性变更**：db schema + migration + admin actions + cloudfunctions order.js + wx-change-propagation |
| `service_items.is_presale` 真实值 | 永远 false（硬编码） | 从 `sale_items.document_type` 派生或直接读取 | **逻辑变更**：staffApi service.js create / admin services.ts createServiceOrder |
| 订单开单流程 | 主表算一次 documentType | 主表算 + 子项复制 documentType | **逻辑变更**：3 个 order.js/orders.ts 的 create |
| 服务单主表类型判定 | 按顾客 customer_type | 用户显式选择（UI 新增 radio） | **逻辑变更** + **前端 UI**：staff 创建服务单页 + admin 创建服务单页 |
| 服务单列表/详情徽章 | 按 `serviceOrderType` 显示"售前/售后" | 主表徽章改显示"普通/体验"；售前/售后徽章仍在子项行展示（无变化） | **渲染层**：staff 前端 + admin 前端 |
| 服务单导出 | 待实现（未见导出代码） | 子项级明细导出，列含 `document_type` | **新增功能**（属会议整体的导出需求，本报告只约束字段） |
| 1980/1990 硬编码 | 10+ 处硬编码 | 全部改读 system_configs | **逻辑变更**：cronTask、payNotify、staffApi (order.js, staff.js)、clientApi (order.js)、admin orders.ts |
| 经营周期说明 | spec 未明确 | spec 固化为"自然月，未来可配" | **文档变更**：`.42cog/pm/*.pr.spec.md` + `.42cog/real.md` |

---

## 4. 修改计划（按执行顺序）

下方条目中标注 **[结构性]** 的必须走 `/wx-change-propagation`，**[逻辑]** 的由本技能直接指导。

### 阶段 A：数据库结构调整

#### A1 [结构性] 服务单类型枚举回滚

**文件**：
- `db/schema/enums.ts:33` — `serviceOrderTypeEnum` 值改回 `['普通', '体验']`
- `db/schema/service.ts:20` — `service_order_type` 默认值改为 `'普通'`
- 新增 `db/migrations/0035_service_order_type_rollback.sql`：
  1. `ALTER TYPE service_order_type ADD VALUE IF NOT EXISTS '普通';`
  2. `ALTER TYPE service_order_type ADD VALUE IF NOT EXISTS '体验';`
  3. 数据回填：`UPDATE service_orders SET service_order_type = '普通' WHERE service_order_type IN ('售前', '售后');`（按 issue-free 语义全部变"普通"，测试数据无实际体验卡场景）
  4. 用 `CREATE TYPE ... AS ENUM` + `ALTER COLUMN TYPE USING` 的惯用手法去掉 `'售前'`/`'售后'` 值并重建枚举
  5. `ALTER TABLE service_orders ALTER COLUMN service_order_type SET DEFAULT '普通';`

**受影响文件全扫描清单**（交 /wx-change-propagation）：
- `fengyu-admin/src/lib/types.ts:120` — `ServiceOrderType = '售前' | '售后'` → `'普通' | '体验'`
- `fengyu-admin/src/db/seed.ts:260-263` — 种子数据的 `serviceOrderType: '售后'`/`'售前'` 批量替换
- `fengyu-admin/src/app/(main)/services/_components/services-page.tsx:188` — 徽章条件与 className 对应的配色表；同时变更"售前/售后"徽章 → "普通/体验"徽章的文案
- `fengyu-admin/src/app/(main)/services/_components/service-detail-page.tsx:51` — 详情页主表徽章，同上
- `fengyu-admin/src/actions/services.ts:26,466,520` — 类型断言、serviceOrderType 推导逻辑全面修改
- `fengyu-staff/cloudfunctions/staffApi/routes/service.js:150-159` — 不再按顾客 customer_type 自动判定，改为 payload 入参或默认 `'普通'`
- `fengyu-client/cloudfunctions/clientApi/routes/service.js:27` — SELECT 会返回新值，类型定义更新（前端类型声明无影响，因是只读字段）
- `fengyu-admin/src/actions/services.test.ts` — 测试用例中涉及 `serviceOrderType` 的 mock/断言
- `.42cog/pm/backend.pr.spec.md:274` — 规范文档同步修正描述
- `.42cog/pm/staff.pr.spec.md` — 服务单类型枚举描述

#### A2 [结构性] sale_items 增加 document_type 列

**文件**：
- `db/schema/order.ts` `saleItems` 表定义，新增：
  ```ts
  documentType: documentTypeEnum('document_type'),
  ```
- 新增 `db/migrations/0036_sale_items_document_type.sql`：
  1. `ALTER TABLE sale_items ADD COLUMN document_type document_type;`
  2. 回填：`UPDATE sale_items si SET document_type = so.document_type FROM sale_orders so WHERE si.sale_order_id = so.sale_order_id;`
  3. 回填退款/转换子项：`UPDATE sale_items si SET document_type = ref.document_type FROM sale_items ref WHERE si.ref_sale_item_id = ref.sale_item_id AND si.document_type IS NULL;`

> 注：不使用 `business_type` 命名，保持与 `sale_orders.document_type` 同名，方便 ORM/代码复用类型定义。

**受影响文件全扫描清单**：
- `fengyu-admin/src/lib/types.ts:249` — `SaleItem` interface 增加 `documentType: DocumentType | null`
- `fengyu-admin/src/actions/orders.ts` — create/list/detail 查询处映射新列；`create` 事务里把主表算出的 documentType 同时写到每个子项 INSERT
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js` create (~第 442 行 INSERT sale_items)：新增 `document_type` 列
- `fengyu-client/cloudfunctions/clientApi/routes/order.js` create：同上
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js` createRefund / createRepayment / createConversion：为 `refund_out`/`convert_out` 类型的子项从原 `sale_items.document_type` 继承
- Admin 订单详情 UI (`app/(main)/orders/...`)：是否展示该列（按会议要求"导出包含子项售前/售后" — 至少在 order-detail 页的子项 table 增加"售前/售后"列）

#### A3 [结构性（小）] service_items 字段与 sale_items 对齐

两种方案选一：

- **方案 B1**（推荐，改动最小）：保留 `service_items.is_presale` 字段，写入时从 `sale_items.document_type === '售前'` 派生。不需要新迁移。
- **方案 B2**：新增 `service_items.document_type`，与 `sale_items.document_type` 同步，并标记 `is_presale` 为 deprecated 或直接删除。

本报告推荐 **B1**，因为前端已经有 `isPresale` 类型/UI，改动最小；代价是"售前/售后"不是 null-safe（即使 document_type 为 null 的子项也会被误归为 "售后"）。

若走 B1：
- 不需新迁移
- 只改写入路径（见阶段 B1）

若走 B2：
- 新增 `db/migrations/0037_service_items_document_type.sql`
- 回填：`UPDATE service_items si SET document_type = sli.document_type FROM sale_items sli WHERE si.sale_item_id = sli.sale_item_id;`
- staff/admin/client 代码全面把 `is_presale` 迁移到 `document_type`（走 /wx-change-propagation）

### 阶段 B：后端逻辑修改

#### B1 [逻辑] 订单开单：把 documentType 下沉到子项

**文件与改动**：

1. `fengyu-staff/cloudfunctions/staffApi/routes/order.js` 的 `create` 函数
   - 第 362-381 行：计算 documentType 的逻辑保留（**基于 totalAmount 而非 saleAmount**，因为目前判定是按整单）
   - 第 442-449 行 INSERT sale_items：在列清单和 VALUES 中加入 `document_type`，值为上面算出的 `documentType`
   - 新增考虑：**如果未来需要子项级独立判定**（例如同一单混合自费 + 刷卡），可以预留钩子；当前阶段保持整单同一个值

2. `fengyu-client/cloudfunctions/clientApi/routes/order.js` 的 `create` 函数
   - 同上

3. `fengyu-admin/src/actions/orders.ts` 的 `createOrder` 函数
   - 第 516-538 行 documentType 计算保留
   - 事务内 `tx.insert(saleItems).values(...)` 处：每个子项对象增加 `documentType`

4. `fengyu-staff/cloudfunctions/staffApi/routes/order.js` 的 `createRefund` / `createRepayment` / `createConversion`
   - 为引用类型（`refund_out`/`convert_out`/`convert_in`/`repayment_in`）的子项，从原 sale_item 的 document_type 继承（查 `ref_sale_item_id` → 原行）

5. 各处 `SELECT sale_items ...` 需要把 `document_type` 列读出来（list/detail/allocation 参考）

#### B2 [逻辑] 服务单创建：serviceOrderType 改为 payload 入参，is_presale 从 sale_items 派生

**`fengyu-staff/cloudfunctions/staffApi/routes/service.js`**

第 150-159 行（服务单主表类型判定）：
```js
// 旧：根据 customer_type 自动判定
let serviceOrderType = '售前'
if (resolvedClientUserId) { ...会员客→售后... }

// 新：从 payload 读取，默认 '普通'
const serviceOrderType = payload.serviceOrderType === '体验' ? '体验' : '普通'
// 校验：'体验' 仅在所有 sale_item 对应商品的 product_kind === '体验卡' 时允许（待业务确认）
```

第 200 行（is_presale 硬编码）：
```js
// 旧
const isPresale = false

// 新：从 sale_items.document_type 派生（SELECT 加 si.document_type）
const siRows = await client.query(
  `SELECT si.sku_id, si.unit_real_price, si.document_type
   FROM sale_items si
   WHERE si.sale_item_id = $1`,
  [item.saleItemId]
)
const isPresale = siRows.rows[0]?.document_type === '售前'
```

**`fengyu-admin/src/actions/services.ts`**

第 460-466 行（serviceOrderType 判定）：
```ts
// 旧：const serviceOrderType = customerRow?.customerType === '会员客' ? '售后' : '售前'
// 新：const serviceOrderType = data.serviceOrderType === '体验' ? '体验' : '普通'
```
同时 `createServiceOrder` 的入参接口增加 `serviceOrderType?: '普通' | '体验'`。

第 469-493 行（is_presale 硬编码 false）：
```ts
// 在 select 中加入 saleItems.documentType
.select({
  remainingSessions: saleItems.remainingSessions,
  unitRealPrice: saleItems.unitRealPrice,
  documentType: saleItems.documentType,  // 新
  saleOrderType: saleOrders.saleOrderType,
})

// snapshot push 时
saleItemSnapshots.push({
  saleItemId: item.saleItemId,
  unitRealPrice: saleItem.unitRealPrice,
  isPresale: saleItem.documentType === '售前',
})
```

#### B3 [逻辑] 会员门槛硬编码统一走 system_configs

为所有云函数增加一个小的 helper：

```js
// fengyu-staff/cloudfunctions/staffApi/utils/config.js (新文件)
const pg = require('../db/pg')
let _cachedThreshold = null
let _cacheAt = 0
const CACHE_TTL = 5 * 60 * 1000  // 5 分钟
async function getMemberThreshold() {
  const now = Date.now()
  if (_cachedThreshold !== null && now - _cacheAt < CACHE_TTL) return _cachedThreshold
  const rows = await pg.query("SELECT value FROM system_configs WHERE key = 'new_member_threshold'")
  _cachedThreshold = Number(rows[0]?.value) || 1980
  _cacheAt = now
  return _cachedThreshold
}
module.exports = { getMemberThreshold }
```

在 clientApi 和 cronTask 做等效实现（若不便跨云函数共享工具，各自复制一份）。

**修改点清单**：

| 文件 | 行号 | 改动 |
|------|------|------|
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 38 | `1990` 改为 `>= ${threshold}`，threshold 由 getMemberThreshold() 提前取 |
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 72, 377 | fallback `1990` → `1980`（与 admin 默认对齐） |
| `fengyu-staff/cloudfunctions/staffApi/routes/staff.js` | 676 | `o.total_amount >= 1980` → 参数化 `>= $N` 传入 threshold |
| `fengyu-staff/cloudfunctions/staffApi/routes/staff.js` | 659 | 注释 "1980 元" 改为 "配置阈值" |
| `fengyu-client/cloudfunctions/clientApi/routes/order.js` | 333 | fallback `1990` → `1980` |
| `fengyu-client/cloudfunctions/payNotify/index.js` | 123 | CASE 里的 `1990` 改为 `>= $1`，传入 threshold |
| `fengyu-client/cloudfunctions/payNotify/index.js` | 146 | fallback `1990` → `1980` |
| `fengyu-client/cloudfunctions/cronTask/index.js` | 77, 84 | `determineMemberLevel(spend, threshold)` 增加参数 |
| `fengyu-client/cloudfunctions/cronTask/index.js` | `refreshMemberLevels` | 在主流程开头读取一次 threshold 传入 |
| `fengyu-admin/src/actions/orders.ts` | 534 | fallback `1990` → `1980` |
| `fengyu-admin/src/app/(main)/settings/_components/settings-page.tsx` | 117 | placeholder 是否保留为 1980（保留，作为 UX 提示） |

**选一个权威数字**：建议统一为 **1980**，理由：
- `fengyu-admin/src/actions/settings.ts:54` 的默认值是 `'1980'`
- 会议纪要 20260304 明确说过"1980"
- admin UI placeholder 也写着 1980
- 只有代码里的 fallback 和 cronTask 的 CASE 是 1990（推测是早期误抄）

> ⚠️ 如果生产 DB 里 `system_configs.new_member_threshold = '1990'`，则统一到 1980 前需要由业务方确认；若未设置（用默认），修正后 new_member_threshold 统一为 1980。

#### B4 [逻辑] spending_tier CASE 的 1990 处理

`spending_tier` 档位枚举本身是 `['10W+', '6-10W', '3-6W', '1-3W', '1990-1W', '<1990']`（见 enums.ts:68），**枚举值里带着 1990**——这是字面量，不可随门槛变化。

所以 `spending_tier` CASE 的 `1990` 应与 `new_member_threshold` **解耦**：`spending_tier` 是对历史消费档位的分桶标签，它的 1990 分界点是固定的领域概念；`new_member_threshold` 是判定会员资格的动态门槛。

**结论**：
- `payNotify/index.js:123` 的 spending_tier CASE → **保留 1990**，不改
- `staffApi/order.js:38` 的 spending_tier CASE → **保留 1990**，不改
- 但代码需补注释说明"此 1990 为 spending_tier 枚举值定义，与 new_member_threshold 独立"

如果业务方要求 spending_tier 的分界点也随 new_member_threshold 变化，则需要改造为动态 CASE（把字符串枚举值改为 numeric 区间查表），工作量较大——**建议默认不动**，等业务方明确提出再做。

### 阶段 C：前端 UI 修改

#### C1 [渲染] 员工端服务单列表/详情

`fengyu-staff/miniprogram/pages/service/service.wxml` 与 `packageService/service-detail/service-detail.wxml`：

- 当前每行的 `item-tag--presale/postsale` 保留（子项级）
- 主表"服务类型"标签的显示文案从"售前/售后" → "普通/体验"（如有）
- 检查 `packageService/service-detail/service-detail.ts:24` 的 Item 类型是否需要新增字段（当前只有 `isPresale`，保留）

#### C2 [渲染/交互] 员工端服务单创建页（如存在）

- `fengyu-staff/miniprogram/packageService/service-create/` 若要让店长选 "普通/体验"，需要新增 radio/picker；若业务决定自动按商品类型判定（体验卡→体验，其他→普通），则维持自动
- **需澄清**：谁决定 serviceOrderType？（店长选 vs 按商品 product_kind 自动）

建议先走"自动按商品判定"路线：
```
所有服务明细对应的 sale_item 的 sku → 查 product 的 product_kind
若所有 product_kind === '体验卡' → '体验'
否则 → '普通'
```
这样不需要新增 UI 元素。

#### C3 [渲染] 员工端开单页

- `fengyu-staff/miniprogram/pages/order-create/order-create.wxml/ts`
- orderType `experience` 未来对应"体验单"，与 sale_items 的 document_type 正交（`experience` orderType 的商品可能是售前也可能是售后，按门槛走）
- 保持 orderType 4 选 1 不变
- 不需要新增售前/售后录入 UI（由系统计算）

#### C4 [渲染] 管理后台服务单页

`fengyu-admin/src/app/(main)/services/_components/services-page.tsx:188`：
- 主表徽章"售前/售后" → "普通/体验"
- 配色表映射调整

`fengyu-admin/src/app/(main)/services/_components/service-detail-page.tsx`：
- 第 51 行顶部徽章同上
- 第 101, 115 行明细 table 中子项徽章保持不变（它已经在读 `item.isPresale`，读源变了但 UI 不变）

#### C5 [渲染] 管理后台订单详情页

- `fengyu-admin/src/app/(main)/orders/_components/order-detail-page.tsx`（需定位）
- 在子项 table 增加"售前/售后"列
- 列表页可以加一个按 `documentType` 筛选的 URL 参数

#### C6 [渲染] 管理后台服务单导出

- 会议要求导出按子项明细，每行含售前/售后
- 新增导出 Server Action（若未实现）：SELECT service_items JOIN sale_items，导出列含 `document_type`
- 该功能属于"数据导出"整体需求，本报告只约束字段

### 阶段 D：测试与 seed 修复

#### D1 seed.ts 更新
`fengyu-admin/src/db/seed.ts:260-263`：
- `serviceOrderType: '售后' as const` → `'普通' as const`
- 对应的 service_items seed 如果存在应同时设置 `is_presale` 的真实值（或让其从 sale_items 派生，数据库层不需要 seed 写入）

#### D2 单元测试
- `fengyu-admin/src/actions/services.test.ts` — 服务单相关 mock 中 `serviceOrderType` 值全面替换
- `fengyu-admin/src/actions/settings.test.ts` — 新增测试：默认值确为 '1980'、保存后读回一致
- `fengyu-admin/src/actions/orders.test.ts` — 开单后断言 `sale_items[i].documentType` 被写入
- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/service.test.js` — is_presale 从 sale_items.document_type 派生的用例（预期 sale_items.document_type = '售前' → is_presale true）
- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/order.test.js` — documentType 写入 sale_items 的回归测试

#### D3 E2E
- Playwright `e2e/services.spec.ts`（如存在）更新徽章文案断言
- 管理后台 settings 页面 E2E 校验"1980 → 保存 → 看板统计读到新值"链路

### 阶段 E：规范文档同步

| 文件 | 修改点 |
|------|--------|
| `.42cog/pm/backend.pr.spec.md:274` | `service_order_type` 描述改为：`普通 / 体验`（对应体验卡业务），不再由 customer_type 判定；新增条目 `sale_items.document_type` |
| `.42cog/pm/staff.pr.spec.md:312` | 新会员门槛"1980"改为"由 system_configs.new_member_threshold 配置，默认 1980" |
| `.42cog/pm/admin.pr.spec.md:232` | 已有"新会员消费门槛"配置项描述，无需改 |
| `.42cog/design/admin.ui.spec.md:825` | 已有 Input 描述，无需改 |
| `.42cog/pm/*.pr.spec.md` 中关于经营周期的描述 | 新增段落："凤御真实经营周期为每月 26 号至次月 25 号；当前系统按自然月实现；未来如需支持自定义周期，通过新增 `system_configs.business_period_start_day` 配置" |
| `.42cog/real.md` | 新增约束："售前/售后是订单子项级属性，随订单创建时机快照写入 `sale_items.document_type`，服务明细从 `sale_items` 继承" |

---

## 5. 结构性变更交接清单（→ /wx-change-propagation）

汇总需要走 wx-change-propagation 10 层传播图的条目：

### 交接 1：枚举值变更 `service_order_type`
- 类型：枚举值重命名 + 语义变更
- 从：`['售前', '售后']`
- 到：`['普通', '体验']`
- 涉及层级：L0 DB schema → L1 migration → L2 drizzle types → L3 admin lib/types → L4 admin actions → L5 admin UI → L6 staffApi routes → L7 clientApi routes → L8 staff 前端 → L9 tests → L10 spec docs

### 交接 2：字段新增 `sale_items.document_type`
- 类型：列新增 + 回填
- 涉及层级：L0 schema → L1 migration → L2 types → L3 三端 INSERT/SELECT → L4 UI 展示 + 导出列 → L5 tests

### 交接 3（可选 B2）：字段替换 `service_items.is_presale → document_type`
- 若选择 B1 方案则跳过此项

---

## 6. 风险点

### 6.1 枚举值回滚的 PG 限制
`ALTER TYPE` **不支持直接删除枚举值**。migration 0035 需要：
1. 先新建同名临时类型 `service_order_type_new AS ENUM ('普通','体验')`
2. `ALTER TABLE service_orders ALTER COLUMN service_order_type TYPE service_order_type_new USING (CASE WHEN service_order_type = '售前' THEN '普通' ELSE '普通' END)::service_order_type_new`
3. `DROP TYPE service_order_type; ALTER TYPE service_order_type_new RENAME TO service_order_type;`

**缓解**：遵循 migration 0030 (`0030_split_sale_order_type.sql`) 的惯用手法——该迁移已经处理过类似的 sale_order_type 枚举切换，可直接复用其 SQL 模板。

### 6.2 "体验"单判定歧义
会议 §6.2 说"保留普通和体验两种类型，对应体验卡等业务场景"，但未明确：
- 服务单类型由谁输入（店长手选 vs 按商品 product_kind 自动推断）
- 一张服务单如果混合了体验卡和正常疗程卡，类型应为哪一个？

**建议**：按"如果所有子项对应 SKU 的 product_kind === '体验卡' 则类型为'体验'，否则为'普通'"自动判定，并在 UI 禁用选择；若业务方有异议再改为手选。

### 6.3 1980 vs 1990 的生产数据影响
生产环境 `system_configs.new_member_threshold` 当前实际值未知。如果管理员历史上设为了 1990，而我们把 fallback 改为 1980，不会影响实际行为（system_configs 有值时不触发 fallback）。但**需要一次性校对**：

```sql
SELECT value FROM system_configs WHERE key = 'new_member_threshold';
```

若返回空或 1990，需要人工确认后写入 1980。

### 6.4 回款/转换子项继承 document_type
退款/转换子项通过 `ref_sale_item_id` 引用原购买行。migration 0036 的回填需要正确处理引用链：
- 第一次 UPDATE：从 sale_orders 继承给"购买"方向的子项
- 第二次 UPDATE：从 `ref_sale_item_id` 原行继承给 refund_out / convert_out 子项

### 6.5 service_items 历史数据
现有 service_items 的 `is_presale` 全部是 false（因为写入路径硬编码了 false）。
- 如果选方案 B1（派生读取），需要考虑是否要回填一次：`UPDATE service_items si SET is_presale = (CASE WHEN sli.document_type = '售前' THEN true ELSE false END) FROM sale_items sli WHERE si.sale_item_id = sli.sale_item_id;`
- 回填前提是 sale_items.document_type 已经回填完成（阶段 A2 之后）
- 由于项目还在开发期（`feedback_no_legacy_compat`），可选择**不回填** service_items，只保证增量数据正确

### 6.6 经营周期未来可配置化
当前决定按自然月实现，未来可能改为 26-25 号。为避免未来大面积重改：
- 所有"本月"相关的 SQL 尽量使用 named parameter `$startDate, $endDate`，不要写 `DATE_TRUNC('month', NOW())` 硬编码
- 前端计算 startDate/endDate 的逻辑集中在一个 utils 函数（`miniprogram/utils/calendar.ts` 或类似）
- 未来改配置化时只需修改一个 helper

**当前状态**：staff/dashboard/staff-performance 已经在前端算 startDate/endDate 后传给 API（符合这个模式）。**calc-monthly-activity.js** 的 SQL 用了 `date_trunc('month')` 裸字面量，未来改造时需替换为参数化。

### 6.7 枚举回滚会破坏部分已有数据
`serviceOrderTypeEnum` 中现有 `'售前'`、`'售后'` 的数据（测试/开发库）需要统一归为 `'普通'`。这会丢失原有售前/售后信息——但由于服务单主表原本就不是合适的承载层（一张单可能混合），这信息在新模型下本就不应该存在主表。

### 6.8 `.42cog/pm/backend.pr.spec.md` 中对 sale_order_type 的描述已是 v2.1.0
v2.1.0 精简了 sale_order_type 到 5 值（`['销售单','内部单','回款单','转换单','退款单']`），与本次变更**无冲突**，但需要一并确认 document_type 的字段描述同步更新到 spec。

---

## 7. 执行顺序建议

按依赖关系：

1. **阶段 A1 + A2 同批次** 作为一个 worktree：`feat/service-type-rollback-and-doctype`
   - 执行：`scripts/worktree-setup.sh feat/service-type-rollback-and-doctype`
   - 在 worktree 内先执行 wx-change-propagation（交接清单 1, 2）
   - 生成 migration 0035, 0036
   - 跑 `bun run db:migrate` 验证无报错
   - 跑 `bun run test` 验证所有引用 serviceOrderType/isPresale 的 test 都过

2. **阶段 B3**（1980 硬编码统一）可与 A 并行，放入单独 worktree：`fix/member-threshold-unify`
   - 不依赖 schema 变更
   - 对 cronTask 的改动需要单独走云函数部署

3. **阶段 B1 + B2** 依赖 A 完成，在 A 之后
4. **阶段 C**（前端 UI）依赖 B 完成
5. **阶段 D**（测试）与 B/C 并行，持续补充
6. **阶段 E**（文档）最后批量提交

---

## 8. 需要澄清的问题（建议同步业务方）

| # | 问题 | 建议默认答案 |
|---|------|-----------|
| Q1 | 服务单主表"普通/体验"由店长手选还是按商品 product_kind 自动判定？ | 自动：所有 sale_item 对应 SKU 的 product_kind === '体验卡' → '体验'，否则 '普通' |
| Q2 | 当前生产 `system_configs.new_member_threshold` 值是 1980 还是 1990？ | 统一为 1980（会议纪要明文） |
| Q3 | `spending_tier` 枚举的"1990-1W"分界点是否也要跟着 new_member_threshold 联动？ | 不联动，spending_tier 是固定分桶标签 |
| Q4 | 组合套餐 (orderType='promotion')、内部单 (orderType='internal') 的 document_type 如何算？ | 仍按整单 total_amount 对比门槛判定；内部单可以允许 null |
| Q5 | 服务单导出 Excel 的表头字段？ | 待张凯团队提供（会议 §8 待办） |
| Q6 | 经营周期自然月决定是暂时的还是永久的？未来是否需要 business_period_start_day 配置项？ | 暂时按自然月；留一个 placeholder 在 system_configs 中，未来真实启用时再迁移 |
| Q7 | `service_items.is_presale` 历史数据（全 false）是否需要回填？ | 不回填（开发阶段无历史兼容要求） |

---

## 9. 摘要

- **核心结构性变更**：
  - `service_order_type` 枚举回滚：`[售前,售后]` → `[普通,体验]`
  - 新增 `sale_items.document_type` 列，开单时主表 + 子项双写
  - 修正 `service_items.is_presale` 从硬编码 false 改为从 sale_items 派生
- **核心逻辑变更**：
  - 服务单主表类型不再按 customer_type 自动判定，改为按子项商品 product_kind 自动判定（或业务方确认后手选）
  - 10+ 处 1980/1990 硬编码统一改走 `system_configs.new_member_threshold`，默认 1980
- **经营周期**：固化为自然月实现，在 spec 补充未来可配置化钩子描述，无代码大动作
- **前端改动**：
  - staff + admin 的服务单徽章文案从"售前/售后"→"普通/体验"
  - 服务单子项级徽章仍显示"售前/售后"（数据源从硬编码变为真实）
  - admin 订单详情页子项 table 增加"售前/售后"列
- **配套**：seed.ts、测试、spec 文档联动更新

**总体估算**：3 个 worktree 并行，2 个迭代工时可完成（schema + 后端 1 迭代，前端 UI + 测试 + 文档 0.5 迭代，导出功能 0.5 迭代）。
