---
name: seed-data
description: |
  适用于测试数据初始化工作流。基于 Drizzle Schema 生成 PG 种子数据，
  验证 WorkFine 只读数据可访问，为集成测试和开发调试提供标准化基础数据集。
  当用户说"初始化测试数据"、"准备种子数据"、"seed"时激活。
argument-hint: '[数据范围：minimal/standard/full]'
user-invocable: true
metadata:
  author: fengyu
  version: 1.0.0
  title: 测试数据初始化
  description_zh: 基于 Drizzle Schema 的标准化测试数据初始化工作流
---

# 测试数据初始化工作流

为开发和测试环境准备标准化的基础数据集。

## 何时使用

- 新开发环境搭建，数据库为空需要初始数据
- 集成测试前需要前置数据（被 `integration-test` 引用）
- 数据库迁移后需要重新填充测试数据
- 用户说"初始化数据"、"seed"、"准备测试数据"

## 使用方法

```bash
/seed-data                    # 标准数据集
/seed-data minimal            # 最小数据集（仅必需数据）
/seed-data full               # 完整数据集（含各种状态的订单、服务单等）
```

## 不适用

- 生产数据导入（生产数据通过正式业务流程写入）
- 数据库 Schema 变更（用 `wx-database-design`）
- WorkFine 数据写入（**严禁写入 WorkFine**，参见 real.md）

---

## Step 1: 确认环境与范围

### 1.1 确认目标环境

```text
目标数据库：[ ] 开发环境  [ ] 测试环境
⚠️ 严禁在生产环境执行 seed 操作
```

### 1.2 检查数据库连接

```bash
cd db && DATABASE_URL="$DATABASE_URL" npx drizzle-kit studio
```

或通过云函数验证：

```json
{
  "tool": "invokeFunction",
  "envId": "<ENV_ID>",
  "functionName": "staffApi",
  "params": { "action": "store.list", "payload": {} }
}
```

> **注意：** envId 从 `cloudbaserc.json` 或 `.claude/mcp.json` 中获取。

### 1.3 选择数据范围

| 范围 | 包含内容 | 适用场景 |
|------|----------|----------|
| **minimal** | 用户 + SPU/SKU | 单接口开发调试 |
| **standard** | minimal + 订单 + 服务单 | 集成测试（推荐） |
| **full** | standard + 各状态订单 + 预约 + 营业额分配 | 全面回归测试 |

---

## Step 2: 数据依赖关系

### 2.1 数据写入顺序

PG 表之间有外键约束，必须按以下顺序写入：

```text
Layer 0（无依赖）：
  ├── client_wechat_users
  ├── staff_wechat_users
  └── product_spu

Layer 1（依赖 Layer 0）：
  └── product_spu_sku_map  → product_spu.spu_id

Layer 2（依赖 Layer 0-1）：
  └── orders               → client_wechat_users.user_id（可选）

Layer 3（依赖 Layer 2）：
  ├── order_items           → orders.order_no, product_spu_sku_map.sku_id
  ├── revenue_allocations   → orders.order_no
  └── service_orders        → client_wechat_users.user_id（可选）

Layer 4（依赖 Layer 3）：
  ├── revenue_allocation_items → revenue_allocations.id
  ├── service_items            → order_items.item_flow_no, service_orders.service_order_no
  └── appointments             → client_wechat_users.user_id, order_items.item_flow_no（可选）
```

### 2.2 WorkFine 数据依赖

以下字段引用 WorkFine 数据，seed 时使用**真实的 WorkFine ID**（从 API 查询获取）：

| PG 字段 | WorkFine 来源 | 获取方式 |
|---------|---------------|----------|
| `staff_wechat_users.staff_wf_id` | `UDT_S_287.UDF_S_1147` | `staff.list` 或 `staff.departments` |
| `orders.store_name` | `UDT_M_219.UDF_M_438` | `store.list` |
| `orders.market_name` | `UDT_M_219.UDF_M_437` | `store.list` |
| `orders.preferred_staff_wf_id` | `UDT_S_287.UDF_S_1147` | `staff.list` |
| `product_spu_sku_map.workfine_item_id` | `UDT_M_1281.UDF_M_14503` | 手动查询或已知值 |
| `appointments.staff_wf_id` | `UDT_S_287.UDF_S_1147` | `staff.list` |

**关键原则：WorkFine ID 必须使用真实值**，否则关联查询将返回空或报错。

---

## Step 3: 获取 WorkFine 真实数据

### 3.1 获取门店信息

```json
{
  "tool": "invokeFunction",
  "envId": "<ENV_ID>",
  "functionName": "staffApi",
  "params": { "action": "store.list", "payload": {} }
}
```

记录：`storeName`、`marketName`、`storeWfId`

