# 员工端小程序 UI 规范（staff_ui.md）

> 凤御双美容院 — fengyu-staff B端员工小程序
> 角色：店长（门店经理）/ 美容师
> 版本：1.0.0 | 2026-02-27

---

## 设计规范声明

```text
设计规范
====================
1. 目的声明：
   面向美容院一线员工（店长 + 美容师）的管理操作端，核心场景为
   开单收款、预约管理、服务核销和顾客档案查阅。需要高效的信息
   密度和清晰的操作路径，兼顾品牌调性与工作效率。

2. 审美方向：工业实用 + 奢华精致点缀
   主体采用"工业实用"风格（紧凑信息密度、网格对齐、低彩度）；
   品牌金色用于关键数据点（分成金额、今日营收）体现凤御高端调性。

3. 配色方案：
   - 主色（品牌棕金）：#8B6A3E — 导航激活态、主操作按钮、金额强调
   - 主色亮：#C4975A — hover 态、辅助高亮
   - 主色暗：#5C4427 — 深色按压态
   - 强调色（状态绿）：#3D8A5A — 已支付、已完成、已确认等正向状态
   - 背景色：#F5F2EE — 暖白底（微米白，区别于冷白）
   - 卡片色：#FFFFFF — 内容卡片
   - 文字主色：#2D2017 — 深棕黑，比纯黑更柔和
   禁用：紫色系、蓝紫渐变

4. 字体策略：
   系统字体栈 -apple-system / PingFang SC
   标题：bold 700，34~40rpx；正文：regular 400，28rpx；
   金额：bold 700，40~52rpx，主色#8B6A3E；辅助：24rpx，#666

5. 布局策略：
   - 工作台：垂直分区（分成卡 → 日历 → 代办列表），明确的区块边界
   - 开单：直接展示商品目录（左侧分类 + 右侧SPU），结算时选顾客和开单类型
   - 护理：护理单管理（开护理单 + 状态筛选列表）
   - 全局：32rpx 页面边距，卡片圆角 16rpx，紧凑行高 88~96rpx
```

---

## CSS 变量定义（app.wxss 追加）

```css
page {
  /* 品牌色 */
  --color-primary:       #8B6A3E;
  --color-primary-light: #C4975A;
  --color-primary-dark:  #5C4427;
  --color-accent:        #3D8A5A;

  /* 语义色 */
  --color-success:  #3D8A5A;
  --color-warning:  #D4820A;
  --color-error:    #D94040;
  --color-info:     #5E8BB3;

  /* 状态徽章背景（低饱和） */
  --color-badge-pending:   #FFF3E0;  /* 待支付 / 待确认 */
  --color-badge-confirmed: #E8F5E9;  /* 已确认 / 已支付 */
  --color-badge-progress:  #E3F0FF;  /* 服务中 */
  --color-badge-done:      #F0F0F0;  /* 已完成 / 已关闭 */
  --color-badge-error:     #FFEBEE;  /* 支付失败 */

  /* 中性色 */
  --color-text-primary:   #2D2017;
  --color-text-secondary: #666666;
  --color-text-hint:      #999999;
  --color-border:         #E5DDD5;
  --color-bg-page:        #F5F2EE;
  --color-bg-card:        #FFFFFF;

  /* 间距 */
  --spacing-page:  32rpx;
  --spacing-card:  24rpx;
  --spacing-tight: 16rpx;
}
```

---

## Tab Bar 配置

```json
// app.json tabBar 配置
{
  "tabBar": {
    "color": "#999999",
    "selectedColor": "#8B6A3E",
    "backgroundColor": "#FFFFFF",
    "borderStyle": "white",
    "list": [
      {
        "pagePath": "pages/workbench/workbench",
        "text": "工作台",
        "iconPath": "images/icons/tab-workbench.png",
        "selectedIconPath": "images/icons/tab-workbench-active.png"
      },
      {
        "pagePath": "pages/order-create/order-create",
        "text": "开单",
        "iconPath": "images/icons/tab-order.png",
        "selectedIconPath": "images/icons/tab-order-active.png"
      },
      {
        "pagePath": "pages/service/service",
        "text": "护理",
        "iconPath": "images/icons/tab-service.png",
        "selectedIconPath": "images/icons/tab-service-active.png"
      },
      {
        "pagePath": "pages/profile/profile",
        "text": "我的",
        "iconPath": "images/icons/tab-profile.png",
        "selectedIconPath": "images/icons/tab-profile-active.png"
      }
    ]
  }
}
```

---

## 一、工作台（workbench）

**文件路径**：`pages/workbench/workbench.*`

### 页面功能

员工打开小程序后的首页，从上到下依次展示：
1. 我的今日分成（金额卡片）
2. 本月业绩日历（员工自身月度业绩视图）
3. 代办 / 消息（预约待处理、服务待推进）
4. 顾客档案（选择需要服务的顾客，查询档案、疗程卡、预约信息）

---

### 1.1 页面头部

```text
┌──────────────────────────────────────────────┐
│  ← （无返回键，Tab页）  工作台        [刷新图标] │
│  门店：南商市场 · 凤御旗舰店     角色：店长      │
└──────────────────────────────────────────────┘
```

- 导航栏标题：工作台
- 副标题行：当前门店名称（`store_name`） + 角色标签（`店长` / `美容师`，小徽章样式）
- 门店未绑定时显示"未绑定门店"提示（绑定门店入口在「我的」页面）
- 右侧刷新按钮：`van-icon name="replay"` 手动触发日历更新

**WXML 示意：**

```xml
<view class="page-header">
  <view class="store-info">
    <text class="store-name">{{storeName}}</text>
    <view class="role-badge role-badge--{{role}}">
      <text class="role-text">{{roleLabel}}</text>
    </view>
  </view>
  <van-icon name="replay" size="40rpx" color="#8B6A3E" bind:click="onRefresh" />
</view>
```

---

### 1.2 分成卡片

**数据来源**：`revenue_allocations` 中当日 `is_void = false` 且关联订单 `status = 已支付` 的 `total_amount` 合计，按当前登录员工 `staff_wf_id` 过滤。

**MVP 说明**：MVP 阶段不实现"提成计算"，此处展示的是今日**营业额分配金额**（非计算提成），数据来源明确。

