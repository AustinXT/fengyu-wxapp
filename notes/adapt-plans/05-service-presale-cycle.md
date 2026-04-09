# 差异报告：服务单售前/售后 + 经营周期/会员门槛配置化

> ⚠️ **本报告已被 [`00-decisions.md`](./00-decisions.md) 部分覆盖（2026-04-10）**
> - `service_order_type` **不回滚**，保留当前 `[售前, 售后]`
> - `sale_items.document_type` **不新增列**
> - 本报告第 12 行起的"修订说明（2026-04-10）"如涉及**新增** `client_wechat_users.became_member_at` 字段，也属结构性变更，需降级为"运行时派生"方案
> - `service_items.is_presale` TODO 就地修复（不删除列、改为从 `service_orders.service_order_type` 回填或按主表口径判断）
> - 1980/1990 硬编码收敛等待 Q9 生产库值确认后再执行

> 适配来源
> - `notes/meetings/meeting-20260324/article.md` §六 服务单
> - `notes/meetings/meeting-20260312/article.md` §五 经营周期
> 适配方法论：`.claude/skills/wx-requirement-adapt/SKILL.md` §3 + §4
> 生成时间：2026-04-09
> **最后修订：2026-04-10 — 方案大幅简化，详见下方"修订说明"**

---

## 修订说明（2026-04-10）

初稿方案试图通过新增 `sale_items.document_type` 列 + 回滚 `service_order_type` 枚举到 `[普通,体验]` 的组合来修复 bug。经业务复核后判断**过度设计**，现采用**简化方案**：

| 项 | 初稿方案 | 现方案 |
|---|---------|-------|
| `service_order_type` 枚举 | 回滚到 `['普通','体验']` | **保持** `['售前','售后']` |
| `sale_items.document_type` | 新增列 + 主表子项双写 | ❌ **取消** |
| `service_items.is_presale` | 派生写入 | ❌ **删除整列** |
| 判定承载层 | 订单子项级 | **服务单主表级** |
| 判定规则 | 按订单金额 × `customer_type` | 按**顾客会员身份时点** |
| 新增字段 | — | `client_wechat_users.became_member_at` |

**核心规则**：顾客成为会员**之前**创建的服务单 = 售前；**之后**创建的 = 售后；严格时间戳比较（同一天成为会员，当天之后的新服务单即售后）。`service_order_type` 在服务单创建时一次性快照。

---

## 0. 需求分解

| 要素 | 说明 |
|------|------|
| **变更概念 A** | 服务单售前/售后的承载层从"子项 + 主表双写"收敛为**主表单点快照** |
| **变更概念 B** | 删除 `service_items.is_presale` 列及其所有写入/查询/UI 引用 |
| **变更概念 C** | 判定规则变更：不再按 `customer_type` 或订单金额，改按"顾客是否已成为会员"（基于新增 `became_member_at` 时间戳） |
| **变更概念 D** | 经营周期先按自然月实现（这条已经隐式落地，需固化） |
| **变更概念 E** | 会员门槛 1980/1990 硬编码全部改走 `system_configs.new_member_threshold` |
| **受影响角色** | 美容师（服务单列表/详情徽章展示）、后台数据分析、开发维护 |
| **受影响端** | db / staffApi / clientApi / payNotify / fengyu-admin / fengyu-staff 前端 |

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
- `saleItems` 表**没有** `business_type` / `is_presale` / `document_type` 字段（本方案**不再新增**）

**`db/schema/service.ts`**
- `serviceOrders.serviceOrderType` (第 20 行)：服务单主表级，默认 `'售前'`
- `serviceItems.isPresale` (第 62 行)：**子项级布尔字段已经存在**，注释说"`sale_orders.sale_order_type = '体验' → true (售前), otherwise false`"——本方案要**删除**此列
- migration 0014 (`0014_service_items_is_presale.sql`) 是新字段 + 初始回填

**`db/schema/user.ts` — `client_wechat_users`（顾客表）**
- 第 16 行：PK 为 `userId`（`user_id`），格式 `FYGK-{YYYYMMDD}{序号}`
- 第 41 行：`customerType` 枚举 `[流量客/体验客/小美客/会员客]`，默认 `'流量客'`
- 第 36 行：`memberLevel` 枚举 `[初钻/星钻/粉钻/金钻/黑钻]`，nullable
- ⚠️ **当前没有任何"成为会员时间"字段**（grep `became_member_at` / `member_since` / `upgraded_at` 均无匹配）→ 本方案需新增

**`db/schema/system-config.ts`**
- 已存在 `system_configs` 键值对表。当前已写入的 key：`new_member_threshold`、`order_timeout`、`banner_images`、`fengyuguan_image`、`member_level_benefits`、`banner_count`
- 默认 `new_member_threshold = '1980'`（见 `fengyu-admin/src/actions/settings.ts:54`）

### 1.2 后端逻辑层

**服务单类型判定（服务单主表级）**

| 位置 | 行号 | 现有逻辑 |
|------|------|---------|
| `fengyu-staff/cloudfunctions/staffApi/routes/service.js` | 150-159 | 创建服务单时查顾客 `customer_type`，会员客→售后，其他→售前 |
| `fengyu-admin/src/actions/services.ts` | 460-466 | 同上 |

**服务明细 is_presale 写入（已"硬编码 false"）**

| 位置 | 行号 | 现有逻辑 |
|------|------|---------|
| `fengyu-staff/cloudfunctions/staffApi/routes/service.js` | 200 | `const isPresale = false // 体验单已合并为销售单，无法区分` |
| `fengyu-admin/src/actions/services.ts` | 491 | `isPresale: false, // TODO: 体验单已合并入销售单，需另行判断售前/售后` |

**🐛 Bug 细化描述**

