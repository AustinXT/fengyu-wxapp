# L2 云函数端到端冒烟测试

**目的**：改代码 → 10 秒看结果。本地直接 `require` 云函数 + 真实 PG，**不走** `tcb fn invoke` 网络往返，**不经过**小程序 UI。

定位：在单元测试 (L1) 和远程灰度 (L3) 之间，给后端开发者一个快速反复迭代的闭环。

## 文件清单

```
tests/e2e-cloudfn/
├── README.md                          # 本文件
├── setup.mjs                          # 全局 setup：环境变量 / 命名空间常量 / 共享 PG 池
├── helpers/
│   ├── invoke.mjs                     # require staffApi / clientApi / payNotify 入口 + wx-server-sdk mock
│   ├── wx-server-sdk-mock.js          # wx-server-sdk 模块替身
│   ├── fixtures.mjs                   # createTestStaff / createTestClient / createTestSaleOrder / cleanupTestData
│   └── pg-snapshot.mjs                # 关键表快照 + before/after diff
├── _admin-preload.mjs                 # bun --preload 钩子：mock @/lib/auth, @/lib/permissions, next/cache, …
├── smoke-confirm-offline.mjs          # P0-15-01b 核心：staffApi order.confirmOffline → 积分 +3
├── smoke-paynotify.mjs                # payNotify PAYNOTIFY_DISABLED guard 行为验证
├── smoke-record-payment.mjs           # P0-15-01：admin recordPayment → 积分 +2（wrapper）
├── smoke-record-payment.impl.mjs      # 上面 wrapper 的真实业务实现
├── run-all.mjs                        # 顺序跑全部 smoke，汇总 PASS/FAIL
└── cleanup.mjs                        # 一次性清理所有 TE2L2_* 命名空间数据
```

## 前置条件

- bun 已安装（项目根 `bun --version` 应有输出，本仓库基线 1.3.x）
- 能访问业务主库：`postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu`（默认）
- 不需要在 cloudbase 远端云函数上设置 `ALLOW_TEST_OPENID=true`：本地 require 模式下，
  脚本进程的 `process.env.ALLOW_TEST_OPENID` 直接被云函数 `auth.js` 读到

## 跑法

```bash
# 单个 smoke（最常用）
bun tests/e2e-cloudfn/smoke-confirm-offline.mjs

# 全套
bun tests/e2e-cloudfn/run-all.mjs

# 仅清理命名空间残留数据
bun tests/e2e-cloudfn/cleanup.mjs

# 失败时打开 SQL 追踪
E2E_DEBUG=1 bun tests/e2e-cloudfn/smoke-confirm-offline.mjs
```

预期：单个 smoke 在 3–6 秒内完成（真实 PG 远程往返），run-all 14 秒左右。

## 命名空间约定

所有 fixture 数据强制以 **`TE2L2_`** 前缀（= "TEST_E2E_L2" 缩写，受 sale_order_id/employee_id
`varchar(30)` 限制必须短）：

| 项 | id |
|----|----|
| 测试门店 | `TE2L2_STORE` |
| 测试组织节点 | `TE2L2_HQ_ORG` / `TE2L2_MARKET_ORG` / `TE2L2_STORE_ORG` |
| 测试店长 | `TE2L2_MGR` (employee_id), `TE2L2_MGR_OPENID`, phone `19999099001` |
| 测试顾客 | `TE2L2_CLI` (user_id), `TE2L2_CLI_OPENID`, phone `19999099002` |
| 测试订单 | `TE2L2_OCO` / `TE2L2_RP` / `TE2L2_PN_ORDER`（每个 smoke 一个） |

`cleanupTestData()` 用 `LIKE 'TE2L2%'` 精确清理；额外按测试手机号 (199990990xx) 防御，
避免命名空间漂移导致残留。**绝不**碰非测试数据。

## 已知生产 bug（已修复）

L2 基础设施搭建过程中暴露的两个 staffApi 生产 SQL bug，已在源码里修复，
对应的 SQL_PATCHES 也已从 `helpers/invoke.mjs` 移除（避免未来真有 SQL 漂移
被运行时 patch 静默掩盖）。

