---
type: arch
number: "011"
date: 2026-09-02
title: 进销存域 v3（三级统一 14+1 表 + 33 单据类型 + 独立角色三重 scope 强制 + 金额触发器单源 + 四档价格裁剪）
tags: [admin, staff, db, inventory, permission, workfine]
related: ["002"]
---

# arch/011 进销存域 v3

> **本文档取代 arch/002。** arch/002 的「门店库存域 v1」（4 对主+明细 8 表、admin 主写、
> 员工端只读）已被 v3 全量推翻：v1/v2 全部表已在 migration `0017_watery_slyde.sql` 删除，
> 现行实现以本文为准。

## 背景与动机

v1（arch/002）只覆盖单一门店层的 8 种 WorkFine 单据，无法承载真实业务的三级协同：
总部（供应链/品项公司）→ 市场 → 门店的报货、采购、发货、配货、退货、调货、员工购、
自采等全链路（权威需求见 `notes/references/进销存/说明.md` 与流程图）。中途出现过
`store_inventory_*` 4 表的单店过渡形态（v2），同样不满足跨层级金额口径与权限隔离要求。

v3 目标：一套单据模型贯通三级主体，金额与市场归属由数据库单源维护，权限用独立角色 +
scope 三重强制，价格按层级在服务端裁剪。

## 演进史

| 版本 | 形态 | 归宿 |
|------|------|------|
| v1（arch/002） | 4 对主+明细表（procurement/sale/transfer/scrap × orders/items），admin 主写、staff 只读 | 0017 删除 |
| v2（过渡） | `store_inventory_docs/doc_items/movements/stocks` 单店 4 表 | 0017 删除 |
| **v3（现行）** | `inventory_*` 统一 14 表 + 权限配套 1 表，单据单表 + doc_type 判别 | 核心骨架 0007 落地，0009/0016/0038/0039 逐步加固 |

关键迁移：`0007`（v3 核心表 + 旧骨架桥接）、`0009_inventory_integrity_guards`
（批次余额/移动 append-only/单据生命周期/主体树校验触发器 + org_nodes/stores→
inventory_locations 实时同步触发器）、`0016_inventory_permission_catalog`
（12 个 `inventory:*` 权限目录）、`0017`（删除 v1/v2 全部表）、`0038`
（单据端点列 RENAME 为 `source_org_node_id` / `target_org_node_id`）、
`0039_inventory_org_endpoints_and_permissions`（org 端点 FK 重建 + 市场进货价
公式/手工覆盖模式 + 金额触发器 + 3 个独立库存角色 + scope 三重强制 + market_id 派生）。

## 数据模型（14 + 1 表）

`db/schema/inventory.ts` 14 张 `inventory_*` 表：

| 分组 | 表 | 说明 |
|------|-----|------|
| 主数据 | `inventory_skus` | 库存 SKU（六价体系：供应链采购价/市场进货价/门店进货价/市场员工购价/零售价/核算价；供应链 SKU 市场进货价默认「核算价 × 市场折扣」公式，手工覆盖必须填原因） |
| 主数据 | `inventory_suppliers` | 供应商实体（编号系统生成） |
| 主数据 | `inventory_sku_product_sku_mappings` | 销售 SKU ↔ 库存 SKU 组成（提货整套扣减） |
| 主体 | `inventory_locations` | 总部/市场/门店库存主体，锚定 `org_nodes.id`，由 0009 触发器随 org_nodes/stores 实时同步 |
| 促销 | `inventory_promotion_plans` / `inventory_promotion_plan_items` | 市场报货福利方案（单品阶梯/组合，「单价-优惠=实际单价」，不改原始价） |
| 库存 | `inventory_stock_lots` | 批次库存（主体 × SKU × 批号 × 价格快照 × 是否赠品） |
| 库存 | `inventory_stock_reservations` | 退货等流程的预留占用（可用量 = 在手 − 预留） |
| 库存 | `inventory_movements` | 库存移动流水，append-only（0009 触发器禁改删） |
| 单据 | `inventory_docs` | 单表 + **33 值 `doc_type` CHECK**（无 pgEnum），端点列 `source_org_node_id` / `target_org_node_id` 经 `inventory_locations.org_node_id` 锚到组织节点 |
| 单据 | `inventory_doc_items` | 明细（数量、四层价格快照、赠品位、履约数量） |
| 单据 | `inventory_doc_links` | 单据血缘（报货→采购→发货→入库→配货 链路关联与进度） |
| 切流 | `inventory_cutover_states` | WorkFine 期初切流门禁（未初始化禁止写库存业务） |
| 切流 | `inventory_import_refs` | 期初导入引用 |

权限配套（`db/schema/permission.ts`）：`permission_role_definitions` —— 角色定义表
（role_key、actions、allowed_scope_types、is_super_admin），与库存三独立角色配套新增。

### 33 种单据类型

DOC_PREFIX 映射（33 对，两端字面一致）：门店报货、市场报货、品项公司报货需求、采购订单、
供应链采购订单、供应链采购入库、品项公司发货、市场采购入库、自采产品入库、分院配货、
院入库、分院调货出库/入库、市场间调货出库/入库、员工购出库、供应链员工购出库、内部领用、
非凤御市场出库、院顾客退货、市场退货、市场退货入库、供应链退货入库、院退货、
院顾客产品出库、市场产品报损、院产品报损、市场产品盘溢、市场库存盘点、分院库存盘点、
库存转换出库/入库、期初库存。按行为分组为 INBOUND(12) / OUTBOUND(10) / NO_MOVEMENT(5) /
RECEIVE_REQUIRED(4) / APPROVAL(4) 等集合，staff 端另有可见(11)/可建(7)/可收货(2) 白名单。