| 属性 | 内容 |
|------|------|
| **类型** | 数据正确性 Bug（写入错误 → 前端展示系统性误导） |
| **严重度** | 中 — 不影响资金/权限/扣次，但"售前/售后"是服务单对账时的关键口径，当前整个列是**死数据** |
| **状态** | 已知缺陷，两处写入路径均保留 TODO 注释待修复 |

**错误行为**：`service_items.is_presale` 两个服务单创建入口（员工端云函数 + 管理后台 Server Action）**一律写 `false`**。上方的 SELECT（`service.js:191-197`、`services.ts:469-480`）虽然已经 JOIN 到了 `sale_orders`，但没有任何可靠字段能区分售前/售后，开发者只能挂 TODO 跳过判定。

**数据流及影响面**：

```
创建 → INSERT service_items (is_presale = false)        ← 写入端硬编码
  ↓
查询 → SELECT si.* (list / detail)                        ← 透传 false
  ↓
前端 → 三处 UI 按 isPresale 二值渲染徽章                   ← 一律显示"售后"
```

受影响的 UI 渲染位置（全部基于 `item.isPresale ? '售前' : '售后'`）：

| 渲染位置 | 行为 |
|---------|------|
| `fengyu-staff/miniprogram/pages/service/service.wxml:60` | 护理 Tab 服务单列表每行徽章 |
| `fengyu-staff/miniprogram/packageService/service-detail/service-detail.wxml:35` | 员工端服务单详情每条明细徽章 |
| `fengyu-admin/src/app/(main)/services/_components/service-detail-page.tsx:113-116` | 管理后台服务单详情表格"售前/售后"列（Badge 配色 `bg-[#E8F0FE] text-[#3574C4]`） |

**观察症状**：打开任意服务单，明细列的徽章**100% 显示"售后"**——不存在任何"售前"数据。

**引入时机与根因**：
- **migration 0014** 首次新增 `service_items.is_presale` 字段，原设计依赖 `sale_orders.sale_order_type === '体验'` 推断（schema 注释仍保留此说明，见 `db/schema/service.ts:62`）
- **migration 0028-0031** 精简 `sale_order_type` 枚举到 `[销售单/内部单/回款单/转换单/退款单]` 时删除了 `'体验'` 值 → 原推断条件彻底失效
- 开发者当时把写入路径改为 `false` 并挂 TODO（两端同步保留），此后再无人补齐

**根因**：**概念错位**——"售前/售后"本就是顾客维度的身份属性（顾客是否已是会员），应在**服务单创建时刻**以**主表级**快照登记，而不是在服务明细层或订单子项层反复推断。现方案删除 `service_items.is_presale` 列，仅在 `service_orders.service_order_type` 上做判定。

**修复路径**：
- **前置条件**：`client_wechat_users` 新增 `became_member_at` 列，并与 `recalcCustomerType` 联动写入
- **修复动作**：
  1. 删除 `service_items.is_presale` 列及两处写入/查询/前端引用（见阶段 A1 + C）
  2. 服务单创建时按"顾客 `became_member_at` ≤ NOW() ? '售后' : '售前'"判定 `service_order_type`（见阶段 B1）
- **验证锚点**：grep 两处 TODO 注释文本（`体验单已合并为销售单` / `体验单已合并入销售单`）确认已全部清除；全仓 grep `is_presale` / `isPresale` 应为零命中

**售前/售后判定（订单主表级）**

> 订单主表 `sale_orders.document_type` 的判定逻辑本次**不改**。以下表格仅作为盘点存档，与 1980/1990 硬编码清单关联，不在本次结构性变更范围内。

| 位置 | 行号 | 现有逻辑 |
|------|------|---------|
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 362-381 | 开单时根据 `customer_type === '会员客'` OR `totalAmount >= threshold` → documentType |
| `fengyu-client/cloudfunctions/clientApi/routes/order.js` | 316-335 | 同上（顾客端下单） |
| `fengyu-admin/src/actions/orders.ts` | 516-538 | 同上（admin 手工开单） |
| `db/migrations/0023_document_type.sql` | 8-34 | 历史回填 |

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
- Admin 默认值写 `'1980'`；除它之外，所有云函数的 fallback 和 CASE 语句都用 `1990`
- 若 `system_configs.new_member_threshold` 有值（已通过 admin 配置保存），代码里的 fallback 不会触发，但 `payNotify`、`staff.js:676`、`cronTask`、`staffApi/order.js:38` 是**完全未读取** `system_configs` 的裸字面量——运行时即使管理员改了后台配置，这几段仍按旧数字执行

### 1.3 前端渲染层

**员工端 (fengyu-staff/miniprogram)**

| 位置 | 现状 |
|------|------|
| `pages/order-create/order-create.wxml` | orderType 4 选 1：`normal / experience / internal / promotion`；**没有**售前/售后录入 |
| `pages/service/service.wxml:60` | 列表行显示子项徽章 `<text class="item-tag item-tag--{{si.isPresale ? 'presale' : 'postsale'}}">{{si.isPresale ? '售前' : '售后'}}</text>` |
| `packageService/service-detail/service-detail.wxml:35` | 详情页每行显示售前/售后徽章（子项级） |
| `packageService/service-detail/service-detail.ts:24` | Item 类型含 `isPresale: boolean` |

**管理后台 (fengyu-admin/src)**

| 位置 | 现状 |
|------|------|
| `app/(main)/services/_components/services-page.tsx:188` | 服务单列表按 `serviceOrder.serviceOrderType === '售前'` 渲染徽章（**主表级**，本次判定源变化但文案不变） |
| `app/(main)/services/_components/service-detail-page.tsx:51` | 详情页顶部徽章（主表级，同上） |
| `app/(main)/services/_components/service-detail-page.tsx:101,115` | 同时又在明细 table 展示 `item.isPresale ? '售前' : '售后'`（**子项级**）——本方案**删除**此列 |
| `app/(main)/orders/...` | 订单管理无任何售前/售后 UI（即 `documentType` 存了但未渲染） |
| `app/(main)/settings/_components/settings-page.tsx:112-120` | 已有"新会员消费门槛"Input 配置 UI |

