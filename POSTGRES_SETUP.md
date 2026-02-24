# PostgreSQL Docker 部署指南

## 快速开始

### 1. 启动数据库

```bash
# 在项目根目录执行
docker-compose up -d

# 查看日志
docker-compose logs -f postgres

# 查看容器状态
docker-compose ps
```

### 2. 配置环境变量

在 `db` 目录下创建 `.env` 文件：

```bash
cd db
cp .env.example .env
```

### 3. 生成迁移文件

```bash
cd db
npm install
npm run db:generate
```

### 4. 执行数据库迁移

```bash
npm run db:migrate
```

### 5. 使用 Drizzle Studio 查看数据

```bash
npm run db:studio
```

## 常用命令

### Docker 操作

```bash
# 停止数据库
docker-compose stop

# 启动数据库
docker-compose start

# 重启数据库
docker-compose restart

# 停止并删除容器（数据保留）
docker-compose down

# 停止并删除容器和数据卷（清空所有数据）
docker-compose down -v

# 查看数据库日志
docker-compose logs -f postgres

# 进入 PostgreSQL 命令行
docker exec -it fengyu-postgres psql -U fengyu -d fengyu
```

### 数据库连接

**连接信息：**
- 主机：localhost
- 端口：5432
- 数据库：fengyu
- 用户名：fengyu
- 密码：fengyu123

**连接字符串：**
```
postgresql://fengyu:fengyu123@localhost:5432/fengyu
```

### 使用 psql 客户端连接

```bash
# 本地安装了 psql 的情况
psql -h localhost -U fengyu -d fengyu

# 或使用连接字符串
psql "postgresql://fengyu:fengyu123@localhost:5432/fengyu"
```

### 数据备份与恢复

```bash
# 备份数据库
docker exec fengyu-postgres pg_dump -U fengyu fengyu > backup_$(date +%Y%m%d_%H%M%S).sql

# 恢复数据库
cat backup.sql | docker exec -i fengyu-postgres psql -U fengyu fengyu
```

## 生产环境建议

### 安全配置

1. **修改默认密码**：编辑 `docker-compose.yml` 中的 `POSTGRES_PASSWORD`
2. **限制端口访问**：如不需要外部访问，移除 `ports` 配置
3. **使用 secrets**：使用 Docker secrets 管理敏感信息
4. **启用 SSL**：配置 SSL 证书加密连接

### 性能优化

```yaml
# 在 docker-compose.yml 中添加 PostgreSQL 配置
command:
  - "postgres"
  - "-c"
  - "max_connections=200"
  - "-c"
  - "shared_buffers=256MB"
  - "-c"
  - "work_mem=4MB"
  - "-c"
  - "maintenance_work_mem=64MB"
  - "-c"
  - "effective_cache_size=1GB"
```

### 持久化存储

数据存储在 Docker volume `postgres_data` 中，位置：
```bash
# 查看卷位置
docker volume inspect fengyu-wxapp_postgres_data
```

## 故障排查

### 1. 容器无法启动

```bash
# 查看详细日志
docker-compose logs postgres

# 检查端口占用
lsof -i :5432

# 检查容器状态
docker-compose ps
```

### 2. 连接被拒绝

```bash
# 检查容器是否运行
docker-compose ps

# 检查健康状态
docker inspect fengyu-postgres | grep -A 10 Health

# 测试连接
docker exec fengyu-postgres pg_isready -U fengyu
```

### 3. 权限问题

```bash
# 重新授权
docker exec -it fengyu-postgres psql -U postgres -c "
  GRANT ALL PRIVILEGES ON DATABASE fengyu TO fengyu;
  GRANT ALL PRIVILEGES ON SCHEMA public TO fengyu;
"
```

### 4. 数据迁移失败

```bash
# 检查 schema 文件
cd db
npm run db:generate

# 手动推送 schema（开发环境）
npm run db:push

# 查看迁移状态
ls -la migrations/
```

## 开发工作流

### 首次设置

```bash
# 1. 启动数据库
docker-compose up -d

# 2. 配置环境
cd db && cp .env.example .env

# 3. 安装依赖
npm install

# 4. 推送 schema（开发环境快速同步）
npm run db:push
```

### Schema 变更流程

```bash
# 1. 修改 schema 文件（db/schema/*.ts）

# 2. 生成迁移文件
npm run db:generate

# 3. 检查生成的迁移文件
cat migrations/0001_*.sql

# 4. 执行迁移
npm run db:migrate

# 5. 验证结果
npm run db:studio
```

## 监控与维护

### 查看数据库统计

```bash
docker exec -it fengyu-postgres psql -U fengyu -d fengyu -c "
  SELECT
    datname,
    numbackends,
    xact_commit,
    xact_rollback,
    blks_read,
    blks_hit
  FROM pg_stat_database
  WHERE datname = 'fengyu';
"
```

### 查看表大小

```bash
docker exec -it fengyu-postgres psql -U fengyu -d fengyu -c "
  SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
  FROM pg_tables
  WHERE schemaname = 'public'
  ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
"
```

### 清理日志

```bash
# PostgreSQL 自动清理，如需手动触发
docker exec -it fengyu-postgres psql -U fengyu -d fengyu -c "VACUUM ANALYZE;"
```