```text
┌───────────────────────────────────────────────┐
│  今日分成（营业额分配）   │          本月累计      │
│                       │                       │
│  ¥ 3,200.00           │         ¥ 3,2000.00   │
│                       │                       │
│  订单数 服务单数        │        订单数 服务单数   │
│  3       2            │         20    100     │
└───────────────────────────────────────────────┘
```

**视觉规格：**

- 卡片背景：`linear-gradient(135deg, #8B6A3E 0%, #C4975A 100%)`（品牌金渐变）
- 今日金额：52rpx，bold，`#FFFFFF`
- 标签文字：24rpx，`rgba(255,255,255,0.75)`
- 本月累计：28rpx，`rgba(255,255,255,0.9)`，右对齐 `>` 箭头可点击（跳转历史明细页，MVP暂不实现）
- 卡片圆角：20rpx，左右 `--spacing-page` 边距

**权限说明**：店长和美容师均可见；美容师只看自己的分成，店长可在卡片下方追加"门店今日营收"（`¥ XX,XXX`，灰色小字），美容师不展示该行。

**WXML 示意：**

```xml
<view class="commission-card">
  <!-- 两列布局：今日分成 | 本月累计 -->
  <view class="commission-columns">
    <!-- 左列：今日分成 -->
    <view class="commission-col commission-col--today">
      <text class="commission-col-label">今日分成（营业额分配）</text>
      <view class="commission-amount">
        <text class="commission-unit">¥ </text>
        <text class="commission-value">{{todayCommission}}</text>
      </view>
      <view class="commission-stats">
        <text class="commission-stat">订单数 {{todayOrderCount}}</text>
        <text class="commission-stat">服务单数 {{todayServiceCount}}</text>
      </view>
    </view>
    <!-- 分隔线 -->
    <view class="commission-divider" />
    <!-- 右列：本月累计（数据来自 staff.monthlyCalendar） -->
    <view class="commission-col commission-col--monthly">
      <text class="commission-col-label">本月累计</text>
      <view class="commission-amount commission-amount--monthly">
        <text class="commission-unit">¥ </text>
        <text class="commission-value commission-value--monthly">{{monthlyCommission}}</text>
      </view>
      <view class="commission-stats">
        <text class="commission-stat">订单数 {{monthlyOrderCount}}</text>
        <text class="commission-stat">服务单数 {{monthlyServiceCount}}</text>
      </view>
    </view>
  </view>
  <!-- 仅店长可见 -->
  <view class="store-revenue" wx:if="{{isManager}}">
    <text class="store-revenue-label">门店今日营收  ¥ {{storeTodayRevenue}}</text>
  </view>
</view>
```

---

### 1.3 本月业绩日历（员工月度业绩）

**文件路径**：`pages/workbench/workbench.*`（内联实现，非独立组件）

**数据来源**：`revenue_allocations` 中当月按 `staff_wf_id = 当前员工` 过滤的每日分配金额汇总（`SUM(total_amount)`）。展示员工本人每天的业绩，而非顾客消费记录。

**API**：调用 `staff.monthlyCalendar`，参数 `{ yearMonth: 'YYYY-MM' }`，返回 `{ dailyData: [{date, amount, orderCount, serviceCount}], totalAmount, totalOrderCount, totalServiceCount }`。其中 `totalAmount` 及汇总计数用于分成卡片右列「本月累计」展示，**不在日历下方单独展示**。

#### 1.3.1 日历组件布局

```text
┌───────────────────────────────────────────────┐
│  本月业绩                    ‹ 2026年2月 ›      │
├──┬──┬──┬──┬──┬──┬──┤
│日│一│二│三│四│五│六│
├──┼──┼──┼──┼──┼──┼──┤
│  │  │  │  │  │  │ 1│
├──┼──┼──┼──┼──┼──┼──┤
│ 2│ 3│ 4│ 5│ 6│ 7│ 8│
│  │  │  │●  │  │  │  │
│  │  │  │5k │  │  │  │
├──┼──┼──┼──┼──┼──┼──┤
│  │...                │
└───────────────────────────────────────────────┘

● = 当日员工有业绩分成，下方显示金额（元，超过999以"1k+"格式）
今日 = 圆形背景高亮
```

**月份导航：** 左箭头切换上月，右箭头切换下月（不超过当月）。

**日历格子状态：**

| 状态 | 样式 |
|------|------|
| 今日（无业绩） | 日期数字高亮圆圈，`--color-primary` 背景 |
| 有业绩 | 金额文字 18rpx，`--color-primary-light` |
| 今日 + 有业绩 | 圆圈背景 + 金额文字 |
| 普通无业绩 | 普通灰色日期 |

---

### 1.4 代办 / 消息区域

**数据来源**：
- 待确认线下收款（`orders.status = 待确认收款`，**仅店长可见**）
- 待确认线开单（`orders.status = 待确认开单`，**仅店长可见**）
- 待确认预约（`appointments.status = 待确认`，`staff_wf_id = 当前员工`）
- 待推进服务单（`service_orders.status IN (待服务, 服务中)`，`assigned_staff_wf_id = 当前员工`）

```text
┌───────────────────────────────────────────────┐
│  待处理事项                                     │
│ ─────────────────────────────────────────────  │
│  [💰] 待确认收款  1条（仅店长）             >  │
│  [💰] 开单待确认  1条（仅店长）             >  │
│  [🗓] 预约待确认  3条                       >  │
│  [💆] 服务单待推进  2条                     >  │
└───────────────────────────────────────────────┘
```

**视觉规格：**
- 区块标题：28rpx bold，`--color-text-primary`
- 每行：88rpx 高度，`van-cell` 样式（或自定义）
- 图标：`van-icon` 或 Icons8 图标 40rpx
- 数量徽章：`van-badge` 红色徽章
- 点击跳转：→ 预约列表（按"待确认"筛选）/ 服务单列表 / 订单列表（按"待确认收款"筛选）

**WXML 示意：**