**客户端 (fengyu-client/miniprogram)**
- 顾客端 `packageService/service-detail` 不展示售前/售后标签，只看状态和明细。无影响。

### 1.4 横切关注点

| 关注点 | 当前状态 |
|--------|---------|
| 权限 | 无新角色要求。售前/售后为信息展示字段，不涉及权限扩展 |
| 审计日志 | `logs-page.tsx:124` 已把 `newMemberThreshold` 映射为"新客阈值"，saveSettings 走 `logUpdate`。门槛修改可被审计 |
| FK / 唯一约束 | 删除 `service_items.is_presale` 不破坏约束；新增 `client_wechat_users.became_member_at` 不破坏约束 |
| WorkFine 同步 | `sync-workfine.js` 不同步订单/服务单，无影响；同步顾客时不会覆盖 `became_member_at`（该字段由 payNotify/order.create 写入） |
| seed.ts | `fengyu-admin/src/db/seed.ts:260-263` 构造了 `serviceOrderType: '售后'`/`'售前'` 的种子数据，**无需改动枚举**，但需配合新规则构造顾客的 `became_member_at` |
| 存量数据 | 开发期无需回填历史服务单（见 §8 Q3） |

---

## 2. 期望行为

### 2.1 概念重定义

| 概念 | 现状承载层 | 目标承载层 | 备注 |
|------|-----------|-----------|------|
| 服务单"售前/售后" | `service_orders.service_order_type`（按 `customer_type` 派生） + `service_items.is_presale`（硬编码 false） | `service_orders.service_order_type`（按 `became_member_at` 快照判定）**单点承载** | 删除 `service_items.is_presale` |
| 顾客"成为会员时间" | 无字段 | `client_wechat_users.became_member_at` (timestamptz, nullable) | 由 `recalcCustomerType` 在 `customer_type` 跃迁为 `会员客` 时写入 `NOW()` |
| 订单"售前/售后" | `sale_orders.document_type`（保留现状） | **不变** | 与服务单售前/售后语义独立，初稿方案曾计划"下沉到子项"现作废 |
| 会员门槛 `1980` | 多处硬编码 `1980`/`1990` | 所有代码路径从 `system_configs.new_member_threshold` 读取，单一事实源 | 修正数字不一致问题 |
| 经营周期 | 各处 `date_trunc('month')` + `new Date(year, month, 1)` 自然月 | 固化为自然月，在 spec 中写明 | 无代码大动作；只需 spec 补一句 |

### 2.2 用户故事层

1. **顾客首次达到会员门槛**
   - 顾客支付订单后触发 `recalcCustomerType`：若累计消费 ≥ `new_member_threshold` → `customer_type` 从非会员客升为 `会员客`
   - 同一事务内 `UPDATE client_wechat_users SET became_member_at = NOW() WHERE user_id = $1 AND became_member_at IS NULL`
   - 此时顾客成为会员的瞬间被精确记录（timestamptz 精度）

2. **美容师创建服务单**
   - 系统查询顾客 `became_member_at`：若 `became_member_at IS NOT NULL AND became_member_at <= NOW()` → `service_order_type = '售后'`；否则 `'售前'`
   - 判定结果在服务单创建事务内一次性写入 `service_orders.service_order_type`，**不再可变**
   - 同一顾客、同一天内跨越会员门槛：跨越前创建的服务单是 `售前`，跨越后创建的是 `售后`

3. **美容师查看服务单列表/详情**
   - 列表页每行显示主表徽章 `售前` / `售后`（现有逻辑数据源变化，UI 无需改动）
   - 详情页每条明细**不再**显示售前/售后徽章（与主表一致，子项无独立语义）

4. **管理员查看顾客档案**
   - 顾客档案详情页展示"成为会员时间"字段（只读展示，不提供编辑入口）
   - 若 `became_member_at IS NULL` 显示"—"

5. **管理员修改会员门槛**
   - 在 `settings` 页面修改 `新会员消费门槛`，保存后**立即生效**
   - 所有云函数的 documentType 判定、消费档位 CASE、"新会员" 统计、member_level `初钻` 阈值都从 system_configs 读取
   - cronTask 夜间重算 member_level 时，读取 system_configs 的最新值

6. **经营周期**
   - 统一按**自然月**（1 号 00:00 到月末 23:59）
   - 看板、绩效、客流、客量、新会员都使用这一口径
   - 在 spec 中写明"凤御真实经营周期为 26-25 号，当前先按自然月实现，未来引入 business_period_start 配置项时再迁移"

### 2.3 关键业务规则

**规则 R1 — 服务单类型判定**

```
serviceOrderType = (customer.became_member_at IS NOT NULL
                    AND customer.became_member_at <= service_order.created_at)
                   ? '售后'
                   : '售前'
```

**规则 R2 — 快照语义**

`service_order_type` 在服务单创建时**一次性确定**，此后顾客会员状态任何变化（升降级）均**不回写**历史服务单。

**规则 R3 — became_member_at 写入时机**

在 `recalcCustomerType` 判定 `customer_type` 即将从非会员客升为 `会员客` 的事务路径上，同步 `UPDATE ... SET became_member_at = NOW() WHERE user_id = $1 AND became_member_at IS NULL`。`COALESCE` 写法避免覆盖已有时间戳。

**规则 R4 — became_member_at 清空时机**

当顾客 `customer_type` 从 `会员客` 降级回非会员客时（退款导致累计消费跌破门槛），同步清空 `became_member_at = NULL`。此时新创建的服务单重新判为 `售前`，但**已创建的历史服务单快照不变**。

