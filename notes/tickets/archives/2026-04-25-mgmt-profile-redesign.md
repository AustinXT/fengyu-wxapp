# Ticket: 管理层视图「我的」tab 重设计（mgmt-dashboard profile tab）

> 生成日期：2026-04-25
> **实施状态：✅ 已落地**（commit 1ae71a3 scopeName 贯通 + commit af63ad6 mgmt-dashboard 重构"我的"区块）
> 端：fengyu-staff（小程序前端 + staffApi 云函数）
> 实施位置：
>   - 前端：`fengyu-staff/miniprogram/pages/mgmt-dashboard/mgmt-dashboard.{ts,wxml,wxss}` 已重构（buildProfileData / roleBindingRows / storeScope 三卡）
>   - 类型：`fengyu-staff/miniprogram/typings/index.d.ts` `RoleBinding.scopeName` 已增
>   - 云函数：`fengyu-staff/cloudfunctions/staffApi/routes/auth.js` `queryRoleBindings` 已 SELECT `o.name AS scope_name`
>   - 单元测试：`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/auth.test.js` 已补 scopeName case
>   - 旧字段已清理：`onSwitchToStore` / `canSwitchStore` / "返回门店视图" 按钮 / `mgmt-profile-action--outline` / `mgmt-profile-tip` 全部移除
> 关联：
>   - [`mgmt-product-cycle-page`](./2026-04-25-mgmt-product-cycle-page.md) — 同期管理层 hub 子页（已落地）
>   - [`mgmt-customer-archive-page`](./2026-04-25-mgmt-customer-archive-page.md) — 同期 hub 子页（待开发）
>   - 门店视图「我的」：`pages/profile/profile.{ts,wxml}` — 仅作业务对照，**不复用代码**
>
> **一句话目标**：将 mgmt-dashboard 的 profile tab 从"占位页"改造为"账号资料页"，
> 展示当前管理层用户的 **基本信息 / 组织归属 / 管辖范围**，移除「返回门店视图」按钮，仅保留「退出登录」。

---

## 0 背景

入口位置：管理层视图底部 tab（`mgmt-navbar`）的第 3 项「我的」，对应
`pages/mgmt-dashboard/mgmt-dashboard.wxml:259-277` 的 `activeTab === 'profile'` 分支。

现状（截至 2026-04-25）：
- header 红色渐变：姓名 + 层级徽章（总部/市场） + 职位 + 手机号
- 大图标 + 文字：`gem-o` + "管理层菜单建设中，敬请期待"
- 两个按钮：
  - 「返回门店视图」（仅当 `availableLoginLevels` 同时含 `store` 时显示）→ `onSwitchToStore` → `app.setLoginLevel('store')` + reLaunch 至 workbench
  - 「退出登录」→ 模态确认 → `app.resetStaffInfo()` + reLaunch 至登录页

业务诉求（本 ticket）：
1. **删除「返回门店视图」按钮** —— 双角色用户切换登录层级，必须经"退出 → 重新登录选层级" 完整流程
2. **新增组织归属展示** —— 让管理层用户清晰看到自己的「层级 / 角色 / 作用域 / 管辖门店」
3. **保留「退出登录」按钮**

设计哲学：管理层用户看自己的"管辖范围与权限"是高频需求；切换层级是低频且容易误触发的操作（一旦切走门店视图，又要 reLaunch 回来），按钮应从该页移除。

---

## 1 视图设计

### 1.1 整体结构

```
┌──────────────────────────────────────────────┐
│ ███████████ Header（红色渐变，保留）████████ │
│  张三                                        │
│  [总部] · 总经理 · 13800138000                │
└──────────────────────────────────────────────┘

─── 基本信息 ───
┌──────────────────────────────────────────────┐
│ 姓名         张三                             │
│ 工号         FY-WX-26042500001                │
│ 手机号       138 0013 8000                    │
│ 职位         总经理                           │
│ 层级         总部                             │
└──────────────────────────────────────────────┘

─── 组织归属 ───
┌──────────────────────────────────────────────┐
│ 角色         作用域                           │
│ admin        总部 · 凤御总部                  │
│ manager      门店 · 龙岗店                    │  ← 多绑定时全部展示
└──────────────────────────────────────────────┘

─── 管辖范围 ───
┌──────────────────────────────────────────────┐
│ 总部 / 全部门店（共 23 家）                    │  ← 总部
│  - 龙岗店                                     │
│  - 福田店                                     │
│  - 南山店                                     │  ← 折叠：默认只展示前 5 家
│  ... [展开/收起]                              │
└──────────────────────────────────────────────┘

         ┌────────────────────────┐
         │      退出登录          │
         └────────────────────────┘
```

