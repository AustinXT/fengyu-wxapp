# fengyu-wxapp 数据库

PostgreSQL + Drizzle ORM，通过 Docker Compose 管理本地开发环境。

## 连接信息

```
主机: localhost / 端口: 5432
数据库: fengyu / 用户名: fengyu / 密码: fengyu123
连接字符串: postgresql://fengyu:fengyu123@localhost:5432/fengyu
```

## 快速开始

```bash
# 1. 启动数据库
docker compose up -d

# 2. 推送 schema（首次或 schema 变更后）
cd db && npm run db:push

# 3. 可视化管理
npm run db:studio
```

## Drizzle 命令

```bash
cd db
npm run db:generate   # 生成迁移文件（schema 变更后）
npm run db:migrate    # 执行迁移
npm run db:push       # 推送 schema（开发环境）
npm run db:studio     # 可视化管理工具
```

## Docker 管理

```bash
docker compose ps               # 查看状态
docker compose logs -f postgres # 查看日志
docker compose stop             # 停止
docker compose restart          # 重启
docker compose down             # 删除容器（保留数据）
docker compose down -v          # 删除容器和数据（谨慎！）
```

## 常用操作

```bash
# 进入数据库命令行
docker exec -it fengyu-postgres psql -U fengyu -d fengyu

# 查看所有表
docker exec fengyu-postgres psql -U fengyu -d fengyu -c "\dt"

# 备份
docker exec fengyu-postgres pg_dump -U fengyu fengyu > backup_$(date +%Y%m%d).sql

# 恢复
cat backup.sql | docker exec -i fengyu-postgres psql -U fengyu fengyu

# 运行验证脚本
./scripts/verify-db.sh
```

## 当前 Schema（11 张表）

| 表名 | 说明 |
|------|------|
| product_spu | SPU 商品主表 |
| product_spu_sku_map | SKU 映射表 |
| client_wechat_users | 客户端微信用户 |
| staff_wechat_users | 员工端微信用户 |
| orders | 订单主表 |
| order_items | 销售明细 |
| revenue_allocations | 营业额分配 |
| revenue_allocation_items | 业绩分类明细 |
| appointments | 预约表 |
| service_orders | 护理单 |
| service_items | 护理明细 |

## 故障排查

**端口被占用（本地 PostgreSQL 冲突）**
```bash
lsof -i :5432
brew services stop postgresql@14
```

**容器无法启动**
```bash
docker compose logs postgres
docker compose down -v && docker compose up -d
```

**Schema 推送失败**
```bash
cat db/.env                          # 检查环境变量
docker exec fengyu-postgres pg_isready -U fengyu
npx drizzle-kit push --force
```

## 相关文档

- [`POSTGRES_SETUP.md`](./POSTGRES_SETUP.md) - 完整部署指南（含阿里云服务器部署）
- [`DATABASE_INIT.md`](./DATABASE_INIT.md) - 数据库初始化详细步骤
- [`scripts/`](./scripts/) - 部署与验证脚本
