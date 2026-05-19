# Ticket: 三端充值卡档位/常量缺 cross-end snapshot 测试

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-19 |
| 实施状态 | ✅ 已完成（2026-05-19，commit df0b2c6）|
| 优先级 | **P3**（当前三端字节一致，但无自动化守护；运营改档位时人工漂移风险）|
| 端 | fengyu-admin + fengyu-staff + fengyu-client（测试新增）|
| 修复成本 | **S**（一个跨端 snapshot 测试文件，约 60 行）|
| 来源 | 2026-05-18 充值卡跨三端调试审计（C2）|
| 决策 | **用户指定**：补 snapshot 测试 |
| 关联文件 | `fengyu-admin/src/lib/recharge.ts` L16-93、`fengyu-staff/cloudfunctions/staffApi/utils/recharge.js` L1-50、`fengyu-client/cloudfunctions/clientApi/routes/card.js` L14-51 |

---

## 0 一句话

三端 `RECHARGE_TIERS` / `RECHARGE_MIN_AMOUNT` / `RECHARGE_MAX_AMOUNT` / `RECHARGE_VIRTUAL_SKU_ID` / `matchTier` 函数体目前字节一致，但无 snapshot 测试守护；运营改档位时若漏改任一端则三端行为漂移。

---

## 1 证据

### 1.1 三处副本一致性（已人工核对，2026-05-18）

| 端 | 文件 | RECHARGE_TIERS | MIN | MAX | VIRTUAL_SKU |
|----|------|---|---|---|---|
| admin | `src/lib/recharge.ts` L23-27 | `[{500,0.99},{1000,0.98},{5000,0.95}]` | 500 | 100000 | `'sku-recharge-virtual'` |
| staff | `cloudfunctions/staffApi/utils/recharge.js` L8-12 | 同上 | 500 | 100000 | 同上 |
| client | `cloudfunctions/clientApi/routes/card.js` L14-20 | 同上 | 500 | 100000 | 同上（`_constants.js`） |

### 1.2 现有测试覆盖

- `staff/__tests__/routes/card.test.js` — 只测 staff 自己的 matchTier 边界
- `client/miniprogram/__tests__/pagesProfile/card-recharge/recharge.test.ts` — 只测 client 自己的 matchTier

**没有**任何测试跨三端字面对比常量。

### 1.3 项目已有的同类守护模式

参考 CLAUDE.md `no-shared-cloudfunctions`：

```
跨端一致性由 snapshot 守护：
fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js
+ fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts
任一漂移立即失败。
```

充值卡档位属于同样模式但漏了守护。

---

## 2 实施方案

### 2.1 新增 cross-end snapshot 测试

新文件：`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/recharge-cross-end-snapshot.test.js`

测试内容：
- 读 staff `utils/recharge.js` 的源码字符串
- 读 admin `src/lib/recharge.ts` 的源码字符串
- 读 client `cloudfunctions/clientApi/routes/card.js` 的源码字符串
- 用正则提取每个文件里：
  - `RECHARGE_TIERS = [...]` 字面块
  - `RECHARGE_MIN_AMOUNT = N`
  - `RECHARGE_MAX_AMOUNT = N`
  - `RECHARGE_VIRTUAL_SKU_ID = '...'`（admin/staff 来自 recharge 文件，client 来自 `_constants.js`）
  - `matchTier` 函数体（normalize 空白后比对）
- 三端两两 assert.deepEqual

**注意**：proper normalize — 三端类型注解和注释会有差异（`.ts` vs `.js`），只比对**逻辑字面量**，不比对类型注解。

### 2.2 测试入口同步到 admin

镜像位置：`fengyu-admin/src/lib/__tests__/recharge-cross-end.test.ts`

两个测试同步运行任一通过都接受；两端各跑自己的测试入口（与 `error-codes-cross-end` 模式一致）。

### 2.3 测试运行

```bash
bun test fengyu-staff/cloudfunctions/staffApi/__tests__/routes/recharge-cross-end-snapshot.test.js
bun test fengyu-admin/src/lib/__tests__/recharge-cross-end.test.ts
```

加入 CI 阻塞门禁。

---

## 3 验证

### 3.1 守护有效性测试

故意改 client `card.js` 的 1000 档折扣从 0.98 → 0.97，跑测试 → 必须失败。

### 3.2 回归

完整 `bun run test`（admin）+ `bun test cloudfunctions/staffApi/__tests__`（staff）必须全过。

---

## 4 后续

修档位的标准 SOP（需同步更新）：

1. 改 admin `src/lib/recharge.ts`（运营管理后台的真值源）
2. 字面同步到 staff `cloudfunctions/staffApi/utils/recharge.js`
3. 字面同步到 client `cloudfunctions/clientApi/routes/card.js` + `_constants.js`
4. 跑 `recharge-cross-end-snapshot.test.js` 确认三端一致
5. 跑各端 e2e 验证业务流程

可考虑在 staff `routes/card.js` 文件顶部加注释说明"修改时跑 snapshot 测试"。

---

## 5 关联引用

- `fengyu-admin/src/lib/recharge.ts`
- `fengyu-staff/cloudfunctions/staffApi/utils/recharge.js`
- `fengyu-client/cloudfunctions/clientApi/routes/card.js` L14-51
- `fengyu-client/cloudfunctions/clientApi/routes/_constants.js`（RECHARGE_VIRTUAL_SKU_ID）
- 参考守护文件：`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js`

---

## 完成记录

- 完成日期：2026-05-19
- 完成 commit：`df0b2c6`
- 实际落地：
  - `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/recharge-cross-end-snapshot.test.js`（162 行）— 覆盖 staff/admin/client/payNotify 四端 RECHARGE_TIERS / MIN / MAX / VIRTUAL_SKU + matchTier
- DoD：
  - [x] §2.1 staff 侧 snapshot 测试
  - [⚠️] §2.2 admin 镜像测试（`src/lib/__tests__/recharge-cross-end.test.ts`）未单独创建 — 单一 staff 测试已覆盖三端字面对比，实用守护已生效；如严格遵循 error-codes-cross-end 双入口模式可后续补
  - [x] CI 测试可跑通
