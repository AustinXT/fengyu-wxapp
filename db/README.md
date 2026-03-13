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
# 1. 启动数据库（从 monorepo 根目录）
docker compose -f docker/docker-compose.yml up -d

# 2. 推送 schema（首次或 schema 变更后）
cd db && npm run db:push

# 3. 可视化管理
npm run db:studio
```

## Drizzle 命令

```bash
cd db
npm run db:generate   # 生成迁移文件（schema 变更后）
npm run db:migrate    # 执行迁移（生产环境）
npm run db:push       # 推送 schema（开发环境）
npm run db:studio     # 可视化管理工具
```

## Docker 管理

```bash
docker compose -f docker/docker-compose.yml ps        # 查看状态
docker compose -f docker/docker-compose.yml logs -f    # 查看日志
docker compose -f docker/docker-compose.yml stop       # 停止
docker compose -f docker/docker-compose.yml down       # 删除容器（保留数据）
docker compose -f docker/docker-compose.yml down -v    # 删除容器和数据（谨慎！）
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

## 当前 Schema

| 表名 | 说明 |
|------|------|
| org_nodes | 组织架构树（邻接表） |
| stores | 门店详情（扩展 org_nodes） |
| employees | 员工档案 |
| product_categories | 品项分类 |
| products | 商品主表 |
| product_skus | 商品规格 |
| client_wechat_users | 顾客端微信用户 + 档案 |
| staff_wechat_users | 员工端微信用户 |
| sale_orders | 订单主表 |
| sale_items | 销售明细 |
| sale_allocations | 营业额分配 |
| appointments | 预约表 |
| service_orders | 护理单 |
| service_items | 护理明细 |
| permission_roles | 权限角色分配 |
| commission_rate_matrix | 提成比例矩阵 |
| coupon_templates | 优惠券模板 |
| user_coupons | 用户优惠券实例 |
| store_unbind_requests | 门店解绑申请 |
| operation_logs | 操作审计日志 |

详细 schema 定义见 `schema/*.ts`，统一导出自 `schema/index.ts`。

## 故障排查

**端口被占用（本地 PostgreSQL 冲突）**
```bash
lsof -i :5432
brew services stop postgresql@14
```

**容器无法启动**
```bash
docker compose -f docker/docker-compose.yml logs
docker compose -f docker/docker-compose.yml down -v && docker compose -f docker/docker-compose.yml up -d
```

**Schema 推送失败**
```bash
cat db/.env                          # 检查环境变量
docker exec fengyu-postgres pg_isready -U fengyu
npx drizzle-kit push --force
```

## 相关文档

- [`CLAUDE.md`](./CLAUDE.md) — Schema 模块说明、同步脚本、架构关系
- [`scripts/`](./scripts/) — 部署、同步与验证脚本
