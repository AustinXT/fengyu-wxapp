/**
 * 微信小程序类型扩展
 * 补充 miniprogram-api-typings 中缺少的类型
 */
declare namespace WechatMiniprogram {
  /** input 事件（miniprogram-api-typings 未导出） */
  type InputEvent = CustomEvent<{ value: string; cursor: number; keyCode: number }>
}

/**
 * 绕过 CustomEvent<Detail extends IAnyObject> 对原始类型的约束
 * Vant 组件和 swiper 等实际传递 number/string/boolean 作为 detail
 */
type WxEvent<Detail = any> = {
  detail: Detail
  currentTarget: WechatMiniprogram.BaseEvent['currentTarget']
  target: WechatMiniprogram.BaseEvent['target']
  type: string
  timeStamp: number
  stopPropagation?(): void
}
