/** Vant Weapp 类型声明（JS 组件无自带 .d.ts） */
declare module '@vant/weapp/toast/toast' {
  interface ToastOptions {
    type?: 'text' | 'loading' | 'success' | 'fail'
    message?: string
    duration?: number
    mask?: boolean
    forbidClick?: boolean
    selector?: string
  }
  function Toast(options: ToastOptions | string): void
  namespace Toast {
    function loading(options: ToastOptions | string): void
    function success(options: ToastOptions | string): void
    function fail(options: ToastOptions | string): void
    function clear(): void
  }
  export default Toast
}

declare module '@vant/weapp/dialog/dialog' {
  interface DialogOptions {
    title?: string
    message?: string
    showCancelButton?: boolean
    confirmButtonText?: string
    cancelButtonText?: string
    selector?: string
  }
  interface DialogResult {
    confirm: boolean
    cancel: boolean
  }
  function Dialog(options: DialogOptions): Promise<DialogResult>
  namespace Dialog {
    function confirm(options: DialogOptions): Promise<DialogResult>
    function alert(options: DialogOptions): Promise<DialogResult>
    function close(): void
  }
  export default Dialog
}
