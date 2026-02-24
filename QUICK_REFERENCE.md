# PostgreSQL 快速参考

## 🚀 常用命令

### Docker 操作
```bash
docker compose up -d          # 启动数据库
docker compose ps             # 查看状态
docker compose logs -f        # 查看日志
docker compose stop           # 停止数据库
docker compose restart        # 重启数据库
docker compose down           # 删除容器（保留数据）
docker compose down -v        # 删除容器和数据
```

### 数据库连接
```bash
# 命令行连接
docker exec -it fengyu-postgres psql -U fengyu -d fengyu

# 本地 psql 连接（如已安装）
psql postgresql://fengyu:fengyu123@localhost:5432/fengyu

# Node.js 连接
const postgres = require('postgres');
const sql = postgres('postgresql://fengyu:fengyu123@localhost:5432/fengyu');
```

### Drizzle ORM
```bash
cd db
npm run db:generate           # 生成迁移文件
npm run db:migrate            # 执行迁移
npm run db:push --force       # 推送 schema（开发）
npm run db:studio             # 可视化管理
```

### 数据备份
```bash
# 备份
docker exec fengyu-postgres pg_dump -U fengyu fengyu > backup.sql

# 恢复
cat backup.sql | docker exec -i fengyu-postgres psql -U fengyu fengyu
```

## 🔍 验证命令

```bash
# 连接测试
docker exec fengyu-postgres pg_isready -U fengyu

# 查看表
docker exec fengyu-postgres psql -U fengyu -d fengyu -c "\dt"

# 查看索引
docker exec fengyu-postgres psql -U fengyu -d fengyu -c "\di"

# 查看枚举
docker exec fengyu-postgres psql -U fengyu -d fengyu -c "\dT+"

# 运行验证脚本
./verify-db.sh
```

## 📊 连接信息

```
主机: localhost
端口: 5432
数据库: fengyu
用户名: fengyu
密码: fengyu123

连接字符串: postgresql://fengyu:fengyu123@localhost:5432/fengyu
```

## 🆘 故障排查

### 端口被占用
```bash
# 检查占用
lsof -i :5432

# 停止本地 PostgreSQL
brew services stop postgresql@14
# 或
launchctl stop homebrew.mxcl.postgresql@14
```

### 容器无法启动
```bash
# 查看日志
docker compose logs postgres

# 重新创建
docker compose down -v
docker compose up -d
```

### Schema 推送失败
```bash
# 检查连接
cat db/.env

# 强制推送
cd db
npx drizzle-kit push --force
```

## 📚 完整文档

- `DATABASE_DEPLOYED.md` - 部署完成说明
- `POSTGRES_SETUP.md` - 完整部署指南
- `DEPLOYMENT_SUMMARY.md` - 部署总结
