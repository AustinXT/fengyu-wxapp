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

问答接口优先使用 Minimax OpenAI-compatible API。把 key 填到 `.env.local`：

```text
MINIMAX_API_KEY=你的 Minimax API Key
MINIMAX_BASE_URL=https://api.minimaxi.com/v1
MINIMAX_MODEL=MiniMax-M3
```

未配置 `MINIMAX_API_KEY` 时会兼容读取旧的 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`；完全未配置 key 时使用本地规则解析兜底，仍可回答常见复购率、趋势和排名问题。

助手会话历史保存在浏览器本地存储中，单浏览器最多保留 30 个会话。问答接口返回结构化 JSON：

```ts
{
  content: string
  visualizations: Array<{
    kind: "metrics" | "line" | "bar" | "table"
    title: string
    rows?: Array<Record<string, string | number | null>>
    metrics?: Array<{ label: string; value: string; helper?: string }>
  }>
}
```

看板指标目录由 `src/lib/metric-catalog.ts` 统一维护。当前仅 `repurchase` 已接入查询，其他 9 个指标位先以预留状态进入二级目录。

## SSO

`fengyu-analyst` 读取 `fy-admin-token` Cookie，并使用共享 `JWT_SECRET` 校验。未登录时跳转到 `ADMIN_LOGIN_URL`。

生产环境需要 `fengyu-admin` 写入跨子域 Cookie：

```text
domain=.fengyu.xxx
secure=true
sameSite=lax
path=/
```