```xml
<view class="todo-section">
  <text class="section-title">待处理事项</text>
  <van-cell-group>
    <!-- 预约待确认：点击跳转预约列表（按"待确认"筛选）；
         预约 Tab 已并入护理 Tab，预约入口仅保留此代办条目 -->
    <van-cell
      title="预约待确认"
      value="{{pendingAppointments}}条"
      is-link
      bind:click="goAppointments"
    >
      <van-icon slot="icon" name="clock-o" size="40rpx" color="#D4820A" />
    </van-cell>
    <van-cell
      title="服务单待推进"
      value="{{pendingServices}}条"
      is-link
      bind:click="goServiceList"
    >
      <van-icon slot="icon" name="flower-o" size="40rpx" color="#3D8A5A" />
    </van-cell>
    <!-- 仅店长可见 -->
    <van-cell
      wx:if="{{isManager}}"
      title="待确认收款"
      value="{{pendingOfflineOrders}}条"
      is-link
      bind:click="goOrderList"
    >
      <van-icon slot="icon" name="gold-coin-o" size="40rpx" color="#8B6A3E" />
    </van-cell>
    <van-cell
      wx:if="{{isManager}}"
      title="开单待确认"
      value="{{pendingCreateOrders}}条"
      is-link
      bind:click="goOrderListPendingCreate"
    >
      <van-icon slot="icon" name="records" size="40rpx" color="#8B6A3E" />
    </van-cell>
  </van-cell-group>
</view>
```

**跳转逻辑：**
- 预约待确认 → `pages/appointment/appointment?tab=pending`（预约列表页，待确认筛选）
- 服务单待推进 → `pages/service/service`（护理 Tab）
- 待确认收款 → `pages/order-list/order-list?status=pendingOffline`
- 开单待确认 → `pages/order-list/order-list?status=pendingCreate`

---

### 1.5 顾客服务搜索入口

**目的**：员工在工作台快速搜索需要服务的顾客，进入其档案页查看疗程卡余量、预约记录、消费历史等，为服务做准备（**非**浏览客户列表）。

```text
┌───────────────────────────────────────────────┐
│  顾客档案                           全部 ›       │
│  搜索顾客查看档案、疗程卡及预约信息               │
│  ┌────────────────────────────────────────┐   │
│  │  🔍 输入手机号搜索顾客...                │   │
│  └────────────────────────────────────────┘   │
│  （搜索结果）                                   │
│  [头像] 张美玲  138****8888              >      │
│  [头像] 王芳    139****5555              >      │
└───────────────────────────────────────────────┘
```

- 搜索框：`van-search` 组件，`placeholder="输入手机号搜索顾客"`
- 输入完整手机号触发搜索（调用 `customer.search`）
- 点击顾客行 → `customer-detail` 页面（可查看档案、疗程卡、预约信息）
- 「全部」链接跳转顾客列表页

---

## 二、开单（order-create）

**文件路径**：`pages/order-create/order-create.*`

**权限**：全员可操作；非店长提交的订单需等待店长审批后生效。体验单（自定义金额）仅店长可选。

### 页面功能

Tab 页直接展示商品目录（左侧分类 + 右侧 SPU，与客户端「服务」Tab 同款双栏布局），员工边与顾客沟通边选择商品。选好后通过底部操作栏点击「下单」，弹出结算面板，依次完成顾客确认、开单类型、订单确认、营业额分配，最终生成收款二维码。

```text
[商品目录主视图] ──点击"下单"──→ [结算面板 Step 0~4] ──→ [订单二维码页]
```

---

### 2.1 页面主视图（商品目录 + 底部操作栏）

```text
┌─────────────────────────────────────────────────────┐
│  ← 开单                                  [促销方案 ↗] │
├───────────────┬─────────────────────────────────────┤
│ 蜜语生玑       │  蜜语生玑精华护理疗程                  │
│ 安吉丽美颜之爱  │  ¥ 起 3,800   生美  [+ 添加]         │
│ 光感白皙       │ ─────────────────────────────────  │
│ 眉眼          │  蜜语焕颜精华液（院装）                 │
│ ...           │  ¥ 起 680    院装产品  [+ 添加]       │
│ 院装产品  ──── │ ─────────────────────────────────  │
│               │  [已添加项目] ─────────────────────  │
│               │  蜜语精华护理疗程 x1   ¥ 3,800   [×] │
│               │  明眸祛皱  x1          ¥ 1,200   [×] │
└───────────────┴─────────────────────────────────────┘
│ [促销方案快捷入口]    已选 2 项 ¥5,000.00    [下单]  │
└─────────────────────────────────────────────────────┘
```

**交互细节：**
- 点击 SPU 卡片 → 弹出 SKU 规格面板（`van-popup position="bottom"`）
- SKU 规格面板展示：规格名（"10次卡"/"20次卡"）+ 价格 + 次数（疗程卡显示）
- 同一 SPU 可多次添加不同 SKU；院装产品直接添加，quantity 可调整
- 右上角「促销方案 ↗」= 快捷跳转促销方案选择流程（同底部快捷入口）
- 底部操作栏固定吸底：左侧「促销方案快捷入口」按钮，右侧显示「已选 N 项 ¥X,XXX」+ **「下单」**按钮
- 点击「下单」弹出结算面板（`van-popup position="bottom" round`）

**体验单模式额外说明**：SKU 规格面板内，金额字段可编辑（`<input type="digit">`），仅店长可使用自定义价格。

---

### 2.2 结算面板 — Step 0：选择顾客

```text
┌───────────────────────────────────────────────┐
│  结算面板  [●○○○○] 选择顾客                     │
│                                               │
│  最近选择：                                    │
│  [头像] 张美玲  138****8888           [选择 >]  │
│  [头像] 王芳    139****5555           [选择 >]  │
│  [头像] 李晓华  136****2233           [选择 >]  │
│                                               │
│  ┌──────────────────────────────────────┐     │
│  │  🔍 输入手机号搜索顾客...              │     │
│  └──────────────────────────────────────┘     │
│                                               │
│  ── 搜索结果 ──────────────────────────────    │
│  顾客姓名：张美玲                               │
│  会员等级：VIP  ·  138 8888 0000（店长）        │
│  所属美容师：李芳芳                              │
│                                               │
│  ──────────────────────── [确认选择此顾客]       │
└───────────────────────────────────────────────┘
```

