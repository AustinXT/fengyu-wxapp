# PostgreSQL 数据库部署完成

## ✅ 部署状态

- **Docker 容器**: 运行中 (fengyu-postgres)
- **数据库版本**: PostgreSQL 16.11 (Alpine)
- **数据库状态**: 已初始化
- **Schema 状态**: 已推送 (11 张表, 9 个枚举类型)

## 📊 数据库连接信息

```
主机: localhost
端口: 5432
数据库: fengyu
用户名: fengyu
密码: fengyu123
```

**连接字符串**:
```
postgresql://fengyu:fengyu123@localhost:5432/fengyu
```

## 📋 已创建的数据表

1. **product_spu** - SPU 商品主表
2. **product_spu_sku_map** - SKU 映射表
3. **client_wechat_users** - 客户端微信用户
4. **staff_wechat_users** - 员工端微信用户
5. **orders** - 订单主表
6. **order_items** - 销售明细
7. **revenue_allocations** - 营业额分配
8. **revenue_allocation_items** - 业绩分类明细
9. **appointments** - 预约表
10. **service_orders** - 护理单
11. **service_items** - 护理明细

## 🔧 常用命令

### Docker 管理

```bash
# 查看容器状态
docker compose ps

# 查看日志
docker compose logs -f postgres

# 停止数据库
docker compose stop

# 启动数据库
docker compose start

# 重启数据库
docker compose restart

# 停止并删除容器
docker compose down

# 完全清理（包括数据）
docker compose down -v
```

### 数据库操作

```bash
# 进入数据库命令行
docker exec -it fengyu-postgres psql -U fengyu -d fengyu

# 查看所有表
docker exec fengyu-postgres psql -U fengyu -d fengyu -c "\dt"

# 查看表结构
docker exec fengyu-postgres psql -U fengyu -d fengyu -c "\d+ 表名"

# 备份数据库
docker exec fengyu-postgres pg_dump -U fengyu fengyu > backup_$(date +%Y%m%d).sql

# 恢复数据库
cat backup.sql | docker exec -i fengyu-postgres psql -U fengyu fengyu
```

### Drizzle ORM

```bash
cd db

# 生成迁移文件（schema 变更后）
npm run db:generate

# 执行迁移
npm run db:migrate

# 推送 schema（开发环境）
npm run db:push --force

# 可视化管理工具
npm run db:studio
```

### 验证脚本

```bash
# 验证数据库
./verify-db.sh
```

## 🚨 故障排查

### 1. 连接失败：role "fengyu" does not exist

**原因**: 本地 PostgreSQL 服务占用端口

**解决**:
```bash
# 检查端口占用
lsof -i :5432

# 停止本地 PostgreSQL
brew services stop postgresql@14
# 或
launchctl stop homebrew.mxcl.postgresql@14
```

### 2. Docker 容器无法启动

**检查步骤**:
```bash
# 查看容器日志
docker compose logs postgres

# 检查 Docker 状态
docker info

# 重新创建容器
docker compose down -v
docker compose up -d
```

### 3. Schema 推送失败

**解决方案**:
```bash
# 检查环境变量
cat db/.env

# 确认数据库连接
docker exec fengyu-postgres pg_isready -U fengyu

# 强制推送
cd db
npx drizzle-kit push --force
```

## 📝 下一步操作

1. **配置应用连接**
   - 在应用中使用 `DATABASE_URL` 环境变量
   - 或使用连接参数配置 Drizzle ORM

2. **开发工作流**
   ```bash
   # 修改 schema 文件 (db/schema/*.ts)
   # 生成迁移
   cd db && npm run db:generate

   # 执行迁移
   npm run db:migrate

   # 或直接推送（开发环境）
   npm run db:push --force
   ```

3. **数据填充**
   - 创建种子数据脚本
   - 使用 Drizzle ORM 插入初始数据

4. **备份策略**
   ```bash
   # 定期备份
   docker exec fengyu-postgres pg_dump -U fengyu fengyu | gzip > backup_$(date +%Y%m%d).sql.gz
   ```

## 📚 相关文档

- [POSTGRES_SETUP.md](./POSTGRES_SETUP.md) - 完整部署指南
- [Drizzle ORM 文档](https://orm.drizzle.team/docs/overview)
- [PostgreSQL 16 文档](https://www.postgresql.org/docs/16/index.html)

## ⚠️ 重要提示

1. **生产环境安全**
   - 修改默认密码
   - 配置防火墙规则
   - 启用 SSL 连接
   - 定期更新备份

2. **数据持久化**
   - 数据存储在 Docker volume `fengyu-wxapp_postgres_data`
   - 执行 `docker compose down -v` 会删除所有数据
   - 定期备份数据库

3. **性能优化**
   - 根据实际负载调整 PostgreSQL 配置
   - 监控慢查询
   - 定期执行 VACUUM ANALYZE
