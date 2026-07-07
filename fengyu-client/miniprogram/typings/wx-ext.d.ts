
declare namespace WechatMiniprogram {
  
  type InputEvent = CustomEvent<{ value: string; cursor: number; keyCode: number }>
}


type WxEvent<Detail = any> = {
  detail: Detail
  currentTarget: WechatMiniprogram.BaseEvent['currentTarget']
  target: WechatMiniprogram.BaseEvent['target']
  type: string
  timeStamp: number
  stopPropagation?(): void
}
