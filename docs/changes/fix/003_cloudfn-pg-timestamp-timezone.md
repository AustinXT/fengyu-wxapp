---
type: fix
number: "003"
date: 2026-06-16
title: 云函数 pg timestamp 读取时区根治（北京时间间歇晚 8 小时显示 16 点）
tags: [timezone, cloudfunction, postgres, pg-types, client, staff, paynotify]
related: ["ops/001"]
---

# fix/003 云函数 pg timestamp 读取时区根治（北京时间间歇晚 8 小时显示 16 点）

## 事件概述

- 发现时间：2026-06-16（用户上报）
- 影响范围：clientApi / staffApi / payNotify 三端云函数返回给小程序的**所有** `timestamp without time zone` 时间字段（订单/预约/服务单/流水/消息等）
- 严重程度：高（时间显示错误，但**不影响数据正确性**——库里存的值是对的）

## 现象

用户在北京时间 8 点提交的数据，之后查看**可能**显示成 16 点（恰好 +8 小时偏移），且为**间歇性**（"可能"，非每次复现）。

## 根因分析

**存储是对的，问题纯在读取侧。**

1. 库里业务时间列是 `timestamp without time zone`，存的是**北京墙钟字面**（如 `2026-06-09 11:43:23`）。
   DB `timezone=Asia/Shanghai`（migration 0028）。写入对进程 TZ **免疫**：node-postgres 把 `new Date()`
   参数序列化为**带偏移**串（实测 TZ=UTC→`...+00:00`、TZ=Shanghai→`...+08:00`，同一绝对时刻），
   PG 按会话 timezone 转换后都落北京墙钟字面；`NOW()` 同理恒定。

2. **读取侧**：node-postgres 用 pg-types 默认 parser `register(1114, parseDate)`，三端只 override 了
   OID 20/1700，**未管 1114**。`postgres-date` 对无时区字面**按进程 TZ** 构造 Date：

   | 进程 TZ | `parseDate("...11:43:23")` → `toISOString()` | 前端(北京)显示 |
   |---|---|---|
   | **UTC**（TZ 设置未生效时） | `...T11:43:23Z` | **19:43:23 ❌（+8h）** |
   | Asia/Shanghai | `...T03:43:23Z` | 11:43:23 ✓ |

3. **为什么间歇 + 难复现**：云函数靠 `process.env.TZ='Asia/Shanghai'`（index.js 顶部**运行时赋值**）+
   cloudbaserc `TZ` env 保证进程时区。但 **CloudBase Node 运行时 V8/ICU 时区在进程 spawn 期即锁定**
   （常为 UTC），运行时改 env / spawn 后注入 env **不保证覆盖**已初始化的 ICU → 冷热启动、不同实例
   表现不一 → 偶发。**开发机默认 TZ 恰是 Asia/Shanghai**，所以本地开发/测试永远是对的，只有线上 UTC
   容器才暴露——这正是它长期逃过测试的原因。代码内 `utils/datetime.js` 早有"不依赖 process.env.TZ
   结果稳定"的同源教训注释，但未贯彻到 pg 读取路径。

4. **admin 为何已正常**：admin（postgres.js）靠**容器 `ENV TZ`**（Dockerfile + compose，进程 spawn
   **之前**注入，见 ops/001），可靠生效。两端差异：admin = OS/容器级 TZ（可靠）；云函数 = 进程内
   env（不可靠）。

## 修复方案

**不再依赖脆弱的进程 TZ，改用进程内确定性的 typeParser**：给无时区时间列的字面显式按 `+08:00` 解读。

四处（跨端各自副本，符合「禁止跨端共享」约定），紧挨现有 `setTypeParser(20)/(1700)`：

```js
// timestamp without time zone (1114)：库存北京墙钟字面，显式按 +08:00 构造 Date，与进程 TZ 解耦。
pg.types.setTypeParser(1114, (val) => (val === null ? null : new Date(val.replace(' ', 'T') + '+08:00')))
```

- `fengyu-client/cloudfunctions/clientApi/db/pg.js`
- `fengyu-staff/cloudfunctions/staffApi/db/pg.js`
- `fengyu-client/cloudfunctions/payNotify/index.js`（getPg）+ `payNotify/config.js`（顶层；与 getPg 注册等价，两处都加防漏）

**返回 Date 对象（类型不变）**：序列化给前端是正确 UTC ISO，云函数内部 Date 运算也兼容。

### 明确不改（避免过度修复）

- **写入端**：实测对进程 TZ 免疫，库存储恒为北京墙钟字面（修复闭环的前提，已坐实）。
- **date 列 (1082)**：所有消费在两种 TZ 下都已正确（本地构造+本地读自洽 / 前端 +8 还原 / 日期差 floor 吸收）；
  ⚠️ 若给 1082 返回"北京午夜 Date"会让生日/到期**倒退一天**，故绝不动。
- **timestamptz 列 (1184)**：默认 parser 已给正确绝对时刻、与进程 TZ 无关；1114 parser 不影响（OID 独立）。
- **前端 / admin / schema**：前端时间展示统一走 formatDate/formatDateTime（含云函数 route 内 formatDateTime），
  修 parser 后自动正确；admin 经 ops/001 已修；无需改 schema（不必 timestamp→timestamptz）。

## 行为变更（修好的副作用，非破坏）

- **待支付订单自动关单**（clientApi `order.js`）：原 `sale_order_datetime` 被当 UTC 晚 8h，10 分钟超时实际
  ~8 小时后才触发；修复后恢复为真正 10 分钟。
- **下单页支付倒计时**：原显示 ~8 小时，修复后显示真正 5–10 分钟。
- **储值卡乐观锁 token**（`updated_at` getTime 相等校验）：部署窗口内前端旧值瞬时 CONFLICT，刷新自愈，无数据风险。

## 验证

1. **本地 TZ=UTC 连 dev 库端到端**：跨 `sale_orders`/`appointments`/`service_orders` 4 表 8 个真实时间值，
   修复前默认 parser 偏 +8h、修复后零偏移，全绿。
2. **dev 线上真实函数**：部署 dev 后 invoke `clientApi order.list`（真实订单 `FY-XSD-WX-2606080003`），
   返回 `sale_order_datetime=...T12:07:51.537Z` → 前端北京 `2026-06-08 20:07:51` == 库存北京墙钟（零偏移）。
3. **回归守护**（强制 TZ=UTC 子进程，本机 Shanghai 也有效）：
   - `fengyu-client/tests/e2e-cloudfn/timezone/pg-timezone-parser.spec.mjs`（run-all `--module timezone`）
   - `fengyu-staff/tests/e2e-cloudfn/smoke-timezone-parser.mjs`（run-all `--filter timezone`）

## 部署

仅云函数侧，**无需小程序发版 / admin 部署 / db migration**。

- [x] dev 三函数（clientApi/staffApi/payNotify）已部署并验证（2026-06-16）
- [ ] prod 部署：`scripts/use-env.sh prod` → `scripts/deploy-cloudfunctions.sh`（禁手动 `tcb fn code update` 跨环境）

## 预防措施

- [x] 两端 TZ=UTC 守护 spec 防回归（删了修复在本机 Shanghai 也会 FAIL）
- [ ] 原则固化：**云函数读 PG 时间字段一律不依赖进程 TZ**；新增云函数的 pg 初始化须带 1114 +08:00 parser
- 关联 [ops/001](../ops/001_admin-container-timezone.md)（admin 容器 TZ）与项目记忆 `pg-date-serialization-utc`（2026-05-26 前端侧同源修复）共同构成全链路时区一致性
