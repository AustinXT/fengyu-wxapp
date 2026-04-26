# 审计报告：WXML / Vant 一致性 (CC8)

**审计时间**：2026-04-25（v1）/ 2026-04-26（v2 合并版）
**域 ID**：CC8（横切收官）
**审计员**：claude-opus-4-7（v1）/ claude batch agent（v2）
**审计时长**：~15 分钟（v1）+ ~20 分钟（v2）
**版本**：v1+v2 合并（最终版）
**合并说明**：
- v1 P1-CC8-01（已关闭 Tab）→ 部分修复，`已关闭` STATUS_MAP 已加，Tab 仍缺，降为 P2-CC8-11
- v1 P1-CC8-02 → watch-only，service_orders 无 `已关闭`，无需修复
- v1 P1-CC8-03（bind:click 混用）→ v2 未发现实际 bug，降为 P2-CC8-12
- v1 P1-CC8-04（Staff error 态缺失）→ v2 确认持续未修复，降为 P2-CC8-13
- v2 新增 4 个 P1（第 06-09 号）
- v2 P2-CC8-V2-05..V2-09 编号为 P2-CC8-11..15（避免与 v1 P2 编号冲突，v1 P2-CC8-06..10 保留）

---

## 1. 三端入口对照（CC8 范围）

CC8 仅覆盖**双小程序端**（admin 是 Next.js Web，不在范围）。

| 层 | client (`fengyu-client/miniprogram/`) | staff (`fengyu-staff/miniprogram/`) |
|----|---------------------------------------|-------------------------------------|
| Tab 主页 (.wxml) | `pages/{home,profile,cart,appointment}/` 4 个 | `pages/{workbench,service,order-create,profile,customer-list,sales-data,mgmt-dashboard,login}/` 8 个 |
| 子包 (.wxml) | `pagesShop/ pagesOrder/ pagesProfile/ pagesAppointment/ pagesStore/ pagesCoupon/ pagesExperience/` 20+ 个页面 | `packageService/ packageOrder/ packageMgmt/ packageCustomer/` 19 个页面 |
| 自定义组件 | `components/staff-popup/`, `components/nav-bar/` 2 个 | `components/{mgmt-data-state, mgmt-stat-card, mgmt-period-picker, mgmt-scope-picker, mgmt-navbar, mgmt-metric-tabs, conversion-panel, bundle-picker, placeholder-page}/` 9 个 |
| Vant 组件 | Vant Weapp 1.x（双层 `miniprogram_npm/@vant/weapp/`，含一份顶层 + 嵌套副本，疑似构建残留） | Vant Weapp 1.x（`miniprogram_npm/@vant/weapp/` + `node_modules/@vant/weapp/{lib,dist}/` 共 3 份；典型未净 build artefact）|
| 后端 enum 权威 | `db/schema/enums.ts:5-90`（28 个枚举的字面量是 UI 文案唯一权威） | ↑ |

> 备注 1：本次仅扫业务 `.wxml` + `.ts`，跳过 `miniprogram_npm/` / `node_modules/` 下的 Vant 自身 wxml。
> 备注 2：双端均 100% 走 Vant Weapp 1.x，无第三方/自研 UI 库混用，根基面 OK。

---

## 2. 数据流图（CC8 视角）

```
后端 enum (db/schema/enums.ts:5-90)
   │
   │  返回 status / type 字面量 (例如 '待服务' / '已确认')
   ▼
云函数 routes/*.js (透传，不映射)
   │
   ▼
前端 .ts (硬编码 status === '中文枚举' 分支或映射表)
   │
   ▼
.wxml `wx:if="{{ item.status === '...' }}"` + `<van-tag>` / `<van-empty>` / `<van-loading>` 渲染
```

整条链路依赖**字面量字符串**对齐：后端改字 → 前端不改 → UI 静默错位（典型如 audit-24 P0-24-02 已记的级联问题）。

---

## 3. 状态机枚举权威对照

### 3.1 sale_orders 状态（orderStatusEnum）

