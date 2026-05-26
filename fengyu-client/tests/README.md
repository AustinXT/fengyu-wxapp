# fengyu-client 自动化测试

按层次组织，**所有 client 端自动化测试统一在本目录下**（独立 unit test 仍位于 `cloudfunctions/clientApi/__tests__/`）。

| 层 | 路径 | 作用 | 速度 | 依赖 |
|----|------|------|------|------|
| L1 unit | `cloudfunctions/clientApi/__tests__/` | mock PG，路由内部逻辑 | <1s | bun test |
| **L2 e2e-cloudfn** | `tests/e2e-cloudfn/` | 本地 require clientApi + 真 PG，覆盖每个 action 全分支 | 单 spec 3-10s | PG 主库 + `ALLOW_TEST_OPENID=true`（本地进程注入） |
| **L2X e2e-cross-end** | `tests/e2e-cross-end/` | 同一 Node 进程内同时 require clientApi + staffApi，验真跨端流（扫码支付 / HMAC 桥 / 历史单可见性 / coupon schema 桥 / paynotify guard） | 单 spec 5-12s | 同 L2 + `CLIENT_SECRET` 注入（setup.mjs 默认设了 mock 值）|
| **L3 e2e-miniprogram** | `tests/e2e-miniprogram/` | IDE automator 驱动真小程序，覆盖完整用户旅程 | 单 journey 30-60s | 微信开发者工具 IDE + IPv6 9420 |

## 跑法

```bash
# L2 全套
bun fengyu-client/tests/e2e-cloudfn/run-all.mjs

# L2 单模块
bun fengyu-client/tests/e2e-cloudfn/run-all.mjs --module order

# L2 单 spec
bun fengyu-client/tests/e2e-cloudfn/auth/login.spec.mjs

# L2 清理残留
bun fengyu-client/tests/e2e-cloudfn/cleanup.mjs

# L2X 跨端全套（client + staff 同进程，~30s）
bun fengyu-client/tests/e2e-cross-end/run-all.mjs

# L2X 单 spec
bun fengyu-client/tests/e2e-cross-end/scan-pay-real.spec.mjs
bun fengyu-client/tests/e2e-cross-end/hmac-bridge.spec.mjs

# L2X 清理残留
bun fengyu-client/tests/e2e-cross-end/cleanup.mjs

# L3 全套（前置：IDE 装载 fengyu-client/miniprogram + IPv6 9420 ready）
bun fengyu-client/tests/e2e-miniprogram/run-all.mjs

# L3 单 journey
bun fengyu-client/tests/e2e-miniprogram/j1-onboarding.spec.mjs

# L3 清理残留
bun fengyu-client/tests/e2e-miniprogram/cleanup.mjs
```

## 命名空间约定

- L2 用 `TE2L2_` 前缀（= TEST_E2E_L2 缩写），与 staff/admin 端同款约定，方便统一清理
- L2X 用 `TE2X_` 前缀（= TEST_E2E_CROSS）和 L2 隔离
- L3 用 `TEST_E2E_L3_` 前缀

helpers 全部位于 `tests/e2e-cloudfn/helpers/`、`tests/e2e-cross-end/helpers/`、`tests/e2e-miniprogram/helpers/`，自包含。client 专属 fixture（产品、SKU、优惠券、储值卡等）放在 `client-fixtures.mjs` / `client-l3-fixtures.mjs`。跨端 fixture 放在 `e2e-cross-end/helpers/fixtures-cross.mjs`。
