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

问答接口当前以服务端确定性查询结果为唯一事实来源，不调用模型改写最终答案。以下 Minimax OpenAI-compatible 配置仅作为保留配置，不参与当前回答链路：

```text
MINIMAX_API_KEY=你的 Minimax API Key
MINIMAX_BASE_URL=https://api.minimaxi.com/v1
MINIMAX_MODEL=MiniMax-M3
```

无论是否配置 `MINIMAX_API_KEY` 或旧的 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`，当前均由本地规则和数据库查询回答复购率、普及率、新客漏斗及上海时间问题；能力范围外的问题会明确拒答。

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