> ⚠️ 当前 `recalcCustomerType` 在 `fengyu-staff/cloudfunctions/staffApi/routes/order.js:67` **只升不降**（检测到已是会员客即 early return）。本方案需要**新增降级路径**：在 refund/conversion 退款后若累计消费跌破门槛，显式降级并清空 `became_member_at`。降级逻辑为本次变更新增的保护性代码，当前为"休眠状态"触发点极少，但必须落地以保持语义正确性。

**规则 R5 — 无订单关联的顾客**

从未消费或 `became_member_at IS NULL` 的顾客，其所有服务单一律判为 `售前`。

**规则 R6 — became_member_at 只读**

管理员后台顾客档案**仅展示**该字段，**不提供编辑入口**（避免人工篡改导致服务单快照与实际成为会员时点不一致）。

---

## 3. 差异分析总表

| 维度 | 当前 | 期望 | 影响范围 |
|------|------|------|---------|
| `client_wechat_users.became_member_at` | 不存在 | 新增 `timestamptz` nullable 列 | **结构性变更**：db schema + migration + seed + types.ts |
| `service_items.is_presale` | 存在但硬编码 false | **删除整列** | **结构性变更**：db schema + migration + 两端写入/查询 + 两处前端徽章 |
| `service_order_type` 枚举 | `['售前','售后']` | **保持不变** | 无 |
| `service_orders.service_order_type` 判定逻辑 | 按 `customer_type === '会员客'` | 按 `became_member_at <= NOW()` | **逻辑变更**：staffApi service.js / admin services.ts |
| `recalcCustomerType` 写入路径 | 仅更新 `customer_type`，且只升不降 | 增升降级时同步写/清 `became_member_at` | **逻辑变更**：staffApi order.js（含 refund/conversion 路径）、clientApi/payNotify 同步点 |
| 服务单明细徽章 UI | staff 列表/详情 + admin 详情显示 `isPresale ? '售前' : '售后'` | **删除所有明细徽章**（主表徽章保留） | **渲染层**：staff WXML/TS + admin TSX + 类型定义 |
| 订单 `sale_orders.document_type` | 按订单金额+ `customer_type` 判定 | **不变**（本方案与订单 documentType 解耦） | 无 |
| 1980/1990 硬编码 | 10+ 处硬编码 | 全部改读 system_configs | **逻辑变更**：cronTask、payNotify、staffApi (order.js, staff.js)、clientApi (order.js)、admin orders.ts |
| 经营周期说明 | spec 未明确 | spec 固化为"自然月，未来可配" | **文档变更**：`.42cog/pm/*.pr.spec.md` + `.42cog/real.md` |

---

## 4. 修改计划（按执行顺序）

下方条目中标注 **[结构性]** 的必须走 `/wx-change-propagation`，**[逻辑]** 的由本技能直接指导。

### 阶段 A：数据库结构调整

#### A1 [结构性] `client_wechat_users` 新增 `became_member_at` 列

**文件**：
- `db/schema/user.ts` `clientWechatUsers` 表定义，在 `customerType` 附近新增：
  ```ts
  /** 顾客首次成为会员客（customer_type = '会员客'）的时间戳。
   *  - 由 recalcCustomerType 在升级路径写入 NOW()
   *  - 由 recalcCustomerType 在降级路径清空为 NULL
   *  - 管理后台仅做只读展示，不提供编辑入口 */
  becameMemberAt: timestamp('became_member_at', { withTimezone: true }),
  ```
- 新增 `db/migrations/0035_client_became_member_at.sql`：
  ```sql
  ALTER TABLE client_wechat_users
    ADD COLUMN became_member_at TIMESTAMP WITH TIME ZONE;

  -- 对当前已是"会员客"的顾客，用一个保底值回填
  -- （开发期无精确时间可追溯，用 updated_at 作为近似）
  UPDATE client_wechat_users
     SET became_member_at = COALESCE(updated_at, created_at, NOW())
   WHERE customer_type = '会员客'
     AND became_member_at IS NULL;
  ```

> 回填精度说明：`updated_at` 在顾客类型跃迁时会被 `$onUpdate` 更新，可作为近似。若后续有更精确需求，可扫 `operation_logs` 中 `customer_type` 变更记录重算。

**受影响文件全扫描清单**（交 `/wx-change-propagation`）：
- `db/schema/user.ts` — 字段定义 + 注释
- `fengyu-admin/src/lib/types.ts` — `ClientWechatUser`/`Customer` 相关 interface 增加 `becameMemberAt: Date | null`
- `fengyu-admin/src/db/seed.ts` — 顾客种子数据构造 `becameMemberAt`（针对 `customerType = '会员客'` 的记录）
- `fengyu-admin/src/actions/customers.ts` — list/detail SELECT 增加映射；管理后台只读展示
- `fengyu-admin/src/app/(main)/customers/_components/customer-detail-page.tsx` — 详情页顶部/档案区增加"成为会员时间"展示
- `fengyu-staff/cloudfunctions/staffApi/routes/customer.js` — detail 返回字段透传（若 staff 端顾客详情需展示）
- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/customer.test.js` — mock 数据补字段

#### A2 [结构性] 删除 `service_items.is_presale` 列

**文件**：
- `db/schema/service.ts:62` 删除 `isPresale: boolean('is_presale').notNull().default(false)` 字段定义及注释
- 新增 `db/migrations/0036_drop_service_items_is_presale.sql`：
  ```sql
  ALTER TABLE service_items DROP COLUMN IF EXISTS is_presale;
  ```

**受影响文件全扫描清单**（交 `/wx-change-propagation`）：
- `db/schema/service.ts` — 字段声明
- `fengyu-admin/src/lib/types.ts` — `ServiceItem` interface 删除 `isPresale: boolean`
- `fengyu-admin/src/db/seed.ts` — 若有 service_items seed，删除 `isPresale` 字段
- `fengyu-admin/src/actions/services.ts` — createServiceOrder（第 469-493 行的 saleItemSnapshots）、list、getServiceOrder 等 SELECT 全部移除 `isPresale` 列
- `fengyu-admin/src/app/(main)/services/_components/service-detail-page.tsx:101,113-116` — 表头"售前/售后"列 + 单元格 Badge 删除；表格列数 -1
- `fengyu-staff/cloudfunctions/staffApi/routes/service.js` — create（第 190-218 行 SELECT + 变量 + INSERT 列清单）、list、detail 全部去除 `is_presale`
- `fengyu-staff/miniprogram/pages/service/service.wxml:60` — 删除 `item-tag--presale/postsale` 徽章元素
- `fengyu-staff/miniprogram/pages/service/service.ts` — Item 类型若含 `isPresale` 字段同步删除
- `fengyu-staff/miniprogram/packageService/service-detail/service-detail.wxml:35` — 删除每行徽章
- `fengyu-staff/miniprogram/packageService/service-detail/service-detail.ts:24` — Item 类型删除 `isPresale: boolean`
- `fengyu-client/cloudfunctions/clientApi/routes/service.js`（若存在）— 去除 `is_presale` 列引用
- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/service.test.js` — mock/断言清理
- `fengyu-admin/src/actions/services.test.ts` — 同上
- `.42cog/pm/backend.pr.spec.md` — 服务明细字段描述更新

