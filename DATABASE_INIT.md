# PostgreSQL 数据库初始化指南

> 本文档指导如何使用 Drizzle ORM 初始化小程序数据库表结构

---

## 一、前置条件

### 1.1 环境要求
- Node.js >= 18
- PostgreSQL >= 14
- 已创建数据库实例

### 1.2 数据库连接信息

```bash
# 示例连接信息,替换为实际值
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=fengyu_wxapp
PG_USER=postgres
PG_PASSWORD=your_password
```

---

## 二、安装依赖

```bash
cd /Users/nv/proj.xt.com/fengyu-wxapp/db
npm install
```

---

## 三、配置数据库连接

### 3.1 创建环境变量文件

```bash
# 创建 .env 文件
cat > .env << 'EOF'
DATABASE_URL="postgresql://postgres:your_password@localhost:5432/fengyu_wxapp"
EOF
```

### 3.2 检查 drizzle.config.ts

```typescript
// db/drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
```

---

## 四、生成迁移文件

### 4.1 生成迁移 SQL

```bash
npx drizzle-kit generate
```

预期输出:
```
drizzle-kit: v0.x.x
drizzle-orm: v0.x.x

1 tables
orders 3 indexes 0 fks
+ 3 other tables

[✓] Your SQL migration file is ready ➜ drizzle/0000_*.sql
```

### 4.2 查看生成的迁移文件

```bash
ls -la drizzle/
```

应该看到类似:
```
0000_busy_living_tribunal.sql
meta/
  0000_snapshot.json
  _journal.json
```

---

## 五、执行迁移

### 5.1 推送表结构到数据库

```bash
npx drizzle-kit push
```

预期输出:
```
drizzle-kit: v0.x.x
drizzle-orm: v0.x.x

[✓] Pulling schema from database...
[✓] Schema pushed successfully
```

### 5.2 验证表结构

```bash
psql -U postgres -d fengyu_wxapp -c "\dt"
```

预期输出应包含:
```
               List of relations
 Schema |        Name         | Type  |  Owner
--------+---------------------+-------+----------
 public | client_wechat_users | table | postgres
 public | staff_wechat_users  | table | postgres
 public | product_spu         | table | postgres
 public | product_spu_sku_map | table | postgres
 public | orders              | table | postgres
 public | order_items         | table | postgres
 public | revenue_allocations | table | postgres
 public | revenue_allocation_items | table | postgres
 public | appointments        | table | postgres
 public | service_orders      | table | postgres
 public | service_items       | table | postgres
```

---

## 六、插入测试数据

### 6.1 连接数据库

```bash
psql -U postgres -d fengyu_wxapp
```

### 6.2 插入 SPU 测试数据

```sql
-- 插入测试 SPU
INSERT INTO product_spu (spu_id, name, category, big_category, cover_image, sort_order, created_at, updated_at)
VALUES
  ('spu_test_001', '蜜语生玑精华护理疗程', '蜜语生玑', '生美', 'https://example.com/mysj.jpg', 1, NOW(), NOW()),
  ('spu_test_002', '安吉丽美颜之爱护理', '安吉丽美颜之爱', '生美', 'https://example.com/ajl.jpg', 2, NOW(), NOW()),
  ('spu_test_003', '蜜语生肌按摩膏(院装)', '院装产品', '院装产品', 'https://example.com/yz.jpg', 999, NOW(), NOW());

-- 插入测试 SKU 映射(疗程卡)
INSERT INTO product_spu_sku_map (sku_id, spu_id, workfine_item_id, workfine_source, product_type, sku_display_name, sort_order, is_active, created_at, updated_at)
VALUES
  ('sku_test_001', 'spu_test_001', 'MYSJ001', 'UDT_M_1281', '疗程卡', '10次卡', 1, true, NOW(), NOW()),
  ('sku_test_002', 'spu_test_001', 'MYSJ002', 'UDT_M_1281', '疗程卡', '20次卡', 2, true, NOW(), NOW()),
  ('sku_test_003', 'spu_test_002', 'AJL001', 'UDT_M_1281', '单品', '单次体验', 1, true, NOW(), NOW()),
  ('sku_test_004', 'spu_test_003', 'MZHAJL0910-015', 'UDT_M_341', '院装产品', '285ml/瓶', 1, true, NOW(), NOW());

-- 插入测试订单
INSERT INTO orders (
  order_no, status, order_type, market_name, store_name, order_datetime,
  client_phone, customer_name, payment_method, order_source, created_at, updated_at
)
VALUES
  (
    'FY-XSD-WX-250225001', '待支付', '正式', '南商市场', '南昌梦祥店',
    '2026-02-25 10:00:00', '13800138000', '张三', 'wechat', 'staff', NOW(), NOW()
  );

-- 查询验证
SELECT * FROM product_spu;
SELECT * FROM product_spu_sku_map;
SELECT * FROM orders;
```

