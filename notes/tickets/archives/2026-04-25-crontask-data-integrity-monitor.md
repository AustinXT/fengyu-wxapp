# 2026-04-25 cron-worker 数据完整性监控 — 完整告警通道

## 背景

`fengyu-admin/src/cron/steps/audit-role-type-nulls.ts` 已落地（STEP 6），
每日 03:00 监控 `sale_allocations.role_type` / `service_commissions.role_type`
NULL 行回归。当前最小可行版本的告警通道：

1. `console.error(...)` → cron-worker 容器 stdout/stderr
2. `INSERT operation_logs (action='dataIntegrity.roleTypeNull', source='cronTask', ...)`

这两条都是"被动告警"——必须有人主动看 docker logs 或 admin 后台才会发现。
本 ticket 跟踪"主动告警通道"的基础设施补全。

## 现状审计（2026-04-25）

项目内已扫描的告警通道：

| 通道 | 是否已有 | 备注 |
|---|---|---|
| 企微机器人 webhook | ❌ 无 | 代码内 grep `qyapi.weixin.qq.com` 无命中 |
| 钉钉/飞书 webhook | ❌ 无 | 同上 |
| SMS / 邮件告警 | ❌ 无 | 无 nodemailer / 短信 SDK 引入 |
| Sentry / 错误聚合 | ❌ 无 | package.json 内无 sentry SDK |
| operation_logs 行 | ✅ 有 | 已被 STEP 5 / STEP 6 复用，但仅 admin 后台可查 |
| docker logs | ✅ 有 | 容器 stdout/stderr，没有外部聚合 |

**结论**：项目当前没有任何"主动推送"型告警通道。

## 目标

让 cron-worker 在发现数据完整性问题（含 STEP 5/6 + 未来扩展）时，
能够主动通知到运维/开发负责人，而不是依赖人工巡检 admin 后台。

## 候选方案（按落地成本排序）

### 方案 A：企微机器人 webhook（推荐）

- 注册一个内部群机器人，拿到 `WECHAT_BOT_WEBHOOK_URL`
- 新增 `src/cron/lib/notify.ts`：薄封装 `fetch(WEBHOOK_URL, { method: 'POST', body })`
- STEP 5/6 在 alertedCount > 0 时调用一次 `notify(...)`，发送 Markdown 文本：
  ```
  ⚠️ [cron-worker] dataIntegrity.roleTypeNull
    sale_allocations.role_type NULL 行数：5
    service_commissions.role_type NULL 行数：0
    时间：2026-04-25 03:00:12
  ```
- 环境变量 `WECHAT_BOT_WEBHOOK_URL` 加到 docker-compose `cron-worker` 服务的 `env_file`
- 缺失环境变量 → notify 退化为 console.warn（不阻塞 STEP）

成本：1-2h；最贴合凤御已用微信生态。

### 方案 B：邮件告警（nodemailer）

- 引入 `nodemailer` 依赖
- 加 `MAIL_SMTP_*` 系列环境变量
- 同一个 `notify()` 接口内分发

成本：3-4h；多一个依赖；运维要维护 SMTP 凭据。

### 方案 C：Sentry / 自托管错误聚合

- 把 cron-worker 包到 Sentry transaction，alert 通过 Sentry 推
- 需要 Sentry 项目 + DSN

成本：4-6h；引入第三方平台；适合长期方向但当前过重。

## 推荐落地

**先做方案 A**：企微 webhook。

DoD：
- [ ] `src/cron/lib/notify.ts` 实现 `notifyOps(message: string)` 包装 webhook POST
- [ ] STEP 5（auditPointsBalance）在 mismatchCount > 0 时调用
- [ ] STEP 6（auditRoleTypeNulls）在 alertedCount > 0 时调用
- [ ] 单元测试 mock fetch，覆盖：webhook URL 缺失 / 网络失败 / 正常 200
- [ ] docker-compose `cron-worker` 加 env `WECHAT_BOT_WEBHOOK_URL`
- [ ] 验证：手动构造一条 NULL（开发库），跑 `bun run cron:once`，群里收到告警

## 同时建议扩展的 NULL 检查项

STEP 6 当前只检查 `role_type`。等通道完善后可一起加进同一 step（同一 SELECT 多 subquery）：

| 检查 | SQL |
|---|---|
| `client_wechat_users.customer_type='会员客' AND became_member_at IS NULL` | 自检会员档案完整性 |
| `staff_wechat_users.is_resigned=false AND store_id IS NULL` | 在职员工必须挂门店 |
| `sale_orders.received IS NULL AND status='completed'` | 已完结订单必须有实收金额 |
| `service_orders.completed_at IS NULL AND status='completed'` | 完结服务单必须有完成时间 |

这些检查通过 `CHECKS` 数组循环执行即可，单一 SELECT + 循环 INSERT。

## 相关 ticket / memory

- `notes/tickets/2026-04-25-role-type-not-null-guard.md`（前置：schema NOT NULL + backfill）
- `fengyu-admin/src/cron/steps/audit-role-type-nulls.ts`（本次落地的 STEP 6）
- `fengyu-admin/src/cron/steps/audit-points-balance.ts`（STEP 5，同样最小告警模式）

## 落地结果（2026-04-25）

方案 A 已交付：

- ✅ `fengyu-admin/src/cron/lib/notify.ts` — `notifyOps(message)` 包装企微机器人
  webhook POST，env 缺失/网络失败/非 2xx 全部退化为 `console.warn`，永不阻塞
  STEP（5s 超时）
- ✅ STEP 5（`audit-points-balance.ts`）：`mismatchCount > 0` 时合并推送 1 条
  消息，含偏差用户数 + 检查总数 + 前 5 条明细
- ✅ STEP 6（`audit-role-type-nulls.ts`）：`alertedCount > 0` 时合并推送 1 条
  消息，列出每张表的 `role_type` NULL 行数
- ✅ 单元测试：notify.test.ts（5 场景：env 缺失/200/非 2xx/网络失败/env 切换）
  + audit-points-balance.test.ts/audit-role-type-nulls.test.ts 加 webhook
  推送断言。本次共 17 测试，全套 vitest 884 例全过；`npx tsc --noEmit` 0 错误
- ✅ `docker/docker-compose.yml` cron-worker service 增加
  `WECHAT_BOT_WEBHOOK_URL=${WECHAT_BOT_WEBHOOK_URL:-}`；`docker/.env.example` 同步空值
- ⏳ 验证「手工构造一条 NULL → 群里收到告警」需先在生产 `.env` 注入真实 webhook
  URL 并重启 cron-worker，留作 ops 侧动作（代码侧 DoD 全部完成）

**未做**（保留作为后续扩展）：本 ticket "同时建议扩展的 NULL 检查项" 一节列出
的 4 个新 NULL 自检（会员档案完整性 / 在职员工挂门店 / 已完结订单实收 /
服务单完结时间）。等 webhook 通道在生产稳定接收 1-2 周后再合并到 STEP 6 同一
SELECT，避免一次性发太多告警噪声。
