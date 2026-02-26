# Vant Weapp TypeScript 类型支持

## 方式一：npm 包（推荐）

社区维护的类型声明包 `vant-weapp-typings`，覆盖 @vant/weapp 1.x 全部组件：

```bash
npm i vant-weapp-typings -D
```

安装后即可获得 Toast、Dialog、Notify 等命令式 API 的类型提示。

> **注意**：该包最后更新于 2022-09，若遇到新增 API 类型缺失，用方式二补充。

## 方式二：手动声明（补充用）

若 `vant-weapp-typings` 未覆盖某些 API，在项目 `typings/vant-weapp.d.ts` 中补充：

```typescript
// typings/vant-weapp.d.ts

// ============ Toast ============
declare module '@vant/weapp/toast/toast' {
  interface ToastOptions {
    message?: string
    type?: 'text' | 'loading' | 'success' | 'fail'
    duration?: number
    mask?: boolean
    forbidClick?: boolean
    zIndex?: number
    position?: 'top' | 'middle' | 'bottom'
    selector?: string
    context?: WechatMiniprogram.Page.TrivialInstance | WechatMiniprogram.Component.TrivialInstance
    onClose?: () => void
  }

  interface ToastStatic {
    (options: string | ToastOptions): void
    success(options: string | ToastOptions): void
    fail(options: string | ToastOptions): void
    loading(options: string | ToastOptions): void
    clear(): void
    setDefaultOptions(options: Partial<ToastOptions>): void
    resetDefaultOptions(): void
  }

  const Toast: ToastStatic
  export default Toast
}

// ============ Dialog ============
declare module '@vant/weapp/dialog/dialog' {
  interface DialogOptions {
    title?: string
    message?: string
    width?: string | number
    theme?: 'default' | 'round-button'
    messageAlign?: 'left' | 'center' | 'right'
    zIndex?: number
    className?: string
    customStyle?: string
    showConfirmButton?: boolean
    showCancelButton?: boolean
    confirmButtonText?: string
    cancelButtonText?: string
    confirmButtonColor?: string
    cancelButtonColor?: string
    overlay?: boolean
    overlayStyle?: string
    closeOnClickOverlay?: boolean
    selector?: string
    context?: WechatMiniprogram.Page.TrivialInstance | WechatMiniprogram.Component.TrivialInstance
    transition?: string
    beforeClose?: (action: 'confirm' | 'cancel') => boolean | Promise<boolean>
  }

  interface DialogStatic {
    (options: DialogOptions): Promise<'confirm'>
    alert(options: DialogOptions): Promise<'confirm'>
    confirm(options: DialogOptions): Promise<'confirm'>
    close(): void
    stopLoading(): void
    setDefaultOptions(options: Partial<DialogOptions>): void
    resetDefaultOptions(): void
  }

  const Dialog: DialogStatic
  export default Dialog
}

// ============ Notify ============
declare module '@vant/weapp/notify/notify' {
  interface NotifyOptions {
    message?: string
    type?: 'primary' | 'success' | 'danger' | 'warning'
    duration?: number
    color?: string
    background?: string
    top?: number
    zIndex?: number
    safeAreaInsetTop?: boolean
    selector?: string
    context?: WechatMiniprogram.Page.TrivialInstance | WechatMiniprogram.Component.TrivialInstance
    onClick?: () => void
    onOpened?: () => void
    onClose?: () => void
  }

  interface NotifyStatic {
    (options: string | NotifyOptions): void
    primary(options: string | NotifyOptions): void
    success(options: string | NotifyOptions): void
    danger(options: string | NotifyOptions): void
    warning(options: string | NotifyOptions): void
    clear(): void
  }

  const Notify: NotifyStatic
  export default Notify
}
```

---

## Vant 事件类型辅助

Vant Weapp 组件事件通过 `bind:xxx` 触发，回调参数为 `WechatMiniprogram.CustomEvent<T>`。
以下工具类型和接口帮助快速标注事件处理函数。

### VantEvent 工具类型

