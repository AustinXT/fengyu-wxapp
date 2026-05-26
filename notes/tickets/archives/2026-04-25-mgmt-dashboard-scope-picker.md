# Ticket 3: 市场/门店二级筛选器组件（mgmt-scope-picker）

> 生成日期：2026-04-25
> 严重级别：P1（数据中心首页 / 后续排行榜 tab 都依赖）
> 端：fengyu-staff（小程序前端组件）+ staffApi（数据源接口）
> 影响面：1 个新组件 + 1 个新 action（`mgmtDashboard.scopeOptions`）+ mgmt-dashboard 引用
> 前置：无（与 Ticket 2 可并行）
> 后置：Ticket 4（首页 dashboard tab）会引用本组件
>
> **一句话目标**：实现一个可复用的"市场 / 门店二级筛选器" Vant 组件
> （顶部一行水平展示，含"全部市场"选项），点击触发底部 popup 选择，
> 选中后通过 `bind:change` 事件抛 `{ scopeType, scopeId, scopeName }`，
> 同时受当前账号 staffLevel 约束（市场账号不能选"全部"或别的市场）。

---

## 0 一句话背景

数据中心首页（Ticket 4）和后续排行榜 tab 都需要一个一致的"市场 / 门店"筛选交互。
现有 `pages/workbench` 顶部只有"门店切换"（单店列表 → action-sheet），不满足"两级 + 全部市场" 需求。
为了不让 mgmt-dashboard 把组件逻辑写死在页面里，独立成组件，方便后续复用（排行榜 tab 极可能用同一筛选）。

---

## 1 交互规格

### 1.1 视图

页面顶部一行（与日历选择器同行或下一行均可，由 mgmt-dashboard 决定）：

```
[ 全部市场 ▾ ]                              ← 当前展示的 scope 名（带下拉箭头）
```

点击 → 弹出 `van-popup`（`position="bottom"`，`round`），内含两列瀑布：

```
  市场列表             门店列表（点击右侧才显示）
  ----------          ----------
  ✓ 全部市场           （选 "全部" 时此栏隐藏）
    华南市场           
    华东市场           
    华北市场           
                      
                      [确定]   [取消]
```

- 默认选中"全部市场"（仅 headquarters 账号可见此项）
- 选中"全部" → 直接关闭 popup，emit `{ scopeType: 'all', scopeId: null, scopeName: '全部市场' }`
- 选中某市场 → 右侧出现该市场下门店列表，第一项是"全部门店"（即仅市场维度，不下钻到店）
- 选中某门店 → 显示"市场名 · 门店名"
- 取消 → 恢复入场前选中

### 1.2 权限约束（按 staffLevel）

| 账号 staffLevel | 可见选项 |
|---|---|
| `headquarters` | 全部市场 / 任一市场 / 任一门店 |
| `market` | 仅自己所属 market（不显示"全部市场"行）；可下钻该 market 下的任意门店 |
| `store_manager` / `store_staff` | 不应进入管理层 hub，**前置在 mgmt-dashboard 已拦截**，组件不再判 |

> 组件接收 `staffLevel` + `scopedStores`（来自 `app.globalData`）作为 props，自行决定显示哪些选项。

### 1.3 默认值

- headquarters → 默认 'all'
- market → 默认 `{ scopeType: 'market', scopeId: 自己的 marketId, scopeName: 市场名 }`

由调用方（mgmt-dashboard）从 `app.globalData.roleBindings` 计算后传入 props（`defaultScope`）。

---

## 2 组件设计

### 2.1 目录与文件

```
fengyu-staff/miniprogram/components/mgmt-scope-picker/
  ├─ mgmt-scope-picker.json
  ├─ mgmt-scope-picker.ts
  ├─ mgmt-scope-picker.wxml
  └─ mgmt-scope-picker.wxss
```

### 2.2 Properties

