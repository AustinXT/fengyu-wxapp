# 发版验证清单（dev/prod）

配合 `SKILL.md` 的 Phase 0（预检）与 Phase 4（部署后验证）使用。所有「线上值」以 `getFunctionConfig` / `tcb fn detail` / `docker exec` 实测为准 —— 因为 `tcb fn code update` **不改 env 变量**，env 由首次 provisioning 决定。**按本次 ENV（dev/prod）核对对应期望列**。

## 环境变量安全表（防 dev 值误入 prod / prod 值误入 dev）

| 变量 | dev 期望 | prod 期望 | 误用风险 |
|------|----------|-----------|----------|
| `ENV_PROFILE` | `dev` | `prod` | render-cloudbaserc 的 ENV_PROFILE 守卫会 abort，防止错配 |
| `ALLOW_TEST_OPENID` | **`true`** | **`false`** | prod 误留 true = 任意伪造 openid 绕过真实鉴权；dev 误设 false = 测试不便 |
| `WXACODE_ENV_VERSION` | **`develop`** | **`release`** | prod 误留 develop = 小程序码指向 dev 环境；dev 误设 release = 码指 prod |
| `PG_CONNECTION_STRING` | `47.113.202.7:5433/fengyu_wxapp` | **`118.178.196.26:5433/fengyu_wxapp`** | 云函数写进错环境库 |
| `ADMIN_DATABASE_URL` | `47.113.202.7:5433/fengyu_wxapp` | **`118.178.196.26:5433/fengyu_wxapp`** | admin 读错环境数据 |
| `CLIENT_SECRET` | dev secret | prod 独立 secret | staffApi↔clientApi HMAC 桥断裂（dev 内自洽、prod 内自洽，两端各自一致即可） |
| `CLIENT_SERVICE_URL` | dev 域名 | prod 真实域名（**非 PLACEHOLDER**） | staffApi 跨函数 HTTP / lakala 回调失败 |
| `ADMIN_JWT_SECRET` | dev jwt | prod 独立 jwt | 跨环境 session 互通（安全隐患） |
| `LAKALA_*` | SIT 沙箱 | prod 真实商户凭证 | 支付不可用（dev 用 SIT 即可） |
| `PAYNOTIFY_ENABLED` | `true` | `true` | 二者一致；prod 需配真实 lakala 凭证才真正可用 |

DB 目标口径（2026-07-17 迁移后，权威）：
- `118.178.196.26:5433/fengyu_wxapp` = **prod**（fengyu-prod 服务器）
- `47.113.202.7:5433/fengyu_wxapp` = **dev / 测试**（ali-demo 服务器；5434/fengyu 已删除，dev 与 test 合并共用此库）
- ⚠ dev/测试与 prod **均用 5433 端口 + fengyu_wxapp 库名**，仅靠 **IP** 区分环境。

## 各云函数 getFunctionConfig 必检项（按 ENV 核对 envId 前缀 + IP）

| 函数 | env | 账号 |
|------|-----|------|
| staffApi | `PG_CONNECTION_STRING`→`$EXPECT_IP`:5433、`ALLOW_TEST_OPENID`(prod=false/dev=true)、`WXACODE_ENV_VERSION`(prod=release/dev=develop)、`CLIENT_SECRET`、`CLIENT_API_HTTP_URL`(非 PLACEHOLDER) | staff 子账号（凭证在 `fengyu-staff/.env`） |
| clientApi | `PG_CONNECTION_STRING`→`$EXPECT_IP`:5433、`TMAP_KEY`、`TMAP_SECRET` | client 子账号（凭证在 `fengyu-client/.env`） |
| payNotify | `PG_CONNECTION_STRING`→`$EXPECT_IP`:5433、（启用支付时）`LAKALA_*` 全套、`LAKALA_NOTIFY_URL`(非 PLACEHOLDER) | client 子账号（同 clientApi env） |

envId 实际值（核对 cloudbaserc.json / `tcb fn detail`）：
- prod：staff=`fengyu-staff-prod-d4dtv6052992e9` / client=`fengyu-client-prod-d1cga6909c0ba`
- dev：staff=`cloud1-9g3ydpg512eecc99` / client=`cloud1-3gpht4b01ff88838`

## 冒烟（按 ENV 选 ssh host）

```bash
tcb fn invoke staffApi          # 空 payload，期望 -401 UNAUTHORIZED（函数运行 + DB 鉴权生效）；-1 也算通过
ssh $SSH_HOST "curl -sf http://localhost:3000/ >/dev/null && echo admin-ok"
ssh $SSH_HOST "docker exec fengyu-admin sh -c 'echo \$DATABASE_URL'" | sed -E 's#://[^@]+@#://***@#'   # 含 $EXPECT_IP:5433/fengyu_wxapp
```
（`$SSH_HOST`：prod=fengyu-prod / dev=ali-demo；`$EXPECT_IP`：prod=118.178.196.26 / dev=47.113.202.7。）

## 回滚指引

- **admin**：上一版镜像仍在远程 → `ssh $SSH_HOST "docker images fengyu-admin"`，把旧 image tag 重打成 `:latest`，再 `ssh $SSH_HOST "cd $REMOTE_DIR && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d admin cron-worker"`。或本地 `git checkout <上一版>` 后重跑 `deploy-admin.sh $ENV`。
- **云函数**：`git checkout <上一版>` 对应端代码 → 重新 `scripts/use-env.sh $ENV && scripts/deploy-cloudfunctions.sh`（仍 `code update`，env 不动）。
- **DB**：本技能不动 DB，无 DB 回滚项。

（`$REMOTE_DIR` 默认 `/root/proj.xt.com/fengyu-wxapp/docker`，远程路径不同时显式传入。）