**交互逻辑：**
- 默认展示最近 3~5 位选择过的顾客（从本地 `wx.getStorageSync('recentCustomers')` 读取），点击「选择」直接确认
- 搜索框支持手机号（11位）输入，调用 `customer.search`；搜索结果与最近记录并列展示
- 已注册客户端：显示顾客信息（店长可见完整手机号，美容师脱敏）
- 未注册客户端：提示"该手机号未注册客户端小程序，订单将以手机号作为临时标识，顾客绑定后自动关联"，仍可继续开单
- 找不到 WorkFine 档案：提示"WorkFine 无此顾客档案，请确认手机号或联系店长"
- 确认顾客后，将顾客信息写入 `recentCustomers`（最多保留 5 条，按最近时间排序）

**数据说明**：
- 查询来源：`client_wechat_users.phone`（判断是否注册）+ WorkFine `UDT_S_311.UDF_S_1478`（顾客档案）

---

### 2.3 结算面板 — Step 1：选择开单类型

```text
┌───────────────────────────────────────────────┐
│  结算面板  [●●○○○] 选择开单类型                  │
│                                               │
│  顾客：张美玲  138****8888                      │
│                                               │
│  选择开单模式：                                 │
│                                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │  正常单   │  │  促销方案  │  │  体验单   │    │
│  │ SPU/SKU  │  │  套餐开单  │  │ 仅店长   │    │
│  └──────────┘  └──────────┘  └──────────┘    │
└───────────────────────────────────────────────┘
```

**三种开单类型说明：**

| 类型 | 说明 | 商品来源 | 权限 |
|------|------|------|------|
| 正常单 | 从商品目录已选项目出单，可增删 | PG `product_spu` + WorkFine 实时价格 | 全员 |
| 促销方案 | 选择一个促销方案，项目自动填入，不可增删；`order_type` 绑定 `promotion_plan_id` | WorkFine `UDT_S_1459 / UDT_M_1460` | 全员 |
| 体验单 | 自定义金额，用于首次体验/引流 | 商品库选择 + 店长自定义金额 | 仅店长 |

选择「促销方案」后继续弹出方案列表（见 2.5），选定方案后商品行替换为方案内容。

---

### 2.4 结算面板 — Step 2：确认订单明细

```text
┌───────────────────────────────────────────────┐
│  结算面板  [●●●○○] 确认订单明细                  │
│                                               │
│  顾客：张美玲  ·  正常单                        │
│  ─────────────────────────────────────────    │
│  蜜语精华护理疗程  10次卡  x1        ¥ 3,800   │
│  明眸祛皱疗程      单品    x1        ¥ 1,200   │
│  ─────────────────────────────────────────    │
│  合计：¥ 5,000.00                             │
│                                               │
│  备注（选填）：______________________           │
│                                               │
│  [← 返回修改商品]               [下一步 →]     │
└───────────────────────────────────────────────┘
```

**交互逻辑：**
- 列表展示主视图已选商品行（可点击「返回修改商品」回到主视图调整）
- 数量可在此页微调（`+/-`），单价不可修改（体验单除外）
- 备注为选填，最多 100 字
- 点击「下一步」进入营业额分配

---

### 2.5 促销方案选择（Step 1 促销方案模式）

```text
┌───────────────────────────────────────────────┐
│  ← 开单  选择促销方案                           │
│  ─────────────────────────────────────────    │
│  [方案卡]                                      │
│  双十一焕肤套餐                    有效期至 12-31  │
│  原价 ¥ 12,800 → 促销价 ¥ 9,800  [选择]         │
│  ─────────────────────────────────────────    │
│  新客首购礼遇套餐                  有效期至 12-31  │
│  原价 ¥ 5,200  → 促销价 ¥ 3,800  [选择]         │
└───────────────────────────────────────────────┘
```

点击"选择"后进入方案详情页，展示方案内所有项目（名称、促销价、原价、是否赠品）。方案内容不可增删，确认后直接进入营业额分配步骤。

**数据来源**：WorkFine `UDT_S_1459`（有效方案）+ `UDT_M_1460`（项目明细）

---

### 2.6 结算面板 — Step 3：营业额分配（revenue-allocation）

**文件路径**：`pages/revenue-allocation/revenue-allocation.*`（独立页面，从订单详情也可访问）

**权限**：仅店长可操作

```text
┌───────────────────────────────────────────────┐
│  ← 营业额分配   订单 FY-XSD-WX-260227001        │
│  实收金额：¥ 5,000.00                           │
│  ─────────────────────────────────────────    │
│  【同部门分配】                                  │
│  部门：美容部                          [切换]    │
│                                               │
│  美容师 1：李芳芳（主）               [选择]      │
│  分成比例： [3:7]  [4:6]  [5:5]  [2:8]         │
│  分配金额：¥ 3,500                             │
│                                               │
│  美容师 2：王晓梅                    [选择]      │
│  分成比例（对应）：30%                           │
│  分配金额：¥ 1,500                             │
│                                               │
│  ─────────────────────────────────────────    │
│  【跨部门分配】（可选）                           │
│  + 添加其他部门参与分配                          │
│  （跨部门时各部门按实收¥5,000分配，总额可达2倍）   │
│                                               │
│  ─────────────────────────────────────────    │
│  本部门已分配：¥ 5,000 / 上限 ¥ 5,000   ✓       │
│                                               │
│             [保存分配方案]                      │
└───────────────────────────────────────────────┘
```

**交互规则：**
- 默认候选人：顾客指定的 `preferred_staff_wf_id` 对应美容师（已自动填入）
- 未指定时：手动从本门店全体可分配业绩员工选择
- 可分配业绩员工来源：WorkFine `UDT_S_287` + 可分配业绩字段 `is_allocatable = true`
- 比例选择：预设 3:7 / 4:6 / 5:5 / 2:8，点击选中，联动更新金额；也可手动输入具体金额
- 同部门：`SUM(allocation) <= 实收金额`，超出时实时红色警告
- 跨部门：各部门各自 `<= 实收金额`，总和可超出实收（最多 2 倍）
- 锁定提示：顾客扫码后（订单二维码状态不为"待扫码"），显示"分配已锁定，如需修改请关单后重新开单"灰底禁用态