```ts
properties: {
  staffLevel: { type: String, value: '' },     // 'headquarters' | 'market'
  scopedMarkets: { type: Array, value: [] },   // 市场账号场景下传入唯一可见的 market；HQ 不传
  defaultScope: {                               // 入场默认值
    type: Object,
    value: { scopeType: 'all', scopeId: null, scopeName: '全部市场' },
  },
}
```

### 2.3 Data

```ts
data: {
  showPopup: false,
  marketList: [],          // 从接口拉取（headquarters 场景）
  storeListByMarket: {},   // { marketId: [{ storeId, storeName }] }
  current: null,           // 当前选中（确认前的临时态）
  applied: null,           // 当前应用的（confirmed）
}
```

### 2.4 Events

```ts
// 选中并确认
this.triggerEvent('change', {
  scopeType: 'all' | 'market' | 'store',
  scopeId: string | null,
  scopeName: string,
})
```

仅在用户点"确定"或选中"全部"后触发；取消不触发。

### 2.5 数据源接口（新增 action）

`mgmtDashboard.scopeOptions`（在 Ticket 2 同一文件 `routes/mgmt-dashboard.js` 内追加）：

```ts
// 入参：无（按账号权限自动过滤）
// 出参：
{
  staffLevel: 'headquarters' | 'market',
  markets: [
    { id: 'org_node_id', name: '华南市场', stores: [{ storeId, storeName }] },
    ...
  ]
}
```

权限：`requireManagementLevel`；HQ 返回所有 market；market 账号仅返回自己 market 一个。
**实现简单**：JOIN org_nodes 一次拉完，缓存到云函数内存（5 分钟 TTL 即可，门店增删频率极低）。

---

## 3 实现要点

### 3.1 mgmt-scope-picker.wxml 骨架

```xml
<view class="scope-picker">
  <view class="scope-trigger" bindtap="onOpen">
    <text>{{ applied.scopeName || '全部市场' }}</text>
    <van-icon name="arrow-down" size="24rpx" color="#999" />
  </view>

  <van-popup show="{{ showPopup }}" position="bottom" round bind:close="onCancel">
    <view class="scope-popup">
      <view class="scope-cols">
        <!-- 左列：市场 -->
        <scroll-view class="scope-col" scroll-y>
          <view
            wx:if="{{ staffLevel === 'headquarters' }}"
            class="scope-row {{ current.scopeType === 'all' ? 'active' : '' }}"
            bindtap="onPickAll"
          >全部市场</view>
          <view
            wx:for="{{ marketList }}" wx:key="id"
            class="scope-row {{ current.marketId === item.id ? 'active' : '' }}"
            bindtap="onPickMarket" data-market-id="{{ item.id }}"
          >{{ item.name }}</view>
        </scroll-view>

        <!-- 右列：门店（市场选中时才有） -->
        <scroll-view wx:if="{{ current.marketId }}" class="scope-col" scroll-y>
          <view
            class="scope-row {{ current.storeId === '' ? 'active' : '' }}"
            bindtap="onPickStore" data-store-id=""
          >全部门店</view>
          <view
            wx:for="{{ storeListByMarket[current.marketId] }}" wx:key="storeId"
            class="scope-row {{ current.storeId === item.storeId ? 'active' : '' }}"
            bindtap="onPickStore" data-store-id="{{ item.storeId }}"
          >{{ item.storeName }}</view>
        </scroll-view>
      </view>

      <view class="scope-actions">
        <button bindtap="onCancel">取消</button>
        <button class="primary" bindtap="onConfirm">确定</button>
      </view>
    </view>
  </van-popup>
</view>
```

### 3.2 状态机

```
入场：showPopup=false, applied=defaultScope, current=defaultScope

点击触发：onOpen → showPopup=true, current = applied（拷贝）

左列点击：
  - "全部市场" → onPickAll → current = {scopeType:'all', scopeId:null, scopeName:'全部市场'}
                            → 直接 onConfirm（关闭 + emit）
  - 某 market → onPickMarket → current = {scopeType:'market', marketId, scopeName, scopeId: marketId}
                              → 不关闭，等右列选门店；若用户不选门店直接点"确定"则保留 market 维度

右列点击：
  - "全部门店" → 维持 current 的 market 维度，store_id 留空
  - 某 store → current = {scopeType:'store', scopeId: storeId, scopeName: '市场名 · 门店名'}

确定：applied = current → emit('change', applied) → showPopup=false
取消：current = applied（回滚）→ showPopup=false
```

