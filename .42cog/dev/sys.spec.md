# 凤御美业 — 系统架构提要

> 仅提供三端全局拓扑与文档索引。各端详细架构见对应 spec 文件。

## 架构拓扑

```text
┌─ 微信小程序 ──────────────────────────────┐
│  fengyu-client（C端）  fengyu-staff（B端）  │
└──────┬─────────────────────────┬─────────┘
       │ wx.cloud.callFunction  │
┌──────▼────────┐  ┌────────────▼──┐  ┌─ Web ─────────────┐
│ clientApi     │  │ staffApi      │  │ fengyu-admin       │
│ payNotify     │  │               │  │ adminApi（独立部署）│
│ CloudBase A   │  │ CloudBase B   │  │                    │
└──────┬────────┘  └───────┬──────┘  └─────────┬──────────┘
       │                   │                    │
       └───────────────────┼────────────────────┘
                           ▼
              PostgreSQL（自托管，三端共享）
```

## 三端速查

| 端 | 定位 | 认证 | 云函数 | envId |
|----|------|------|--------|-------|
| 顾客端 | C端消费者 | 微信 OPENID（静默） | clientApi + payNotify | `cloud1-3gpht4b01ff88838` |
| 员工端 | B端门店管理 | 微信 OPENID + RBAC | staffApi | `cloud1-9g3ydpg512eecc99` |
| 管理后台 | Web 内部管理 | 手机号+密码 → JWT | adminApi | 独立部署 |

## 隔离与共享

| 独立（各端隔离） | 共享 |
|------------------|------|
| CloudBase 环境、云函数 | PostgreSQL 实例（唯一共享资源） |
| OPENID（两小程序 appid 不同） | 业务数据（orders/products/…） |
| 用户表（client_ / staff_wechat_users） | Drizzle schema 定义（db/） |

## 详细文档索引

| 文档 | 范围 |
|------|------|
| [`client.sys.spec.md`](client.sys.spec.md) | 顾客端架构：认证流、购物车状态、中间件链、业务流 |
| [`staff.sys.spec.md`](staff.sys.spec.md) | 员工端架构：RBAC 权限模型、域过滤、开单/分配/核销业务流 |
| [`admin.sys.spec.md`](admin.sys.spec.md) | 管理后台架构：JWT 认证、RBAC、Next.js + tRPC 技术栈 |
| [`../pm/backend.pr.spec.md`](../pm/backend.pr.spec.md) | 后端数据模型、权限矩阵、状态机、核心业务规则 |
| [`../pm/admin.pr.spec.md`](../pm/admin.pr.spec.md) | 管理后台需求：数据填报/业务操作/系统管理 |

## 错误码体系（三端统一 9 项白名单）

云函数响应：`{ code, message, data, errorType }`，前端按 `errorType` 二级路由（不只看 `code`，因 -403/-400 共享多前缀）。

| 前缀 | code | 含义 |
|------|------|------|
| `UNAUTHORIZED:` | -401 | 未登录 / openid 失效 |
| `PHONE_REQUIRED:` | -403 | 未绑定手机号 |
| `INVALID_PARAMS:` | -400 | 入参不合法 |
| `PERMISSION_DENIED:` | -403 | 鉴权失败 |
| `NOT_FOUND:` | -404 | 资源不存在 / 不可见 |
| `INSUFFICIENT_BALANCE:` | -400 | 储值卡余额 / 剩余次数不足 |
| `CONFLICT:` | -409 | 并发冲突 / 唯一约束 / 状态被改 |
| `INVALID_STATE:` | -400 | 状态机不允许该操作 |
| `CLIENT_NOT_REGISTERED:` | -400 | 顾客未注册（staff/admin 抛） |

二级前缀语法：`<一级前缀>: <子标签>: <用户消息>`（如 `INVALID_STATE: STATE_TRANSITION_BLOCKED: ...`），子标签 `[A-Z_]+` 仅供日志归类，不计入白名单。

跨端一致性由 snapshot 守护：`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js` + `fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts` 任一漂移立即失败。

> **字面量单源**：各端 `cloudfunctions/*/utils/error-codes.js` + `fengyu-admin/src/lib/api-error.ts`。本 spec 仅描述形态，不复制字面量；client / staff / admin 各 sys.spec 展开各端抛出路径。

## cron STEP 与 schema docstring 反向引用

`fengyu-admin/src/cron/steps/*.ts` 的 STEP 实现中，凡是 WHERE / UPDATE 子句硬编码以下 3 类字面量，对应 schema 字段必须在 docstring 中反向标注，避免未来枚举值新增时 cron 漏更：

1. **enum 值字面量**（如 `status IN ('待确认','已确认')`、`change_type = '退款'`）
   - `db/schema/enums.ts` 对应 enum 定义需加注：`/** 引用方：cron.closeExpiredAppointments WHERE 子句 */`
2. **system_configs.key 字面量**（如 `key = 'new_member_threshold'`）
   - `db/schema/system-config.ts` 对应列定义需加注：`/** cron 消费者：getMemberThreshold（双层缓存） */`
3. **operation_logs.action 命名空间**（如 `'cron.audit_invariants'`）
   - 同名约束记录在 `db/schema/operation-log.ts` 注释或 `notes/references/cron-action-namespace.md` 单源

未来加 CI lint（`scripts/lint-cron-schema-coupling.mjs`）反向扫描 cron/steps/*.ts 的字面量，缺失即 fail。本 spec 仅落决策，lint 实现单开 ticket（"cron-schema-coupling-lint"）。
