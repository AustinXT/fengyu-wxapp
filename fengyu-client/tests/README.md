# fengyu-client 自动化测试

按层次组织，**所有 client 端自动化测试统一在本目录下**（独立 unit test 仍位于 `cloudfunctions/clientApi/__tests__/`）。

| 层 | 路径 | 作用 | 速度 | 依赖 |
|----|------|------|------|------|
| L1 unit | `cloudfunctions/clientApi/__tests__/` | mock PG，路由内部逻辑 | <1s | bun test |
| **L2 e2e-cloudfn** | `tests/e2e-cloudfn/` | 本地 require clientApi + 真 PG，覆盖每个 action 全分支 | 单 spec 3-10s | PG 主库 + `ALLOW_TEST_OPENID=true`（本地进程注入） |
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

# L3 全套（前置：IDE 装载 fengyu-client/miniprogram + IPv6 9420 ready）
bun fengyu-client/tests/e2e-miniprogram/run-all.mjs

# L3 单 journey
bun fengyu-client/tests/e2e-miniprogram/j1-onboarding.spec.mjs

# L3 清理残留
bun fengyu-client/tests/e2e-miniprogram/cleanup.mjs
```

## 命名空间约定

- L2 沿用根 `tests/e2e-cloudfn/` 的 `TE2L2_` 前缀（= TEST_E2E_L2 缩写），与 staff 端测试共享 fixture 基础设施
- L3 沿用根 `tests/e2e-miniprogram/` 的 `TEST_E2E_L3_` 前缀

helpers 通过相对路径引用根 `tests/` 下的共享 helpers（`pg-snapshot.mjs` / `fixtures.mjs` / `automator.mjs` 等），client 端只新增专属 fixture（产品、SKU、优惠券、储值卡等）。

## 与现有 `fengyu-client/e2e/` 的关系

`fengyu-client/e2e/smoke.js` 是早期独立 smoke 脚本，已被 L3 j1-onboarding + j2-shopping-to-cart 覆盖。计划在 L3 12 条 journey 全部稳定后归档删除。当前并存，npm script `e2e:smoke` 仍可用。