| DB 值 | Staff 订单列表 Tab 文案 | Staff TS STATUS_CLASS | Client 订单列表 Tab 文案 | Client TS STATUS_CLASS |
|-------|------------------------|----------------------|-------------------------|------------------------|
| 待支付 | `待支付` (Tab 名) | `pending` | `待支付` (Tab 名) | `status-pending` |
| 待确认收款 | `待确认` (Tab 名) | `pending` | — (无独立 Tab) | `status-confirm` |
| 已支付 | `已支付` (Tab 名) | `success` | `已支付` (Tab 名) | `status-paid` |
| 已完成 | `已完成` (Tab 名) | `done` | `已完成` (Tab 名) | `status-completed` |
| 支付失败 | `支付失败` (Tab 名) | `error` | — (无独立 Tab) | `status-failed` |
| 已关闭 | `已关闭` (Tab 名) | `done` | — (无独立 Tab) | `status-closed` |
| **待审批** | `待审批` (refund-list Tab) | 仅 `formatters.ts` 有；`order-list.ts` 局部 **缺失** | — (无独立 Tab) | **缺失** |
| **部分支付** | — (无 Tab) | **缺失** | order-detail.wxml `wx:if` 有 | **缺失（format.ts 和 formatters.ts 均无）** |

**说明**：
- Staff `formatters.ts` 的 `STATUS_CLASS` 覆盖了 `待审批`，但 `packageOrder/order-list/order-list.ts` 的局部 `STATUS_CLASS` 不包含 `待审批`（两处不同步）。
- `部分支付` 两端 STATUS_CLASS 均未定义，client `order-detail.wxml` 有条件渲染但无颜色类。

### 3.2 service_orders 状态（serviceOrderStatusEnum）

| DB 值 | Staff service.wxml Tab | Staff TS 状态映射 | Client service-records 文案 |
|-------|------------------------|------------------|-----------------------------|
| 待服务 | `待服务` | pending → `status-tag--pending` | `待服务` |
| 服务中 | `服务中` | processing → `status-tag--progress` | `服务中` |
| 已完成 | `已完成` | completed → `status-tag--done` | `已完成` |
| 已取消 | — (无 Tab) | — | `已取消` |

**结论**：Staff service.wxml 缺少 `已取消` Tab（服务单 TAB 仅 3 个，`已取消` 单据无入口）。Client service-records 展示全部记录，已取消可见。

### 3.3 appointments 状态（appointmentStatusEnum）

| DB 值 | Staff appointment.wxml Tab | Staff TS | Client appointment.wxml Tab | Client TS STATUS_MAP |
|-------|--------------------------|----------|-----------------------------|----------------------|
| 待确认 | `待确认` | pending → `warning` | `待确认` | `warning` |
| 已确认 | `已确认` | confirmed → `primary` | `已确认` | `primary` |
| 已完成 | `全部` Tab 包含 | completed → `success` | 全部 Tab（含） | `success` |
| 已取消 | `全部` Tab 包含 | cancelled → `default` | `已取消` | `default` |
| **已关闭** | `全部` Tab 包含（5 值齐）| — | **已加入 STATUS_MAP**（部分修复） | **有兜底：`STATUS_MAP['已关闭']`**，但**仍无独立 Tab** |

> v1 指出 client 缺 `已关闭` STATUS_MAP；v2 确认已修复（`appointment.ts:14` 已加入映射），但独立 Tab 仍缺（P2-CC8-11）。

---

## 4. 自身漏洞

### 4.1 P0（阻断 / 资损 / 越权）

无（CC8 的 UI 一致性问题主要影响 UX 与维护性，未观察到直接资损或越权通道）。

### 4.2 P1（数据一致 / 状态错乱 / UX 断裂）

#### **[P1-CC8-06]** `部分支付` 状态双端 STATUS_CLASS 缺失 → 渲染降级为未定义样式

- **文件**：
  - `fengyu-client/miniprogram/utils/format.ts:68-75`（无 `部分支付` key）
  - `fengyu-staff/miniprogram/utils/formatters.ts:3-10`（无 `部分支付` key）
  - `fengyu-staff/miniprogram/packageOrder/order-list/order-list.ts:47-54`（无 `部分支付` key）
- **现象**：
  - DB `orderStatusEnum` 中 `部分支付` 是合法值（`db/schema/enums.ts:13`）
  - Client `order-detail.wxml:143` 有 `wx:if="{{order.status === '部分支付'}}"` 条件渲染，说明运行时会出现此状态
  - 但两端 STATUS_CLASS 映射均无此 key；`order-detail.wxml:59` 的 `{{item.statusClass}}` 将得到 `getStatusClass` 的默认值 `status-class-done`（client）或 `pending`（staff），显示样式语义错误
