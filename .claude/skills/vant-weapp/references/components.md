# Vant Weapp 组件 API 速查

> 本文件列出项目常用组件的关键 Props/Events/Slots，完整 API 请通过 Context7 查询：
> `libraryId: /youzan/vant-weapp`

## Button 按钮

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

## Cell 单元格

| Props | 类型 | 说明 |
|-------|------|------|
| title | `string` | 左侧标题 |
| value | `string` | 右侧内容 |
| label | `string` | 标题下方描述 |
| icon | `string` | 左侧图标 |
| is-link | `boolean` | 展示箭头 |
| url | `string` | 跳转链接 |
| link-type | `navigateTo / redirectTo / switchTab / reLaunch` | 跳转类型 |

| External Classes | 说明 |
|-----------------|------|
| custom-class | 根节点 |
| title-class | 标题 |
| label-class | 描述 |
| value-class | 内容 |

## Field 输入框

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

## Popup 弹出层

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

## Tabs 标签页

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
| bind:change | 切换标签 |
| bind:click | 点击标签 |

## Card 商品卡片

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

## Dialog 对话框

### 命令式调用

```javascript
import Dialog from '@vant/weapp/dialog/dialog';

// 提示
Dialog.alert({ title: '标题', message: '内容' });

// 确认
Dialog.confirm({ title: '标题', message: '内容' });

// 关闭
Dialog.close();
```

### 组件式调用

```html
<van-dialog
  use-slot
  title="标题"
  show="{{ showDialog }}"
  bind:close="onCloseDialog"
  bind:confirm="onConfirmDialog"
>
  <view>自定义内容</view>
</van-dialog>
```

## Toast 轻提示

```javascript
import Toast from '@vant/weapp/toast/toast';

Toast('文字提示');
Toast.success('成功');
Toast.fail('失败');
Toast.loading({ message: '加载中...', forbidClick: true, duration: 0 });
Toast.clear();
```

## ActionSheet 动作面板

```html
<van-action-sheet
  show="{{ showActions }}"
  actions="{{ actions }}"
  cancel-text="取消"
  bind:close="onCloseActions"
  bind:select="onSelectAction"
  bind:cancel="onCancelActions"
/>
```

```javascript
Page({
  data: {
    actions: [
      { name: '选项一' },
      { name: '选项二' },
      { name: '选项三', subname: '描述信息', color: '#ee0a24' }
    ]
  }
});
```

## Calendar 日历

```html
<van-calendar
  show="{{ showCalendar }}"
  type="single"
  bind:close="onCloseCalendar"
  bind:confirm="onConfirmCalendar"
/>
```

type 可选值：`single`（单选）、`multiple`（多选）、`range`（区间）

## Search 搜索

```html
<van-search
  value="{{ searchValue }}"
  placeholder="请输入搜索关键词"
  show-action
  bind:search="onSearch"
  bind:cancel="onCancel"
  bind:change="onSearchChange"
/>
```

## Empty 空状态

```html
<van-empty description="暂无数据" />
<van-empty image="search" description="没有找到相关内容" />
<van-empty image="network" description="网络错误">
  <van-button round type="danger" class="bottom-button">重新加载</van-button>
</van-empty>
```

image 内置值：`default`、`error`、`network`、`search`

## Grid 宫格

```html
<van-grid column-num="4" border="{{ false }}">
  <van-grid-item icon="photo-o" text="文字" bind:click="onClickGrid" />
  <van-grid-item icon="photo-o" text="文字" />
</van-grid>
```

## Skeleton 骨架屏

```html
<van-skeleton title avatar row="3" loading="{{ isLoading }}">
  <view>实际内容</view>
</van-skeleton>
```

## NoticeBar 通知栏

```html
<van-notice-bar
  left-icon="volume-o"
  text="通知内容"
  mode="closeable"
  scrollable
/>
```

## Stepper 步进器

```html
<van-stepper value="{{ count }}" min="1" max="99" bind:change="onStepperChange" />
```

## Tag 标签

```html
<van-tag type="primary">标签</van-tag>
<van-tag type="success" plain>标签</van-tag>
<van-tag type="danger" round>标签</van-tag>
<van-tag type="warning" closeable bind:close="onCloseTag">标签</van-tag>
```

type 可选值：`default`、`primary`、`success`、`danger`、`warning`
