# envs/ — 三环境配置中央目录

凤御项目有 **dev / test / prod 三个部署环境**，但只有两个 CloudBase env（dev / prod）。
test 有独立服务器和 PG，不部署 CloudBase 云函数，只供 test admin/analyst 访问既有资源。
此目录是所有环境差异变量的 **单一权威源**。

## 拓扑

| 环境 | SSH host | 迁移 PG | 容器 PG | CloudBase |
|------|----------|---------|---------|-----------|
| dev | `ali-demo` | `47.113.202.7:5433/fengyu_wxapp` | 同迁移地址 | dev client/staff env |
| test | `sqlserver101` | `101.34.242.103:5433/fengyu_wxapp` | `172.18.0.1:5433/fengyu_wxapp` | 无独立 env，强制跳过云函数部署 |
| prod | `fengyu-prod` | `118.178.196.26:5433/fengyu_wxapp` | 生产公网地址或已验证同机网桥 | prod client/staff env |

CloudBase envId：dev client=`cloud1-3gpht4b01ff88838`、staff=`cloud1-9g3ydpg512eecc99`；prod client=`fengyu-client-prod-d1cga6909c0ba`、staff=`fengyu-staff-prod-d4dtv6052992e9`。

client 与 staff CloudBase 由 **两个不同的腾讯云子账号** 管理；两套账号凭据必须独立
（历史兼容来源为 `fengyu-{client,staff}/.env`，集中配置使用 `TENCENTCLOUD_*` 与
`STAFF_TENCENTCLOUD_*` 区分）。

## 文件

| 文件 | git | 说明 |
|------|-----|------|
| `dev.env.example` / `prod.env.example` | ✓ | 占位符模板，列出所有必需变量 |
| `dev.env` / `test.env` / `prod.env` | ✗ | 真实值（含 PEM / SM4 / 拉卡拉密钥） |
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

Admin/Analyst 远程部署用 `docker/docker-compose.remote.yml` override。部署脚本以
`envs/<env>.env` 为唯一权威源，分别生成 Admin、cron、export、Analyst 的 `0600` 白名单
运行环境，并和不可变镜像 tag 一起保存在版本化 release 目录。远端历史 `.env` 不再参与
新版 compose 解析，也不会整包注入容器。

首次从旧版部署脚本升级时，Admin/Analyst 入口会先幂等执行本地配置迁移，再进入严格门禁。
也可提前手动执行：

```bash
node .claude/skills/remote-deploy/runtime-config.mjs reconcile
```

迁移会保留三个真实 env 的已有值，从旧 `fengyu-staff/.env`（test 优先沿用 prod）补齐 staff
独立账号凭据，只从 example 补齐白名单内的非秘密运行时默认值，并将三个文件统一为 `0600`。
全部配置通过与发布相同的严格校验后才会写回；不会读取远端配置，也不会打印任何秘密。

拉卡拉门店入网测试必须显式选择 test，部署到 `101.34.242.103`（SSH 别名
`sqlserver101`）：

```bash
.claude/skills/remote-deploy/deploy-admin.sh test
```

test 的公网服务器和 SSH 目标是 `101.34.242.103`；Admin/Analyst 容器通过
`172.18.0.1:5433` 回连同机 PostgreSQL，本地迁移则连接 `101.34.242.103:5433`。部署前会同时
断言宿主公网 IP、5433 监听和容器 DB host。`dev` 始终指向 `ali-demo`，`test` 始终指向
`sqlserver101`，`prod` 始终指向 `fengyu-prod`，不允许参数、环境变量或分支名改写目标。

部署脚本不执行迁移：只读比对 Drizzle 最新 migration 的 `created_at + hash`，发现 pending、
hash 漂移或数据库领先本地代码即停止。先通过 `release-all` 或数据库专项流程完成迁移，再重跑部署。

拉卡拉支付与门店入网统一复用 `LAKALA_*` 的模式、环境、APPID、证书、SM4、机构号、用户号、
活动 ID、MCC、结算类型和来源。`LAKALA_ONBOARDING_*` 只保留入网 API 地址及业务参数，电子合同
回调地址和合同类型继续使用 `LAKALA_ECONTRACT_*`；电子合同机构号统一读取 `LAKALA_ORG_CODE`。

## 小程序自适应（不需要渲染）

小程序代码 `fengyu-{client,staff}/miniprogram/utils/cloud-env.ts` 是 git tracked
静态文件，通过 `wx.getAccountInfoSync().miniProgram.envVersion` 运行时区分：

- `'release'` / `'trial'` → prod envId（118.178.196.26:5433）
- `'develop'` → dev envId（47.113.202.7:5433）
- 异常兜底（取不到 envVersion）→ dev envId，避免误判进 prod

所以**切换 envs/.active 不会影响小程序代码**。仅开发者工具开发版留在 dev，体验版/正式版都走 prod。

## 添加新变量

1. 同步加入 `dev.env.example` + `prod.env.example`（含说明注释）
2. 同步加入 `dev.env` + `test.env` + `prod.env`（真实值）
3. 如果云函数需要：在 `fengyu-{client,staff}/cloudbaserc.example.json` 的 envVariables 加 `"NEW_VAR": "${NEW_VAR}"`
4. 如果 Admin/Analyst/worker 需要：把 `NEW_VAR` 加入 `runtime-config.mjs` 对应服务的白名单；不要恢复远端 `.env` 整包注入

修改后运行 `node scripts/check-env-shape.mjs`，确保 `prod.env.example`、`dev.env.example` 以及本地
`prod.env` / `test.env` / `dev.env` 的键集合与顺序完全一致。`prod.env.example` 是唯一结构基准，
Admin/Analyst 的真实生产值只以本地 `prod.env` 为准；远端容器运行态只用于发布后的只读一致性核验，
不得反向补齐或覆盖本地配置。CloudBase 函数变量仍由云函数部署流程单独只读核验。

## 安全

- `envs/{dev,test,prod}.env` 已 `.gitignore`
- 三个真值文件必须为 `0600`；部署生成的所有服务 env 同样为 `0600`
- build args 只允许版本号及 `NEXT_PUBLIC_*` 公共值，秘密只进入运行期服务 env
- 切到 prod 时 `use-env.sh` 打印 ⚠️ 横幅，避免误部署
- `deploy-cloudfunctions.sh` 强制 confirm
- e2e 入口只允许连接 dev IP `47.113.202.7`，不得连接 test `101.34.242.103` 或 prod `118.178.196.26`；三个环境均用 5433 端口，仅靠 IP 区分
