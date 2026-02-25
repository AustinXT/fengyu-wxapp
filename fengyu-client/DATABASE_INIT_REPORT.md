# PostgreSQL 数据库初始化完成报告

**完成时间**: 2026-02-25
**服务器**: ali-demo (47.113.202.7)
**数据库**: fengyu_wxapp
**端口**: 5433

---

## 一、PostgreSQL 安装

✅ **安装信息**:
- 版本: PostgreSQL 16
- 系统: Ubuntu 24.04 (Noble)
- 服务状态: Active (running)

✅ **数据库和用户**:
- 数据库名: `fengyu_wxapp`
- 用户名: `fengyu`
- 密码: `fengyu123`
- 端口: `5433`

✅ **远程访问配置**:
- 监听地址: `*` (所有网络接口)
- 防火墙: 端口 5433 已开放
- 认证方式: scram-sha-256

---

## 二、数据库表结构

✅ **已创建 11 张表**:

| 表名 | 说明 | 字段数 | 索引数 |
|------|------|--------|--------|
| `client_wechat_users` | 客户端微信用户 | 8 | 2 |
| `staff_wechat_users` | 员工端微信用户 | 8 | 2 |
| `product_spu` | SPU 商品概念 | 7 | 0 |
| `product_spu_sku_map` | SKU↔WorkFine 映射 | 8 | 1 |
| `orders` | 订单主表 | 19 | 4 |
| `order_items` | 订单明细 | 13 | 1 |
| `revenue_allocations` | 营业额分配 | 9 | 1 |
| `revenue_allocation_items` | 业绩分类明细 | 4 | 0 |
| `appointments` | 预约 | 13 | 2 |
| `service_orders` | 护理单主表 | 11 | 2 |
| `service_items` | 护理明细 | 6 | 0 |

✅ **枚举类型**:
- `appointment_status`: 预约状态
- `big_category`: 大分类
- `order_source`: 订单来源
- `order_status`: 订单状态
- `order_type`: 订单类型
- `payment_method`: 支付方式
- `product_type`: 产品类型
- `service_order_status`: 服务单状态
- `workfine_source`: WorkFine 数据源

✅ **索引和约束**:
- 主键: 所有表都有主键
- 外键: 10 个外键约束
- 唯一索引: 6 个（防止重复数据）
- 普通索引: 10 个（提升查询性能）

---

## 三、连接信息

### 3.1 连接字符串

```
postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp
```

### 3.2 psql 命令行连接

```bash
PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp
```

### 3.3 Node.js 连接示例

```javascript
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp'
});

const result = await pool.query('SELECT NOW()');
console.log(result.rows[0]);
```

---

## 四、云函数环境变量

✅ **已更新云函数环境变量** (RequestId: 44f99cc5-0d31-4e14-b274-ff4248f3e67b):

```
PG_CONNECTION_STRING=postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp
MSSQL_CONNECTION_STRING=Server=111.229.31.128,1433;Database=wkdb_20220804_86cd3292;User Id=Sa;Password=oHx#+Q;TrustServerCertificate=True
```

✅ **本地配置文件**:
- `fengyu-client/.env` - 已更新端口为 5433
- `fengyu-client/cloudbaserc.json` - 已更新端口为 5433

---

## 五、测试连接

### 5.1 本地测试

```bash
# 测试连接
PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp -c "SELECT NOW() as current_time, current_database() as database, current_user as user;"

# 查看表列表
PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp -c "\dt"

# 查看枚举类型
PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp -c "\dT+"
```

### 5.2 云函数测试

在 CloudBase 控制台测试云函数：

```json
{
  "action": "store.list",
  "payload": {}
}
```

**预期结果**: 应该能成功查询到 WorkFine 中的门店数据

---

## 六、下一步操作

### 6.1 插入测试数据（可选）

参考 `DATABASE_INIT.md` 中的测试数据 SQL，插入示例数据：