### 3.2 获取员工信息

```json
{
  "tool": "invokeFunction",
  "envId": "<ENV_ID>",
  "functionName": "staffApi",
  "params": { "action": "staff.list", "payload": { "storeId": "<storeWfId>" } }
}
```

记录：`staffWfId`（员工编号）、`staffName`、`position`（岗位）

### 3.3 获取商品/SKU 信息

```json
{
  "tool": "invokeFunction",
  "envId": "<ENV_ID>",
  "functionName": "clientApi",
  "params": { "action": "product.categories", "payload": { "storeId": "<storeWfId>" } }
}
```

记录：`spuId`、`skuId`、`workfineItemId`、价格、次数

---

## Step 4: 生成种子数据

### 4.1 Seed 脚本位置

种子数据脚本放在 `db/seed/` 目录下：

```text
db/
├── seed/
│   ├── index.ts          # 种子脚本入口
│   ├── users.ts          # 用户数据
│   ├── products.ts       # 商品数据
│   ├── orders.ts         # 订单数据（standard+）
│   ├── services.ts       # 服务单数据（standard+）
│   ├── appointments.ts   # 预约数据（full）
│   └── cleanup.ts        # 清理脚本
├── schema/
└── migrations/
```

### 4.2 Minimal 数据集

**用户数据** (`users.ts`)：

```typescript
import { drizzle } from 'drizzle-orm/node-postgres'
import { clientWechatUsers, staffWechatUsers } from '../schema'

export async function seedUsers(db: ReturnType<typeof drizzle>) {
  // 测试顾客
  await db.insert(clientWechatUsers).values([
    {
      userId: 'test-client-001',
      openid: 'test-openid-client-001',
      phone: '13800000001',
      boundStoreName: '<从 store.list 获取>',
      boundMarketName: '<从 store.list 获取>',
    },
    {
      userId: 'test-client-002',
      openid: 'test-openid-client-002',
      phone: '13800000002',
      // 未绑定门店的顾客
    },
  ]).onConflictDoNothing()

  // 测试员工
  await db.insert(staffWechatUsers).values([
    {
      userId: 'test-staff-001',
      openid: 'test-openid-staff-001',
      phone: '13900000001',
      staffWfId: '<从 staff.list 获取的真实店长 ID>',
    },
    {
      userId: 'test-staff-002',
      openid: 'test-openid-staff-002',
      phone: '13900000002',
      staffWfId: '<从 staff.list 获取的真实美容师 ID>',
    },
  ]).onConflictDoNothing()
}
```

**商品数据** (`products.ts`)：

```typescript
import { drizzle } from 'drizzle-orm/node-postgres'
import { productSpu, productSpuSkuMap } from '../schema'

export async function seedProducts(db: ReturnType<typeof drizzle>) {
  // SPU - 疗程卡
  await db.insert(productSpu).values([
    {
      spuId: 'test-spu-001',
      name: '测试疗程项目',
      category: '测试分类',
      bigCategory: '生美',
      sortOrder: 1,
    },
    {
      spuId: 'test-spu-002',
      name: '测试单品项目',
      category: '测试分类',
      bigCategory: '非生美',
      sortOrder: 2,
    },
    {
      spuId: 'test-spu-003',
      name: '测试院装产品',
      category: '院装',
      bigCategory: '院装产品',
      sortOrder: 3,
    },
  ]).onConflictDoNothing()

  // SKU 映射（workfineItemId 必须使用 WorkFine 真实值）
  await db.insert(productSpuSkuMap).values([
    {
      skuId: 'test-sku-001',
      spuId: 'test-spu-001',
      workfineItemId: '<真实 WorkFine 疗程编号>',
      workfineSource: 'UDT_M_1281',
      productType: '疗程卡',
      skuDisplayName: '10次卡',
      sortOrder: 1,
      isActive: true,
    },
    {
      skuId: 'test-sku-002',
      spuId: 'test-spu-002',
      workfineItemId: '<真实 WorkFine 项目编号>',
      workfineSource: 'UDT_M_1281',
      productType: '单品',
      skuDisplayName: '单次体验',
      sortOrder: 1,
      isActive: true,
    },
    {
      skuId: 'test-sku-003',
      spuId: 'test-spu-003',
      workfineItemId: '<真实 WorkFine 商品编号>',
      workfineSource: 'UDT_M_341',
      productType: '院装产品',
      skuDisplayName: '285ml/瓶',
      sortOrder: 1,
      isActive: true,
    },
  ]).onConflictDoNothing()
}
```

### 4.3 Standard 数据集（在 minimal 基础上追加）

**订单数据** (`orders.ts`)：

