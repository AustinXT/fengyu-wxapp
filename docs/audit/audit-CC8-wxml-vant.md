# 审计报告：CC8 WXML / Vant 一致性 (CC8)

**审计时间**：2026-04-25
**域 ID**：CC8（横切收官）
**审计员**：claude-opus-4-7
**审计时长**：~15 分钟
**关联 PR/Ticket**：—
**前置参考**：audit_plan.md §3 CC8 / §1 评级 / §4 报告模板

---

## 1. 三端入口对照（CC8 范围）

CC8 仅覆盖**双小程序端**（admin 是 Next.js Web，不在范围）。

| 层 | client (`fengyu-client/miniprogram/`) | staff (`fengyu-staff/miniprogram/`) |
|----|---------------------------------------|-------------------------------------|
| Tab 主页 (.wxml) | `pages/{home,profile,cart,appointment}/` 4 个 | `pages/{workbench,service,order-create,profile,customer-list,sales-data,mgmt-dashboard,login}/` 8 个 |
| 子包 (.wxml) | `pagesShop/ pagesOrder/ pagesProfile/ pagesAppointment/ pagesStore/ pagesCoupon/` 17 个页面 | `packageService/ packageOrder/ packageMgmt/ packageCustomer/` 19 个页面 |
| 自定义组件 | `components/staff-popup/`, `components/nav-bar/` 2 个 | `components/{mgmt-data-state, mgmt-stat-card, mgmt-period-picker, mgmt-scope-picker, mgmt-navbar, mgmt-metric-tabs, conversion-panel, bundle-picker, placeholder-page}/` 9 个 |
| Vant 组件 | Vant Weapp 1.x（双层 `miniprogram_npm/@vant/weapp/`，含一份顶层 + 嵌套 `miniprogram_npm/miniprogram_npm/` 副本，疑似构建残留） | Vant Weapp 1.x（`miniprogram_npm/@vant/weapp/` + `node_modules/@vant/weapp/{lib,dist}/` 共 3 份；典型未净 build artefact）|
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

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

无（CC8 的 UI 一致性问题主要影响 UX 与维护性，未观察到直接资损或越权通道）。

### 3.2 P1（数据一致 / 状态错乱）

#### **[P1-CC8-01]** 客户端 appointment 页缺 `已关闭` Tab 与状态色映射 → 用户看不到自动关闭的过期预约

- **文件**：`fengyu-client/miniprogram/pages/appointment/appointment.ts:9-14` + `appointment.wxml:14-17`
- **现象**：
  - 后端枚举 5 值：`['待确认', '已确认', '已完成', '已取消', '已关闭']`（`db/schema/enums.ts:70`）
  - 客户端 Tab 仅 4 个：`('全部', '待确认', '已确认', '已完成', '已取消')`，缺 `已关闭`（appointment.wxml:14-17 实际只有 confirmed / cancelled 两个 status Tab + 全部）
  - `appointment.ts:9-14` `STATUS_META` 仅 4 个 key（`待确认/已确认/已完成/已取消`），无 `已关闭` 的 label/color，落到此状态时 wxml 渲染空白 tag
- **风险**：
  - 与 audit-06 P0-06-04 同源——"过期关闭机制"虽然代码层未实现，但一旦运营手动 / cron 把 `appointment.status` 写成 `已关闭`，客户端会丢失这条预约（按 status 筛选时不会显示在任何 Tab 内）
  - 用户体验断裂："我的预约去哪了？"
- **修复**：(L9 前端) 补 Tab + STATUS_META key

#### **[P1-CC8-02]** 双端服务单状态机文案对齐 OK，但 client 缺 `服务中` 中间态独立色