**数据写入**：调用 `allocation.save`（`revenue_allocations` + `revenue_allocation_items`）

---

### 2.7 结算面板 — Step 4：生成订单二维码（order-qrcode）

**文件路径**：`pages/order-qrcode/order-qrcode.*`

```text
┌───────────────────────────────────────────────┐
│  ← 订单二维码   张美玲  ¥ 5,000.00              │
│                                               │
│           [ 待扫码 ] 状态                       │
│                                               │
│         ┌──────────────────┐                  │
│         │                  │                  │
│         │   [二维码图像]    │                  │
│         │                  │                  │
│         └──────────────────┘                  │
│                                               │
│  请顾客用微信扫码完成支付                        │
│  订单号：FY-XSD-WX-260227001                  │
│                                               │
│  ─────────────────────────────────────────    │
│  [确认线下收款]（店长，当顾客选择线下付款后出现）    │
│  [关闭订单]（店长权限）                         │
└───────────────────────────────────────────────┘
```

**三态展示：**

| 状态 | 说明 | 视觉 |
|------|------|------|
| 待扫码 | 订单已创建，等待顾客扫码 | 二维码正常显示，状态徽章橙色"待扫码" |
| 已扫码待付款 | 顾客已扫码，在客户端选择支付方式 | 二维码变灰半透明，状态徽章蓝色"支付中" |
| 已付款 | 支付成功 | 绿色成功图标 + "¥5,000 已支付"，隐藏二维码 |

**轮询机制**：页面激活时每 3 秒轮询一次 `order.qrcode` 接口，更新二维码状态；收到 WebSocket 推送时立即刷新。

**线下收款**：顾客在客户端选择"线下付款"后，订单状态变为`待确认收款`，页面出现"确认线下收款"大按钮（店长才能看到），点击调用 `order.confirmOffline`。

---

## 三、护理（service）

**文件路径**：`pages/service/service.*`

### 页面功能

护理 Tab 是美容师日常操作的核心入口，提供护理单的创建与状态管理，涵盖从「待服务」到「已完成」的完整服务流程。

> **预约管理说明**：预约列表不再独立占用 Tab，预约相关操作通过工作台代办区「预约待确认」条目进入，或从顾客档案页访问。

---

### 3.1 护理单列表

```text
┌───────────────────────────────────────────────┐
│  护理                                          │
│  ┌──────────┬──────────┬──────────┐           │
│  │ 待服务 2  │ 服务中 1  │ 已完成    │           │
│  └──────────┴──────────┴──────────┘           │
│                                               │
│  ┌─────────────────────────────────────────┐  │
│  │  [待服务]  HLD-WX-260227001              │  │
│  │  张美玲    蜜语精华护理疗程（10次卡）       │  │
│  │  服务时间：今天 14:00                     │  │
│  │  剩余次数：8 / 10                         │  │
│  │                           [开始服务]      │  │
│  └─────────────────────────────────────────┘  │
│                                               │
│  ┌─────────────────────────────────────────┐  │
│  │  [服务中]  HLD-WX-260227002              │  │
│  │  王芳      明眸祛皱疗程                    │  │
│  │  开始时间：13:05（进行中 42分钟）           │  │
│  │                           [确认完成]      │  │
│  └─────────────────────────────────────────┘  │
│                                               │
│                               [+ 新建护理单]   │
└───────────────────────────────────────────────┘
```

**Tab 筛选：**
- 待服务（显示数量徽章）
- 服务中（显示数量徽章）
- 已完成

**权限规则：**
- 美容师：仅可见 `assigned_staff_wf_id = 当前员工` 的护理单
- 店长：可见本店全部护理单（额外 Tab 或筛选入口）

**FAB 按钮**：右下角固定「+ 新建护理单」按钮 → 跳转 `service-create` 页（见规范 5.4）

**列表卡片字段：**
- 护理单编号（`service_orders.service_no`）
- 顾客姓名 + 脱敏手机号
- 服务项目名称 + 规格（疗程卡显示剩余次数）
- 预计服务时间 / 开始时间
- 状态徽章 + 操作按钮

**操作按钮状态矩阵：**

| 状态 | 可用操作 |
|------|---------|
| 待服务 | [开始服务] → 调用 `service.start` |
| 服务中 | [确认完成] → 弹窗确认 → 调用 `service.complete` |
| 已完成 | [查看详情] → `service-detail` |

---

### 3.2 新建护理单（快捷入口）

点击 FAB「+ 新建护理单」→ 跳转 `pages/service-create/service-create`，规范详见 **5.4 创建服务单**。

**触发场景：**
- 护理 Tab FAB 按钮（无关联预约，无 `appointment_id`）
- 预约详情页「创建服务单」按钮（携带 `appointment_id`）
- 顾客档案页「新建服务单」按钮（无 `appointment_id`）

---

### 3.3 预约管理（非 Tab 子页面）

预约相关页面保留为非 Tab 子页面，入口如下：

| 入口 | 目标页面 |
|------|---------|
| 工作台代办「预约待确认 N条」 | `pages/appointment/appointment?tab=pending` |
| 顾客档案页「预约记录」 | `pages/appointment-detail/appointment-detail` |
| 护理单详情「关联预约」 | `pages/appointment-detail/appointment-detail` |

**预约列表页**（`pages/appointment/appointment`）与**预约详情页**（`pages/appointment-detail/appointment-detail`）规范保持不变，详见原预约规范（文档内 5.x 子页面，或独立子文档）。

## 四、我的（profile）

**文件路径**：`pages/profile/profile.*`

### 页面布局

```text
┌───────────────────────────────────────────────┐
│  我的                                          │
│                                               │
│  ┌──────────────────────────────────────────┐ │
│  │  [头像占位]  李芳芳                        │ │
│  │  店长  ·  南商市场 · 凤御旗舰店             │ │
│  │  手机号：138 8888 0000                    │ │
│  └──────────────────────────────────────────┘ │
│                                               │
│  ─────────────────────────────────────────    │
│  [手机号]     138 8888 0000                    │
│  [员工编号]   WF-00123                         │
│  [所属门店]   南商市场 · 凤御旗舰店  [切换 >]   │
│                                               │
│  ─────────────────────────────────────────    │
│  [服务单管理]   我的服务单列表              >   │
│  [订单记录]     相关订单查询（仅店长）       >   │
│  [顾客档案]     顾客搜索入口               >   │
│                                               │
│  ─────────────────────────────────────────    │
│  [退出登录]                                    │
└───────────────────────────────────────────────┘
```

