# Vant Weapp 组件速查

> 完整 API 请通过 Context7 查询：`libraryId: /youzan/vant-weapp`

---

## 组件注册路径速查

每个使用 Vant 组件的页面/组件，必须在 `.json` 的 `usingComponents` 中声明。
路径格式：`@vant/weapp/{组件名}/index`

### 表单组件

| 组件 | 注册路径 |
|------|----------|
| Field | `@vant/weapp/field/index` |
| Picker | `@vant/weapp/picker/index` |
| DatetimePicker | `@vant/weapp/datetime-picker/index` |
| Calendar | `@vant/weapp/calendar/index` |
| Radio | `@vant/weapp/radio/index` |
| RadioGroup | `@vant/weapp/radio-group/index` |
| Checkbox | `@vant/weapp/checkbox/index` |
| CheckboxGroup | `@vant/weapp/checkbox-group/index` |
| Stepper | `@vant/weapp/stepper/index` |
| Search | `@vant/weapp/search/index` |
| Switch | `@vant/weapp/switch/index` |
| Rate | `@vant/weapp/rate/index` |
| Slider | `@vant/weapp/slider/index` |
| Uploader | `@vant/weapp/uploader/index` |

### 反馈组件

| 组件 | 注册路径 |
|------|----------|
| Button | `@vant/weapp/button/index` |
| Toast | `@vant/weapp/toast/index` |
| Dialog | `@vant/weapp/dialog/index` |
| ActionSheet | `@vant/weapp/action-sheet/index` |
| Popup | `@vant/weapp/popup/index` |
| SwipeCell | `@vant/weapp/swipe-cell/index` |
| Loading | `@vant/weapp/loading/index` |
| Overlay | `@vant/weapp/overlay/index` |
| Notify | `@vant/weapp/notify/index` |
| SubmitBar | `@vant/weapp/submit-bar/index` |

### 导航组件

| 组件 | 注册路径 |
|------|----------|
| Tabs / Tab | `@vant/weapp/tabs/index`, `@vant/weapp/tab/index` |
| NavBar | `@vant/weapp/nav-bar/index` |
| Sidebar / SidebarItem | `@vant/weapp/sidebar/index`, `@vant/weapp/sidebar-item/index` |
| Tabbar / TabbarItem | `@vant/weapp/tabbar/index`, `@vant/weapp/tabbar-item/index` |
| TreeSelect | `@vant/weapp/tree-select/index` |
| IndexBar / IndexAnchor | `@vant/weapp/index-bar/index`, `@vant/weapp/index-anchor/index` |

### 展示组件

| 组件 | 注册路径 |
|------|----------|
| Cell / CellGroup | `@vant/weapp/cell/index`, `@vant/weapp/cell-group/index` |
| Card | `@vant/weapp/card/index` |
| Grid / GridItem | `@vant/weapp/grid/index`, `@vant/weapp/grid-item/index` |
| Tag | `@vant/weapp/tag/index` |
| Icon | `@vant/weapp/icon/index` |
| Image | `@vant/weapp/image/index` |
| Empty | `@vant/weapp/empty/index` |
| Skeleton | `@vant/weapp/skeleton/index` |
| NoticeBar | `@vant/weapp/notice-bar/index` |
| Divider | `@vant/weapp/divider/index` |
| Steps | `@vant/weapp/steps/index` |
| Progress | `@vant/weapp/progress/index` |
| Collapse / CollapseItem | `@vant/weapp/collapse/index`, `@vant/weapp/collapse-item/index` |
| CountDown | `@vant/weapp/count-down/index` |

### 布局/配置组件

| 组件 | 注册路径 |
|------|----------|
| ConfigProvider | `@vant/weapp/config-provider/index` |
| Sticky | `@vant/weapp/sticky/index` |
| Row / Col | `@vant/weapp/row/index`, `@vant/weapp/col/index` |
| Transition | `@vant/weapp/transition/index` |

---

## 表单组件

### Field 输入框