```sql
-- 插入测试 SPU
INSERT INTO product_spu (spu_id, name, category, big_category, cover_image, sort_order, created_at, updated_at)
VALUES
  ('spu_test_001', '蜜语生玑精华护理疗程', '蜜语生玑', '生美', 'https://example.com/mysj.jpg', 1, NOW(), NOW()),
  ('spu_test_002', '安吉丽美颜之爱护理', '安吉丽美颜之爱', '生美', 'https://example.com/ajl.jpg', 2, NOW(), NOW());

-- 插入测试 SKU 映射
INSERT INTO product_spu_sku_map (sku_id, spu_id, workfine_item_id, workfine_source, product_type, sku_display_name, sort_order, is_active, created_at, updated_at)
VALUES
  ('sku_test_001', 'spu_test_001', 'MYSJ001', 'UDT_M_1281', '疗程卡', '10次卡', 1, true, NOW(), NOW()),
  ('sku_test_002', 'spu_test_001', 'MYSJ002', 'UDT_M_1281', '疗程卡', '20次卡', 2, true, NOW(), NOW());
```

### 6.2 执行接口联调测试

使用 `cloudfunctions/clientApi/test_cases.json` 中的测试用例，在云函数测试面板中逐一验证：

1. ✅ 认证模块 (auth.login)
2. ⏳ 门店模块 (store.list) - 应该能查询 WorkFine 数据
3. ⏳ 商品模块 (product.categories, product.spuList)
4. ⏳ 员工模块 (staff.list)
5. ⏳ 订单模块 (order.create, order.list)
6. ⏳ 预约模块 (appointment.create)
7. ⏳ 服务模块 (service.detail)

### 6.3 配置数据同步任务

创建定时任务，从 WorkFine 同步商品数据到 PostgreSQL：

```bash
cd /Users/nv/proj.xt.com/fengyu-wxapp/db/scripts
export DATABASE_URL="postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp"
node sync-products-from-workfine.js
```

---

## 七、备份与恢复

### 7.1 备份数据库

```bash
# 备份结构和数据
PGPASSWORD=fengyu123 pg_dump -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp > backup_$(date +%Y%m%d).sql

# 仅备份结构
PGPASSWORD=fengyu123 pg_dump -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp --schema-only > schema_backup.sql

# 仅备份数据
PGPASSWORD=fengyu123 pg_dump -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp --data-only > data_backup.sql
```

### 7.2 恢复数据库

```bash
PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp < backup_20260225.sql
```

---

## 八、性能优化建议

### 8.1 连接池配置

云函数中已配置连接池（最大 5 连接）：

```javascript
const pool = new Pool({
  connectionString: process.env.PG_CONNECTION_STRING,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});
```

### 8.2 索引优化

已创建的关键索引：
- `idx_orders_client_user_id` - 按用户查询订单
- `idx_orders_store_status` - 按门店和状态查询订单
- `idx_appts_staff_time` - 按员工和时间查询预约
- `idx_svc_orders_store_date` - 按门店和日期查询服务单

### 8.3 查询优化建议

1. **使用索引**: WHERE 子句中使用已索引的字段
2. **避免 SELECT ***: 只查询需要的字段
3. **使用分页**: LIMIT + OFFSET 或游标分页
4. **使用事务**: 批量操作使用事务

---

## 九、安全建议

1. **定期备份**: 每天自动备份数据库
2. **限制访问**: 配置 pg_hba.conf 只允许特定 IP 访问
3. **监控连接**: 监控连接数，防止连接泄露
4. **定期清理**: 清理过期数据和日志

---

## 十、故障排查

### 问题 1: 连接超时

**排查步骤**:
```bash
# 1. 测试网络连通性
telnet 47.113.202.7 5433

# 2. 检查防火墙
ssh ali-demo "ufw status | grep 5433"

# 3. 检查 PostgreSQL 监听
ssh ali-demo "netstat -tlnp | grep 5433"
```

### 问题 2: 认证失败

**排查步骤**:
```bash
# 1. 检查用户是否存在
ssh ali-demo "sudo -u postgres psql -c \"\du fengyu\""

# 2. 重置密码
ssh ali-demo "sudo -u postgres psql -c \"ALTER USER fengyu WITH PASSWORD 'fengyu123';\""

# 3. 检查 pg_hba.conf
ssh ali-demo "cat /etc/postgresql/16/main/pg_hba.conf | grep -v '^#' | grep -v '^$'"
```

### 问题 3: 表不存在

**排查步骤**:
```bash
# 查看所有表
PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp -c "\dt"

# 重新执行迁移
cd /Users/nv/proj.xt.com/fengyu-wxapp/db
PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp -f migrations/0000_equal_earthquake.sql
```

---

**数据库初始化完成！** 🎉

PostgreSQL 已成功安装并初始化，云函数环境变量已配置，可以开始进行接口测试和前端集成了。