---

## 七、配置云函数环境变量

### 7.1 通过微信开发者工具配置

1. 打开微信开发者工具
2. 进入「云开发」控制台
3. 选择环境 `cloud1-3gpht4b01ff88838`
4. 进入「云函数」→「clientApi」→「配置」
5. 添加环境变量:

```
DATABASE_URL=postgresql://postgres:your_password@your_host:5432/fengyu_wxapp
MSSQL_SERVER=111.229.31.128
MSSQL_PORT=1433
MSSQL_DATABASE=wkdb_20220804_86cd3292
MSSQL_USER=Sa
MSSQL_PASSWORD=oHx#+Q
```

### 7.2 通过 cloudbase CLI 配置(可选)

```bash
tcb fn code update clientApi --envId cloud1-3gpht4b01ff88838 \
  --env DATABASE_URL="postgresql://..." \
  --env MSSQL_SERVER="111.229.31.128"
```

---

## 八、验证数据库连接

### 8.1 测试 PostgreSQL 连接

在云函数中添加测试代码:

```javascript
// cloudfunctions/clientApi/routes/test.js
const pg = require('../db/pg')

async function testPg(ctx) {
  try {
    const result = await pg.query('SELECT NOW() as now')
    ctx.result = {
      connected: true,
      timestamp: result[0].now
    }
  } catch (err) {
    ctx.result = {
      connected: false,
      error: err.message
    }
  }
}

module.exports = { testPg }
```

调用测试:
```json
{
  "action": "test.testPg",
  "payload": {}
}
```

### 8.2 测试 WorkFine SQL Server 连接

```javascript
async function testMssql(ctx) {
  try {
    const result = await mssql.query('SELECT TOP 1 UDF_M_438 FROM UDT_M_219')
    ctx.result = {
      connected: true,
      sampleStore: result[0].UDF_M_438
    }
  } catch (err) {
    ctx.result = {
      connected: false,
      error: err.message
    }
  }
}
```

---

## 九、常见问题

### Q1: Drizzle Kit 生成迁移失败

**错误**: `Cannot find module 'drizzle-orm'`

**解决**: 确保已安装依赖
```bash
npm install drizzle-orm drizzle-kit pg
npm install -D @types/pg
```

---

### Q2: 推送表结构失败

**错误**: `relation "orders" already exists`

**解决**: 删除已存在的表重新推送
```sql
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
-- ... 其他表
```

---

### Q3: 云函数连接数据库超时

**错误**: `Connection timeout`

**解决**:
1. 检查数据库是否允许云函数 IP 访问
2. 检查安全组/防火墙规则
3. 增加连接超时配置:

```javascript
// db/pg.js
const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  query_timeout: 10000
})
```

---

### Q4: WorkFine SQL Server 连接失败

**错误**: `Login failed for user 'Sa'`

**解决**:
1. 验证用户名密码是否正确
2. 检查 SQL Server 是否启用混合模式认证
3. 检查防火墙是否开放 1433 端口

---

## 十、数据库备份与恢复

### 10.1 备份

```bash
pg_dump -U postgres -d fengyu_wxapp > backup_$(date +%Y%m%d).sql
```

### 10.2 恢复

```bash
psql -U postgres -d fengyu_wxapp < backup_20260225.sql
```

---

## 十一、下一步

1. ✅ 完成数据库表结构初始化
2. ✅ 插入测试数据
3. ✅ 配置云函数环境变量
4. ⏳ 部署云函数到微信云开发环境
5. ⏳ 执行接口联调测试

---

## 附录: 表结构概览

| 表名 | 说明 | 记录数(预估) |
|-----|------|------------|
| client_wechat_users | 客户端微信用户 | 1,000+ |
| staff_wechat_users | 员工端微信用户 | 100+ |
| product_spu | SPU 商品概念 | 50+ |
| product_spu_sku_map | SKU↔WorkFine 映射 | 200+ |
| orders | 订单主表 | 10,000+ |
| order_items | 订单明细 | 30,000+ |
| revenue_allocations | 营业额分配 | 20,000+ |
| revenue_allocation_items | 业绩分类明细 | 50,000+ |
| appointments | 预约 | 5,000+ |
| service_orders | 护理单主表 | 20,000+ |
| service_items | 护理明细 | 60,000+ |