- **风险**：已付款但未付清的订单在列表中会被错误标为"已完成"样式（绿色/灰色），用户和店员误判订单状态
- **修复**：在 `format.ts` 和 `formatters.ts` 各加 `'部分支付': 'status-confirm'`（橙色，表示未完成）；同步更新 `order-list.ts` 局部 STATUS_CLASS

#### **[P1-CC8-07]** Staff `待审批` 状态两处 STATUS_CLASS 不同步

- **文件**：
  - `fengyu-staff/miniprogram/utils/formatters.ts:10`：`'待审批': 'pending'` ✅
  - `fengyu-staff/miniprogram/packageOrder/order-list/order-list.ts:47-54`：**无 `待审批` key** ❌
- **现象**：`order-list.ts:128` 使用局部 `STATUS_CLASS[r.status] || 'pending'` 作兜底，偶然使得退款单的 `待审批` 状态也显示为 `pending`（橙色）——结果正确，但是靠兜底而非显式定义，未来若修改兜底值将静默错位
- **风险**：维护性漏洞，需显式补充
- **修复**：在 `order-list.ts:47` 局部 STATUS_CLASS 显式加 `'待审批': 'pending'`

#### **[P1-CC8-08]** Client 端 `待审批` 状态无渲染逻辑

- **文件**：`fengyu-client/miniprogram/utils/format.ts:68-75`、`pagesOrder/orders/orders.wxml`
- **现象**：
  - Client 订单列表 Tab 仅 4 项（全部/待支付/已支付/已完成），无 `待审批` Tab
  - `orders.wxml:108` 的操作按钮区仅有 `已完成 || 已关闭` 分支
  - 若退款单状态为 `待审批` 出现在顾客订单列表，`statusClass` 将得到 `status-class-done`，显示样式与语义不符
  - Client 实际上不会直接操作退款审批（这是 Staff 专属功能），但顾客可在"我的订单"看到退款单，当其状态变为 `待审批` 时 UI 渲染无明确处理
- **风险**：退款中的顾客在客户端看不到明确的"退款审核中"状态说明
- **修复**：在 `format.ts STATUS_CLASS` 加 `'待审批': 'status-pending'`；`orders.wxml` 可在操作按钮区加 `wx:elif="{{item.status === '待审批'}}"` 展示"退款审核中"提示文本

#### **[P1-CC8-09]** Staff service.wxml 缺 `已取消` 服务单入口

- **文件**：`fengyu-staff/miniprogram/pages/service/service.wxml:13-16`
- **现象**：Tab 仅 3 个（待服务/服务中/已完成），无 `已取消` Tab。已取消的服务单无法通过此页面查看。`packageService/service-list/service-list.wxml` 为空壳（仅 loading spinner，无实际内容）
- **风险**：员工无法在前端确认服务单是否已取消，需跳转 order-detail 间接查看
- **修复**：在 `pages/service/service.wxml` 加第 4 Tab `name="cancelled" title="已取消"`；`service.ts:65-70` statusMap 加 `cancelled: '已取消'`

#### **[P1-CC8-10]** 双端 `bind:click` / `bindtap` 混用（v1 P1-CC8-03，降级后从略）

- **文件**：双端所有 WXML 文件
- **现象**：延续 v1 报告，双端内部及跨端均存在混用；client `bindtap` 93 处 / `bind:click` 6 处；staff `bindtap` 117 处 / `bind:click` 50 处。Vant Weapp 1.x 推荐 `<van-cell>` 用 `bind:click`（经过 clickable 状态门控），`bindtap` 不经过。
- **v2 降级原因**：v2 审查未发现实际因 `disabled` 绕过产生的业务 bug，主要影响维护性
- **修复**：统一规范：Vant 组件上一律用 `bind:click`，原生元素用 `bindtap`；可用 grep 脚本门禁

---

### 4.3 P2（代码质量 / 可维护）

#### **[P2-CC8-11]** Client appointment.wxml 缺 `已关闭` 独立 Tab（v1 P1-CC8-01 部分修复后降级）