### 1.2 三个信息卡片

| 卡片 | 字段 | 数据源 |
|------|------|--------|
| 基本信息 | 姓名 / 工号 / 手机号 / 职位 / 层级 | `globalData.staffName` / `staffWfId` / `phone` / `position` / `staffLevel` |
| 组织归属 | role + scopeType + scopeName 列表 | `globalData.roleBindings`（**需后端补 scopeName**） |
| 管辖范围 | scopedStores 列表 + 摘要 | `globalData.scopedStores` |

### 1.3 字段渲染细则

**基本信息**
- 工号：直接展示 `staffWfId`，无格式化（员工端登记号 `FY-WX-{YYMMDD}{3 位序号}`）
- 手机号：每 4 位空格分隔（`138 0013 8000`），失败时原样展示
- 层级：`headquarters → 总部` / `market → 市场`；其他值（理论上不会到这页）显示 `--`

**组织归属**
- 表格两列：角色（role）/ 作用域（scopeType + " · " + scopeName）
- 角色列原样展示英文 key（`admin` / `manager` / `viewer` …）；如后续要中文化再开 ticket
- 多绑定按 scopeType 排序（`总部 → 市场 → 门店 → 部门`）后展示
- 空数组时显示 `暂无角色绑定`（理论上不会发生，仅做兜底）

**管辖范围**
- 总部（`staffLevel='headquarters'`）：标题 `总部 / 全部门店（共 N 家）`；
  门店列表默认折叠至前 5 家，> 5 家显示「展开 / 收起」
- 市场（`staffLevel='market'`）：标题 `市场 · {marketName}（共 N 家）`；
  marketName 取 `roleBindings` 中第一个 `scopeType='市场'` 的 `scopeName`
- 列表项仅显示 `storeName`，无图标 / 跳转

### 1.4 删除项

- ❌ 「返回门店视图」按钮（`onSwitchToStore`）
- ❌ 中间大图标 + "管理层菜单建设中"占位文案
- ❌ data 中的 `canSwitchStore` 字段
- ❌ wxss 中的 `.mgmt-profile-action--outline` / `.mgmt-profile-tip`（如不再被引用）

### 1.5 保留项

- ✅ Header 红色渐变 + 姓名 + 层级徽章 + 职位 + 手机号 内联块
- ✅ 「退出登录」按钮 + 二次确认（`onLogout` 不动）
- ✅ `mgmt-navbar` 底部导航
- ✅ `onShow` 中 `canAccessManagement()` 越权拦截

---

## 2 字段补全：后端 auth.js queryRoleBindings 增加 scopeName

### 2.1 当前实现（`cloudfunctions/staffApi/routes/auth.js:53-67`）

```js
async function queryRoleBindings(employeeId) {
  if (!employeeId) return []
  const rows = await pg.query(
    `SELECT pr.role, pr.scope_id, o.type AS scope_type
     FROM permission_roles pr
     LEFT JOIN org_nodes o ON o.id = pr.scope_id
     WHERE pr.employee_id = $1`,
    [employeeId]
  )
  return rows.map((r) => ({
    role: r.role,
    scopeId: r.scope_id,
    scopeType: r.scope_type,
  }))
}
```

### 2.2 改造（增加 `o.name AS scope_name`）

```js
async function queryRoleBindings(employeeId) {
  if (!employeeId) return []
  const rows = await pg.query(
    `SELECT pr.role, pr.scope_id, o.type AS scope_type, o.name AS scope_name
     FROM permission_roles pr
     LEFT JOIN org_nodes o ON o.id = pr.scope_id
     WHERE pr.employee_id = $1`,
    [employeeId]
  )
  return rows.map((r) => ({
    role: r.role,
    scopeId: r.scope_id,
    scopeType: r.scope_type,
    scopeName: r.scope_name,
  }))
}
```

**影响面**：
- `auth.login` 响应中的 `roleBindings` 增字段（向后兼容，前端旧版本忽略）
- `auth.bindPhone` 响应同步（同函数链路）
- `middleware/auth.js` 的 ctx.auth.roleBindings 同步（不影响业务，业务只读 role / scopeId / scopeType）
- `utils/scope.js` 的 `deriveStaffLevel` / `expandScopeStoreIds` 不依赖 scopeName，无影响

### 2.3 前端类型定义