### 3.3 wxss 样式要点

- 两列等宽，最小高度 60vh
- 选中行加左边框红色（项目主色 `#C0322A`）
- 触发器只占一行，文本左对齐，箭头右对齐

### 3.4 onLoad / 数据加载

```ts
attached() {
  this.loadOptions()
  this.setData({ applied: this.properties.defaultScope, current: this.properties.defaultScope })
},

async loadOptions() {
  const res = await callStaffApi('mgmtDashboard.scopeOptions', {})
  const marketList = res.markets.map(m => ({ id: m.id, name: m.name }))
  const storeListByMarket = {}
  res.markets.forEach(m => { storeListByMarket[m.id] = m.stores })
  this.setData({ marketList, storeListByMarket })
},
```

### 3.5 调用方使用示例

```xml
<!-- pages/mgmt-dashboard/mgmt-dashboard.wxml 中 -->
<mgmt-scope-picker
  staff-level="{{ staffLevel }}"
  default-scope="{{ defaultScope }}"
  bind:change="onScopeChange"
/>
```

```ts
// pages/mgmt-dashboard/mgmt-dashboard.ts
onScopeChange(e: WechatMiniprogram.CustomEvent<{ scopeType, scopeId, scopeName }>) {
  this.setData({ scope: e.detail })
  this.refreshDashboard()
}
```

---

## 4 测试

### 4.1 手动验收

1. **HQ 账号**：打开数据中心 → 看到"全部市场" → 点击 → popup 出现，左列含"全部市场" + 3 个市场 → 选"全部" 立即关闭 + emit
2. 选某市场 → 右列出现门店；点门店 → 标题改为"市场名 · 门店名"；点"全部门店" + 确定 → 标题改为市场名
3. 点取消 → 恢复入场前选中
4. **市场账号**：默认显示自己市场名；popup 内左列**不显示**"全部市场"行；左列只有自己一个市场
5. 切回门店视图 → 切到管理层 → 重新进入数据中心 → 默认值正确

### 4.2 单元测试（可选）

WXTS 单测对小程序组件覆盖有限；优先做 §4.1 手动验收，单测仅覆盖纯逻辑函数（如 scopeOptions 接口的服务端测试）。

---

## 5 风险

| 风险 | 缓解 |
|---|---|
| 市场数量极多（> 50）时左列体验差 | 实际 < 10 个 market，可不做搜索；> 20 时再加搜索框 |
| 接口 5 分钟缓存导致门店增删延迟 | 改 cache TTL；或用 `wx.getStorageSync` 在前端再缓存（首版不做） |
| 复用到排行榜 tab 时需求略有差异（如必须选门店） | 加一个 prop `requireStore: boolean` 控制（首版不加，等真用到时） |
| 进入弹层后旋转屏幕 / 切横屏 | 小程序场景基本不用横屏，可忽略 |

---

## 6 不在本 ticket 范围

- 任何统计接口（在 Ticket 2）
- 排行榜 tab 内的排序选项（与本组件无关，另开 ticket）
- 持久化"上次选的 scope"到 storage（首版不做，每次进入都从默认值开始）
- 多选（首版只支持单选）

---

## 7 交付物

- [ ] `components/mgmt-scope-picker/` 4 个文件
- [ ] `staffApi/routes/mgmt-dashboard.js` 追加 `scopeOptions` action
- [ ] `staffApi/index.js` 路由表已含 mgmtDashboard 模块（Ticket 2 已注册时无需重复）
- [ ] `staffApi/CLAUDE.md` 路由表追加 `scopeOptions`
- [ ] 手动验收 §4.1 全通