- **文件**：`fengyu-client/miniprogram/pagesOrder/service-records/service-records.ts:115-118`
- **现象**：client 把 `'服务中'` 染色 `#096DD9`、staff 把它染色 `progress` (status-tag--progress 样式名)；颜色虽不同但语义对齐 OK；**但**，client `service-records.ts` 的 switch 漏掉了 `已关闭`（spec 上 service_orders 状态机只有 4 个，service_orders 没有"已关闭"，OK 实际无影响），可暂忽略。后续若 spec 引入 `已关闭` 必须双端同步加。
- **风险**：低；记录为 watch-only。
- **修复**：—

#### **[P1-CC8-03]** 双端 van 事件绑定风格分裂：client 偏 `bindtap`，staff 偏 `bind:click`

- **文件**：
  - client：`bindtap=93` 处 / `bind:click=6` 处（占比 93.9% / 6.1%）
  - staff：`bindtap=117` 处 / `bind:click=50` 处（占比 70.0% / 30.0%）
- **现象**：
  - 双端均存在两种风格混用：`<van-cell bindtap="...">` vs `<van-cell bind:click="...">`
  - Vant Weapp 1.x 文档对 `van-cell` 推荐 `bind:click`（自定义 emit 事件），`bindtap` 走原生 dom 事件——两者表现一致但语义不同：`bind:click` 经过 Vant 内部 `clickable` 状态门控（disabled/loading 等），`bindtap` 不经过
  - staff 在 `mgmt-data-state.wxml:10` 的 `<van-button bind:click="onRetry">` 与 client 在 `pagesOrder/scan-pay.wxml:22` 的 `<van-button bindtap="onBackHome">` 同语义不同写法
- **风险**：
  - `<van-cell clickable disabled bindtap=...>` 场景下，disabled 状态下 `bindtap` 仍会触发 → 可绕过 disabled 守卫（弱风险，未发现实际利用）
  - 维护性：双端公共组件（如 `staff-popup` / `nav-bar` 未来共享）会出现风格冲突
- **修复**：(L9) 统一为 `bind:{eventName}` 冒号风格；可加 lint rule 拒绝 van 组件上的 `bindtap`

#### **[P1-CC8-04]** 双端 list 三态（loading / empty / error）组件实现完全分裂

- **文件**：
  - **client**：直接组合 `<van-skeleton>` (loading) + `<van-empty image="error" description="加载失败，下拉刷新重试">` (error) + `<van-empty description="暂无...">` (empty) **27 处一致模式**（pagesOrder/orders, pagesAppointment, pagesShop, pages/appointment 等）
  - **staff**：分为两派：
    - **mgmt 域**：用自研组件 `<mgmt-data-state state="..." bind:retry="onRetry" empty-text="...">`（`packageMgmt/*` 7 处 + `pages/{sales-data,mgmt-dashboard}` 3 处）
    - **其他域**：直接 `<van-loading type="spinner" color="#C0322A">` + `<van-empty description="暂无...">`，**不区分** loading 失败的 error 态（`packageOrder/*` 7 处 / `packageService/*` / `packageCustomer/*`）
- **现象**：
  - client 27 处 / 0 处 `image="error"` 区分错误态 ✓
  - staff 27 处 / **0 处 `image="error"`**，loading 失败一律退化为 "暂无..."  → 用户无法区分"无数据"和"加载失败"
  - 双端**没有**共享的 list-state 组件；staff 内部 mgmt-data-state（位于 `components/mgmt-data-state/`）只在 mgmt 域使用，未推广到 packageOrder / packageService
- **风险**：
  - UX 不一致：staff 端"已审批退款"列表加载失败，用户以为是真无数据，不会下拉刷新
  - 维护成本：同一态有 2 套写法（mgmt vs 其他），新人易写第三套
- **修复**：(L9) 推广 `mgmt-data-state` 到全 staff；client 引入对应组件统一三态

#### **[P1-CC8-05]** staff `refund-list` Tab 用"待审批/已支付/已关闭"三值与 sale_orders.status 对齐 OK，但与 storeUnbindRequestStatus 的"待处理/已通过/已拒绝/已取消"两套语义同时存在 → 后续若有员工改名易混淆

