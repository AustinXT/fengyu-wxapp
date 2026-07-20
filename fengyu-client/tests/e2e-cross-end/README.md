# tests/e2e-cross-end — 跨端 (cross-end) E2E 测试层

**目的**：在一个 Node 进程内同时 require clientApi + staffApi（+ payNotify）+ pgQuery 模拟 admin
端 Drizzle 写入，跑跨多个 API 网关 + 同一份 PG 业务库的真实端到端链路。

与 `tests/e2e-cloudfn/`（仅 clientApi）的核心差异：

| 维度 | e2e-cloudfn (L2) | e2e-cross-end |
|------|------------------|---------------|
| 命名空间 | `TE2L2_` | `TE2X_` |
| 加载的云函数 | clientApi | clientApi + staffApi + payNotify |
| admin 端 | 不涉及 | 用 pgQuery 模拟写入（"pretend admin wrote it"） |
| 主要校验对象 | 单端 API 单元行为 | 跨端契约：staff→client 链路 / admin schema → client read / HMAC 桥 |

## 命名空间

`NS = 'TE2X'`（TEST_E2E_CROSS）。所有 fixture id / openid / 手机号都以 `TE2X_` 开头。
与 L2 的 `TE2L2_`、L3 的 `TEST_E2E_L3_` 完全错开，可并发跑。

手机号段：`19999091001..1099`（L2 在 `19999099001..099` 段，不冲突）。

## 前置依赖

1. **本地两个云函数 node_modules 已装**：
   ```bash
   cd fengyu-client/cloudfunctions/clientApi && npm install
   cd fengyu-staff/cloudfunctions/staffApi && npm install
   cd fengyu-client/cloudfunctions/payNotify && npm install
   ```
2. **PG_CONNECTION_STRING** 指向 5433/fengyu_wxapp 生产业务库（默认值见 setup.mjs）
3. `bun` 已装（用作 spec runner）

## Spec 列表（5 个）

| Spec | 验证什么 | cases |
|------|----------|-------|
| `hmac-bridge.spec.mjs` | clientApi HTTP 触发器 HMAC 守卫矩阵 | 7 |
| `coupon-admin-issue.spec.mjs` | admin 写券 → client 读券契约 | 3 |
| `legacy-orders-visibility.spec.mjs` | admin 历史订单导入 → client 可见性 | 3 |
| `scan-pay-real.spec.mjs` | staff 真开单 → client 扫码全额抵扣 → 余额扣减 + 流水 | 2 |
| `smoke-paynotify.spec.mjs` | payNotify PAYNOTIFY_DISABLED 守卫 | 1 |

合计 **16 cases**。

## 跑法

```bash
# 全套
bun fengyu-client/tests/e2e-cross-end/run-all.mjs

# 第一个 fail 即停
bun fengyu-client/tests/e2e-cross-end/run-all.mjs --bail

# 单 spec
bun fengyu-client/tests/e2e-cross-end/scan-pay-real.spec.mjs

# 命名空间清理（防残留）
bun fengyu-client/tests/e2e-cross-end/cleanup.mjs
```

## 选型决策

### admin Server Action 调用方式

admin Server Actions（`fengyu-admin/src/actions/*.ts`）依赖 Next.js Server Action context
（cookies/redirect/revalidatePath/`getSession`），无法在普通 bun 子进程里直接 import 调用。
fengyu-admin/tests/e2e-actions/_admin-preload.mjs 用 `bun --preload` 注入 4 个 mock（auth/permissions/
operation-log/next/cache）才能跑通。

本层选 **"pseudo admin via pgQuery"**：用 SQL 直接模拟 admin 写入，注释明确标注。
真正校验的是 schema 跨端契约（admin Drizzle snake_case ↔ 云函数原生 pg 读取），不是 admin 业务逻辑。
admin 业务逻辑的覆盖见 fengyu-admin/tests/e2e-actions/、fengyu-admin/tests/e2e-chains/。

### staff order.create 实际签名

staff `order.create`（fengyu-staff/cloudfunctions/staffApi/routes/order.js:165+）的实际入参：

```js
{
  clientPhone,        // ← 按 phone 反查 client_wechat_users，不接受 clientUserId
  clientName,
  items: [{skuId, quantity?, customPrice?, discount?}],
  paymentMethod,      // ← 仅 '微信' | '线下'；不允许 '储值卡'
  saleOrderType?,     // 默认 '销售单'；不接受 '回款单'/'退款单'
  useCard?, prepaidCardAmount?, receivedAmount?,
  couponId?, remark?, preferredStaffWfId?,
}
```

scan-pay-real.spec.mjs 因此先用 `paymentMethod: '微信'` 开单，再让 client `order.scanAdjust`
覆写为 `'储值卡'`，完整复现"店长开单→顾客扫码改抵扣→确认"链路。

## Hard rules

1. 复用 `e2e-cloudfn/helpers/invoke-client.mjs` 等现成 wrapper（跨目录相对路径 import）
2. 不修改 e2e-cloudfn / 云函数业务代码 / admin Server Actions
3. 每个 spec 文件独立 CASES + cleanup + process.exit
4. NS 严格 `TE2X`，不要叫 TE2L3 / TEST_E2E_CROSS

## 失败排查

- **duplicate key sale_orders_pkey FY-XSD-WX-...**: 跨端测试残留 + 本日序号顶到边界，先跑
  `bun cleanup.mjs` 清掉本 NS 数据
- **CLIENT_NOT_REGISTERED 串扰**：cleanup 顺序不全，sale_orders FK 阻塞 staff_wechat_users / stores
  删除。fixtures-cross.mjs 的 cleanup 已用 `UNION` 把 client_user_id / opened_by 两路 sale_orders
  都覆盖
- **HMAC 守卫 case 失败**：检查 process.env.CLIENT_SECRET 是否被外部覆盖，setup.mjs 默认值是
  `test_client_secret_for_hmac_bridge`