- **文件**：`fengyu-client/miniprogram/pages/appointment/appointment.ts:14` + `appointment.wxml:14-17`
- **现象**：`appointment.ts:14` 已加入 `已关闭` STATUS_MAP 映射（v2 确认修复），但 `appointment.wxml:14-17` 仍仅 4 个 Tab（全部/待确认/已确认/已取消），无 `已关闭` 独立 Tab；用户只能在"全部"中看到已关闭预约，无法精确筛选
- **风险**：用户体验断裂，无法精确筛选已关闭预约
- **修复**：(L9 前端) 补 Tab

#### **[P2-CC8-12]** 双端 van 事件绑定风格分裂（v1 P1-CC8-03 降级）

- **文件**：双端所有 WXML 文件（见 §4.2 P1-CC8-10）
- **修复**：统一为 `bind:{eventName}` 冒号风格；加 lint rule 拒绝 van 组件上的 `bindtap`

#### **[P2-CC8-13]** Staff 非 mgmt 域列表缺 error 态区分（v1 P1-CC8-04 降级）

- **文件**：`pages/service/service.wxml`、`packageOrder/order-list/order-list.wxml`、`packageService/appointment/appointment.wxml`、`pages/customer-list/customer-list.wxml`、`pages/workbench/workbench.wxml` 等
- **现象**：
  - Staff mgmt 域用 `<mgmt-data-state>` 组件覆盖 loading/empty/error/retry 四态（✅）
  - Staff **非 mgmt 域**（packageOrder / packageService / pages/{service,customer-list}）全部 **0 处** 使用 `image="error"` 区分错误态；loading 失败一律退化为"暂无…"（⚠️）
  - client 27 处 `image="error"` 一致模式（✅）
- **风险**：Staff 非 mgmt 域"已审批退款"列表加载失败，用户以为是真无数据，不会下拉刷新
- **修复**：在 packageOrder / packageService 的列表页加 `wx:elif="{{error}}"` + `<van-empty image="error">`；或推广 `<mgmt-data-state>` 组件

#### **[P2-CC8-14]** Staff `mgmt-data-state` 设计良好但仅 1/3 范围使用（v1 P2-CC8-08）

- **文件**：`fengyu-staff/miniprogram/components/mgmt-data-state/mgmt-data-state.wxml`
- **现象**：组件已封装 loading/empty/error/retry 四态，contract 清晰（`state` / `empty-text` / `bind:retry`），但 `packageOrder/*`、`packageService/*`、`packageCustomer/*` 全部未引用，仅 mgmt 子域使用
- **风险**：好抽象未被复用 = 隐性技术债
- **修复**：(L9) 推广该组件到全 staff，再考虑 client 同步引入

#### **[P2-CC8-15]** 双端 Vant 副本目录爆炸（v1 P2-CC8-06）

- **文件**：
  - client：`miniprogram_npm/@vant/weapp/` + `miniprogram_npm/miniprogram_npm/@vant/weapp/`（嵌套 npm dist）
  - staff：`miniprogram_npm/@vant/weapp/` + `node_modules/@vant/weapp/lib/` + `node_modules/@vant/weapp/dist/`
- **现象**：构建产物未净，体积冗余、IDE 跳转易跳到错的副本
- **风险**：仅维护性
- **修复**：(L9) `.gitignore` 只保留 `miniprogram_npm/@vant/weapp/`，删冗余副本；CI 脚本净构建

#### **[P2-CC8-16]** 双端"暂无…"文案完全分散，无中心化字典（v1 P2-CC8-07）

- **现象**：grep 到至少 20+ 处不同的 `<van-empty description="暂无XXX" />`（暂无购买记录 / 暂无订单 / 暂无可用疗程卡 / 暂无积分记录 / 暂无消息 / 暂无可核销疗程 / 暂无赠送记录 / 暂无退换记录 / 暂无提成记录 / 暂无待分配订单 / 暂无可用优惠券 / 暂无…），文案散落在各 wxml 字面量
- **风险**：i18n / 文案统一调整时需逐个改
- **修复**：(L9) 抽 `utils/empty-text.ts` 字典常量

#### **[P2-CC8-17]** `service-list.wxml` 为空壳（v2 新增）

