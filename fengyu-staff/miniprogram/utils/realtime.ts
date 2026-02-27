// utils/realtime.ts — WebSocket 实时推送 + 轮询降级
//
// 用途：订单支付成功后，员工端实时感知，更新日历视图。
// 策略：优先 WebSocket（wsGateway 云函数），断线自动降级至 30 秒轮询。

type CalendarUpdateCallback = (storeName: string) => void;

let socketTask: WechatMiniprogram.SocketTask | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let wsConnected = false;
let calendarCb: CalendarUpdateCallback | null = null;

/** 启动实时监听，传入支付事件回调 */
export function startRealtime(onCalendarUpdate: CalendarUpdateCallback): void {
  calendarCb = onCalendarUpdate;
  connectWS();
  // 降级轮询（30 秒）
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      if (!wsConnected && calendarCb) {
        calendarCb('poll');
      }
    }, 30000);
  }
}

/** 停止实时监听（页面 onHide / onUnload 时调用） */
export function stopRealtime(): void {
  calendarCb = null;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (socketTask) {
    socketTask.close({});
    socketTask = null;
  }
  wsConnected = false;
}

function connectWS(): void {
  try {
    socketTask = wx.connectSocket({
      url: 'wss://placeholder-ws-gateway', // 由 wsGateway 云函数提供
      success: () => { /* 连接发起成功 */ }
    });
    socketTask.onOpen(() => {
      wsConnected = true;
    });
    socketTask.onMessage((res) => {
      try {
        const msg = JSON.parse(res.data as string);
        if (msg.type === 'order_paid' && calendarCb) {
          calendarCb(msg.storeName || '');
        }
      } catch (_) {}
    });
    socketTask.onClose(() => {
      wsConnected = false;
      // 3 秒后重连
      setTimeout(connectWS, 3000);
    });
    socketTask.onError(() => {
      wsConnected = false;
    });
  } catch (_) {
    wsConnected = false;
  }
}
