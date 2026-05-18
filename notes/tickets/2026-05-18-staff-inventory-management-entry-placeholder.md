# Ticket: staff 端"库存管理"占位入口（仅菜单埋点，不含 WorkFine 写入）

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待实施 |
| 优先级 | **P3**（占位性质，不阻塞任何关键流程） |
| 端 | fengyu-staff（仅小程序前端，无云函数改动） |
| 修复成本 | **S**（半天 — 新增 1 页 + 1 个菜单项） |
| 来源 | meeting-20260507 §四（库存管理讨论） |
| 关联 schema | 无（本期不动 DB） |
| 关联反馈 | `feedback_mssql_readonly.md`（WorkFine 严格只读 — 本 ticket 不写入，不冲突；后续完整开发需重新评估） |

---

## 0 一句话背景

会议讨论了把库存录入复制到小程序员工端（门店级），数据回写 WorkFine 现有 8 张库存表（出货 / 入库 / 调拨申请 / 调拨执行 / 盘点 / 报损 / 报溢 / 期初余额）。完整实现涉及 8 表录入界面 + 解除 MSSQL 只读约束，工作量大且需进一步设计。**本 ticket 范围严格限定为"在 staff 我的页埋一个占位入口 + 一张静态骨架页"**，让员工知道功能即将到来，完整功能拆 follow-up ticket 后续开发。

---

## 1 现状（grep 实证）

### 1.1 staff 我的页结构

`fengyu-staff/miniprogram/pages/my/my.ts` + `.wxml`：
- 当前展示员工信息卡 + 快捷导航网格
- 现有快捷导航项：订单 / 服务单 / 预约 / 顾客 / 分配列表 / 数据看板 / 员工绩效
- 部分项已有角色判定（如分配列表仅 manager 可见）

### 1.2 角色判定

```ts
// fengyu-staff/miniprogram/utils/role.ts
export function isManager(): boolean {
  return getApp<IAppOption>().globalData.roles?.includes('manager') ?? false;
}
```

当前 `permission_roles` 表角色枚举：`admin / manager / finance / hr / product / customer_mgr`。

库存管理本质上是"门店级管理"，建议入口对 `manager` / `admin` / `finance` 三角色可见（财务也需要看库存数据）。普通美容师不应看到。

### 1.3 WorkFine 写入约束（重要）

`notes/memory/feedback_mssql_readonly.md` 原文：
> **WorkFine MSSQL 严格只读**，禁止 INSERT/UPDATE/DELETE/DDL，任何写入需求必须先停下来问用户

→ 本 ticket 仅做静态占位页，**不触发任何写入路径，不冲突**。
→ 后续完整开发时（follow-up），需先停下来与用户确认是否解除/收窄此约束（仅限库存场景）。

### 1.4 WorkFine 8 张库存表（会议口头列出，未文档化）

会议中提到的表（具体表名待 follow-up ticket SELECT 摸清）：
1. 出货
2. 入库
3. 调拨申请
4. 调拨执行
5. 盘点
6. 报损
7. 报溢
8. 期初余额

骨架页仅静态展示这 8 个名称作为"功能预览"，不涉及表结构。

---

## 2 修复方案（单 PR）

### PR-1：staff 我的页加占位入口 + 新增骨架页

#### 文件改动清单

1. **`fengyu-staff/miniprogram/pages/my/my.wxml`** — 在快捷导航网格中追加 "库存管理" 项，外层用 `wx:if` 包条件
2. **`fengyu-staff/miniprogram/pages/my/my.ts`** — `onShow` 中根据 `globalData.roles` 计算 `canSeeInventory: boolean` 写入 data
3. **新增页面**：`fengyu-staff/miniprogram/packageMy/inventory/inventory.{ts,wxml,wxss,json}`
4. **`fengyu-staff/miniprogram/app.json`** — 在 `subPackages.packageMy.pages` 注册 `inventory/inventory`（如 packageMy 已存在；若不存在则建分包）

#### my.ts 关键改动