**门店绑定：**
- 「所属门店」行点击后弹出 `van-picker`，从 `store.list` 获取可选门店列表
- 选择后调用 `staff.bindStore`，更新 `globalData.boundStoreName`
- 所有页面读取 `app.globalData.boundStoreName` 显示当前门店

**用户信息区：**
- 头像：微信头像（`wx.getUserInfo` 获取，或占位符）
- 姓名：`staff_wechat_users.phone` 关联 WorkFine 的员工姓名
- 角色：店长 / 美容师（从 WorkFine `UDT_S_287` 职位判断）
- 门店：`staff_wf_id` 对应的门店名
- 手机号：绑定的手机号（已绑定则显示，未绑定则显示"绑定手机号"入口）

**功能入口：**

| 入口 | 跳转目标 | 权限 |
|------|---------|------|
| 所属门店 | 门店选择弹出层（`van-picker`） | 全员（切换门店） |
| 服务单管理 | `pages/service/service`（护理 Tab） | 全员 |
| 订单记录 | `order-list` | 店长（美容师不展示） |
| 顾客档案 | `customer-list` | 全员（美容师仅见相关顾客） |

**WXML 示意：**

```xml
<view class="profile-page">
  <!-- 用户信息卡片 -->
  <view class="user-card">
    <image class="avatar" src="{{avatarUrl}}" mode="aspectFill" />
    <view class="user-info">
      <text class="user-name">{{staffName}}</text>
      <view class="user-meta">
        <text class="role-tag">{{roleLabel}}</text>
        <text class="store-name">{{storeName}}</text>
      </view>
      <text class="user-phone">{{phone}}</text>
    </view>
  </view>

  <!-- 功能列表 -->
  <van-cell-group>
    <van-cell title="服务单管理" is-link bind:click="goServiceList">
      <van-icon slot="icon" name="orders-o" />
    </van-cell>
    <van-cell wx:if="{{isManager}}" title="订单记录" is-link bind:click="goOrderList">
      <van-icon slot="icon" name="records" />
    </van-cell>
    <van-cell title="顾客档案" is-link bind:click="goCustomerList">
      <van-icon slot="icon" name="friends-o" />
    </van-cell>
  </van-cell-group>

  <!-- 版本与退出 -->
  <van-cell-group style="margin-top: 32rpx;">
    <van-cell title="当前版本" value="v1.0.0" />
    <van-cell title="退出登录" bind:click="onLogout" title-class="logout-text" />
  </van-cell-group>
</view>
```

---

## 五、子页面详细规范

### 5.1 顾客档案（customer-detail）

**文件路径**：`pages/customer-detail/customer-detail.*`

**数据来源**：
- 顾客基本信息：WorkFine `UDT_S_311`（只读）
- 消费记录（日历）：PG `orders` 表（`status = 已支付`）
- 关联服务单：PG `service_orders`

```text
┌───────────────────────────────────────────────┐
│  ← 顾客档案                                    │
│                                               │
│  [基本信息区]                                   │
│  张美玲  VIP  ·  138 8888 0000（店长）          │
│  所属美容师：李芳芳   肤质：干性                  │
│  改善重点：色斑、细纹                            │
│  累计消费：¥ 128,600   本年：¥ 18,500           │
│                                               │
│  ─────────────────────────────────────────    │
│  [消费日历]（calendar-view 组件复用）            │
│  < 2026年02月 >                               │
│  ... 日历格子 ...                              │
│                                               │
│  ─────────────────────────────────────────    │
│  [订单记录]  Tab: 全部 / 待支付 / 已支付         │
│  FY-XSD-WX-260205001  ¥3,200  已支付  02-05 > │
│  FY-XSD-WX-260120002  ¥5,000  已支付  01-20 > │
│                                               │
│  ─────────────────────────────────────────    │
│  [预约记录]                                    │
│  2026-02-27 14:00  蜜语精华护理疗程  已确认  >   │
└───────────────────────────────────────────────┘
```

**数据权限：**
- 店长：可见完整手机号、完整消费历史
- 美容师：手机号脱敏（`138****8888`），仅可见分配给自己的服务相关顾客

---

### 5.2 服务单列表（service-list）

> **注**：护理单列表现已作为独立 Tab 页实现，文件路径已更新为 `pages/service/service.*`（见 **三、护理**）。本节 WXML/布局规范作为设计参考保留。

**文件路径**：`pages/service/service.*`（护理 Tab 主页）

```text
┌───────────────────────────────────────────────┐
│  服务单                                         │
│  ┌──────────┬──────────┬──────────┐           │
│  │ 分配给我  │ 待服务 2  │ 服务中 1  │           │
│  └──────────┴──────────┴──────────┘           │
│                                               │
│  ┌─────────────────────────────────────────┐  │
│  │  [待服务]  HLD-WX-260227001              │  │
│  │  张美玲    蜜语精华护理疗程（10次卡）       │  │
│  │  服务时间：今天 14:00                     │  │
│  │  剩余次数：8 / 10                         │  │
│  │                           [开始服务]      │  │
│  └─────────────────────────────────────────┘  │
│                                               │
│  ┌─────────────────────────────────────────┐  │
│  │  [服务中]  HLD-WX-260227002              │  │
│  │  王芳      明眸祛皱疗程                    │  │
│  │  开始时间：13:05（进行中 42分钟）           │  │
│  │                           [确认完成]      │  │
│  └─────────────────────────────────────────┘  │
└───────────────────────────────────────────────┘
```

**Tab 筛选：**
- 分配给我（`assigned_staff_wf_id = 当前员工`）
- 待服务 / 服务中 / 已完成（状态筛选）
- 店长额外：本店全部

---

### 5.3 服务单详情（service-detail）

**文件路径**：`pages/service-detail/service-detail.*`

