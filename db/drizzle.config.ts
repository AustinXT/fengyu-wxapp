import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './schema/index.ts',
  out: './migrations',
  dbCredentials: {
    // 本地开发时使用环境变量，避免硬编码连接信息
    // 运行迁移前执行：export DATABASE_URL="postgresql://user:pass@host:5432/dbname"
    url: process.env.DATABASE_URL!,
  },
  // 迁移时输出详细日志
  verbose: true,
  // 严格模式：检测到破坏性变更时要求确认
  strict: true,
})