- **文件**：`fengyu-staff/miniprogram/packageService/service-list/service-list.wxml`
- **现象**：文件内容为 1 个永久 loading spinner，无任何列表渲染逻辑。实际 UI 入口由 `pages/service/service.wxml` 承担
- **风险**：死代码，可能误导新开发者
- **修复**：删除或补全 `packageService/service-list/` 目录内容

#### **[P2-CC8-18]** Client profile.wxml 订单快捷入口状态覆盖不完整（v2 新增）

- **文件**：`fengyu-client/miniprogram/pages/profile/profile.wxml:52-67`
- **现象**：快捷入口仅展示"待支付 / 已支付 / 已完成 / 全部"4 个，`data-status` 分别为 `待支付`、`已支付`、`已完成`（硬编码）。DB 中还有 `待确认收款`、`支付失败`、`已关闭`、`待审批`、`部分支付` 共 5 个状态未在快捷入口体现
- **风险**：视觉不完整，但顾客使用的状态通常就是这 3-4 个，业务影响有限
- **修复**：视产品需求酌情补充"已关闭"入口或保持现状（顾客视角 4 态够用）

#### **[P2-CC8-19]** client `pagesProfile/messages` 与 client `pages/appointment` 的 list footer 文案分裂（v1 P2-CC8-09）

- **现象**：均是分页底部，文案一处用 `没有更多消息了`，一处用 `没有更多预约了`，再一处仅 `没有更多了`（points / orders）
- **风险**：体验细节不一致
- **修复**：(L9) 统一 `加载完毕` 或抽组件

#### **[P2-CC8-20]** Vant `<van-tag color="{{kindDisplayColor}}">` 无 HEX 校验兜底（v1 P2-CC8-10）

- **文件**：`fengyu-staff/miniprogram/packageService/product-detail/product-detail.wxml:23`、client 同源
- **现象**：admin 写入的 `display_color` 若非合法 HEX，Vant 渲染未定义
- **修复**：(L7 admin schema 校验) 已在 audit-24 提，不重复评级

#### **[P2-CC8-21]** staff `refund-list` Tab 用"待审批/已支付/已关闭"与 storeUnbindRequestStatus 的"待处理/已通过/已拒绝/已取消"两套语义同时存在（v1 P1-CC8-05，降级为 P2）

- **文件**：
  - `fengyu-staff/miniprogram/packageOrder/refund-list/refund-list.ts:4` `type TabStatus = '待审批' | '已支付' | '已关闭'`（基于 sale_orders.status）
  - `fengyu-staff/miniprogram/packageService/unbind-requests/unbind-requests.wxml:12` 暂未在前端 Tab 显示 storeUnbindRequestStatus 的全 4 值
- **现象**：审批类 UI 文案在两个域用了两套 enum：退款单走 `orderStatusEnum` 的 `待审批`，门店解绑走 `storeUnbindRequestStatusEnum` 的 `待处理`。审批人在不同页面看见不同字。
- **降级原因**：属业务设计分歧，超出 wxml/vant 技术范畴
- **风险**：员工心智模型不统一
- **修复**：(L9) UI 文案统一用业务通用语 "待审批/已通过/已驳回"，前端做 enum→label 映射层

---

## 5. 跨端不一致（双小程序）

| 维度 | client | staff | 风险 | 优先级 |
|------|--------|--------|------|--------|
| `部分支付` STATUS_CLASS | 缺失（format.ts） | 缺失（formatters.ts + order-list.ts） | 订单样式语义错误 | P1-CC8-06 |
| `待审批` STATUS_CLASS | 缺失（format.ts） | 两处不同步（formatters.ts 有，order-list.ts 无） | 维护性漏洞 | P1-CC8-07 |
| `待审批` 渲染逻辑 | 无（orders.wxml 无此状态处理）| refund-list 有 | 顾客看不到退款审核中 | P1-CC8-08 |
| `已取消` 服务单 Tab | ✅（service-records 展示全部）| ❌（仅 3 Tab） | 员工无法从前端直接查看已取消服务单 | P1-CC8-09 |
| 事件绑定风格 | `bindtap` 93 处（94%）| `bindtap` 117 处（70%）+ `bind:click` 50 处 | 维护性 + disabled 绕过弱风险 | P2-CC8-12 |
| 列表 error 态 | `<van-empty image="error">` 6 处一致 ✅ | 0 处区分（loading 失败 = empty）❌ | UX 误导 | P2-CC8-13 |
| appointment `已关闭` Tab | 无独立 Tab（STATUS_MAP 已修复）| 无独立 Tab | 无法精确筛选已关闭预约 | P2-CC8-11 |
| Vant 副本数 | 2 份 | 3 份 | 体积 + IDE | P2-CC8-15 |
| 退款/解绑审批 UI 文案 | — | `待审批` vs `待处理` 分裂 | 心智不统一 | P2-CC8-21 |
| 自定义组件数 | 2 个（staff-popup, nav-bar） | 9 个（mgmt-* 7 + bundle-picker + placeholder-page） | staff 抽象成熟度更高 | — |