| Props | 类型 | 说明 |
|-------|------|------|
| value | `string` | 输入值 |
| model:value | `string` | 双向绑定（基础库 >= 2.9.3） |
| type | `text / number / idcard / digit / textarea / password` | 输入类型 |
| label | `string` | 左侧标签 |
| placeholder | `string` | 占位提示 |
| required | `boolean` | 必填标记 |
| clearable | `boolean` | 清除按钮 |
| maxlength | `number` | 最大长度 |
| show-word-limit | `boolean` | 字数统计 |
| error | `boolean` | 错误状态 |
| error-message | `string` | 错误提示 |
| autosize | `boolean / object` | 自适应高度（textarea） |
| use-button-slot | `boolean` | 启用按钮插槽 |

| Events | 说明 |
|--------|------|
| bind:change | 值变化 |
| bind:focus | 聚焦 |
| bind:blur | 失焦 |
| bind:clear | 清除 |
| bind:click-icon | 点击右图标 |

| Slots | 说明 |
|-------|------|
| button | 右侧按钮（需 `use-button-slot`） |
| left-icon | 左侧图标 |
| right-icon | 右侧图标 |

### Radio 单选框

| Props | 类型 | 说明 |
|-------|------|------|
| name | `string` | 标识符 |
| shape | `round / square` | 形状 |
| disabled | `boolean` | 禁用 |
| checked-color | `string` | 选中颜色 |
| icon-size | `string / number` | 图标大小 |

**RadioGroup：**

| Props | 类型 | 说明 |
|-------|------|------|
| value | `string` | 当前选中值 |
| direction | `horizontal / vertical` | 排列方向 |
| disabled | `boolean` | 全部禁用 |

| Events | 说明 |
|--------|------|
| bind:change | 选中值变化，e.detail 为选中的 name |

### Checkbox 复选框

| Props | 类型 | 说明 |
|-------|------|------|
| name | `string` | 标识符 |
| shape | `round / square` | 形状 |
| disabled | `boolean` | 禁用 |
| checked-color | `string` | 选中颜色 |
| icon-size | `string / number` | 图标大小 |

**CheckboxGroup：**

| Props | 类型 | 说明 |
|-------|------|------|
| value | `string[]` | 当前选中值 |
| direction | `horizontal / vertical` | 排列方向 |
| max | `number` | 最大可选数 |
| disabled | `boolean` | 全部禁用 |

| Events | 说明 |
|--------|------|
| bind:change | 选中值变化，e.detail 为 string[] |

### Picker 选择器

| Props | 类型 | 说明 |
|-------|------|------|
| columns | `Column[]` | 列数据 |
| show-toolbar | `boolean` | 显示顶部栏 |
| title | `string` | 标题 |
| confirm-button-text | `string` | 确认按钮文字 |
| cancel-button-text | `string` | 取消按钮文字 |
| default-index | `number` | 默认选中索引 |

| Events | 说明 |
|--------|------|
| bind:confirm | 确认选择 |
| bind:cancel | 取消 |
| bind:change | 列变化 |

### Stepper 步进器

| Props | 类型 | 说明 |
|-------|------|------|
| value | `number` | 当前值 |
| min | `number` | 最小值 |
| max | `number` | 最大值 |
| step | `number` | 步长 |
| integer | `boolean` | 只允许整数 |
| disabled | `boolean` | 禁用 |
| input-width | `string` | 输入框宽度 |

| Events | 说明 |
|--------|------|
| bind:change | 值变化，e.detail 为 number |

### Search 搜索

| Props | 类型 | 说明 |
|-------|------|------|
| value | `string` | 搜索值 |
| placeholder | `string` | 占位文字 |
| show-action | `boolean` | 显示取消按钮 |
| action-text | `string` | 取消按钮文字 |
| shape | `round / square` | 搜索框形状 |

| Events | 说明 |
|--------|------|
| bind:search | 确认搜索 |
| bind:change | 值变化 |
| bind:cancel | 取消 |
| bind:focus | 聚焦 |
| bind:blur | 失焦 |

### Switch 开关

| Props | 类型 | 说明 |
|-------|------|------|
| checked | `boolean` | 开关状态 |
| size | `string` | 尺寸 |
| active-color | `string` | 打开颜色 |
| inactive-color | `string` | 关闭颜色 |
| disabled | `boolean` | 禁用 |

| Events | 说明 |
|--------|------|
| bind:change | 状态变化 |

---

## 反馈组件

### Button 按钮

