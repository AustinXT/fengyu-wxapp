# Ticket: 会员权益页拆分 + 生日/感恩日场景补齐

> 生成日期：2026-04-24
> 严重级别：P2（管理后台结构调整 + 新增 2 个权益场景）
> 端：fengyu-admin（**本 ticket 范围**） + cronTask 云函数（**待接入**）
> 影响面：admin.actions.settings（+2 action）+ admin 路由（+1 页面）+ menu（+1 项）+ cronTask（待补 2 个发放任务）

---

## 0 一句话背景

原「会员等级权益」仅配置**升级**场景，埋在 `/settings` 页面的一个 Tab 里。业务新增两个场景：生日权益 + 感恩日权益。三者字段结构完全一致（积分 + 消息标题 + 消息正文 + 优惠券），适合复用同一个 UI 组件，但数据独立存储。

本 ticket 只实现**管理后台配置层**。生日权益 / 感恩日权益的**发放逻辑**由 cronTask 云函数补齐（见 §4）。

## 1 已完成（admin 配置层）

- 新增页面 `/member-benefits`，归属菜单「数据管理」组，权限 `system:config`（admin）
- 三个 Tab：升级权益 / 生日权益 / 感恩日，共享 `MemberLevelBenefitsForm` 组件
- 数据层三份独立 JSON，存 `system_configs` 表：
  - `member_level_benefits`（升级，cronTask 已在用，key 不变）
  - `birthday_benefits`（生日，**新增**）
  - `thanksgiving_benefits`（感恩日，**新增**）
- Server Actions：`getMemberBenefits()` / `saveMemberBenefits(bundle)`
- 原 `/settings` 页面删除「会员等级权益」Tab，`getSettings` / `saveSettings` 不再处理权益字段

## 2 业务规则

### 升级权益（已有发放逻辑）

顾客每日 3:00 由 cronTask 重算会员等级时，若等级升高，发对应等级权益。降级仅记录日志。

### 生日权益（待接入发放）

- **触发时机**：顾客生日当天（按 `client_wechat_users.birthday` 字段月日匹配）
- **发放对象**：当日生日 + 已绑定门店的顾客
- **权益读取**：按顾客**当前等级**读 `birthday_benefits[level]`
- **幂等约束**：同一 `(customer_id, year)` 一年仅发一次（需新增表或复用 `customer_benefits_ledger`）

### 感恩日权益（待接入发放）

- **触发时机**：**每月 20 号**
- **发放对象**：当日下**护理单**的顾客（`service_orders` 当日存在 `status IN ('服务中','已完成')` 的行）
- **权益读取**：按顾客当前等级读 `thanksgiving_benefits[level]`
- **优惠券有效期**：**10 天**（需在 cronTask 发券时覆盖 coupon_template 默认有效期）
- **幂等约束**：同一 `(customer_id, year_month)` 一月仅发一次

## 3 数据结构

三种场景共用 `MemberLevelBenefitsMap`：

```ts
Record<'初钻'|'星钻'|'粉钻'|'金钻'|'黑钻', {
  points: number              // 非负整数，0 表示不发
  couponTemplateIds: string[] // 来自 coupon_templates.template_id
  messageTitle: string        // 空字符串表示不发消息
  messageBody: string
}>
```

## 4 待办（cronTask 云函数侧，下一 ticket）

### 4.1 生日权益发放任务

- 新增 `cronTask` 每日任务（或合并到现有 3:00 重算任务）扫描当日生日顾客
- 按 `client_wechat_users.birthday` 匹配月日（忽略年份）
- 复用现有 `grantBenefitsToCustomer` 发放函数（升级场景已实现），传入 `birthday_benefits` 作为 benefits map
- 幂等：建议新建 `benefit_grants` 表或在 `operation_logs` 查重

### 4.2 感恩日权益发放任务

- 新增 `cronTask` 每月 20 号触发（CRON: `0 3 20 * *`）
- 扫描当日 `service_orders` 有 `status IN ('服务中','已完成')` 的 DISTINCT customer_id
- 按顾客等级查 `thanksgiving_benefits[level]`，发放三件套
- 发券时将 `valid_end = NOW() + 10 days` 强制覆盖 coupon_template 默认有效期
- 幂等：同月同客户仅一次

### 4.3 复用建议

现有 cronTask 已有 `grantBenefits` 逻辑读 `member_level_benefits`。重构建议：
1. 抽一个 `loadBenefitsByScenario(scenario)` 函数，入参 `'upgrade'|'birthday'|'thanksgiving'`
2. 抽一个 `grantBenefits(customerId, level, benefits, options)` 函数，`options.couponValidDays` 覆盖券有效期

## 5 不做

- 不做 WorkFine 同步相关改动
- 不做顾客端/员工端 UI（权益消息已有消息中心页面承接）
- 不做降级场景的权益配置（业务明确降级只记日志）