```typescript
import { drizzle } from 'drizzle-orm/node-postgres'
import { orders, orderItems } from '../schema'

export async function seedOrders(db: ReturnType<typeof drizzle>) {
  const today = new Date()
  const yymmdd = today.toISOString().slice(2, 10).replace(/-/g, '')
  const yyyymmdd = today.toISOString().slice(0, 10).replace(/-/g, '')

  // 已支付订单（可用于创建服务单）
  await db.insert(orders).values({
    orderNo: `FY-XSD-WX-${yymmdd}901`,
    status: '已支付',
    orderType: '正式',
    marketName: '<真实市场名>',
    storeName: '<真实门店名>',
    orderDatetime: today,
    clientUserId: 'test-client-001',
    clientPhone: '13800000001',
    customerName: '测试顾客A',
    paymentMethod: 'offline',
    orderSource: 'staff',
    openedBy: '<真实店长 staffWfId>',
    paidAt: today,
    offlineConfirmedBy: '<真实店长 staffWfId>',
    offlineConfirmedAt: today,
  }).onConflictDoNothing()

  // 疗程卡明细（10次，剩余8次 → 可用于核销测试）
  await db.insert(orderItems).values({
    itemFlowNo: `XSLSH-WX-${yyyymmdd}901`,
    orderNo: `FY-XSD-WX-${yymmdd}901`,
    skuId: 'test-sku-001',
    sessionCount: 10,
    remainingSessions: 8,
    unitPrice: '1000.00',
    quantity: 1,
    unitDiscount: '0',
    saleAmount: '1000.00',
    receivable: '1000.00',
    received: '1000.00',
  }).onConflictDoNothing()

  // 单品明细
  await db.insert(orderItems).values({
    itemFlowNo: `XSLSH-WX-${yyyymmdd}902`,
    orderNo: `FY-XSD-WX-${yymmdd}901`,
    skuId: 'test-sku-002',
    sessionCount: 1,
    remainingSessions: 1,
    unitPrice: '200.00',
    quantity: 1,
    unitDiscount: '0',
    saleAmount: '200.00',
    receivable: '200.00',
    received: '200.00',
  }).onConflictDoNothing()
}
```

**服务单数据** (`services.ts`)：

```typescript
import { drizzle } from 'drizzle-orm/node-postgres'
import { serviceOrders, serviceItems } from '../schema'

export async function seedServices(db: ReturnType<typeof drizzle>) {
  const today = new Date()
  const yymmdd = today.toISOString().slice(2, 10).replace(/-/g, '')
  const todayStr = today.toISOString().slice(0, 10)

  // 已完成的服务单（历史记录）
  await db.insert(serviceOrders).values({
    serviceOrderNo: `HLD-WX-${yymmdd}901`,
    status: '已完成',
    marketName: '<真实市场名>',
    storeName: '<真实门店名>',
    serviceDate: todayStr,
    serviceDuration: 60,
    assignedStaffWfId: '<真实美容师 staffWfId>',
    clientUserId: 'test-client-001',
  }).onConflictDoNothing()

  await db.insert(serviceItems).values({
    serviceItemId: 'test-si-001',
    itemFlowNo: `XSLSH-WX-${today.toISOString().slice(0, 10).replace(/-/g, '')}901`,
    serviceOrderNo: `HLD-WX-${yymmdd}901`,
    skuId: 'test-sku-001',
    sessionUsed: 1,
    employeeId: '<真实美容师 staffWfId>',
  }).onConflictDoNothing()
}
```

### 4.4 Full 数据集（在 standard 基础上追加）

在 standard 基础上额外创建：

- **各状态订单**：待支付、待确认收款、已支付、已完成、支付失败、已关闭各一笔
- **各状态服务单**：待服务、服务中、已完成各一单
- **各状态预约**：待确认、已确认、已完成、已取消、已关闭各一条
- **营业额分配记录**：含同部门、跨部门示例

### 4.5 种子脚本入口

```typescript
// db/seed/index.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { seedUsers } from './users'
import { seedProducts } from './products'
import { seedOrders } from './orders'
import { seedServices } from './services'
// import { seedAppointments } from './appointments'  // full only

async function main() {
  const scope = process.argv[2] || 'standard'
  console.log(`Seeding ${scope} dataset...`)

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = drizzle(pool)

  try {
    // Layer 0: 基础数据
    await seedUsers(db)
    await seedProducts(db)
    console.log('[OK] Layer 0: users + products')

    if (scope === 'standard' || scope === 'full') {
      // Layer 2-3: 订单 + 服务单
      await seedOrders(db)
      await seedServices(db)
      console.log('[OK] Layer 2-3: orders + services')
    }

    if (scope === 'full') {
      // Layer 4: 预约 + 营业额分配
      // await seedAppointments(db)
      console.log('[OK] Layer 4: appointments + allocations')
    }

    console.log(`\nSeed complete (${scope})`)
  } finally {
    await pool.end()
  }
}

main().catch(console.error)
```