### 阶段 B：后端逻辑修改

#### B1 [逻辑] 服务单创建：按 `became_member_at` 判定 `service_order_type`

**`fengyu-staff/cloudfunctions/staffApi/routes/service.js`**

替换第 150-159 行的 customer_type 判定逻辑：

```js
// 旧：
// let serviceOrderType = '售前'
// if (resolvedClientUserId) {
//   const { rows } = await client.query(
//     'SELECT customer_type FROM client_wechat_users WHERE user_id = $1',
//     [resolvedClientUserId]
//   )
//   if (rows[0]?.customer_type === '会员客') serviceOrderType = '售后'
// }

// 新：按 became_member_at 快照判定
let serviceOrderType = '售前'
if (resolvedClientUserId) {
  const { rows } = await client.query(
    'SELECT became_member_at FROM client_wechat_users WHERE user_id = $1',
    [resolvedClientUserId]
  )
  const bma = rows[0]?.became_member_at
  if (bma && new Date(bma) <= new Date()) {
    serviceOrderType = '售后'
  }
}
```

同时删除第 190-218 行 INSERT service_items 逻辑里所有 `is_presale` 相关代码（SELECT 列、`isPresale` 变量、INSERT 列清单与 VALUES 占位）。

**`fengyu-admin/src/actions/services.ts`**

替换第 460-466 行的判定逻辑：

```ts
// 旧：
// const serviceOrderType: ServiceOrderType =
//   customerRow?.customerType === '会员客' ? '售后' : '售前'

// 新：
const [customerRow] = await db
  .select({
    becameMemberAt: clientWechatUsers.becameMemberAt,
  })
  .from(clientWechatUsers)
  .where(eq(clientWechatUsers.userId, data.clientUserId))
  .limit(1)

const serviceOrderType: ServiceOrderType =
  customerRow?.becameMemberAt && customerRow.becameMemberAt <= new Date()
    ? '售后'
    : '售前'
```

删除第 488-492 行 `saleItemSnapshots.push({ ..., isPresale: false })` 中的 `isPresale` 字段；删除事务内 `tx.insert(serviceItems).values(...)` 对 `isPresale` 的映射。

#### B2 [逻辑] `recalcCustomerType` 升降级时同步维护 `became_member_at`

**升级路径（写入 `NOW()`）**

涉及文件：
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js:59-100`（`recalcCustomerType` 函数体）
- `fengyu-client/cloudfunctions/payNotify/index.js`（支付回调后调用或内联的 recalc 逻辑）
- `fengyu-staff/cloudfunctions/staffApi/routes/customer.js`（若有独立升级路径）

在 `UPDATE client_wechat_users SET customer_type = '会员客' ...` 语句中同步写入：

```sql
UPDATE client_wechat_users
   SET customer_type = '会员客',
       became_member_at = COALESCE(became_member_at, NOW())
 WHERE user_id = $1
   AND customer_type <> '会员客'
```

`COALESCE(became_member_at, NOW())` 保证**首次入会时间只写一次**，即使在降级再升级的场景下也只记录"当前这一段会员期"的起点（见下方降级清空逻辑后重新开始新一段）。

> 决策说明：此处保留 `COALESCE` 看似冗余（因降级会清空），但：
> 1. 若降级路径未运行（部署顺序错位）不会污染历史
> 2. 并发场景下避免两次 UPDATE 互相覆盖
> 3. 语义上显式"若无则写"更清晰

**降级路径（清空为 `NULL`）**

当前 `recalcCustomerType` 在 `order.js:67` 一句 `if (cur.rows[0]?.customer_type === '会员客') return` **只升不降**。本方案需要新增降级分支：

```js
async function recalcCustomerType(client, clientUserId) {
  if (!clientUserId) return

  const cur = await client.query(
    'SELECT customer_type FROM client_wechat_users WHERE user_id = $1',
    [clientUserId]
  )
  const currentType = cur.rows[0]?.customer_type
  const threshold = await getMemberThreshold(client)  // 见 B3

  // 计算累计消费
  const { rows: [{ total }] } = await client.query(
    `SELECT COALESCE(SUM(total_amount), 0) AS total
       FROM sale_orders
      WHERE client_user_id = $1
        AND status = '已支付'`,
    [clientUserId]
  )

  const shouldBeMember = Number(total) >= threshold

  if (shouldBeMember && currentType !== '会员客') {
    // 升级
    await client.query(
      `UPDATE client_wechat_users
          SET customer_type = '会员客',
              became_member_at = COALESCE(became_member_at, NOW())
        WHERE user_id = $1`,
      [clientUserId]
    )
  } else if (!shouldBeMember && currentType === '会员客') {
    // 降级（新增路径）
    await client.query(
      `UPDATE client_wechat_users
          SET customer_type = '体验客',   -- 或业务定义的默认非会员类型
              became_member_at = NULL
        WHERE user_id = $1`,
      [clientUserId]
    )
  }
}
```

> ⚠️ 降级后 `customer_type` 应退回哪个具体值（流量客/体验客/小美客）需业务确认。参考原 `customer_type` 枚举 `[流量客/体验客/小美客/会员客]`，建议默认退为"体验客"（曾消费但未达标）。

**调用点同步审计**：
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js:634` — `order.create` 成功后调用 `recalcCustomerType`（保留）
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1077` — `approveRefund` 成功后调用（此处新降级分支即会触发）
- `fengyu-client/cloudfunctions/payNotify/index.js` — 支付成功回调（保留）
- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/customer.test.js` — 测试新降级分支