---

## 6. 横切检查（套用 §3 模板）

CC8 自身就是收官报告。以下记录与其他 CC 的交叉点：

- [—] CC1 数值精度：N/A（UI 渲染层）
- [—] CC2 并发幂等：N/A
- [x] CC3 组织隔离：UI 不直接涉及，但 staff `customer-detail.wxml` 等手写 wxml 透传后端字段，CC3 漏 scope 的 PII 会原样渲染（详 audit-10 / audit-19）
- [x] CC4 鉴权：UI 上"前端 UI 文本字符串错传后端 ID 字段"主线（CROSS-CUTTING.md:584-588 已记），与 CC8 同根
- [x] CC5 错误码：staff `<van-empty>` 不区分 error / empty 与 CC5 "callStaffApi 丢 errorType 致 UI dispatch 失效" (audit-CC5-error-code.md) 互为因果
- [—] CC6 PII：与 audit-CC6-pii §5 "staff 4 处 wxml 直显 phone（manager 分支）" 已交叉
- [x] CC7 时间字段：CC7 P2-14 "前端 formatDateTime 可能展示误差" 在 wxml 中等 `<van-cell value="{{formattedTime}}">` 体现
- [x] **CC8 自身**：本报告
- [x] CC9 测试与残留：双 Vant 副本 + 嵌套 `miniprogram_npm/miniprogram_npm/` 是构建残留，与 CC9 "已废弃残留"同纲

---

## 7. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema/enums | — | — | — |
| L9 前端 client | `utils/format.ts` | 加 `'部分支付': 'status-confirm'` + `'待审批': 'status-pending'` | P1-CC8-06, P1-CC8-08 |
| L9 前端 client | `pagesOrder/orders/orders.wxml` | 加 `wx:elif="{{item.status === '待审批'}}"` 提示文本 | P1-CC8-08 |
| L9 前端 client | `pages/appointment/appointment.{ts,wxml}` | 补 `已关闭` Tab（STATUS_MAP 已修复，仅补 Tab）| P2-CC8-11 |
| L9 前端 staff | `utils/formatters.ts` | 已含 `'待审批': 'pending'`，确认保留 | P1-CC8-07 |
| L9 前端 staff | `packageOrder/order-list/order-list.ts:47` | 显式加 `'部分支付': 'pending'` + `'待审批': 'pending'` | P1-CC8-06, P1-CC8-07 |
| L9 前端 staff | `utils/formatters.ts` | 加 `'部分支付': 'pending'` | P1-CC8-06 |
| L9 前端 staff | `pages/service/service.wxml` | 加第 4 Tab `name="cancelled" title="已取消"` | P1-CC8-09 |
| L9 前端 staff | `pages/service/service.ts` | statusMap 加 `cancelled: '已取消'` | P1-CC8-09 |
| L9 前端 staff | `packageOrder/*`, `packageService/*`, `pages/{service,customer-list,workbench}` | 加 `<van-empty image="error">` 或推广 `<mgmt-data-state>` | P2-CC8-13, P2-CC8-14 |
| L9 前端 双端 | grep `<van-[^>]+bindtap` 全替换为 `bind:click`/`bind:tap` | 风格统一 | P2-CC8-12 |
| L9 前端 双端 | 抽 `utils/empty-text.ts` 字典 | 暂无文案集中 | P2-CC8-16 |
| L9 前端 双端 | 抽 `utils/status-label.ts` 字典 | 状态 label 字面量集中 | P2-CC8-21 |
| L10 构建 | `.gitignore` + CI | 只保留 `miniprogram_npm/@vant/weapp/`，删冗余副本 | P2-CC8-15 |
| L10 lint | 引入 wxml-lint 规则：`van-*` 元素禁用 `bindtap` | 自动门禁 | P2-CC8-12 |
| L10 或 L9 | 删除 `packageService/service-list/` 空壳文件 | 消除死代码 | P2-CC8-17 |