| Props | 类型 | 说明 |
|-------|------|------|
| type | `primary / info / warning / danger / default` | 按钮类型 |
| size | `large / normal / small / mini` | 按钮尺寸 |
| round | `boolean` | 圆角按钮 |
| plain | `boolean` | 朴素按钮 |
| block | `boolean` | 块级按钮 |
| loading | `boolean` | 加载状态 |
| disabled | `boolean` | 禁用状态 |
| open-type | `string` | 微信开放能力 |

| Events | 说明 |
|--------|------|
| bind:click | 点击事件 |
| bind:getuserinfo | 获取用户信息 |
| bind:getphonenumber | 获取手机号 |

### Popup 弹出层

| Props | 类型 | 说明 |
|-------|------|------|
| show | `boolean` | 是否显示 |
| position | `top / bottom / left / right / center` | 弹出位置 |
| round | `boolean` | 圆角 |
| closeable | `boolean` | 关闭按钮 |
| overlay | `boolean` | 遮罩层 |
| close-on-click-overlay | `boolean` | 点击遮罩关闭 |
| safe-area-inset-bottom | `boolean` | 底部安全区 |

| Events | 说明 |
|--------|------|
| bind:close | 关闭 |
| bind:click-overlay | 点击遮罩 |

### ActionSheet 动作面板

| Props | 类型 | 说明 |
|-------|------|------|
| show | `boolean` | 是否显示 |
| actions | `Action[]` | 选项列表 |
| title | `string` | 标题 |
| description | `string` | 描述 |
| cancel-text | `string` | 取消按钮文字 |
| close-on-click-overlay | `boolean` | 点击遮罩关闭 |
| close-on-click-action | `boolean` | 点击选项后关闭 |
| safe-area-inset-bottom | `boolean` | 底部安全区 |

| Events | 说明 |
|--------|------|
| bind:select | 选中选项 |
| bind:close | 关闭 |
| bind:cancel | 取消 |

### SwipeCell 滑动单元格

| Props | 类型 | 说明 |
|-------|------|------|
| left-width | `number` | 左侧宽度（px） |
| right-width | `number` | 右侧宽度（px） |
| disabled | `boolean` | 禁用 |
| name | `string` | 标识符 |

| Events | 说明 |
|--------|------|
| bind:open | 打开时，e.detail: `{ position, name }` |
| bind:close | 关闭时，e.detail: `{ position, name }` |

| Slots | 说明 |
|-------|------|
| left | 左侧内容 |
| right | 右侧内容 |

### Loading 加载

| Props | 类型 | 说明 |
|-------|------|------|
| color | `string` | 颜色 |
| type | `circular / spinner` | 类型 |
| size | `string` | 大小 |
| vertical | `boolean` | 垂直排列 |

### SubmitBar 提交订单栏

| Props | 类型 | 说明 |
|-------|------|------|
| price | `number` | ⚠️ **单位为分**，传入 100 显示 ¥1.00 |
| label | `string` | 价格左侧文案 |
| button-text | `string` | 按钮文字 |
| disabled | `boolean` | 禁用按钮 |
| loading | `boolean` | 按钮加载状态 |
| tip | `boolean / string` | 提示文案 |
| safe-area-inset-bottom | `boolean` | 底部安全区 |

| Events | 说明 |
|--------|------|
| bind:submit | 点击提交按钮 |

---

## 导航组件

### Tabs 标签页

| Props | 类型 | 说明 |
|-------|------|------|
| active | `string / number` | 当前选中 |
| type | `line / card` | 样式类型 |
| color | `string` | 标签颜色 |
| sticky | `boolean` | 粘性定位 |
| swipeable | `boolean` | 手势滑动切换 |
| animated | `boolean` | 切换动画 |

| Events | 说明 |
|--------|------|
| bind:change | 切换标签，e.detail: `{ name, title, index }` |
| bind:click | 点击标签 |

### Sidebar 侧边导航

| Props | 类型 | 说明 |
|-------|------|------|
| activeKey | `number` | 当前选中索引 |

**SidebarItem：**

| Props | 类型 | 说明 |
|-------|------|------|
| title | `string` | 标题 |
| dot | `boolean` | 红点 |
| badge | `string / number` | 徽标 |
| disabled | `boolean` | 禁用 |

