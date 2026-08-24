# 发版验证清单（dev/test/prod）

配合 `SKILL.md` 的 Phase 0 与 Phase 6 使用。dev/prod 的 CloudBase 线上值以 `getFunctionConfig` / `tcb fn detail` 实测为准；test 没有独立 CloudBase，禁止部署或验证云函数，只验证 101 上的 admin、analyst 和测试库。

## 环境变量安全表（防 dev 值误入 prod / prod 值误入 dev）

| 变量 | dev 期望 | test 期望 | prod 期望 | 误用风险 |
|------|----------|-----------|-----------|----------|
| `ENV_PROFILE` | `dev` | `test` | `prod` | 环境选择错误 |
| `ALLOW_TEST_OPENID` | `true` | `false` | `false` | 鉴权策略串环境 |
| `WXACODE_ENV_VERSION` | `develop` | `release` | `release` | 小程序码指错环境 |
| `PG_CONNECTION_STRING` | `47.113.202.7:5433/fengyu_wxapp` | `101.34.242.103:5433/fengyu_wxapp`（仅迁移） | `118.178.196.26:5433/fengyu_wxapp` | 数据写错库 |
| `ADMIN_DATABASE_URL` | `47.113.202.7:5433/fengyu_wxapp` | `172.18.0.1:5433/fengyu_wxapp`（101 容器） | `118.178.196.26:5433/fengyu_wxapp` 或已验证同机网桥 | admin 读错库 |
| `CLIENT_SECRET` | dev secret | 101 现有配置 | prod 独立 secret | HMAC 桥断裂或跨环境互通 |
| `CLIENT_SERVICE_URL` | dev 域名 | 101 现有配置 | prod 真实域名 | 跨服务调用指错环境 |
| `ADMIN_JWT_SECRET` | dev jwt | test 独立 jwt | prod 独立 jwt | 跨环境 session 互通 |
| `ANALYST_PUBLIC_ORIGIN` | dev analyst URL | `http://101.34.242.103:3001` | prod analyst URL | analyst 入口串环境 |
| `LAKALA_*` | SIT 沙箱 | 101 既有测试配置 | prod 真实商户凭证 | 支付或入网不可用 |
| `PAYNOTIFY_ENABLED` | `true` | N/A（不部署云函数） | `true` | 支付通知不可用 |

DB 目标口径：
- `118.178.196.26:5433/fengyu_wxapp` = **prod**（fengyu-prod 服务器）
- `101.34.242.103:5433/fengyu_wxapp` = **test**（sqlserver101；容器内经 `172.18.0.1` 回连）
- `47.113.202.7:5433/fengyu_wxapp` = **dev**（ali-demo）

## 各云函数 getFunctionConfig 必检项（仅 dev/prod）

test 必须跳过本节。其 `test.env` 暂时复用 prod envId，只供 admin 访问资源，绝不能执行云函数 code update。

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
ssh $SSH_HOST "curl -sSL -o /dev/null -w '%{http_code}\\n' --max-time 10 http://localhost:3001/"  # 期望 200 或 307
ssh $SSH_HOST "docker exec fengyu-analyst sh -c 'printf \"%s|%s\\n\" \"\$DATABASE_URL\" \"\$NEXT_PUBLIC_ANALYST_ORIGIN\"'" | sed -E 's#://[^@]+@#://***@#'  # dev/prod DB 含 $EXPECT_IP:5433；test 可为 172.18.0.1:5433；origin 与 envs/$ENV.env 一致
```
（`$SSH_HOST`：prod=fengyu-prod / test=sqlserver101 / dev=ali-demo。test 执行 admin + analyst 冒烟，但跳过云函数冒烟。）

## 回滚指引

- **admin**：上一版镜像仍在远程 → `ssh $SSH_HOST "docker images fengyu-admin"`，把旧 image tag 重打成 `:latest`，再 `ssh $SSH_HOST "cd $REMOTE_DIR && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d admin cron-worker"`。或本地 `git checkout <上一版>` 后重跑 `deploy-admin.sh $ENV`。
- **analyst**：`.claude/skills/remote-deploy/deploy-analyst.sh --rollback $SSH_HOST` 回退上一个远程镜像；若没有上一版镜像，本地切回已验证提交后重跑 `deploy-analyst.sh $ENV`。
- **云函数（仅 dev/prod）**：`git checkout <上一版>` 对应端代码 → 重新 `scripts/use-env.sh $ENV && scripts/deploy-cloudfunctions.sh`。test 禁止执行。
- **DB**：本技能会在代码上线前执行 `db:migrate`。迁移失败时不得继续部署；已成功应用的 migration 不自动回滚，须按 `db/CLAUDE.md` 新建向前修复 migration。仅在已批准的灾难恢复流程中使用已验证备份，禁止 `db:push`、手工改 journal 或回改已应用 migration。

（`$REMOTE_DIR` 默认 prod/test=`/www/wwwroot/fengyu-admin/docker`、dev=`/root/proj.xt.com/fengyu-wxapp/docker`。）
