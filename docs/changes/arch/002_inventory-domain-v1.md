---
type: arch
number: "002"
date: 2026-05-19
title: 门店库存域 v1（PG 4 对表 + admin 主写 + 员工端只读 + 提货流程 UI）
tags: [admin, staff, db, inventory, workfine, pickup]
related: [001]
---

# arch/002 门店库存域 v1

> ⚠️ **本文档已被 [arch/011 进销存域 v3](011_inventory-domain-v3.md) 推翻（2026-09-02）。**
> v1 的 4 对主+明细表与过渡期 `store_inventory_*` 表已在 migration 0017 全部删除，
> 现行实现为三级统一进销存 v3，本文仅作历史决策记录保留。

## 背景与动机

员工端"我的"Tab 的「库存管理」入口已经预埋（`profile.wxml` + `canSeeInventory` + `/packageMy/inventory/inventory` 占位页），但实际功能没落地。同时家居产品的提货流程在云函数 + admin 后台已经齐备（`order.createPickup` + `pickup_records` 表 + admin `/pickup-records`），员工端仅缺 UI。

业务诉求：

1. **门店库存管理** —— WorkFine 8 种库存单据（院报货 / 院入库 / 顾客退货 / 销售出库 / 退货出库 / 报损出库 / 调拨入库 / 调拨出库）的 CRUD
2. **提货流程管理** —— 店长在员工端核销顾客已购未提的家居产品

需要做出几项关键架构决策：数据存哪里、写入入口在哪、WorkFine 桌面端去留。

## 技术选型

| 维度 | 选择 | 否决项 |
|------|------|--------|
| **库存数据存放** | PG 4 对主+明细表 | 直写 WorkFine MSSQL（违反 mssql-readonly + 增大云函数包体 + 桌面端并发风险）；不在 PG 重复建表 |
| **WorkFine 桌面端** | **上线即弃用**，PG 是唯一真理源 | 并行过渡需做 WorkFine→PG 增量同步（违反 workfine-sync-stopped） |
| **历史数据** | 不导入，PG 从上线起空表起步 | 一次性全量导入（约 2.5 万主单 + 10 万明细，与 `pre-launch-data-wipe` 思路不符） |
| **写入主入口** | **admin 后台**（Next.js Server Actions + Drizzle） | 员工端小程序写入（CloudBase 包体限制 + 表单复杂度高 + 桌面端店员习惯电脑录单） |
| **员工端定位** | **只读**（list + detail），全员可查 | 员工端可写（与全员可写权限粒度冲突） |
| **8 表归类** | 按业务方向 4 对表 | 单表+doc_type 枚举（特有字段差异大、归类不明显）；8 张表 1:1 映射（schema 翻倍、跨类型报表难）|

**采纳理由**：迁 PG 让 WorkFine 严格只读约束保持完整，主键/网络/并发/包体积四大风险归零；admin 主写复用现成的 Drizzle / Server Actions / 权限矩阵 / 表格组件，开发效率最高；员工端只读保持包小并匹配"店员手机端只看不录"的实际场景。

## 数据模型

新建 **4 对 PG 表**（按业务方向归类）：

| 主表 | 明细表 | 涵盖 docSubtype | 共同语义 |
|------|--------|-----------------|----------|
| `inventory_procurement_orders` | `_items` | 院报货 / 院入库 / 退货出库 | 与供应商互动（采购链） |
| `inventory_sale_orders` | `_items` | 销售出库 / 顾客退货 | 与顾客互动 |
| `inventory_transfer_orders` | `_items` | 调拨出库 / 调拨入库（单条 + `is_dispatcher` 方向位） | 内部门店间调拨 |
| `inventory_scrap_orders` | `_items` | 报损出库 | 异常损耗 |

公共主表字段：`id` (PK，单据号 `INV-{PREFIX}-{YYMMDD}-{NNNN}`)、`doc_subtype`、`status`（草稿 / 已完成 / 已取消）、`store_id` FK `stores.storeId` NOT NULL、`doc_date`、`total_quantity`、`created_by`/`confirmed_by` FK `staff_wechat_users.employeeId`、`created_at`/`updated_at`。

公共明细字段：产品编号 / 名称 / 规格 / 厂家 / 系列 / 批号 / 有效期 / 是否赠送 / 数量 / 库存快照 / 单价 / 金额 / 备注。

各类型特有字段：参见 `db/schema/inventory.ts` —— 共 5 列采购特有 + 4 列销售特有 + 4 列调拨特有 + 1 列报损特有。

新增枚举：`inventoryDocStatusEnum`、`inventoryProcurementSubtypeEnum`、`inventorySaleSubtypeEnum`、`inventoryTransferSubtypeEnum`。

Migration: `db/migrations/0042_curvy_piledriver.sql`。

## 架构设计

### admin 写入层

权限 keys：`inventory:list` / `inventory:create` / `inventory:update` / `inventory:delete`，授予：
- admin：全开
- manager：list/create/update（删除留给 admin）
- finance / product：仅 list

Server Actions 模块（`fengyu-admin/src/actions/inventory/`）：
- `doc-no.ts` — 单据号生成（advisory lock + 当日序号，与 `sale_orders` 同模式）
- `types.ts` — 跨模块共享 DTO
- `procurement.ts` / `sale.ts` / `transfer.ts` / `scrap.ts` — 各自 list/get/create/update/delete + `confirmTransferReceive`（接收方确认收货）

