# prod 发版验证清单

配合 `SKILL.md` 的 Phase 0（预检）与 Phase 4（部署后验证）使用。所有「线上值」以 `getFunctionConfig` / `tcb fn detail` / `docker exec` 实测为准 —— 因为 `tcb fn code update` **不改 env 变量**，env 由首次 provisioning 决定。

## prod 环境变量安全表（dev 值误入 prod 的风险）

| 变量 | dev 值 | prod 值（必须） | 误用风险 |
|------|--------|----------------|----------|
| `ENV_PROFILE` | `dev` | `prod` | render-cloudbaserc 的 ENV_PROFILE 守卫会 abort，防止错配 |
| `ALLOW_TEST_OPENID` | `true` | **`false`** | dev 值在 prod = 任意伪造 openid 绕过真实鉴权 |
| `WXACODE_ENV_VERSION` | `develop` | **`release`** | dev 值在 prod = 生成的小程序码指向 dev 环境，顾客扫到错端点 |
| `PG_CONNECTION_STRING` | `5434/fengyu` | **`5433/fengyu_wxapp`** | 云函数写进 dev 库 |
| `ADMIN_DATABASE_URL` | `5434/fengyu` | **`5433/fengyu_wxapp`** | admin 读空库或读 dev 数据 |
| `CLIENT_SECRET` | dev secret | prod 独立 secret | staffApi↔clientApi HMAC 桥断裂 |
| `CLIENT_SERVICE_URL` | dev 域名 | prod 真实域名（**非 PLACEHOLDER**） | staffApi 跨函数 HTTP / lakala 回调失败 |
| `ADMIN_JWT_SECRET` | dev jwt | prod 独立 jwt | 跨环境 session 互通（安全隐患） |
| `LAKALA_*` | SIT 沙箱 | prod 真实商户凭证 | 支付不可用 |
| `PAYNOTIFY_ENABLED` | `true` | `true` | 二者一致，但 prod 需配真实 lakala 凭证才真正可用 |

DB 目标口径（2026-05-21 实测，权威）：
- `5433/fengyu_wxapp` = **prod**（上线前为空库）
- `5434/fengyu` = **dev / e2e**
- 旧记忆「5434 为唯一生产业务库」**已过时**，以本表为准。

## 各云函数 getFunctionConfig 必检项

| 函数 | env | 账号 |
|------|-----|------|
| staffApi | `PG_CONNECTION_STRING`→5433、`ALLOW_TEST_OPENID=false`、`WXACODE_ENV_VERSION=release`、`CLIENT_SECRET`、`CLIENT_API_HTTP_URL`(非 PLACEHOLDER) | staff 子账号 `fengyu-staff-prod-*` |
| clientApi | `PG_CONNECTION_STRING`→5433、`TMAP_KEY`、`TMAP_SECRET` | client 子账号 `fengyu-client-prod-*` |
| payNotify | `PG_CONNECTION_STRING`→5433、（启用支付时）`LAKALA_*` 全套、`LAKALA_NOTIFY_URL`(非 PLACEHOLDER) | client 子账号（同 clientApi env） |

## 冒烟

```bash
tcb fn invoke staffApi          # 空 payload，期望返回 -401 UNAUTHORIZED（函数运行 + DB 鉴权生效）
ssh ali-demo "curl -sf http://localhost:3000/ >/dev/null && echo admin-ok"
ssh ali-demo "docker exec fengyu-admin sh -c 'echo \$DATABASE_URL'"   # 含 5433/fengyu_wxapp
```

## 回滚指引

- **admin**：上一版镜像仍在远程 → `ssh ali-demo "docker images fengyu-admin"`，把旧 image tag 重打成 `:latest`，再 `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d admin cron-worker`。或本地 `git checkout <上一版>` 后重跑 `deploy-admin.sh prod ali-demo`。
- **云函数**：`git checkout <上一版>` 对应端代码 → 重新 `scripts/use-env.sh prod && scripts/deploy-cloudfunctions.sh`（仍 `code update`，env 不动）。
- **DB**：本技能不动 DB，无 DB 回滚项。
