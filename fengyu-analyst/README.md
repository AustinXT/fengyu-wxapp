# fengyu-analyst

凤御经营分析独立站点。

## 定位

`fengyu-analyst` 是独立部署的 Next.js 站点，面向 PC 和移动端经营分析场景。它不维护独立用户体系，登录、权限和数据库均复用 `fengyu-wxapp/fengyu-admin`。

## 本地开发

```bash
cd fengyu-analyst
npm install
npm run dev -- -p 3100

# Node.js 需要 22 或以上
```

建议同时启动管理后台：

```bash
cd ../fengyu-admin
npm run dev
```

## 环境变量

从 `.env.example` 复制：

```bash
cp .env.example .env.local
```

开发期默认使用 `data_center:dashboard` 作为访问权限。切换到正式分析权限时设置：

```text
ANALYST_VIEW_ACTION=analyst:view
```

## SSO

`fengyu-analyst` 读取 `fy-admin-token` Cookie，并使用共享 `JWT_SECRET` 校验。未登录时跳转到 `ADMIN_LOGIN_URL`。

生产环境需要 `fengyu-admin` 写入跨子域 Cookie：

```text
domain=.fengyu.xxx
secure=true
sameSite=lax
path=/
```