```text
┌───────────────────────────────────────────────┐
│  ← 服务单详情   HLD-WX-260227001      [待服务]  │
│                                               │
│  顾客：张美玲                                   │
│  服务人员：李芳芳                               │
│  服务日期：2026-02-27                          │
│                                               │
│  ─────────────────────────────────────────    │
│  核销明细                                      │
│  蜜语精华护理疗程（10次卡）                      │
│  本次核销：1 次   剩余：7 / 10                  │
│  流水号：XSLSH-WX-20260205001                  │
│                                               │
│  ─────────────────────────────────────────    │
│  关联预约：2026-02-27 14:00（已确认）  [查看]    │
│                                               │
│                    [开始服务]                   │
└───────────────────────────────────────────────┘
```

**状态操作按钮：**
- 待服务：[开始服务] → 调用 `service.start`
- 服务中：[确认完成] → 弹窗确认 → 调用 `service.complete`（幂等，扣减疗程次数）
- 次数不足时 `service.complete` 返回错误：toast 提示"该订单行剩余次数不足，无法完成核销"

---

### 5.4 创建服务单（service-create）

**文件路径**：`pages/service-create/service-create.*`

**触发入口**：
1. 预约详情页 → [创建服务单]（携带 `appointment_id`）
2. 顾客档案页 → [新建服务单]（无 `appointment_id`）

```text
┌───────────────────────────────────────────────┐
│  ← 创建服务单                                   │
│                                               │
│  顾客：张美玲（已自动填入，来自预约）              │
│                                               │
│  关联预约（可选）：                              │
│  2026-02-27 14:00  蜜语精华护理疗程  [已选中 ×] │
│                                               │
│  选择核销订单行：                               │
│  ─────────────────────────────────────────    │
│  FY-XSD-WX-260205001  已支付  02-05            │
│  ├─ 蜜语精华护理疗程（10次卡）  剩余 8次   [选择]  │
│  └─ 安吉丽眼部护理（单品）   剩余 1次   [选择]   │
│  ─────────────────────────────────────────    │
│  FY-XSD-WX-260120002  已支付  01-20            │
│  └─ 眉眼提升疗程（20次卡）   剩余 15次   [选择]  │
│                                               │
│  已选核销项目：                                 │
│  ✓ 蜜语精华护理疗程  本次核销 1 次              │
│                                               │
│  服务人员：李芳芳（自动，可更改）                  │
│  备注（选填）：___________________________     │
│                                               │
│                [提交服务单]                     │
└───────────────────────────────────────────────┘
```

**规则说明：**
- `appointment_id`：可选，有预约则关联；一条预约只能关联一张服务单
- `order_no`：必须关联至少一个已支付订单行（`remaining_sessions >= 1`）；如顾客无已支付订单，引导"请先开单"
- 院装产品行（`product_type = 院装产品`）不在核销选项中出现（支付即完成，无核销）

---

### 5.5 订单列表（order-list）

**文件路径**：`pages/order-list/order-list.*`（仅店长可访问）

```text
┌───────────────────────────────────────────────┐
│  订单记录                  [搜索] [日期筛选]     │
│  ┌──────┬──────┬──────┬──────┐               │
│  │ 全部  │待支付 │待确认 │已支付 │               │
│  └──────┴──────┴──────┴──────┘               │
│                                               │
│  ┌─────────────────────────────────────────┐  │
│  │  [待确认收款]                             │  │
│  │  张美玲  FY-XSD-WX-260227001  ¥5,000    │  │
│  │  员工开单 · 线下付款 · 02-27 13:45        │  │
│  │                        [确认收款] [关闭]  │  │
│  └─────────────────────────────────────────┘  │
│                                               │
│  ┌─────────────────────────────────────────┐  │
│  │  [已支付]                                │  │
│  │  王芳    FY-XSD-WX-260205001  ¥3,200    │  │
│  │  顾客自助 · 微信支付 · 02-05 14:32        │  │
│  │                              [查看详情]  │  │
│  └─────────────────────────────────────────┘  │
└───────────────────────────────────────────────┘
```

---

### 5.6 订单详情（order-detail）

**文件路径**：`pages/order-detail/order-detail.*`

```text
┌───────────────────────────────────────────────┐
│  ← 订单详情   FY-XSD-WX-260227001   [已支付]    │
│                                               │
│  顾客：张美玲    138 8888 0000                 │
│  下单方式：员工开单    下单人：王店长              │
│  支付方式：线下收款    确认人：王店长              │
│  支付时间：2026-02-27 14:12                   │
│                                               │
│  ─────────────────────────────────────────    │
│  订单明细                                      │
│  蜜语精华护理疗程  10次卡  x1                   │
│    原价 ¥3,800  实收 ¥3,800  剩余次数 8/10     │
│  安吉丽美颜之爱  单品  x1                       │
│    原价 ¥1,200  实收 ¥1,200  剩余次数 1/1      │
│  ─────────────────────────────────────────    │
│  合计：¥5,000.00                              │
│                                               │
│  ─────────────────────────────────────────    │
│  营业额分配（仅店长可见）                        │
│  李芳芳（美容部）  ¥3,500 · 70%                │
│  王晓梅（美容部）  ¥1,500 · 30%                │
│           [重新分配]（仅待扫码状态可用）          │
│                                               │
│  ─────────────────────────────────────────    │
│  [重置支付失败]（仅支付失败状态，店长可见）         │
└───────────────────────────────────────────────┘
```

---

## 六、通用组件规范

### 6.1 状态徽章（status-tag）

```css
/* 状态徽章通用样式 */
.status-tag {
  display: inline-flex;
  align-items: center;
  padding: 4rpx 16rpx;
  border-radius: 24rpx;
  font-size: 22rpx;
  font-weight: 500;
}
.status-tag--pending  { background: var(--color-badge-pending);  color: #D4820A; }
.status-tag--success  { background: var(--color-badge-confirmed); color: #3D8A5A; }
.status-tag--progress { background: var(--color-badge-progress);  color: #5E8BB3; }
.status-tag--done     { background: var(--color-badge-done);      color: #888888; }
.status-tag--error    { background: var(--color-badge-error);     color: #D94040; }
```

**状态文字映射：**