UI（`fengyu-admin/src/app/(main)/inventory/`）：
- `page.tsx` — 4 类入口面板（hub）
- `procurement/page.tsx` + `[id]/page.tsx` —— 列表 + 创建 Dialog + 详情，对其它 3 类同构
- `_components/inventory-list-view.tsx` — 列表 + 筛选 + 新建 dialog（schema-driven 表单：按 docCategory 切换字段集）
- `_components/inventory-detail-view.tsx` — 详情卡片 + 明细表

侧边栏菜单：`门店库存`（Boxes 图标），`/inventory`，requiredRoles=manager，readonlyRoles=[finance, product]。

### staffApi 只读层

新建 `routes/inventory.js`：
- `inventory.list` — payload: `{docCategory, page, pageSize, docSubtype?, status?, storeId?, startDate?, endDate?, keyword?}`
- `inventory.detail` — payload: `{docCategory, id}`

鉴权：仅 `requireStaffBound`（全员可查），默认按 `ctx.auth.scopeStoreIds` 过滤。调拨单查询用 `(store_id = ANY(...) OR counterpart_store_id = ANY(...))` 让对方门店也看到。

### 员工端 UI

新增 `fengyu-staff/miniprogram/packageMy/inventory/`：
- `inventory.{ts,wxml,wxss,json}` — 4 类入口分发面板（原占位页升级）
- `list.{ts,wxml,wxss,json}` — 单据列表（子类型筛选 + 关键词 + 分页 + 下拉刷新）
- `detail.{ts,wxml,wxss,json}` — 主表字段 + 明细行

### 提货流程 UI（与库存并列）

云函数层补 2 个 staffApi action（仅店长可调）：
- `order.availablePickupItems` —— 列出某顾客已购未提的家居产品
- `order.pickupRecordsList` —— 提货记录分页列表（默认按 scopeStoreIds 过滤）

员工端 UI：`fengyu-staff/miniprogram/packageMy/pickup/`
- `pickup-by-customer.{ts,wxml,wxss,json}` —— 搜索顾客 → 展开可提清单 → 点"录入提货"弹 dialog → 调既有 `order.createPickup`
- `pickup-list.{ts,wxml,wxss,json}` —— 历史记录（日期筛选 + 分页）

profile.wxml 新增`提货核销`入口（仅 manager 可见）。

## 影响范围

### 新增

- `db/schema/inventory.ts` + `db/schema/enums.ts`（追加 4 个枚举） + migration 0042
- `fengyu-admin/src/actions/inventory/` 6 个 ts（4 actions + doc-no + types）+ inventory.test.ts 5 个 smoke 单测
- `fengyu-admin/src/app/(main)/inventory/` 5 个 page + 2 个共享组件
- `fengyu-admin/src/lib/permissions.ts` 加 4 个 inventory action 到 admin/manager/finance/product
- `fengyu-admin/src/lib/menu.ts` 加 Boxes 入口
- `fengyu-staff/cloudfunctions/staffApi/routes/inventory.js`（含 list/detail）
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js` 新增 `availablePickupItems` / `pickupRecordsList`
- `fengyu-staff/cloudfunctions/staffApi/index.js` 注册 4 个新 action
- `fengyu-staff/miniprogram/packageMy/inventory/{inventory,list,detail}.{ts,wxml,wxss,json}` 三套
- `fengyu-staff/miniprogram/packageMy/pickup/{pickup-by-customer,pickup-list}.{ts,wxml,wxss,json}` 两套
- `fengyu-staff/miniprogram/app.json` packageMy.pages 追加 4 个页面
- `fengyu-staff/miniprogram/pages/profile/profile.wxml` 加`提货核销`入口

### 不动（保护项）

- `pickup_records` 表 + `order.createPickup` 既有云函数 —— 不修改任何既有提货闭环
- `notes/research/store-inventory-schema.md` 双表合并方案 —— **作废**（实际使用 4 对表归类）
- WorkFine MSSQL —— 严格只读约束完整保留，不读不写

## 风险与权衡

| 风险 | 处置 |
|------|------|
| **桌面端弃用需培训** | 店员习惯 WorkFine 桌面端录单，强制改用 admin 网页需要业务方培训（计划外，PM 决策） |
| **历史数据割裂** | 上线后查老库存单据要去 WorkFine 桌面端查；与 `pre-launch-data-wipe` 一致可接受 |
| **admin 表单 schema-driven 复杂** | 已抽 `inventory-list-view.tsx` 通用骨架 + 各 docCategory 按字段条件渲染 |
| **调拨单一致性** | 单条记录 + `is_dispatcher` 方向位 + DB check `store_id <> counterpart_store_id`；`confirmTransferReceive` 拒幂等重复 |
| **报损/出库无库存校验** | v1 不做库存余量约束（PG 无库存余量表，需要事件溯源汇总）；店员录单时填的 `stock_on_hand` 仅为快照 |

## 验证

- ✅ db schema 落地 5434/fengyu（migration 0042）
- ✅ admin 全量 vitest 通过（1154 tests / 59 files）
- ✅ admin tsc 0 error
- ✅ staff miniprogram tsc 0 error
- ✅ staffApi 三个 routes JS 文件 node -c 语法 OK
- ⏳ staffApi e2e-cloudfn 跑 inventory + order 过滤（待部署 cloudbase 后跑）
- ⏳ admin 浏览器端到端跑 4 个模块各 list/create/detail/delete（待部署）

## 后续

- 库存余量统计页（按门店 × SKU 汇总 in/out 净额）—— 视上线后店员反馈再决定
- 调拨"接收方确认收货" UI 暴露：当前 `confirmTransferReceive` action 已就绪，admin UI 后续补一个`待确认收货` tab
- 单据编辑 UI：当前 admin 只支持`新建 + 删除`（编辑 Server Action 已就绪 `updateXxxOrder`），UI 入口后续补在详情页