---

## 8. 验证 SQL（在 5434 EXPLAIN，禁止写入）

CC8 是纯前端域，无对应 SQL 验证。仅可验证后端枚举 baseline 是否被 UI 全部覆盖：

```sql
-- 验证后端 appointment_status 枚举与 client UI Tab 数差异（人工对照）
SELECT unnest(enum_range(NULL::appointment_status)) AS status_val
ORDER BY 1;
-- 预期 5 行：待确认 / 已确认 / 已完成 / 已取消 / 已关闭
-- client appointment.wxml 仅 4 个 Tab；缺 已关闭 → P2-CC8-11

-- 验证 sale_orders status 分布（含 P1-CC8-06 背景数据）
SELECT status, count(*) FROM sale_orders GROUP BY 1 ORDER BY 1;
-- 部分支付 / 待审批 若有数据则 P1-CC8-06/07 严重程度上升

-- 验证 service_order_status 枚举（供回归）
SELECT unnest(enum_range(NULL::service_order_status));
-- 预期：待服务 / 服务中 / 已完成 / 已取消（双端 wxml 已对齐 ✓）
-- P1-CC8-09：Staff service.wxml 缺 已取消 Tab

-- 是否真有数据落入 appointment.status='已关闭'（佐证 P2-CC8-11 严重程度）
SELECT count(*) FROM appointments WHERE status = '已关闭';
```

---

## 9. 回归测试用例（建议）

1. **client `部分支付` 样式渲染**：构造 1 条 `status='部分支付'` 的 sale_order，列表项 statusClass 应为橙色（`status-confirm`）而非绿色（`status-done`）
2. **client `待审批` 状态显示**：退款单状态为 `待审批` 时，订单列表项应有明确状态标签（如"退款审核中"），不降级为"已完成"
3. **staff `待审批` 两处映射同步**：检查 order-list（局部 STATUS_CLASS）和 formatters.ts（共享）均含 `待审批`
4. **staff service `已取消` Tab**：点击"已取消"Tab，列表应展示状态为 `已取消` 的服务单
5. **staff list 失败态区分**：mock 退款列表 API 返回 5xx，wxml 应渲染"加载失败"而非"暂无退款单"
6. **client appointment `已关闭` Tab**：点击"已关闭"Tab，列表应展示状态为 `已关闭` 的预约
7. **wxml-lint**：CI 加 `grep '<van-[a-z-]+[^>]*bindtap'` 计数门禁（首次设阈值，禁止增量）
8. **暂无文案字典覆盖**：snapshot 测试所有 `<van-empty description=` 是否取自 `utils/empty-text.ts` 常量

---

## 10. 影响半径

- 单端：☐
- 跨端（双小程序）：☑
- 全栈（3 端 + DB）：☐（CC8 不涉 admin web 与 DB）
- 涉及历史数据：☐
- 修复成本：**S**（多为字面量统一 + 组件复用，无 schema 变更）

---

## 11. 后续待办

- [ ] 与产品 / 设计对齐：`待审批` vs `待处理` UI 统一文案（P2-CC8-21）
- [ ] 引入 wxml-lint（如 `wxml-linter` + 自定义规则禁 `<van-* bindtap>`）（P2-CC8-12）
- [ ] staff 推广 `mgmt-data-state` → 全包；client 同步引入（与 staff 共同 contract）（P2-CC8-14）
- [ ] 写一条 `notes/tickets/2026-04-26-cc8-wxml-vant-final.md` 把 P1-CC8-06..10 / P2-CC8-11..21 拉成清单
- [ ] 与 audit-24 P0-24-02 / CROSS-CUTTING.md "UI ↔ DB enum 同步" 主线合流，统一为治理项
- [ ] 删除 `packageService/service-list/` 空壳文件（P2-CC8-17）
- [ ] `部分支付` / `待审批` STATUS_CLASS 修复后回归验证（见 §9 测试用例）

