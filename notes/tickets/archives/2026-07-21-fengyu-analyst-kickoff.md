# fengyu-analyst 新版开发启动清单

日期：2026-07-21
分支：`analyst`
worktree：`/Users/nv/proj.xt.com/worktrees/fengyu-wxapp/analyst/fengyu-wxapp`

## 当前决策

`fengyu-analyst` 作为独立 Next.js 站点开发，使用独立子域名和移动端适配；但登录、权限、数据库、组织 scope、指标口径与 `fengyu-wxapp` 统一。

## 第一阶段目标

完成最小可运行站点：

- 独立 `fengyu-analyst` Next.js 应用
- 复用 `db/schema`
- 读取 `fy-admin-token`
- 复用 `JWT_SECRET`
- 查询员工和权限
- 使用 `data_center:dashboard` 作为临时访问门槛
- 提供移动端友好的 dashboard / assistant / knowledge 页面壳

## 待办

- [x] 安装 `fengyu-analyst` 依赖
- [x] 配置 `.env.local`
- [x] 复制根目录 `envs/` 到 worktree
- [x] 启动 `fengyu-admin` 和 `fengyu-analyst` 双站点本地联调
- [x] 调整 `fengyu-admin` Cookie domain，支持生产跨子域 SSO
- [ ] 在 `fengyu-admin` 增加外链入口
- [ ] 把访问权限从 `data_center:dashboard` 切换到 `analyst:view`
- [ ] 实现复购率 PostgreSQL 查询
- [ ] 接入 Vercel AI SDK 智能助手

## 本地建议端口

```text
fengyu-admin    http://localhost:3000
fengyu-analyst  http://localhost:3100
```

同一 hostname 下，HttpOnly Cookie 可跨端口发送；生产环境再通过 `.fengyu.xxx` Cookie domain 支持跨子域。

## 已验证

- 测试账号 `15958024945` 可通过 `fengyu-admin` 数据库认证，角色包含 `admin`、`manager`，无需强制改密。
- 未登录访问 `fengyu-analyst /dashboard` 会跳转到 `fengyu-admin /login?returnTo=...`。
- 已登录访问 `fengyu-admin /login?returnTo=http://localhost:3100/dashboard` 会跳转回 `fengyu-analyst /dashboard`。
- 已登录访问 `fengyu-analyst /dashboard` 返回 200。