```ts
// onShow 中
const roles = getApp<IAppOption>().globalData.roles ?? [];
const canSeeInventory = ['manager', 'admin', 'finance'].some(r => roles.includes(r));
this.setData({ canSeeInventory });
```

#### my.wxml 关键改动

```xml
<view
  wx:if="{{canSeeInventory}}"
  class="nav-item"
  bindtap="goInventory"
>
  <image src="/assets/icon-inventory.png" />
  <text>库存管理</text>
</view>
```

```ts
goInventory() {
  wx.navigateTo({ url: '/packageMy/inventory/inventory' });
}
```

#### 骨架页 inventory.wxml 结构

```xml
<view class="container">
  <view class="header">
    <text class="title">库存管理</text>
  </view>

  <view class="notice">
    <text>功能开发中，敬请期待。</text>
    <text>库存操作目前仍在 WorkFine 桌面端进行。</text>
  </view>

  <view class="preview-section">
    <text class="section-title">即将开放的功能</text>
    <view class="preview-list">
      <view class="preview-item disabled">出货</view>
      <view class="preview-item disabled">入库</view>
      <view class="preview-item disabled">调拨申请</view>
      <view class="preview-item disabled">调拨执行</view>
      <view class="preview-item disabled">盘点</view>
      <view class="preview-item disabled">报损</view>
      <view class="preview-item disabled">报溢</view>
      <view class="preview-item disabled">期初余额</view>
    </view>
  </view>

  <view class="footer">
    <text>详细需求请联系管理员</text>
  </view>
</view>
```

#### 骨架页 inventory.wxss 要点

- 8 项 grid 布局，灰色（`color: #999`），不可点击（无 bindtap）
- 顶部 notice 使用品牌色 `#C0322A` 边框强调"开发中"
- 整体风格沿用 staff 现有 my 页 / 快捷导航的 design token

#### 不做的事（明确边界）

- **不**在 staffApi 添加任何库存相关 action
- **不**触发 cloudbase 部署（前端纯静态）
- **不**引入 mssql / 库存相关 npm 包
- **不**动 admin 任何代码
- **不**改 permission_roles 表 / 权限矩阵
- **不**在 8 项预览上挂任何 bindtap

---

## 3 验收标准（DoD）

### 角色可见性
- [ ] 以 `manager` 角色登录 → my 页可见 "库存管理" 入口
- [ ] 以 `admin` 角色登录 → my 页可见 "库存管理" 入口
- [ ] 以 `finance` 角色登录 → my 页可见 "库存管理" 入口
- [ ] 以普通美容师（无上述三角色）登录 → my 页**不可见**该入口
- [ ] 角色组合（如 manager+finance）只显示一次入口（已是同一菜单项）

### 骨架页
- [ ] 点击入口能正常跳转至 `/packageMy/inventory/inventory`，无报错
- [ ] 页面顶部展示 "库存管理" 标题
- [ ] 主体展示"功能开发中，敬请期待。库存操作目前仍在 WorkFine 桌面端进行。"占位文案
- [ ] 8 张表名称（出货 / 入库 / 调拨申请 / 调拨执行 / 盘点 / 报损 / 报溢 / 期初余额）以灰色不可点击形式展示
- [ ] 底部展示 "详细需求请联系管理员"
- [ ] 页面在 iPhone / Android 中端机型上无错位

### 工程质量
- [ ] `cd fengyu-staff/miniprogram && tsc --noEmit` 0 错（如已配 ts 检查）
- [ ] 微信开发者工具预览无 console 报错
- [ ] app.json 子包注册正确，构建不报 "page not registered"

### 文档
- [ ] 本 ticket §5 列出的 5 个 follow-up ticket 标题**不在本 PR 内创建文件**，由开发者按业务优先级后续按需创建

---

## 4 风险与回滚

