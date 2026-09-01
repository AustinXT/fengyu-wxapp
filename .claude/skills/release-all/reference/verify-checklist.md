# 发版验证清单（dev/prod）

配合 `SKILL.md` 的 Phase 0 与 Phase 6 使用。云函数线上值以 `getFunctionConfig` / `tcb fn detail` 实测为准。

## 环境变量安全表（防 dev 值误入 prod / prod 值误入 dev）

| 变量 | dev 期望 | prod 期望 | 误用风险 |
|------|----------|-----------|----------|
| `ENV_PROFILE` | `dev` | `prod` | 环境选择错误 |
| `ALLOW_TEST_OPENID` | `true` | `false` | 鉴权策略串环境 |
| `WXACODE_ENV_VERSION` | `develop` | `release` | 小程序码指错环境 |
| `PG_CONNECTION_STRING` | `101.34.242.103:5433/fengyu_wxapp` | `118.178.196.26:5433/fengyu_wxapp` | 数据写错库 |
| `ADMIN_DATABASE_URL` | `172.18.0.1:5433/fengyu_wxapp`（101 容器） | `118.178.196.26:5433/fengyu_wxapp` 或已验证同机网桥 | admin 读错库 |
| `CLIENT_SECRET` | dev secret | prod 独立 secret | HMAC 桥断裂或跨环境互通 |
| `CLIENT_SERVICE_URL` | dev 域名 | prod 真实域名 | 跨服务调用指错环境 |
| `ADMIN_JWT_SECRET` | dev 独立 jwt | prod 独立 jwt | 跨环境 session 互通 |
| `ANALYST_PUBLIC_ORIGIN` | 以 `envs/dev.env` 为准 | prod analyst URL | analyst 入口串环境 |
| `LAKALA_*` | release 生产通道（APPID 禁 SIT 凭据 OP00000003） | prod 真实商户凭证 | 支付或入网不可用 |
| `PAYNOTIFY_ENABLED` | `true` | `true` | 支付通知不可用 |

DB 目标口径：
- `118.178.196.26:5433/fengyu_wxapp` = **prod**（fengyu-prod 服务器）
- `101.34.242.103:5433/fengyu_wxapp` = **dev**（sqlserver101；容器内经 `172.18.0.1` 回连）

## 各云函数 getFunctionConfig 必检项

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
ssh $SSH_HOST "docker exec fengyu-analyst sh -c 'printf \"%s|%s\\n\" \"\$DATABASE_URL\" \"\$NEXT_PUBLIC_ANALYST_ORIGIN\"'" | sed -E 's#://[^@]+@#://***@#'  # prod DB 含 $EXPECT_IP:5433；dev 为 172.18.0.1:5433；origin 与 envs/$ENV.env 一致
```
（`$SSH_HOST`：prod=fengyu-prod / dev=sqlserver101。）

## 回滚指引

- **admin**：发布健康检查失败时会自动回滚；人工切换上一成功 release 使用 `.claude/skills/remote-deploy/deploy-admin.sh --rollback $ENV`。
- **analyst**：发布健康检查失败时会自动回滚；人工切换上一成功 release 使用 `.claude/skills/remote-deploy/deploy-analyst.sh --rollback $ENV`。
- **云函数**：`git checkout <上一版>` 对应端代码 → 重新 `scripts/use-env.sh $ENV && scripts/deploy-cloudfunctions.sh`。
- **DB**：本技能会在代码上线前执行 `db:migrate`。迁移失败时不得继续部署；已成功应用的 migration 不自动回滚，须按 `db/CLAUDE.md` 新建向前修复 migration。仅在已批准的灾难恢复流程中使用已验证备份，禁止 `db:push`、手工改 journal 或回改已应用 migration。

（`$REMOTE_DIR` 两环境均为 `/www/wwwroot/fengyu-admin/docker`。）
