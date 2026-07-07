# 凤御双美容院系统 — 部署指南

本仓库为 monorepo,含顾客端小程序、员工端小程序、管理后台、云函数、数据库 schema。

## 目录结构

| 目录 | 内容 |
|------|------|
| `fengyu-client/` | 顾客端小程序(`miniprogram/`)+ 云函数(`clientApi`、`payNotify`) |
| `fengyu-staff/` | 员工端小程序(`miniprogram/`)+ 云函数(`staffApi`) |
| `fengyu-admin/` | 管理后台(Next.js 15 App Router) |
| `db/` | PostgreSQL schema(Drizzle ORM)+ 迁移 |
| `docker/` | admin 容器构建(Dockerfile.admin + compose) |
| `scripts/` | 部署脚本(deploy-cloudfunctions.sh / deploy-admin.sh / use-env.sh 等) |
| `envs/` | 环境变量模板(`dev.env.example` / `prod.env.example`) |

## 前置条件

1. **PostgreSQL 16**(自托管业务主库)
2. **CloudBase 云开发**(顾客端 + 员工端两个环境,各自腾讯云子账号)
3. **微信小程序**(顾客端 + 员工端两个 appid)
4. **拉卡拉商户号**(聚合支付;含商户私钥 PEM + 平台证书)
5. **腾讯地图 key**(`TMAP_KEY` / `TMAP_SECRET`,门店定位用)
6. **Node.js 18+** 与 **bun**(admin 构建)
7. **Docker**(admin 容器)
8. **微信开发者工具**(小程序上传)

## 环境变量

详见 `envs/dev.env.example` 与 `envs/prod.env.example`。复制为 `envs/dev.env` / `envs/prod.env`(均已 gitignored)后填入真实值。

关键必填(生产):
- `PG_CONNECTION_STRING` / `ADMIN_DATABASE_URL` — PG 业务库(prod:5433)
- `CLIENT_ENV_ID` / `STAFF_ENV_ID` / `CLOUDBASE_ENV_ID` — CloudBase 环境
- `CLIENT_SECRET` — staffApi↔clientApi HMAC 共享密钥(`openssl rand -hex 32`)
- `CLIENT_APPSECRET` — 顾客端小程序 appsecret
- `LAKALA_*`(APPID / SERIAL_NO / PRIVATE_KEY_PEM / PLATFORM_CERT_PEM / NOTIFY_URL 等)
- `TMAP_KEY` / `TMAP_SECRET`
- `ADMIN_JWT_SECRET` — admin JWT(`openssl rand -hex 32`)
- `NEXT_PUBLIC_RSA_PUBLIC_KEY` — admin 登录密码 RSA 公钥(build-arg,base64 SPKI)

## 部署顺序

### 1. 数据库

```bash
cd db
# 新库从零建表(已处理 0018/0023/0028 三个历史 migration 兼容)
DATABASE_URL="postgresql://user:pass@host:5433/dbname" bash scripts/bootstrap-from-zero.sh

# 后续增量迁移
DATABASE_URL="postgresql://user:pass@host:5433/dbname" npm run db:migrate
```

⚠️ 新库**不要直接** `npm run db:migrate`(3 个历史 migration bug 会让从零 apply 失败),必须先用 `bootstrap-from-zero.sh`。

### 2. 云函数(clientApi / payNotify / staffApi)

```bash
# 切换到目标环境(按 envs/.active 渲染 cloudbaserc.json)
scripts/use-env.sh prod

# 一次部署三个云函数
scripts/deploy-cloudfunctions.sh
```

首次部署后,为 clientApi 开启 HTTP 触发器,拿到 URL 后回填 `envs/prod.env` 的:
- `CLIENT_SERVICE_URL`
- `LAKALA_NOTIFY_URL`(通常 = `${CLIENT_SERVICE_URL}/lakala/notify`)
- `CLIENT_API_HTTP_URL`(通常 = `${CLIENT_SERVICE_URL}/cloudfunctions/clientApi`)

然后**二次部署**使回调 URL 生效。

### 3. 管理后台(admin)

```bash
# 推荐方式:本地构建 Docker 镜像 + 远程部署(远程不 build)
scripts/deploy-admin.sh prod

# 或手动构建
docker build -f docker/Dockerfile.admin -t fengyu-admin:latest \
  --build-arg NEXT_PUBLIC_RSA_PUBLIC_KEY="<base64 公钥>" .
docker compose -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d
```

admin 通过 `docker-compose.prod.yml` 接 5433 生产库(`ADMIN_DATABASE_URL`)。

### 4. 小程序

1. 微信开发者工具打开 `fengyu-client/miniprogram/`(顾客端)或 `fengyu-staff/miniprogram/`(员工端)
2. 「工具 → 构建 npm」(生成 `miniprogram_npm/`,Vant Weapp 组件)
3. 上传(trial 体验版 / release 正式版)

## 关键陷阱

- **RSA 公私钥配对**:build 期 `NEXT_PUBLIC_RSA_PUBLIC_KEY`(inline 进前端 bundle)必须与运行期 `ADMIN_RSA_PRIVATE_KEY`(docker-compose prod 注入)是**同一对**,错配导致登录 500
- **双账号 tcb 凭证**:顾客端与员工端是不同 CloudBase 账号,`TENCENTCLOUD_SECRETID/SECRETKEY` 分别配在 `fengyu-client/.env` 与 `fengyu-staff/.env`
- **`CLIENT_SECRET` ≠ `CLIENT_APPSECRET`**:前者是 HMAC 共享密钥(staffApi↔clientApi,两端一致);后者是顾客端小程序真实 appsecret,勿混(混用导致 order.qrcode「生成小程序码失败」40125)
- **`ALLOW_TEST_OPENID`**:生产必须 `false`
- **`WXACODE_ENV_VERSION`**:prod=`release`,dev=`develop`
- **双活库**:生产 `47.113.202.7:5433/fengyu_wxapp`,开发 `47.113.202.7:5434/fengyu`,schema 变更两边都要迁
- **拉卡拉回调 URL**:首次部署 `CLIENT_SERVICE_URL` 为 PLACEHOLDER,开 HTTP 触发器拿到真实 URL 后回填再二次部署
- **PG 时区**:PG 容器 `server_timezone=Asia/Shanghai`,admin 写入时间戳用 `nowTs()`/`beijingTs()`(见 `fengyu-admin/src/lib/db-time.ts`),勿直接 `new Date()`