---

## 附：横切归集回写（CROSS-CUTTING.md 视角）

**本身就是 CC8 合并收官**，无新条目向 `CROSS-CUTTING.md` 追加。

历史上各业务域 §5 CC8 节明确点名的问题已合并到本报告 P1/P2，含：
- audit-06 §5 CC8（appointment 状态映射）→ 本报告 P1-CC8-06（部分修复，仍缺 Tab → P2-CC8-11）
- audit-07 §5 CC8（commissionRate vs allocationRatio UI 字段错位）→ 见 audit-CC4-auth + audit-25 同主题，CC8 仅借引用
- audit-16 §5 CC8（client `{{item.body}}` auto-escape OK）→ 通过
- audit-18 §5 CC8（staff-performance Tab 文案 OK）→ 通过
- audit-19 §5 CC8（admin share-gift 单页 OK）→ 通过（admin 不在 CC8 范围）
- audit-24 §5 CC8（`<van-tag color="{{x}}">` 无 HEX 校验）→ 已在域报告内，本报告 P2-CC8-20 仅交叉引用
- audit-25 §5 CC8（store-detail wxml 标准；语义错位 P0-25-02 已记 audit-25）→ 通过

---

## 附：Vant 组件用法 Top 10（频次量化）

| 组件 | client 用例数 | staff 用例数 | 备注 |
|------|---------------|--------------|------|
| `<van-cell>` | 66 | 87 | 双端最常用 |
| `<van-icon>` | 61 | 78 | — |
| `<van-button>` | 30 | 56 | — |
| `<van-empty>` | 28 | 29 | client 6 处用 `image="error"`，staff **0 处（非 mgmt 域）** ⚠ |
| `<van-skeleton>` | 27 | 3 | client 偏好 skeleton，staff 偏好 `<van-loading>` |
| `<van-loading>` | 12 | 41 | 风格分裂 |
| `<van-cell-group>` | 23 | 17 | — |
| `<van-tab>` | 11 | 31 | — |
| `<van-tag>` | 20 | 11 | — |
| `<van-popup>` | 7 | 11 | — |

观察：client 用 skeleton 模拟内容形状，staff 用 spinner 文案；两者哲学不同但单端内一致。

---

## 报告统计（v1+v2 合并最终版）

- **P0**：0
- **P1**：5（P1-CC8-06 ~ P1-CC8-10）
  - P1-CC8-06：`部分支付` 双端 STATUS_CLASS 缺失（v2 新增）
  - P1-CC8-07：Staff `待审批` 两处 STATUS_CLASS 不同步（v2 新增）
  - P1-CC8-08：Client `待审批` 状态无渲染逻辑（v2 新增）
  - P1-CC8-09：Staff service.wxml 缺 `已取消` 服务单入口（v2 新增）
  - P1-CC8-10：双端 `bind:click`/`bindtap` 混用（v1 P1-CC8-03 降级后保留）
- **P2**：11（P2-CC8-11 ~ P2-CC8-21）
  - P2-CC8-11：Client appointment.wxml 缺 `已关闭` 独立 Tab（v1 P1-CC8-01 部分修复后降级）
  - P2-CC8-12：双端 van 事件绑定风格分裂（v1 P1-CC8-03 降级）
  - P2-CC8-13：Staff 非 mgmt 域列表缺 error 态区分（v1 P1-CC8-04 降级）
  - P2-CC8-14：mgmt-data-state 未推广（v1 P2-CC8-08）
  - P2-CC8-15：Vant 副本目录爆炸（v1 P2-CC8-06）
  - P2-CC8-16：暂无文案散落（v1 P2-CC8-07）
  - P2-CC8-17：service-list.wxml 空壳（v2 新增）
  - P2-CC8-18：profile 订单快捷入口状态覆盖不完整（v2 新增）
  - P2-CC8-19：list footer 文案分裂（v1 P2-CC8-09）
  - P2-CC8-20：van-tag color 无 HEX 校验（v1 P2-CC8-10）
  - P2-CC8-21：退款/解绑审批 UI 文案分裂（v1 P1-CC8-05 降级）
- **总计**：16 条（5 P1 + 11 P2）