| Events | 说明 |
|--------|------|
| bind:change | 切换选中，e.detail 为索引 |

### NavBar 导航栏

| Props | 类型 | 说明 |
|-------|------|------|
| title | `string` | 标题 |
| left-text | `string` | 左侧文案 |
| right-text | `string` | 右侧文案 |
| left-arrow | `boolean` | 左侧箭头 |
| fixed | `boolean` | 固定顶部 |
| placeholder | `boolean` | 固定时占位 |
| border | `boolean` | 下边框 |

| Events | 说明 |
|--------|------|
| bind:click-left | 点击左侧 |
| bind:click-right | 点击右侧 |

---

## 展示组件

### Cell 单元格

| Props | 类型 | 说明 |
|-------|------|------|
| title | `string` | 左侧标题 |
| value | `string` | 右侧内容 |
| label | `string` | 标题下方描述 |
| icon | `string` | 左侧图标 |
| is-link | `boolean` | 展示箭头 |
| url | `string` | 跳转链接 |
| link-type | `navigateTo / redirectTo / switchTab / reLaunch` | 跳转类型 |
| clickable | `boolean` | 点击反馈 |

| External Classes | 说明 |
|-----------------|------|
| custom-class | 根节点 |
| title-class | 标题 |
| label-class | 描述 |
| value-class | 内容 |

### Card 商品卡片

| Props | 类型 | 说明 |
|-------|------|------|
| thumb | `string` | 图片 |
| title | `string` | 标题 |
| desc | `string` | 描述 |
| price | `string / number` | 价格 |
| num | `string / number` | 数量 |
| tag | `string` | 标签 |
| currency | `string` | 货币符号，默认 ¥ |
| lazy-load | `boolean` | 图片懒加载 |

| Slots | 说明 |
|-------|------|
| title | 标题 |
| desc | 描述 |
| thumb | 图片 |
| footer | 底部 |
| tags | 标签 |

### Empty 空状态

| Props | 类型 | 说明 |
|-------|------|------|
| image | `default / error / network / search / string` | 图片类型或 URL |
| description | `string` | 描述文字 |

| Slots | 说明 |
|-------|------|
| default | 底部内容 |
| image | 自定义图片 |
| description | 自定义描述 |

### Skeleton 骨架屏

| Props | 类型 | 说明 |
|-------|------|------|
| row | `number` | 段落行数 |
| title | `boolean` | 标题占位 |
| avatar | `boolean` | 头像占位 |
| loading | `boolean` | 是否显示骨架屏 |
| animate | `boolean` | 是否开启动画 |

### Tag 标签

| Props | 类型 | 说明 |
|-------|------|------|
| type | `default / primary / success / danger / warning` | 类型 |
| plain | `boolean` | 空心样式 |
| round | `boolean` | 圆角 |
| mark | `boolean` | 标记样式 |
| closeable | `boolean` | 可关闭 |
| size | `medium / large` | 尺寸 |
| color | `string` | 自定义颜色 |

| Events | 说明 |
|--------|------|
| bind:close | 关闭（closeable 时） |

### Grid 宫格

| Props | 类型 | 说明 |
|-------|------|------|
| column-num | `number` | 列数 |
| border | `boolean` | 边框 |
| gutter | `string / number` | 间距 |
| square | `boolean` | 正方形 |
| clickable | `boolean` | 点击反馈 |

**GridItem：**

| Props | 类型 | 说明 |
|-------|------|------|
| text | `string` | 文字 |
| icon | `string` | 图标 |
| url | `string` | 跳转链接 |

### NoticeBar 通知栏

| Props | 类型 | 说明 |
|-------|------|------|
| text | `string` | 通知文字 |
| mode | `closeable / link` | 模式 |
| left-icon | `string` | 左侧图标 |
| scrollable | `boolean` | 是否滚动 |
| wrapable | `boolean` | 是否换行 |

### Icon 图标

| Props | 类型 | 说明 |
|-------|------|------|
| name | `string` | 图标名称 |
| size | `string / number` | 大小 |
| color | `string` | 颜色 |
| dot | `boolean` | 红点 |
| info | `string / number` | 徽标 |