| # | 文件 | 原 bug | PG 16 报错 | 修复 |
|---|------|--------|------------|------|
| 1 | `staffApi/utils/scope.js` `expandScopeStoreIds` 两处 | `ANY($1::uuid[])` | `operator does not exist: text = uuid`（`org_nodes.id` 是 text） | 改为 `ANY($1::text[])` |
| 2 | `staffApi/routes/order.js` `confirmOffline` UPDATE | `allocation_status = CASE WHEN ... END`（CASE 返回 text 触发 enum 类型错配） | `column "allocation_status" is of type allocation_status but expression is of type text` | 改为 `COALESCE(allocation_status, '待分配'::allocation_status)`（等价语义：保留非 NULL，NULL 时置默认）|

修复 commit 由本次 L2 巩固工作产出（见 git log "fix(staffApi): scope/order SQL 类型修正"）。
生产 operation_logs 0 命中说明 bug 暴露在路径上但未触发（manager 4 层登录 +
confirmOffline 为近期新功能，无真实流量）。

⚠️ 未来如果发现新的 SQL 漂移，先在源码修；**不要**在 invoke.mjs 重新引入
SQL_PATCHES 基础设施——那会让本地测试和生产行为偏离，掩盖真实 bug。

## 设计要点

### 为什么用本地 require 而非 tcb fn invoke
- tcb fn 一次网络往返 5–15 秒，反复迭代体验差
- 云函数都是纯 Node.js 代码，唯一外部依赖是 `wx-server-sdk`，可在本地 mock
- 业务 SQL 直连同一个生产业务库（5434/fengyu），数据完全真实
- 唯一不真实的是 `cloud.getWXContext()` 的 OPENID — 通过云函数自带的 `_testOpenid` 测试模式
  绕过（`ALLOW_TEST_OPENID=true` 环境变量门控）

### 为什么 staffApi 测试走 require + payload `_testOpenid`，admin 走 bun --preload
- staffApi 是纯 CJS 云函数：单进程 `require` 即可加载，wx-server-sdk mock 通过
  `Module._resolveFilename` 短路
- admin Server Action 是 TypeScript + 'use server' + Next.js context（依赖 cookies / redirect /
  revalidatePath），无法在普通 Node 进程跑。用 `bun --preload _admin-preload.mjs` 通过
  `Bun.plugin().module()` 提前注入 mock，再 dynamic import `actions/orders.ts`

### snapshot/diff 设计
- `snapshot(specs)` → `{table: rows[]}`，每张表按其主键稳定排序
- `diff(before, after)` 返回 `{added, removed, changed, addedRows, removedRows, changedRows}`，
  changed 自动忽略 `updated_at`（避免每个 row 触发噪声）
- 失败时 `fmtDiff(d)` 把所有变化打印到 stdout，便于定位

## 故障排查

1. **`duplicate key value violates unique constraint`** — 上次跑挂中途，命名空间数据残留。
   先跑 `bun tests/e2e-cloudfn/cleanup.mjs`
2. **`Cannot find module 'wx-server-sdk'`** — invoke.mjs 的 `Module._resolveFilename` patch 失效，
   可能 bun 升级后 API 改了。检查 `helpers/invoke.mjs` 顶部 `installWxServerSdkMock()`
3. **`PERMISSION_DENIED: 仅店长可执行此操作`** — auth 缓存命中过期的旧 fixture。
   清理后重跑：`bun tests/e2e-cloudfn/cleanup.mjs && bun tests/e2e-cloudfn/smoke-confirm-offline.mjs`
4. **`operator does not exist: text = uuid`** — 新增的 SQL 触发了 `::uuid[]` 模式但
   `org_nodes.id` / `stores.org_node_id` 等都是 text 列。**直接修源码**改为 `::text[]`，
   不要再走 SQL_PATCHES 路线（已废弃，详见上节"已知生产 bug（已修复）"）
5. **admin smoke 报 NEXT_REDIRECT** — `_admin-preload.mjs` 的 mock 列表不全，
   admin 又走到了 redirect 路径。把缺的模块加进 `plugin().module(...)`

## 后续可扩展

- 增加 staffApi 其他 P0 路径冒烟：order.create / order.approveRefund / service.complete
- 增加 clientApi 关键路径：order.pay / order.scanAdjust / card.balance
- payNotify 解锁拉卡拉对接后，把 smoke-paynotify 改成真正模拟微信回调（含签名）
- 把 helpers 抽成可复用的小工具包，供 admin Playwright E2E 共用 fixture 命名空间
- 加 `--watch` 模式：监听 `cloudfunctions/**/*.js` 变更，自动重跑 smoke