```typescript
// typings/vant-event.d.ts

/**
 * Vant 组件事件的简写类型
 * 用法：handler(e: VantEvent<TabChangeDetail>) { ... }
 */
type VantEvent<T = any> = WechatMiniprogram.CustomEvent<T>
```

### 各组件 e.detail 接口

```typescript
// typings/vant-event-details.d.ts

// ============ Tabs ============
/** van-tabs bind:change / bind:click */
interface TabChangeDetail {
  name: string   // tab 的 name 属性
  title: string  // tab 的标题文字
  index: number  // tab 的索引
}

// ============ Picker ============
/** van-picker bind:confirm */
interface PickerConfirmDetail {
  value: string | string[]     // 选中值（单列为 string，多列为 string[]）
  index: number | number[]     // 选中索引
}

/** van-picker bind:change */
interface PickerChangeDetail {
  value: string | string[]
  index: number | number[]
  picker: any  // picker 实例
}

// ============ Calendar ============
/**
 * van-calendar bind:confirm
 * ⚠️ type="single" 时 detail 为 Date
 *    type="range" 时 detail 为 [Date, Date]
 *    type="multiple" 时 detail 为 Date[]
 */
type CalendarConfirmDetail = Date | Date[]

// ============ Radio ============
/** van-radio-group bind:change */
type RadioChangeDetail = string  // 选中的 radio name

// ============ Checkbox ============
/** van-checkbox-group bind:change */
type CheckboxChangeDetail = string[]  // 所有选中的 checkbox name 数组

/** van-checkbox bind:change */
interface CheckboxSingleDetail {
  value: boolean  // 当前勾选状态
}

// ============ SwipeCell ============
/** van-swipe-cell bind:open */
interface SwipeCellOpenDetail {
  position: 'left' | 'right'
  name: string
}

/** van-swipe-cell bind:close */
interface SwipeCellCloseDetail {
  position: 'left' | 'right' | 'cell' | 'outside'
  name: string
}

// ============ Field ============
/** van-field bind:change / bind:blur / bind:focus */
type FieldChangeDetail = string  // 输入框当前值

// ============ Search ============
/** van-search bind:search / bind:change */
type SearchChangeDetail = string  // 搜索框当前值

// ============ Stepper ============
/** van-stepper bind:change */
type StepperChangeDetail = number  // 步进器当前值

// ============ ActionSheet ============
/** van-action-sheet bind:select */
interface ActionSheetSelectDetail {
  name: string
  subname?: string
  color?: string
  disabled?: boolean
  loading?: boolean
}

// ============ Popup ============
/** van-popup bind:close / bind:click-overlay 无 detail 数据 */

// ============ SubmitBar ============
/** van-submit-bar bind:submit 无 detail 数据 */
```

### 事件类型速查表

| 组件 | 事件 | e.detail 类型 | 说明 |
|------|------|--------------|------|
| Tabs | `bind:change` | `{ name, title, index }` | 切换标签 |
| Picker | `bind:confirm` | `{ value, index }` | 确认选择 |
| Picker | `bind:change` | `{ value, index, picker }` | 列变化 |
| Calendar | `bind:confirm` | `Date \| Date[]` | 确认日期（⚠️ Date 对象） |
| Radio | `bind:change` | `string` | 选中值（name） |
| Checkbox Group | `bind:change` | `string[]` | 所有选中值数组 |
| Checkbox | `bind:change` | `{ value: boolean }` | 单个勾选状态 |
| SwipeCell | `bind:open` | `{ position, name }` | 滑开 |
| SwipeCell | `bind:close` | `{ position, name }` | 关闭 |
| Field | `bind:change` | `string` | 输入值 |
| Search | `bind:search` | `string` | 搜索值 |
| Stepper | `bind:change` | `number` | 步进值 |
| ActionSheet | `bind:select` | `{ name, subname?, ... }` | 选中项 |
| Button | `bind:click` | 无 | 点击 |
| Popup | `bind:close` | 无 | 关闭 |
| SubmitBar | `bind:submit` | 无 | 提交 |
