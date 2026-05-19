# Ticket: CLAUDE.md 路由表缺漏 card 模块（staff/client 文档与 index.js 不同步）

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-19 |
| 实施状态 | ✅ 已完成（2026-05-19，commit 4702f85）|
| 优先级 | **P3**（文档导航缺漏；不影响运行时；影响新人/AI 检索）|
| 端 | fengyu-staff + fengyu-client（CLAUDE.md 文档）|
| 修复成本 | **XS**（4 行 markdown 编辑）|
| 来源 | 2026-05-18 充值卡跨三端调试审计（C5）|
| 决策 | **直接补齐**，无需选方案 |
| 关联文件 | `fengyu-staff/CLAUDE.md`、`fengyu-staff/cloudfunctions/staffApi/CLAUDE.md`、`fengyu-client/CLAUDE.md`、`fengyu-client/cloudfunctions/clientApi/CLAUDE.md` |

---

## 0 一句话

staff CLAUDE.md 路由表完全没列 `card` 模块；client CLAUDE.md 列了 `card | list, history, balance` 但漏了 `rechargeConfig` 和 `recharge` 两个实际注册的 action。

---

## 1 证据

### 1.1 staff CLAUDE.md 路由表（缺 card 行）

```markdown
| 模块 | 接口 |
|------|------|
| auth | login, bindPhone |
| store | list, ... |
| ... |
| service | create, start, complete, cancel, list, detail, counts |
| mgmtDashboard | scopeOptions, summary, storeRanking, staffRanking |
```

— 完全没有 card 行，但实际：

```js
// fengyu-staff/cloudfunctions/staffApi/index.js（实际注册）
// card.rechargeSkus + card.recharge
```

`cloudfunctions/staffApi/CLAUDE.md` 同样缺漏。

### 1.2 client CLAUDE.md 路由表（card 行不全）

```markdown
| card | list, history, balance |
```

— 但实际：

```js
// fengyu-client/cloudfunctions/clientApi/routes/card.js L330
module.exports = { list, balance, history, rechargeConfig, recharge, matchTier }
// fengyu-client/cloudfunctions/clientApi/index.js（实际注册全部 5 个）
```

`cloudfunctions/clientApi/CLAUDE.md` 同样不全。

---

## 2 修复内容

### 2.1 staff CLAUDE.md（顶层）

在路由表追加：

```markdown
| card | rechargeSkus, recharge |
```

并在"### 储值卡抵扣相关接口说明"小节追加：

```markdown
- `card.rechargeSkus` — 店长开充值卡单时拉取可售档位（查 `product_skus WHERE is_recharge_card=true`）+ 自定义金额配置（matchTier 档位）
- `card.recharge` — 店长替顾客开充值卡订单（仅店长；强制销售单 + 一单一笔 + 禁优惠券）；线下走 `order.confirmOffline` 入账，微信走 `payNotify` 入账
```

### 2.2 staff cloudfunctions/staffApi/CLAUDE.md

在目录结构和路由表中追加 `routes/card.js` 行 + 注册说明。

### 2.3 client CLAUDE.md（顶层）

路由表 card 行改为：

```markdown
| card | list, history, balance, rechargeConfig, recharge |
```

### 2.4 client cloudfunctions/clientApi/CLAUDE.md

目录结构 `card.js` 行已有，但路由说明里需要展开 `rechargeConfig` 和 `recharge` 的语义。

---

## 3 验证

- 完成后跑 `grep -rn "card\." */CLAUDE.md` 确认全部 action 都在文档里
- 后续可加 lint：用脚本对比 `index.js` 注册项与 CLAUDE.md 路由表，CI 检测漂移

---

## 4 关联引用

- `fengyu-staff/CLAUDE.md`、`fengyu-staff/cloudfunctions/staffApi/CLAUDE.md`
- `fengyu-client/CLAUDE.md`、`fengyu-client/cloudfunctions/clientApi/CLAUDE.md`
- `fengyu-staff/cloudfunctions/staffApi/index.js`（实际注册源）
- `fengyu-client/cloudfunctions/clientApi/index.js`（实际注册源）

---

## 完成记录

- 完成日期：2026-05-19
- 完成 commit：`4702f85`
- 实际落地：
  - `fengyu-staff/CLAUDE.md` 路由表新增 `| card | rechargeSkus, recharge |`
  - `fengyu-staff/cloudfunctions/staffApi/CLAUDE.md` 同步补 card 行
  - `fengyu-client/CLAUDE.md` card 行改为 `list, history, balance, rechargeConfig, recharge`
  - `fengyu-client/cloudfunctions/clientApi/CLAUDE.md` 同步
- DoD：
  - [x] 四个 CLAUDE.md 路由表补齐
  - [⚠️] §3 lint 脚本（index.js vs CLAUDE.md 漂移检测）未做 — 后续可作独立 ticket
