# PostgreSQL 部署完成总结

## ✅ 部署成功

**时间**: 2026-02-25
**状态**: 运行中
**数据库**: PostgreSQL 16.11 (Alpine)

---

## 📦 已创建的文件

### 配置文件
- `docker-compose.yml` - Docker Compose 配置
- `db/.env` - 数据库环境变量（已配置）
- `db/.env.example` - 环境变量模板

### 初始化文件
- `init-scripts/01-init-database.sql` - 数据库初始化脚本

### 脚本工具
- `setup-postgres.sh` - 一键部署脚本
- `verify-db.sh` - 数据库验证脚本

### 文档
- `POSTGRES_SETUP.md` - 完整部署指南
- `DATABASE_DEPLOYED.md` - 部署完成说明

---

## 🗄️ 数据库结构

### 数据表 (11 张)
✅ product_spu - SPU 商品主表
✅ product_spu_sku_map - SKU 映射表
✅ client_wechat_users - 客户端微信用户
✅ staff_wechat_users - 员工端微信用户
✅ orders - 订单主表
✅ order_items - 销售明细
✅ revenue_allocations - 营业额分配
✅ revenue_allocation_items - 业绩分类明细
✅ appointments - 预约表
✅ service_orders - 护理单
✅ service_items - 护理明细

### 枚举类型 (9 个)
✅ appointment_status - 预约状态
✅ big_category - 大类分类
✅ order_source - 订单来源
✅ order_status - 订单状态
✅ order_type - 订单类型
✅ payment_method - 支付方式
✅ product_type - 产品类型
✅ service_order_status - 护理单状态
✅ workfine_source - WorkFine 数据源

### 索引 (28 个)
✅ 主键索引 (11 个)
✅ 唯一索引 (8 个)
✅ 业务索引 (9 个)

---

## 🔗 连接信息

```
主机: localhost
端口: 5432
数据库: fengyu
用户名: fengyu
密码: fengyu123

连接字符串: postgresql://fengyu:fengyu123@localhost:5432/fengyu
```

---

## 🚀 快速开始

### 启动数据库
```bash
docker compose up -d
```

### 验证数据库
```bash
./verify-db.sh
```

### 连接数据库
```bash
docker exec -it fengyu-postgres psql -U fengyu -d fengyu
```

### 可视化管理
```bash
cd db
npm run db:studio
```

---

## ⚠️ 解决的问题

### 1. 本地 PostgreSQL 端口冲突
**问题**: 本地 PostgreSQL 服务占用 5432 端口，导致连接到错误的数据库实例
**解决**: 停止本地 PostgreSQL 服务 (`launchctl stop homebrew.mxcl.postgresql@14`)

### 2. Drizzle ORM SQL 语法错误
**问题**: 部分索引的 WHERE 子句语法不正确
**解决**: 修改 `db/schema/order.ts`，使用原始 SQL 字符串

**修复前**:
```typescript
.where(sql`${table.status} = '待支付' AND ${table.clientUserId} IS NOT NULL`)
```

**修复后**:
```typescript
.where(sql`status = '待支付' AND client_user_id IS NOT NULL`)
```

---

## 📝 后续步骤

1. ✅ 数据库已部署并初始化
2. ✅ Schema 已推送到数据库
3. ⏭️ 配置应用连接
4. ⏭️ 创建种子数据
5. ⏭️ 实现业务逻辑
6. ⏭️ 配置生产环境

---

## 📚 参考文档

- [DATABASE_DEPLOYED.md](./DATABASE_DEPLOYED.md) - 完整使用指南
- [POSTGRES_SETUP.md](./POSTGRES_SETUP.md) - 详细部署文档
- [Drizzle ORM 文档](https://orm.drizzle.team/docs/overview)
- [PostgreSQL 16 文档](https://www.postgresql.org/docs/16/index.html)

---

## 🎉 部署完成

数据库已成功部署并可以正常使用！