## 架构设计

### 三级独立角色 + scope 三重强制（说明.md §9）

3 个独立角色（0039 seed）：`inventory_supply_chain_operator` 供应链库存员（只能绑总部）、
`inventory_market_finance` 市场库存财务（只能绑市场）、`inventory_store_operator`
门店库存员（只能绑门店，无任何价格动作）。既有 manager/finance/product 等历史角色的
`inventory:*` 动作被 0039 全部剥离，不自动放权；超级管理员除外。

scope 三重强制：

1. **角色定义层（DB 触发器）**：`trg_permission_role_definitions_scope_types` ——
   库存动作按层级分组（供应链/市场/门店），普通角色不能混层级，且 `allowed_scope_types`
   必须与动作层级一致（供应链→仅总部、市场→仅市场、门店→仅门店）。
2. **角色绑定层（DB 触发器）**：`trg_permission_roles_validate_scope_type` ——
   `permission_roles` 绑定的 `org_nodes.type` 必须 ∈ 角色 `allowed_scope_types`。
3. **应用层（两端各自副本）**：admin `withPermission/withAllPermissions` +
   `scopeSessionToActions/scopeSessionToAllActions`（多权限必须同一角色绑定，跨绑定拼接
   PERMISSION_DENIED）+ `src/lib/inventory/access.ts`（scope 唯一真相源：总部不下钻、
   市场含门店、门店仅自身）；staff `buildInventoryLocationScope` +
   `descendantOrgNodeIdsSql`（source/target 双端点 org 树过滤）。

单据可见性（说明.md §9.4）：按 `source_org_node_id` / `target_org_node_id` 双端点 OR
过滤；跨市场调货出库归来源市场、入库归目标市场，双方互不见对方其他单据；库存总部 scope
不因父级关系自动看到市场/门店单据。

### 金额 DB 触发器单源（说明.md §10）

- `inventory_set_doc_item_amount`（0039）：明细金额按单据层级的实际单价统一计算，
  赠品金额恒 0；`trg_inventory_doc_items_refresh_totals` 自动汇总单头总数量/总金额。
  admin/staff 不各自维护金额算法（应用层只写价格快照，不写金额结果）。
- `trg_inventory_docs_set_market_id`（0039）：`market_id` 按单据类型与来源/目标组织
  节点自动派生，调用端传值不能改变归属；总部单据不带市场归属。
- 0009 完整性护栏：批次余额非负、movements append-only、单据生命周期状态机、
  主体树合法性、org_nodes/stores → inventory_locations 实时同步（INSERT + 相关列
  UPDATE 全覆盖；应用层 `syncInventoryLocations` 仅作漂移自愈兜底，已加反连接探测短路）。

### 四档价格裁剪（说明.md §9.5）

`inventoryPriceVisibility(session)` → `all` / `supply_chain` / `market` / `none`，
由 `inventory:supply_chain_price_view` / `inventory:market_price_view` 权限推导，
**服务端**逐字段裁剪（SKU 资料、批次、单据头、明细、导出同口径）：

| 档位 | 可见 | 不可见 |
|------|------|--------|
| supply_chain | 供应成本、核算价、市场结算价、公式/覆盖模式 | 门店结算价、员工购价 |
| market | 市场进货价、门店结算价、员工购价、明细金额 | 供应链成本 |
| none（门店） | 仅数量/批次/主体 | **任何金额字段不出现在响应中** |

品项公司发货单业务页不展示单价与货款（价格快照仅供入库/退货/审计追溯）。
staff 云函数同样执行 `assertNoStaffMoneyFields`（金额字段禁提交）+ 无金额响应。

### 跨端一致性

staff（`fengyu-staff/cloudfunctions/staffApi/routes/inventory.js`，11 action）与
admin（`fengyu-admin/src/lib/inventory/engine.ts` + `business.ts`）各自独立副本，
禁止抽共享目录；一致性由
`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-inventory-snapshot.test.js`
守护（端点列口径、单据类型集合、错误前缀白名单、金额禁提交、sync 短路探测片段）。

## 相关文件

- `db/schema/inventory.ts` / `db/schema/permission.ts` — 表定义权威
- `db/migrations/0007/0009/0016/0017/0038/0039` — v3 演进迁移
- `fengyu-admin/src/lib/inventory/{engine,business,access}.ts` — admin 实现层
- `fengyu-admin/src/actions/inventory/` — Server Action 薄壳
- `fengyu-admin/src/app/(main)/(inventory)/inventory/` — 六路由 UI（operations 三级办理台 / docs 单据中心 / stocks / skus / suppliers / sku-mappings / promotions）
- `fengyu-staff/cloudfunctions/staffApi/routes/inventory.js` — 门店侧 11 action
- `.42cog/pm/admin.pr.spec.md` §「进销存三级权限、组织归属与金额口径」— 需求权威
- `notes/references/进销存/说明.md` — 业务权威（§9-11 系统落地规则）

## 相关变更记录

- `arch/002` — 门店库存域 v1（**已被本文档推翻**）
