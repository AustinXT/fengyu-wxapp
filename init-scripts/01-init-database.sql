-- Fengyu Database Initialization Script
-- 此脚本在 PostgreSQL 容器首次启动时自动执行

-- 设置客户端编码
SET client_encoding = 'UTF8';

-- 创建扩展（如果需要）
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 注意：POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB 已在 docker-compose.yml 中配置
-- Docker entrypoint 脚本会自动创建用户和数据库

-- 授予 fengyu 用户必要的权限
GRANT ALL PRIVILEGES ON DATABASE fengyu TO fengyu;
GRANT ALL PRIVILEGES ON SCHEMA public TO fengyu;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO fengyu;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO fengyu;

-- 设置默认权限（未来创建的表也会自动授权）
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO fengyu;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO fengyu;

-- 输出初始化完成信息
DO $$
BEGIN
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Fengyu Database Initialized Successfully';
    RAISE NOTICE 'Database: fengyu';
    RAISE NOTICE 'User: fengyu';
    RAISE NOTICE 'Extensions: uuid-ossp, pgcrypto';
    RAISE NOTICE '========================================';
END $$;
