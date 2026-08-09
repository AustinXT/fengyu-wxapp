# envs/ — 双环境配置中央目录

凤御项目有 **两个 CloudBase env**（dev / prod），分别承载完整的云函数 + PG 链路。
此目录是所有环境差异变量的 **单一权威源**。

## 拓扑

| 端 | dev/测试 envId | dev/测试 PG | prod envId | prod PG |
|----|-----------|-------------|------------|---------|
| client | `cloud1-3gpht4b01ff88838` | 47.113.202.7:5433/fengyu_wxapp | `fengyu-client-prod-d1cga6909c0ba` | 118.178.196.26:5433/fengyu_wxapp |
| staff | `cloud1-9g3ydpg512eecc99` | 47.113.202.7:5433/fengyu_wxapp | `fengyu-staff-prod-d4dtv6052992e9` | 118.178.196.26:5433/fengyu_wxapp |

dev 与 prod 由 **两个不同的腾讯云子账号** 管理（账号凭证在 `fengyu-{client,staff}/.env`）。

## 文件

| 文件 | git | 说明 |
|------|-----|------|
| `dev.env.example` / `prod.env.example` | ✓ | 占位符模板，列出所有必需变量 |
| `dev.env` / `prod.env` | ✗ | 真实值（含 PEM / SM4 / 拉卡拉密钥） |
| `.active` | ✗ | 当前 active env 名（dev / prod），由 use-env.sh 写 |

## 使用

```bash
# 初始化（首次 clone 或新建 env）
cp envs/dev.env.example envs/dev.env       # 然后从现有 .env / cloudbaserc 收集实值
cp envs/prod.env.example envs/prod.env     # prod 实值需向商户经理/运维申请

# 切到 dev 做开发或部署
scripts/use-env.sh dev

# 切到 prod 部署生产
scripts/use-env.sh prod

# 看当前 active
cat envs/.active
```

`use-env.sh` 会渲染：
- `fengyu-client/cloudbaserc.json`
- `fengyu-staff/cloudbaserc.json`

之后 `scripts/deploy-cloudfunctions.sh` 会按 active env 选 envId + 自动切 tcb 双账号部署。

admin 远程部署用 `docker/docker-compose.remote.yml` override。`deploy-admin.sh` 会从
`envs/<env>.env` 生成仅含 CloudBase envId/CDN 的远程运行时覆盖文件，禁止手工把另一环境的
存储值写死到 compose。

## 小程序自适应（不需要渲染）

小程序代码 `fengyu-{client,staff}/miniprogram/utils/cloud-env.ts` 是 git tracked
静态文件，通过 `wx.getAccountInfoSync().miniProgram.envVersion` 运行时区分：

- `'release'` / `'trial'` → prod envId（118.178.196.26:5433）
- `'develop'` → dev envId（47.113.202.7:5433）
- 异常兜底（取不到 envVersion）→ dev envId，避免误判进 prod

所以**切换 envs/.active 不会影响小程序代码**。仅开发者工具开发版留在 dev，体验版/正式版都走 prod。

## 添加新变量

1. 同步加入 `dev.env.example` + `prod.env.example`（含说明注释）
2. 同步加入 `dev.env` + `prod.env`（真实值）
3. 如果云函数需要：在 `fengyu-{client,staff}/cloudbaserc.example.json` 的 envVariables 加 `"NEW_VAR": "${NEW_VAR}"`
4. 如果 admin 需要：在 `docker/docker-compose.remote.yml` 的 environment 加 `NEW_VAR`，并决定它应由远程 `.env` 还是部署脚本生成的运行时覆盖文件注入
5. 远程 `docker/.env` 同步追加（生产 `ssh fengyu-prod` / 测试 `ssh ali-demo` 后手工改）

## 安全

- `envs/{dev,prod}.env` 已 `.gitignore`
- 切到 prod 时 `use-env.sh` 打印 ⚠️ 横幅，避免误部署
- `deploy-cloudfunctions.sh` 强制 confirm
- e2e 入口不得连生产 IP `118.178.196.26`（防污染生产；2026-07-17 起 dev/测试与 prod 均用 5433 端口，环境仅靠 IP 区分）
