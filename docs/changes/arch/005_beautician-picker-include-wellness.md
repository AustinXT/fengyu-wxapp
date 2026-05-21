---
type: arch
number: "005"
date: 2026-05-21
title: 开单/下单/服务单的美容师选择列表放开养生师
tags: [staff, picker, skills, order, service]
related: []
---

# arch/005 开单/下单/服务单的美容师选择列表放开养生师

## 背景与动机

开单（员工端）、下单（顾客端）、服务单（员工端）三处选择「美容师」时，可选列表此前只放出**美容师**。判定口径是 `staff_wechat_users.skills` 数组**仅含 `'美容师'`**（不按 `position_name`）。

业务诉求：选服务人员时，除美容师外，**养生师也应可被指定接单**。`'养生师'` 在系统里早已是 `skills` 标签 + 提成 `role_type`（mgmt-dashboard 统计、`commission_rate_matrix`、营收/服务提成分配都已含），唯独「美容师选择列表」把它挡在门外。

UI 称呼仍沿用「美容师」（用户偏好），仅在每一项追加身份标签以便区分养生师。

## 技术选型

三个入口共用同一后端 `staff.list`（员工端 `staffApi` / 顾客端 `clientApi` 各一份独立副本，按项目「禁止跨端共享代码」约定）。

| 方案 | 说明 | 取舍 |
|------|------|------|
| 改共享 `staff.list` 过滤（选用） | 一处放开 → 三个入口同时生效，符合单源约定 | 最小改动、跨端一致 |
| 给 `staff.list` 加过滤参数区分调用方 | 可只放开部分入口 | 改动更大、打破现有单源一致性，养生师本就该能接服务单，无必要 |

过滤写法统一为 `skills && ARRAY['美容师','养生师']::text[]`，与 `staffApi/routes/mgmt-dashboard.js:463` 同源；任一技能命中即入选。

## 架构设计

- **后端**：两端 `staff.list` 过滤由 `'美容师' = ANY(skills)` 改为 `skills && ARRAY['美容师','养生师']::text[]`，并在响应中透出 `skills` 数组，供前端派生身份标签。
- **前端身份标签**：各消费方用同一小工具 `roleTag(skills) = skills.filter(s => s==='美容师'||s==='养生师').join('/')`。
  - 员工端开单/服务单 picker 列：`${name}（${[roleTag, department].filter(Boolean).join('·')}）`
  - 顾客端 `staff-popup`：把派生身份写进 `position` 字段（兜底 `position_name`），弹层标题保留「选择美容师」
- **不改**：`staff.default`（绑定美容师，按 `bound_employee_id` 取，不走 skills 过滤）、`staff.detail`、`staff.departments`（营收分配部门选择器）；`service.js` 的 `roleType = skills[0] || '美容师'` 已能对养生师正确归类。

## 相关文件

- `fengyu-staff/cloudfunctions/staffApi/routes/staff.js` — `list()` 过滤 + 透出 skills
- `fengyu-client/cloudfunctions/clientApi/routes/staff.js` — `list()` 过滤 + 透出 skills
- `fengyu-staff/miniprogram/pages/order-create/order-create.ts` — 开单 picker 身份标签
- `fengyu-staff/miniprogram/packageService/service-create/service-create.ts` — 服务单 picker 身份标签
- `fengyu-client/miniprogram/pagesOrder/checkout/checkout.ts` — 下单 staff 映射派生身份
- `fengyu-client/miniprogram/components/staff-popup/staff-popup.wxml` — 弹层注释
- `.42cog/pm/client.pr.spec.md` — EMPLOYEE-01 口径修正（顺手修正旧 spec-code mismatch）
- `fengyu-client/tests/e2e-cloudfn/staff/list-default-detail.spec.mjs` — 养生师入选 + skills 透出断言
- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/staff.test.js` — 养生师入选单测

## 验证

- 员工端 staffApi 单测 + 跨端 SQL 快照：134 passed（快照未漂移，staff.list 字面量不在快照内）
- 顾客端 L2 e2e `staff` 模块：5 cases PASS（含养生师正向入选、skills 透出、非技能员工反例不入选）