`fengyu-staff/miniprogram/typings/index.d.ts`：

```ts
interface RoleBinding {
  role: string
  scopeId: string
  scopeType: string // 总部 / 市场 / 门店 / 部门
  scopeName: string // ← 新增
}
```

`app.ts` 中持久化 / 还原 roleBindings 的逻辑无需改动（透传整个对象）。

---

## 3 前端实现细节

### 3.1 mgmt-dashboard.ts data 调整

**移除**：
```ts
canSwitchStore: false,
```

**新增**：
```ts
basicInfo: null as null | {
  staffName: string
  staffWfId: string
  phoneFormatted: string
  position: string
  staffLevelLabel: string
},
roleBindingRows: [] as Array<{ role: string; scopeText: string }>,
storeScope: null as null | {
  title: string         // "总部 / 全部门店（共 23 家）" 或 "市场 · 华南区（共 8 家）"
  stores: string[]      // 门店名列表
  expanded: boolean
  needToggle: boolean   // stores.length > 5
},
```

### 3.2 mgmt-dashboard.ts onShow 改造

`onShow` 中（mgmt-dashboard.ts:171-189），当 `activeTab === 'profile'` 时调用 `buildProfileData()`：

```ts
buildProfileData() {
  const g = app.globalData
  const staffLevelLabel = g.staffLevel === 'headquarters' ? '总部'
    : g.staffLevel === 'market' ? '市场' : '--'

  this.setData({
    basicInfo: {
      staffName: g.staffName || '--',
      staffWfId: g.staffWfId || '--',
      phoneFormatted: this.formatPhone(g.phone),
      position: g.position || '--',
      staffLevelLabel,
    },
    roleBindingRows: this.buildRoleBindingRows(g.roleBindings || []),
    storeScope: this.buildStoreScope(g.staffLevel, g.roleBindings || [], g.scopedStores || []),
  })
},

formatPhone(p: string): string {
  if (!p || p.length !== 11) return p || '--'
  return `${p.slice(0,3)} ${p.slice(3,7)} ${p.slice(7)}`
},

buildRoleBindingRows(bindings: RoleBinding[]) {
  const order: Record<string, number> = { '总部': 0, '市场': 1, '门店': 2, '部门': 3 }
  return [...bindings]
    .sort((a, b) => (order[a.scopeType] ?? 9) - (order[b.scopeType] ?? 9))
    .map(b => ({
      role: b.role,
      scopeText: `${b.scopeType || '--'} · ${b.scopeName || '--'}`,
    }))
},

buildStoreScope(level: StaffLevel, bindings: RoleBinding[], stores: ScopedStore[]) {
  if (level !== 'headquarters' && level !== 'market') return null
  let title = ''
  if (level === 'headquarters') {
    title = `总部 / 全部门店（共 ${stores.length} 家）`
  } else {
    const m = bindings.find(b => b.scopeType === '市场')
    title = `市场 · ${m?.scopeName || '--'}（共 ${stores.length} 家）`
  }
  return {
    title,
    stores: stores.map(s => s.storeName),
    expanded: false,
    needToggle: stores.length > 5,
  }
},

onToggleStoreScope() {
  this.setData({ 'storeScope.expanded': !this.data.storeScope?.expanded })
},
```

### 3.3 mgmt-dashboard.wxml profile 块改造

替换现有 `<!-- 我的 -->` 整块（mgmt-dashboard.wxml:258-277）：