#### B3 [逻辑] 会员门槛硬编码统一走 system_configs

为所有云函数增加一个小的 helper：

```js
// fengyu-staff/cloudfunctions/staffApi/utils/config.js (新文件)
const pg = require('../db/pg')
let _cachedThreshold = null
let _cacheAt = 0
const CACHE_TTL = 5 * 60 * 1000  // 5 分钟
async function getMemberThreshold(client) {
  const now = Date.now()
  if (_cachedThreshold !== null && now - _cacheAt < CACHE_TTL) return _cachedThreshold
  const exec = client ? client.query.bind(client) : pg.query.bind(pg)
  const rows = await exec("SELECT value FROM system_configs WHERE key = 'new_member_threshold'")
  _cachedThreshold = Number(rows.rows?.[0]?.value || rows[0]?.value) || 1980
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
| `fengyu-admin/src/app/(main)/settings/_components/settings-page.tsx` | 117 | placeholder 保留 1980 |

**选一个权威数字**：统一为 **1980**，理由：
- `fengyu-admin/src/actions/settings.ts:54` 的默认值是 `'1980'`
- 会议纪要 20260304 明确说过"1980"
- admin UI placeholder 也写着 1980

#### B4 [逻辑] spending_tier CASE 的 1990 处理

`spending_tier` 档位枚举本身是 `['10W+', '6-10W', '3-6W', '1-3W', '1990-1W', '<1990']`（见 enums.ts:68），**枚举值里带着 1990**——这是字面量，不可随门槛变化。

**结论**：
- `payNotify/index.js:123` 的 spending_tier CASE → **保留 1990**，不改
- `staffApi/order.js:38` 的 spending_tier CASE → **保留 1990**，不改
- 但代码需补注释说明"此 1990 为 spending_tier 枚举值定义，与 new_member_threshold 独立"

### 阶段 C：前端 UI 修改

#### C1 [渲染] 员工端服务单列表/详情删除明细徽章

**`fengyu-staff/miniprogram/pages/service/service.wxml:60`**

删除整行徽章：
```diff
- <text class="item-tag item-tag--{{si.isPresale ? 'presale' : 'postsale'}}">{{si.isPresale ? '售前' : '售后'}}</text>
```

**`fengyu-staff/miniprogram/packageService/service-detail/service-detail.wxml:35`**

删除详情页每行售前/售后徽章。

**`fengyu-staff/miniprogram/packageService/service-detail/service-detail.ts:24`** 及 `pages/service/service.ts` — 删除 Item 类型中的 `isPresale: boolean`。

**样式清理**：`.item-tag--presale` / `.item-tag--postsale` CSS 选择器若在 wxss 中定义，删除。

#### C2 [渲染] 管理后台服务单详情删除明细列

**`fengyu-admin/src/app/(main)/services/_components/service-detail-page.tsx`**

删除第 101 行表头 `<th>售前/售后</th>`，第 113-116 行单元格 Badge 代码。表格列数相应调整。

**`fengyu-admin/src/lib/types.ts`**

`ServiceItem` interface 删除 `isPresale: boolean` 字段。

#### C3 [渲染] 管理后台顾客详情新增"成为会员时间"展示

**`fengyu-admin/src/app/(main)/customers/_components/customer-detail-page.tsx`**

在顾客档案区（会员等级/顾客类型附近）新增一行只读展示：

```tsx
<div className="flex justify-between">
  <span className="text-gray-500">成为会员时间</span>
  <span>
    {customer.becameMemberAt
      ? format(new Date(customer.becameMemberAt), 'yyyy-MM-dd HH:mm')
      : '—'}
  </span>
</div>
```

**`fengyu-admin/src/actions/customers.ts`**

`getCustomer` / `listCustomers` 的 SELECT 增加 `becameMemberAt` 字段映射。

#### C4 [渲染] 服务单主表徽章保持不变

**`fengyu-admin/src/app/(main)/services/_components/services-page.tsx:188`** 与 `service-detail-page.tsx:51`：

- 徽章文案 `售前` / `售后` **保持不变**
- 数据源 `serviceOrder.serviceOrderType` **保持不变**
- 实际判定规则从"按 customer_type 派生"变为"按 became_member_at 快照"，但此变化对前端不可见

### 阶段 D：测试与 seed 修复

#### D1 seed.ts 更新
- `fengyu-admin/src/db/seed.ts` — 顾客种子数据：
  - 对构造为 `customerType: '会员客'` 的记录，补 `becameMemberAt: new Date(...)` 字段
  - 删除所有 service_items seed 中的 `isPresale` 字段
- `seed.ts:260-263` — `serviceOrderType: '售后'`/`'售前'` 枚举值**保留不变**（本方案不回滚枚举）

#### D2 单元测试
- `fengyu-admin/src/actions/services.test.ts` — createServiceOrder 测试：
  - mock 顾客 `becameMemberAt` 为过去时间 → 断言 `serviceOrderType === '售后'`
  - mock 顾客 `becameMemberAt = null` → 断言 `serviceOrderType === '售前'`
  - mock 顾客 `becameMemberAt` 为未来时间（边界 case）→ 断言 `serviceOrderType === '售前'`
  - 删除所有 `isPresale` 相关断言
- `fengyu-admin/src/actions/customers.test.ts` — 新增 `becameMemberAt` 透传测试
- `fengyu-admin/src/actions/settings.test.ts` — 新增测试：默认值确为 '1980'、保存后读回一致
- `fengyu-admin/src/actions/orders.test.ts` — 新增：
  - 订单支付后，顾客首次达标 → 顾客 `becameMemberAt` 被写入
  - 已是会员的顾客再支付 → `becameMemberAt` 不被覆盖（`COALESCE`）
  - 退款后顾客累计消费跌破门槛 → `becameMemberAt` 被清空，`customer_type` 降级
- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/service.test.js` — 新增用例：
  - 顾客 `became_member_at IS NULL` → 服务单 `service_order_type === '售前'`
  - 顾客 `became_member_at <= NOW()` → 服务单 `service_order_type === '售后'`
  - 删除所有 `is_presale` 相关断言
- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/order.test.js` — 回归测试 recalcCustomerType 升降级

#### D3 E2E
- Playwright `e2e/services.spec.ts`（如存在）— 确认列表/详情主表徽章仍正常；确认详情页明细 table 已无"售前/售后"列
- `e2e/customers.spec.ts` — 断言顾客详情页"成为会员时间"行渲染正常
- Admin settings 页面 E2E 校验"1980 → 保存 → 看板统计读到新值"链路

### 阶段 E：规范文档同步

| 文件 | 修改点 |
|------|--------|
| `.42cog/pm/backend.pr.spec.md` | `client_wechat_users` 字段清单增加 `became_member_at`；`service_orders.service_order_type` 描述改为"按顾客成为会员时间判定（快照）"；`service_items` 删除 `is_presale` 字段描述 |
| `.42cog/pm/staff.pr.spec.md` | 新会员门槛"1980"改为"由 system_configs.new_member_threshold 配置，默认 1980"；服务单售前/售后规则补描述 |
| `.42cog/pm/admin.pr.spec.md` | 顾客详情增加"成为会员时间"只读字段描述 |
| `.42cog/design/admin.ui.spec.md` | 顾客详情页布局补"成为会员时间"展示位 |
| `.42cog/pm/*.pr.spec.md` 中关于经营周期的描述 | 新增段落："凤御真实经营周期为每月 26 号至次月 25 号；当前系统按自然月实现；未来如需支持自定义周期，通过新增 `system_configs.business_period_start_day` 配置" |
| `.42cog/real.md` | 新增约束："服务单售前/售后在创建时刻按顾客 `became_member_at` 快照判定；`service_items` 无售前/售后字段；顾客 `became_member_at` 由 `recalcCustomerType` 维护，管理员不可手动编辑" |

---

## 5. 结构性变更交接清单（→ `/wx-change-propagation`）

汇总需要走 wx-change-propagation 10 层传播图的条目：

### 交接 1：字段新增 `client_wechat_users.became_member_at`
- 类型：列新增 + 回填
- 涉及层级：L0 schema → L1 migration → L2 drizzle types → L3 admin lib/types → L4 admin actions (customers) → L5 admin UI (customer-detail) → L6 staffApi routes (customer) → L7 tests → L8 seed → L9 spec docs

### 交接 2：字段删除 `service_items.is_presale`
- 类型：列删除 + 所有写入/查询/UI 清理
- 涉及层级：L0 schema → L1 migration → L2 drizzle types → L3 admin lib/types → L4 admin actions (services) → L5 admin UI (service-detail table) → L6 staffApi routes (service) → L7 staff 前端 WXML/TS (list + detail) → L8 tests → L9 seed → L10 spec docs

---

## 6. 风险点

### 6.1 `recalcCustomerType` 降级路径是新增行为
当前 `recalcCustomerType` 在 `order.js:67` **只升不降**。本方案新增降级分支会引入之前不存在的写入路径。虽然当前业务中降级触发频率极低（仅 approveRefund 场景），但需要：
1. 明确降级后 `customer_type` 退回值（建议"体验客"）
2. 降级后是否需要 `spending_tier`/`member_level` 联动重算
3. 审计日志是否记录降级事件

**缓解**：新增的降级分支默认触发条件严格（`!shouldBeMember && currentType === '会员客'`），若业务担忧可加 feature flag 分阶段启用。

### 6.2 历史顾客 `became_member_at` 回填精度
迁移回填使用 `updated_at` 作为近似值。若某顾客长期是会员但近期有其他字段更新（例如改绑门店），`updated_at` 会偏晚于实际成为会员时间。

**影响**：此值仅用于**判定未来新创建服务单**的 `service_order_type`。对于已经存在的服务单，`service_order_type` 已是历史快照不受影响。新创建的服务单由于顾客早已是会员，判定结果仍为"售后"（回填值 <= NOW()），结果正确。

**结论**：精度偏差不影响业务正确性，可接受。

### 6.3 `became_member_at` 与 `customer_type` 一致性
两个字段必须满足约束：`customer_type = '会员客' ⇔ became_member_at IS NOT NULL`。任何违反此约束的写入都是 bug。

**防御措施**：
- 所有写入都走 `recalcCustomerType` 单一入口
- 迁移脚本回填时保证一致
- 可选：添加 CHECK constraint `CHECK ((customer_type = '会员客') = (became_member_at IS NOT NULL))`（但注意 constraint 会让降级分两步 UPDATE 失败，需要在同一 UPDATE 语句内同时改两列）

### 6.4 清理 `is_presale` 的历史数据无需处理
现有 `service_items.is_presale` 全部是 false（因为写入路径硬编码了 false）。DROP COLUMN 后数据自然消失，**无历史兼容负担**（`feedback_no_legacy_compat`）。

### 6.5 经营周期未来可配置化
当前决定按自然月实现，未来可能改为 26-25 号。为避免未来大面积重改：
- 所有"本月"相关的 SQL 尽量使用 named parameter `$startDate, $endDate`，不要写 `DATE_TRUNC('month', NOW())` 硬编码
- 前端计算 startDate/endDate 的逻辑集中在一个 utils 函数
- 未来改配置化时只需修改一个 helper

**当前状态**：staff/dashboard/staff-performance 已经在前端算 startDate/endDate 后传给 API（符合这个模式）。**calc-monthly-activity.js** 的 SQL 用了 `date_trunc('month')` 裸字面量，未来改造时需替换为参数化。

### 6.6 并发写入 `became_member_at`
同一顾客短时间内两次支付达标，两次 `recalcCustomerType` 并发执行：
- 若两次都走升级分支：第二次的 `COALESCE(became_member_at, NOW())` 保证不覆盖第一次
- 若都在同一事务的 advisory lock 下：天然串行化

**现状**：`order.create` 已在事务内调用 `recalcCustomerType`（order.js:634），天然串行。无额外锁需求。

### 6.7 `service_order_type` 枚举未回滚的隐性影响
初稿方案曾计划把枚举回滚为 `[普通, 体验]`，本方案决定保留 `[售前, 售后]`。需核对：
- `db/seed.ts:260-263` 现有种子数据 `'售后'` / `'售前'` **仍然有效**，无需改动
- `fengyu-admin/src/lib/types.ts:120` `ServiceOrderType = '售前' | '售后'` **仍然有效**
- 所有前端徽章文案 **仍然有效**

**结论**：保留枚举是最小改动路径。

---

## 7. 执行顺序建议

按依赖关系：

1. **阶段 A1**（became_member_at 新增）与 **A2**（is_presale 删除）可同一 worktree：`feat/service-presale-snapshot`
   - 执行：`scripts/worktree-setup.sh feat/service-presale-snapshot`
   - 在 worktree 内串行执行 wx-change-propagation（交接 1 → 交接 2）
   - 生成 migration 0035, 0036
   - 跑 `bun run db:migrate` 验证无报错
   - 跑 `bun run test` 验证所有引用 isPresale 的 test 都更新完毕

2. **阶段 B1 + B2** 紧跟 A 完成：服务单创建新判定 + recalcCustomerType 升降级

3. **阶段 B3**（1980 硬编码统一）可与 B1/B2 并行，放入单独 worktree：`fix/member-threshold-unify`
   - 不依赖 schema 变更
   - 对 cronTask 的改动需要单独走云函数部署

4. **阶段 C**（前端 UI）依赖 B 完成，可在同一 worktree 接着做
5. **阶段 D**（测试）与 B/C 并行，持续补充
6. **阶段 E**（文档）最后批量提交

---

## 8. 已澄清问题

| # | 问题 | 决策 |
|---|------|------|
| Q1 | `client_wechat_users` 是否已有"成为会员时间"字段？若有名称是什么？ | ❌ **当前没有**（grep `member_since` / `became_member_at` / `upgraded_at` 均无匹配）→ 新增 `became_member_at` (timestamptz, nullable) |
| Q2 | "成为会员" 基于 `customer_type` 还是 `member_level`？ | ✅ 以 `customer_type` 转换时点为准（与 `new_member_threshold` 判定一致）。`member_level` 初钻及以上是业务展示层级，与售前/售后判定解耦 |
| Q3 | 历史服务单 `service_order_type` 是否需要按新规则回填？ | ✅ **不回填**（开发期 `feedback_no_legacy_compat`）。历史服务单保持其创建时快照 |
| Q4 | 顾客从会员客降级回非会员客时，`became_member_at` 是否清空？ | ✅ **清空为 NULL**。需同步在 `recalcCustomerType` 新增降级分支（见 §B2），当前代码的 only-upgrade 行为要打破 |
| Q5 | 管理员能否手动修改顾客的 `became_member_at`？ | ✅ **不能**。后台仅提供只读展示（顾客档案详情页），避免人工干预导致快照与客观事实不符 |
| Q6 | 服务单创建时，判定时间用 `NOW()` 还是 `service_orders.service_time`？ | ✅ 用 `NOW()`（即 `created_at`），因为"成为会员"是顾客**身份**状态，而非服务**发生**时点 |

---

## 9. 摘要

- **核心结构性变更**（两条）：
  - 新增 `client_wechat_users.became_member_at` (timestamptz, nullable) — 顾客首次成为会员客的时点快照
  - **删除** `service_items.is_presale` 列及两端写入/查询、两处前端徽章
- **核心逻辑变更**：
  - `service_order_type` 判定从"按 `customer_type` 派生"改为"按 `became_member_at <= NOW()` 快照判定"
  - `recalcCustomerType` 新增降级分支（退款跌破门槛时降级 + 清空 `became_member_at`），打破当前 only-upgrade 行为
  - 10+ 处 1980/1990 硬编码统一改走 `system_configs.new_member_threshold`，默认 1980
- **保持不变**：
  - `service_order_type` 枚举仍为 `['售前','售后']`（不回滚到 `['普通','体验']`）
  - `sale_orders.document_type` 判定逻辑（与服务单售前/售后解耦）
  - 服务单主表徽章文案与数据源名称
- **前端改动**：
  - staff + admin 服务单**明细**徽章/列**全部删除**
  - admin 顾客详情页新增"成为会员时间"只读展示
  - 服务单主表徽章保持现状
- **经营周期**：固化为自然月实现，在 spec 补充未来可配置化钩子描述，无代码大动作
- **配套**：seed.ts、测试、spec 文档联动更新
- **与初稿方案对比**：工作量和风险显著收敛 — 初稿 3 处结构性变更（枚举回滚 + 新增 document_type 列 + service_items 字段重构）缩减为 2 处（`became_member_at` 新增 + `is_presale` 删除）