| 风险 | 缓解 |
|------|------|
| 占位入口让员工误以为"马上能用" | 文案明确写"功能开发中，敬请期待"+"库存操作目前仍在 WorkFine 桌面端进行"，且 8 项灰色禁用，视觉上明确表达"未上线"|
| 后续完整开发时若需写入 WorkFine，违反 `feedback_mssql_readonly.md` | follow-up ticket FU-3 单独评估解除/收窄只读约束，**必须先与用户确认**（feedback 原文："任何写入需求必须先停下来问用户"）|
| 角色判定依赖前端 `globalData.roles`，理论上可被绕过 | 占位页不调用任何后端接口，无数据泄露风险；完整开发时所有库存 action 必须在 staffApi 中间件做服务端鉴权 |
| 入口图标资源缺失 | 临时复用现有快捷导航的通用图标，或用 emoji-free 的纯文字 + 边框样式 |

**回滚**：commit revert 即可，无 DB / 云函数 / 部署副作用。

---

## 5 关联 + follow-up ticket 设计草稿

### 关联

| 项 | 说明 |
|----|------|
| 来源 | `notes/meetings/meeting-20260507/article.md` §四（库存管理）|
| 关联 feedback | `notes/memory/feedback_mssql_readonly.md`（本 ticket 不冲突；FU-3 需重新评估）|
| 关联代码 | `fengyu-staff/miniprogram/pages/my/my.{ts,wxml}` / `fengyu-staff/miniprogram/utils/role.ts` |
| 关联角色枚举 | `db/schema/permission.ts` permission_roles 表 |

### follow-up ticket 设计草稿（本 ticket merge 后按需创建）

| 编号 | 标题 | 一句话目标 | 预估成本 |
|------|------|-----------|---------|
| FU-1 | `staff-inventory-workfine-tables-schema-doc` | 通过 SELECT 把 WorkFine 8 张库存表的字段 / 类型 / 业务语义 / 关联关系全部摸清，输出文档至 `notes/memory/reference_workfine_inventory_tables.md` | M |
| FU-2 | `staff-inventory-mssql-write-path-evaluation` | 评估 MSSQL 写入路径选型：云函数直连 `mssql` 库 vs 经 admin 中间层转发 vs 反向同步脚本，输出技术方案对比 | M |
| FU-3 | `staff-inventory-mssql-readonly-scope-narrow` | 在 `feedback_mssql_readonly.md` 中收窄只读约束，明确"仅库存场景的 8 张表允许 INSERT/UPDATE，其余继续严格只读"；**实施前必须先与用户确认** | S |
| FU-4 | `staff-inventory-outbound-inbound-entry` | 按业务优先级先落地"出货 + 入库"两张表的录入界面 + WorkFine 写入逻辑（依赖 FU-1/2/3 完成）| L |
| FU-5 | `staff-inventory-remaining-six-tables-entry` | 其余 6 张表（调拨申请 / 调拨执行 / 盘点 / 报损 / 报溢 / 期初余额）的录入界面，按使用频率分批落地 | L |

**依赖关系**：FU-1 → FU-2 → FU-3 → FU-4 → FU-5（串行；FU-3 是 FU-4/5 的硬阻塞，未与用户确认前不得动写入路径）。

---

## 实施路径修正（2026-05-18）

**ticket 原始路径有误**：本 ticket 写的是 `fengyu-staff/miniprogram/pages/my/my.{ts,wxml}`，但实际 staff 我的页是 **`fengyu-staff/miniprogram/pages/profile/profile.{ts,wxml,wxss,json}`**（grep 确认）。

实施时所有 `pages/my/my.*` 路径替换为 `pages/profile/profile.*`。占位页路径保持 `packageMy/inventory/inventory.*`（业务包名不变），或改为 `packageMy/profile-inventory/` 视分包配置而定。

**决策应用**：D12=A（manager / admin / finance 三角色可见）

### 后续 spec 更新

完整功能开发时（FU-4/5 阶段）需要：
- 更新 `.42cog/pm/staff.pr.spec.md` 新增 §inventory_management 章节
- 更新 `.42cog/dev/sys.spec.md`（staff 端）说明 MSSQL 写入通道
- memory 新增 `project_staff_inventory_workflow.md` 记录"为什么复制门店级录入而非重构 WorkFine"决策