```xml
<block wx:elif="{{activeTab === 'profile'}}">
  <view class="mgmt-profile-wrap">
    <!-- Header（保留） -->
    <view class="mgmt-profile-header">
      <view class="mgmt-profile-name">{{staffName || '未命名员工'}}</view>
      <view class="mgmt-profile-meta">
        <text wx:if="{{staffLevelLabel}}" class="mgmt-profile-badge">{{staffLevelLabel}}</text>
        <text wx:if="{{position}}" class="mgmt-profile-meta-text">{{position}}</text>
        <text wx:if="{{phone}}" class="mgmt-profile-meta-text">{{phone}}</text>
      </view>
    </view>

    <view class="mgmt-profile-body">
      <!-- 基本信息卡 -->
      <view class="profile-section-title">基本信息</view>
      <view class="profile-card" wx:if="{{basicInfo}}">
        <view class="profile-row"><text class="lbl">姓名</text><text class="val">{{basicInfo.staffName}}</text></view>
        <view class="profile-row"><text class="lbl">工号</text><text class="val">{{basicInfo.staffWfId}}</text></view>
        <view class="profile-row"><text class="lbl">手机号</text><text class="val">{{basicInfo.phoneFormatted}}</text></view>
        <view class="profile-row"><text class="lbl">职位</text><text class="val">{{basicInfo.position}}</text></view>
        <view class="profile-row"><text class="lbl">层级</text><text class="val">{{basicInfo.staffLevelLabel}}</text></view>
      </view>

      <!-- 组织归属卡 -->
      <view class="profile-section-title">组织归属</view>
      <view class="profile-card">
        <view class="profile-table-header">
          <text class="col col-role">角色</text>
          <text class="col col-scope">作用域</text>
        </view>
        <view wx:if="{{roleBindingRows.length === 0}}" class="profile-empty">暂无角色绑定</view>
        <view wx:else wx:for="{{roleBindingRows}}" wx:key="role" class="profile-table-row">
          <text class="col col-role">{{item.role}}</text>
          <text class="col col-scope">{{item.scopeText}}</text>
        </view>
      </view>

      <!-- 管辖范围卡 -->
      <view wx:if="{{storeScope}}" class="profile-section-title">管辖范围</view>
      <view wx:if="{{storeScope}}" class="profile-card">
        <view class="profile-store-title">{{storeScope.title}}</view>
        <block wx:if="{{storeScope.stores.length === 0}}">
          <view class="profile-empty">暂无管辖门店</view>
        </block>
        <block wx:else>
          <view
            wx:for="{{storeScope.stores}}"
            wx:key="*this"
            wx:if="{{storeScope.expanded || index < 5}}"
            class="profile-store-item"
          >· {{item}}</view>
          <view
            wx:if="{{storeScope.needToggle}}"
            class="profile-store-toggle"
            bindtap="onToggleStoreScope"
          >{{storeScope.expanded ? '收起' : '展开全部 ' + storeScope.stores.length + ' 家'}}</view>
        </block>
      </view>

      <!-- 退出登录（保留） -->
      <button class="mgmt-profile-action" bindtap="onLogout">退出登录</button>
    </view>
  </view>
</block>
```

**关键变更点**：
- 移除 `<view wx:if="{{canSwitchStore}}" ... bindtap="onSwitchToStore">返回门店视图</view>`
- 移除 `<van-icon name="gem-o" .../>` + `<text class="mgmt-profile-tip">...</text>` 占位
- `mgmt-profile-body` 内部由"居中弹簧布局" → "上下罗列卡片 + 底部退出按钮"

### 3.4 wxss 调整

**新增**（追加到现有 `.mgmt-profile-*` 之后）：
```css
.profile-section-title {
  font-size: 26rpx;
  color: #999;
  padding: 32rpx 32rpx 12rpx;
  letter-spacing: 1rpx;
}

.profile-card {
  background: #fff;
  border-radius: 16rpx;
  margin: 0 24rpx;
  padding: 16rpx 24rpx;
}

.profile-row {
  display: flex;
  justify-content: space-between;
  padding: 20rpx 0;
  border-bottom: 1rpx solid #f0f0f0;
  font-size: 28rpx;
}

.profile-row:last-child { border-bottom: none; }
.profile-row .lbl { color: #999; }
.profile-row .val { color: #333; font-weight: 500; }

.profile-table-header {
  display: grid;
  grid-template-columns: 200rpx 1fr;
  padding: 16rpx 0;
  font-size: 24rpx;
  color: #999;
  border-bottom: 1rpx solid #f0f0f0;
}

.profile-table-row {
  display: grid;
  grid-template-columns: 200rpx 1fr;
  padding: 20rpx 0;
  font-size: 28rpx;
  color: #333;
}

.profile-table-row:not(:last-child) { border-bottom: 1rpx solid #f0f0f0; }

.profile-store-title {
  font-size: 28rpx;
  color: #C0322A;
  font-weight: 600;
  padding: 12rpx 0 16rpx;
}

.profile-store-item {
  font-size: 28rpx;
  color: #333;
  padding: 12rpx 0;
}

.profile-store-toggle {
  text-align: center;
  font-size: 26rpx;
  color: #C0322A;
  padding: 16rpx 0 8rpx;
}

.profile-empty {
  text-align: center;
  font-size: 26rpx;
  color: #999;
  padding: 32rpx 0;
}
```