运行方式：

```bash
cd db && DATABASE_URL="$DATABASE_URL" npx tsx seed/index.ts [minimal|standard|full]
```

---

## Step 5: 验证种子数据

### 5.1 PG 数据验证

通过 API 调用验证数据已正确写入：

```text
验证清单：
  [ ] auth.login (clientApi) → 返回 test-client-001 用户信息
  [ ] auth.login (staffApi) → 返回 test-staff-001 员工信息
  [ ] product.categories → 返回测试分类
  [ ] product.skuDetail → 返回 SKU 价格（从 WorkFine 实时读取）
  [ ] order.list → 返回种子订单
  [ ] service.list → 返回种子服务单（standard+）
```

### 5.2 WorkFine 可访问性验证

确认 WorkFine 只读数据可正常访问：

```text
WorkFine 验证：
  [ ] store.list → 返回门店列表（UDT_M_219）
  [ ] staff.list → 返回员工列表（UDT_S_287）
  [ ] product.skuDetail → 返回 WorkFine 价格（UDT_M_1281/1383）
  [ ] customer.search → 返回顾客档案（UDT_S_311）
```

### 5.3 数据关联完整性

```text
关联检查：
  [ ] order_items.order_no → 对应 orders 存在
  [ ] order_items.sku_id → 对应 product_spu_sku_map 存在
  [ ] service_items.item_flow_no → 对应 order_items 存在
  [ ] service_items.service_order_no → 对应 service_orders 存在
  [ ] appointments.client_user_id → 对应 client_wechat_users 存在
  [ ] staff_wechat_users.staff_wf_id → WorkFine 中有对应员工记录
```

---

## Step 6: 数据清理

### 6.1 清理脚本

```typescript
// db/seed/cleanup.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'

async function cleanup() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = drizzle(pool)

  try {
    // 按外键依赖逆序删除（Layer 4 → 0）
    await db.execute(sql`DELETE FROM revenue_allocation_items WHERE allocation_id IN (SELECT id FROM revenue_allocations WHERE order_no LIKE 'FY-XSD-WX-%901')`)
    await db.execute(sql`DELETE FROM revenue_allocations WHERE order_no LIKE 'FY-XSD-WX-%901'`)
    await db.execute(sql`DELETE FROM appointments WHERE client_user_id LIKE 'test-%'`)
    await db.execute(sql`DELETE FROM service_items WHERE service_item_id LIKE 'test-%'`)
    await db.execute(sql`DELETE FROM service_orders WHERE service_order_no LIKE 'HLD-WX-%901'`)
    await db.execute(sql`DELETE FROM order_items WHERE item_flow_no LIKE 'XSLSH-WX-%90%'`)
    await db.execute(sql`DELETE FROM orders WHERE order_no LIKE 'FY-XSD-WX-%901'`)
    await db.execute(sql`DELETE FROM product_spu_sku_map WHERE sku_id LIKE 'test-%'`)
    await db.execute(sql`DELETE FROM product_spu WHERE spu_id LIKE 'test-%'`)
    await db.execute(sql`DELETE FROM staff_wechat_users WHERE user_id LIKE 'test-%'`)
    await db.execute(sql`DELETE FROM client_wechat_users WHERE user_id LIKE 'test-%'`)

    console.log('[OK] Test data cleaned up')
  } finally {
    await pool.end()
  }
}

cleanup().catch(console.error)
```

运行方式：

```bash
cd db && DATABASE_URL="$DATABASE_URL" npx tsx seed/cleanup.ts
```

### 6.2 清理原则

- 种子数据使用 `test-` 前缀的 ID，便于批量清理
- 订单号使用 `901`-`909` 段，不与业务序号冲突
- 清理顺序必须与写入顺序相反（先删子表再删主表）
- **永远不要 TRUNCATE 整个表**，只删除 `test-` 前缀的记录

---

## 输出摘要

```text
=== 种子数据报告 ===

数据范围：[minimal/standard/full]
目标环境：[envId]

写入数据：
  client_wechat_users: X 条
  staff_wechat_users: X 条
  product_spu: X 条
  product_spu_sku_map: X 条
  orders: X 条（standard+）
  order_items: X 条（standard+）
  service_orders: X 条（standard+）
  service_items: X 条（standard+）
  appointments: X 条（full）
  revenue_allocations: X 条（full）

WorkFine 验证：
  门店数据: [可访问/不可访问]
  员工数据: [可访问/不可访问]
  商品价格: [可访问/不可访问]

验证结果：X/Y 通过
```