- **文件**：
  - `fengyu-staff/miniprogram/packageOrder/refund-list/refund-list.ts:4` `type TabStatus = '待审批' | '已支付' | '已关闭'`（基于 sale_orders.status）
  - `fengyu-staff/miniprogram/packageService/unbind-requests/unbind-requests.wxml:12` 暂未在前端 Tab 显示 storeUnbindRequestStatus 的全 4 值
- **现象**：审批类 UI 文案在两个域用了两套 enum：退款单走 `orderStatusEnum` 的 `待审批`，门店解绑走 `storeUnbindRequestStatusEnum` 的 `待处理`。审批人在不同页面看见不同字。
- **风险**：员工心智模型不统一（与 audit-11 / audit-12 已发现的状态机分裂同源）
- **修复**：(L9) UI 文案统一用业务通用语 "待审批/已通过/已驳回"，前端做 enum→label 映射层

### 3.3 P2（代码质量 / 可维护）

#### **[P2-CC8-06]** 双端 Vant 副本目录爆炸（client 2 份 / staff 3 份）

- **文件**：
  - client：`miniprogram_npm/@vant/weapp/` + `miniprogram_npm/miniprogram_npm/@vant/weapp/`（嵌套 npm dist）
  - staff：`miniprogram_npm/@vant/weapp/` + `node_modules/@vant/weapp/lib/` + `node_modules/@vant/weapp/dist/`
- **现象**：构建产物未净，体积冗余、IDE 跳转易跳到错的副本
- **风险**：仅维护性
- **修复**：(L9) `.gitignore` 只保留 `miniprogram_npm/@vant/weapp/`，删冗余副本

#### **[P2-CC8-07]** 双端"暂无…"文案完全分散，无中心化字典

- **现象**：grep 到至少 20+ 处不同的 `<van-empty description="暂无XXX" />`（暂无购买记录 / 暂无订单 / 暂无可用疗程卡 / 暂无积分记录 / 暂无消息 / 暂无可核销疗程 / 暂无赠送记录 / 暂无退换记录 / 暂无提成记录 / 暂无待分配订单 / 暂无可用优惠券 / 暂无…），文案散落在各 wxml 字面量
- **风险**：i18n / 文案统一调整时需逐个改
- **修复**：(L9) 抽 `utils/empty-text.ts` 字典常量

#### **[P2-CC8-08]** staff `mgmt-data-state` 设计良好但仅 1/3 范围使用

- **文件**：`fengyu-staff/miniprogram/components/mgmt-data-state/mgmt-data-state.wxml`
- **现象**：组件已封装 loading/empty/error/retry 四态，contract 清晰 (`state` / `empty-text` / `bind:retry`)，但 `packageOrder/*`、`packageService/*`、`packageCustomer/*` 全部未引用，仅 mgmt 子域使用
- **风险**：好抽象未被复用 = 隐性技术债
- **修复**：(L9) 推广该组件到全 staff，再考虑 client 同步引入

#### **[P2-CC8-09]** client `pagesProfile/messages` 与 client `pages/appointment` 的 list footer 文案分裂

- **现象**：均是分页底部，文案一处用 `没有更多消息了`，一处用 `没有更多预约了`，再一处仅 `没有更多了`（points / orders）
- **风险**：体验细节不一致
- **修复**：(L9) 统一 `加载完毕` 或抽组件

#### **[P2-CC8-10]** Vant `<van-tag color="{{kindDisplayColor}}">` 无 HEX 校验兜底（已记录于 audit-24 P2-24-?）

- **文件**：`fengyu-staff/miniprogram/packageService/product-detail/product-detail.wxml:23`、client 同源
- **现象**：admin 写入的 `display_color` 若非合法 HEX，Vant 渲染未定义
- **修复**：(L7 admin schema 校验) 已在 audit-24 提，不重复评级

---