| 数据值 | 显示文字 | 样式类 |
|--------|---------|--------|
| 待支付 | 待支付 | pending |
| 待确认收款 | 待确认收款 | pending |
| 已支付 | 已支付 | success |
| 已完成 | 已完成 | done |
| 支付失败 | 支付失败 | error |
| 已关闭 | 已关闭 | done |
| 待服务 | 待服务 | pending |
| 服务中 | 服务中 | progress |
| 已确认 | 已确认 | success |
| 已取消 | 已取消 | done |

---

### 6.2 顾客消费日历（calendar-view）组件

**文件路径**：`components/calendar-view/calendar-view.*`

**用途**：在「顾客档案」页（`customer-detail`）展示该顾客的消费历史日历。工作台中的月度业绩日历直接内联在工作台页面，不使用此组件。

**Props：**

```typescript
Component({
  properties: {
    clientUserId: { type: String },   // 顾客 user_id
    defaultMonth: { type: String },   // 'YYYY-MM'，默认当月
    realtime: { type: Boolean, value: true } // 是否开启 WebSocket 实时更新
  }
})
```

**数据加载**：组件内部调用 `customer.calendar`，参数 `{ client_user_id, year_month }`，返回当月每日汇总金额数组。

**实时更新**：通过 `realtime.ts` 监听 WebSocket 事件 `order.paid`，事件触发时重新拉取当月日历数据。

---

### 6.3 角色权限守卫（role-guard）组件

**文件路径**：`components/role-guard/role-guard.*`

```xml
<!-- 使用示例：包裹仅店长可见的内容 -->
<role-guard required-role="manager">
  <view slot="content">
    <!-- 店长专属内容 -->
  </view>
  <view slot="fallback">
    <van-empty description="暂无权限" />
  </view>
</role-guard>
```

---

### 6.4 二维码展示（qrcode-display）组件

**文件路径**：`components/qrcode-display/qrcode-display.*`

**Props：**

```typescript
properties: {
  orderNo: { type: String },  // 订单号，用于轮询
  qrcodeUrl: { type: String }, // 初始二维码图片 URL
  status: { type: String }    // 待扫码 / 已扫码待付款 / 已付款
}
```

---

## 七、页面路由汇总

| 页面 | 路径 | Tab | 权限 |
|------|------|-----|------|
| 工作台 | `pages/workbench/workbench` | ✓ | 全员 |
| 开单 | `pages/order-create/order-create` | ✓ | 全员（店长审批） |
| 订单二维码 | `pages/order-qrcode/order-qrcode` | — | 全员 |
| 订单列表 | `pages/order-list/order-list` | — | 仅店长 |
| 订单详情 | `pages/order-detail/order-detail` | — | 仅店长 |
| 营业额分配 | `pages/revenue-allocation/revenue-allocation` | — | 仅店长 |
| 护理 | `pages/service/service` | ✓ | 全员 |
| 服务单详情 | `pages/service-detail/service-detail` | — | 全员（权限过滤） |
| 创建服务单 | `pages/service-create/service-create` | — | 全员（权限过滤） |
| 预约列表 | `pages/appointment/appointment` | — | 全员（权限过滤） |
| 预约详情 | `pages/appointment-detail/appointment-detail` | — | 全员（权限过滤） |
| 顾客列表 | `pages/customer-list/customer-list` | — | 全员（权限过滤） |
| 顾客档案 | `pages/customer-detail/customer-detail` | — | 全员（权限过滤） |
| 我的 | `pages/profile/profile` | ✓ | 全员 |

---

## 八、权限控制汇总

| 功能 | 店长 | 美容师 |
|------|------|-------|
| 进入开单Tab | ✓ | ✓（提交后需店长审批）|
| 选择体验单类型 | ✓ | ✗（不显示该选项）|
| 查看完整手机号 | ✓ | ✗（脱敏）|
| 确认线下收款 | ✓ | ✗ |
| 关闭订单 | ✓ | ✗ |
| 重置支付失败 | ✓ | ✗ |
| 营业额分配 | ✓ | ✗ |
| 查看本店全部服务单 | ✓ | ✗（仅分配给自己）|
| 查看全部预约 | ✓ | ✗（仅自己相关）|
| 确认预约 | ✓ | ✓（被预约者）|
| 创建/推进服务单 | ✓ | ✓（被分配者）|
| 查看顾客档案 | ✓（全店）| ✓（相关顾客）|
| 今日门店营收 | ✓ | ✗ |
| 绑定/切换门店 | ✓ | ✓ |

---

## 九、实时通信集成要点

**场景**：顾客在客户端完成支付后，员工端工作台日历需在 5 秒内更新。

**实现方案**：

```typescript
// utils/realtime.ts 使用方式（工作台页面）
import { subscribe, unsubscribe } from '../../utils/realtime'

Page({
  onShow() {
    subscribe('order.paid', (data) => {
      // 收到支付通知，刷新日历和今日分成
      this.calendarView?.refresh()
      this.loadTodayCommission()
    })
  },
  onHide() {
    unsubscribe('order.paid')
  }
})
```

**降级策略**：WebSocket 断连时，`realtime.ts` 自动切换为每 30 秒轮询 `customer.calendar`，保证最终一致性。

---

## 十、MVP 实现优先级

| 优先级 | 模块 | 关键功能 |
|--------|------|---------|
| P0 | 登录 + 手机号绑定 | 员工端 auth 流程 |
| P0 | 工作台 - 今日分成 | 营业额分配汇总 |
| P0 | 工作台 - 顾客日历 | `customer.calendar` + 实时推送 |
| P0 | 工作台 - 代办事项 | 待确认预约数 + 待推进服务单数 |
| P0 | 开单完整流程 | 选顾客→选商品→分配→二维码 |
| P0 | 营业额分配 | 同部门 / 跨部门分配 |
| P0 | 订单二维码 + 确认收款 | 扫码状态轮询 + 线下收款确认 |
| P1 | 预约管理 | 确认预约 + 顾客到店签到 |
| P1 | 服务单 CRUD | 创建 + 开始 + 完成（扣减次数）|
| P1 | 顾客档案 + 日历 | 搜索顾客 + 查看消费日历 |
| P2 | 订单列表 / 详情 | 完整订单查询 |
| P2 | 促销方案开单 | WorkFine 促销方案读取 |