**改动**：
- `.mgmt-profile-body` 现有规则（mgmt-dashboard.wxss:241-246）：去掉 `align-items: center` + `padding: 96rpx 48rpx`，改为 `padding-bottom: 48rpx`，让卡片左对齐填满
- `.mgmt-profile-action` 现有规则（mgmt-dashboard.wxss:254-264）：`margin: 64rpx 32rpx 0` 改为 `margin: 64rpx 24rpx 0`，`width: 60%` 改 `width: auto` 让按钮跨满卡片栅格宽度

**删除**：
- `.mgmt-profile-tip`（254-252）— 不再使用
- `.mgmt-profile-action--outline`（266-270）— 不再使用

---

## 4 ts 中要删除的方法

`mgmt-dashboard.ts:427-430`：

```ts
onSwitchToStore() {
  app.setLoginLevel('store')
  wx.reLaunch({ url: '/pages/workbench/workbench' })
},
```

整段 **删除**。同时在 `onShow` 中删除：
```ts
canSwitchStore: (availableLoginLevels || []).includes('store'),
```

> ⚠️ **注意**：`setLoginLevel` 函数本身保留在 `app.ts`，登录页选择登录层级时仍需要。

---

## 5 边界与异常

| 场景 | 处理 |
|------|------|
| `staffLevel` 为 null（账号无层级） | `canAccessManagement()` 在 onShow 已拦截 → reLaunch workbench；理论上不会进入 profile tab |
| `staffWfId` 缺失 | 显示 `--` |
| `phone` 缺失（极少见，需先 bindPhone 才能登录） | 显示 `--` |
| `roleBindings` 为空数组 | 「组织归属」卡显示 `暂无角色绑定` |
| `scopedStores` 为空数组 | 「管辖范围」卡显示 `暂无管辖门店` |
| 市场用户但 roleBindings 中无 scopeType='市场' 的绑定 | title 中市场名显示 `--`（数据异常，但不阻塞页面渲染） |
| 跨页返回（用户从 dashboard tab → profile tab） | onTabChange 不重新调 buildProfileData；改在 onShow 中无条件构建（globalData 已就绪），简单可靠 |
| 总部用户管辖 0 家门店（数据异常） | 标题 `总部 / 全部门店（共 0 家）`，列表显示 `暂无管辖门店` |

---

## 6 测试建议

### 6.1 后端 auth 单测（如已存在则补 case，否则在本 ticket 内不强制）

- `queryRoleBindings` 返回结果含 `scopeName` 字段
- `o.name` 为 NULL（理论上不会，但 LEFT JOIN 兜底）时 `scopeName === null`

### 6.2 前端手测清单

| 场景 | 预期 |
|------|------|
| 总部账号登录 → 我的 | 三卡均展示；管辖范围标题 `总部 / 全部门店（共 N 家）` |
| 市场账号登录 → 我的 | 三卡均展示；管辖范围标题 `市场 · {marketName}（共 N 家）` |
| 多绑定账号（总部 + 门店 manager） | 组织归属表格 2 行；管辖门店为合并去重后的 scopedStores |
| 管辖门店 > 5 家 | 默认显示前 5 家 + "展开全部 N 家"；点击后全部展开 + "收起" |
| 管辖门店 = 0 家（异常） | 标题 `共 0 家`，列表 `暂无管辖门店` |
| 退出登录 | 模态确认 → 跳登录页（不变） |
| 双层级账号（store + management） | **不应再看到「返回门店视图」按钮** |

---

## 7 验收标准

- [ ] `auth.queryRoleBindings` 返回 `scopeName` 字段，`auth.login` / `auth.bindPhone` 响应同步
- [ ] `IAppOption.RoleBinding` 类型增加 `scopeName: string`
- [ ] mgmt-dashboard 的 profile tab 不再展示「返回门店视图」按钮
- [ ] 三个信息卡片正确渲染：基本信息 / 组织归属 / 管辖范围
- [ ] 总部 / 市场两种身份切换登录后页面渲染均正确
- [ ] 退出登录功能保留且行为不变
- [ ] `onSwitchToStore` 方法 + `canSwitchStore` data 字段已删除
- [ ] wxss 中 `.mgmt-profile-action--outline` / `.mgmt-profile-tip` 已删除
- [ ] 在管理层用户账号上 `tsc --noEmit`（如配置）通过

---

## 8 不在本 ticket 范围

- 角色 key 中文化（`admin → 管理员` 等映射表）
- 「修改资料」/「修改密码」/「关于我们」等扩展菜单项
- 总部账号下管辖门店的搜索 / 分页
- mgmt-navbar 的 profile icon 替换
- 市场账号支持多市场（理论上一个员工只挂一个市场绑定，待运营确认后再扩展）