## 4. 跨端不一致（双小程序）

| 维度 | client | staff | 风险 | 优先级 |
|------|--------|--------|------|--------|
| 事件绑定风格 | `bindtap` 93/99 (94%) | `bindtap` 117/167 (70%) + `bind:click` 50/167 (30%) | 维护性 + disabled 绕过弱风险 | P1-CC8-03 |
| 列表 error 态 | `<van-empty image="error">` 6 处一致 | 0 处区分（loading 失败 = empty） | UX 误导 | P1-CC8-04 |
| 列表三态组件 | 全手写 wx:if 组合 | 一半用 `mgmt-data-state` 组件 / 一半手写 | 维护成本翻倍 | P2-CC8-08 |
| appointment status 渲染 | 仅 4 值（缺 `已关闭`） | appointment.wxml:5 仅 confirmed Tab；STATUS_META 5 值齐 | client 漏 status | P1-CC8-01 |
| Vant 副本数 | 2 份 | 3 份 | 体积 + IDE | P2-CC8-06 |
| 自定义组件数 | 2 个（staff-popup, nav-bar） | 9 个（mgmt-* 7 + bundle-picker + placeholder-page） | staff 抽象成熟度更高 | — |
| 退款审批 UI 文案 | — | `待审批` (orderStatus) vs `待处理` (storeUnbindRequestStatus) | 心智不统一 | P1-CC8-05 |

---

## 5. 横切检查（套用 §3 模板）

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

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema/enums | — | — | — |
| L9 前端 client | `pages/appointment/appointment.{ts,wxml}` | 补 `已关闭` Tab + STATUS_META | P1-CC8-01 |
| L9 前端 staff | `packageOrder/refund-list`, `packageService/*`, `packageCustomer/*` | 改用 `<mgmt-data-state>` 组件 | P1-CC8-04 / P2-CC8-08 |
| L9 前端 双端 | grep `<van-[^>]+bindtap` 全替换为 `bind:click`/`bind:tap` | 风格统一 | P1-CC8-03 |
| L9 前端 双端 | 抽 `utils/empty-text.ts` 字典 | 暂无文案集中 | P2-CC8-07 |
| L9 前端 双端 | 抽 `utils/status-label.ts` 字典 | 状态 label 字面量集中 | P1-CC8-05 |
| L10 构建 | `.gitignore` 加 `miniprogram_npm/miniprogram_npm/` + `node_modules/@vant/`；CI 脚本删冗余副本 | 副本爆炸 | P2-CC8-06 |
| L10 lint | 引入 wxml-lint 规则：`van-*` 元素禁用 `bindtap` | 自动门禁 | P1-CC8-03 |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

CC8 是纯前端域，无对应 SQL 验证。仅可验证后端枚举 baseline 是否被 UI 全部覆盖：

```sql
-- 验证后端 appointment_status 枚举与 client UI Tab 数差异（人工对照）
SELECT unnest(enum_range(NULL::appointment_status)) AS status_val
ORDER BY 1;
-- 预期 5 行：待确认 / 已确认 / 已完成 / 已取消 / 已关闭
-- 而 client appointment.wxml 仅 4 个 Tab；缺 已关闭 → P1-CC8-01

-- 验证 service_order_status 枚举（供回归）
SELECT unnest(enum_range(NULL::service_order_status));
-- 预期：待服务 / 服务中 / 已完成 / 已取消（双端 wxml 已对齐 ✓）

-- 是否真有数据落入 appointment.status='已关闭'（佐证 P1 严重程度）
SELECT count(*) FROM appointments WHERE status = '已关闭';
```

---

## 8. 回归测试用例（建议）

