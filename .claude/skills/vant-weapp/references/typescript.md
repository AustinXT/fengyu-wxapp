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