1. **client appointment 已关闭 Tab 渲染**：构造 1 条 `status='已关闭'` 的 appointment，client 列表"全部" Tab 应可见、状态 tag 不空白
2. **staff list 失败态区分**：mock 退款列表 API 返回 5xx，wxml 应渲染"加载失败"而非"暂无退款单"
3. **disabled van-cell 不响应 tap**：`<van-cell clickable="false" bindtap=...>` 与 `<van-cell clickable="false" bind:click=...>` 行为差异回归（前者会触发，后者不会）
4. **wxml-lint**：CI 加 grep `<van-[a-z-]+[^>]*bindtap` 计数门禁（首次设阈值，禁止增量）
5. **暂无文案字典覆盖**：snapshot 测试所有 `<van-empty description=` 是否取自 `utils/empty-text.ts` 常量

---

## 9. 影响半径

- 单端：☐
- 跨端（双小程序）：☑
- 全栈（3 端 + DB）：☐（CC8 不涉 admin web 与 DB）
- 涉及历史数据：☐
- 修复成本：**S**（多为字面量统一 + 组件复用，无 schema 变更）

---

## 10. 后续待办

- [ ] 与产品 / 设计对齐：`待审批` vs `待处理` UI 统一文案
- [ ] 引入 wxml-lint（如 `wxml-linter` + 自定义规则禁 `<van-* bindtap>`）
- [ ] staff 推广 `mgmt-data-state` → 全包；client 同步引入（与 staff 共同 contract）
- [ ] 写一条 `notes/tickets/2026-04-25-cc8-wxml-vant-cleanup.md` 把 P1-CC8-01..05 拉成清单
- [ ] 与 audit-24 P0-24-02 / CROSS-CUTTING.md "前端 UI 文本字符串错传后端 ID 字段" 主线合流，统一为 "UI ↔ DB enum 同步"治理项

---

## 附：横切归集回写（CROSS-CUTTING.md 视角）

**本身就是 CC8 收官**，无新条目向 `CROSS-CUTTING.md` 追加。

历史上各业务域 §5 CC8 节明确点名的问题已合并到本报告 P1/P2，含：
- audit-06 §5 CC8（appointment 状态映射）→ 本报告 P1-CC8-01
- audit-07 §5 CC8（commissionRate vs allocationRatio UI 字段错位）→ 见 audit-CC4-auth + audit-25 同主题，CC8 仅借引用
- audit-16 §5 CC8（client `{{item.body}}` auto-escape OK）→ 通过
- audit-18 §5 CC8（staff-performance Tab 文案 OK）→ 通过
- audit-19 §5 CC8（admin share-gift 单页 OK）→ 通过（admin 不在 CC8 范围）
- audit-24 §5 CC8（`<van-tag color="{{x}}">` 无 HEX 校验）→ 已在域报告内，本报告 P2-CC8-10 仅交叉引用
- audit-25 §5 CC8（store-detail wxml 标准；语义错位 P0-25-02 已记 audit-25）→ 通过

---

## 附：Vant 组件用法 Top 10（频次量化）

| 组件 | client 用例数 | staff 用例数 | 备注 |
|------|---------------|--------------|------|
| `<van-cell>` | 66 | 87 | 双端最常用 |
| `<van-icon>` | 61 | 78 | — |
| `<van-button>` | 30 | 56 | — |
| `<van-empty>` | 28 | 29 | client 6 处用 `image="error"`，staff **0 处** ⚠ |
| `<van-skeleton>` | 27 | 3 | client 偏好 skeleton，staff 偏好 `<van-loading>` |
| `<van-loading>` | 12 | 41 | 风格分裂 |
| `<van-cell-group>` | 23 | 17 | — |
| `<van-tab>` | 11 | 31 | — |
| `<van-tag>` | 20 | 11 | — |
| `<van-popup>` | 7 | 11 | — |

观察：client 用 skeleton 模拟内容形状，staff 用 spinner 文案；两者哲学不同但单端内一致。

---

## 报告统计（用于 PLAN 进度表）

- **P0**：0
- **P1**：5（CC8-01..05）
- **P2**：5（CC8-06..10）
- **总计**：10 条
