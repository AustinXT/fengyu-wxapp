




type CalendarUpdateCallback = (storeName: string) => void;

let socketTask: WechatMiniprogram.SocketTask | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let wsConnected = false;
let calendarCb: CalendarUpdateCallback | null = null;


export function startRealtime(onCalendarUpdate: CalendarUpdateCallback): void {
  calendarCb = onCalendarUpdate;
  connectWS();
  
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      if (!wsConnected && calendarCb) {
        calendarCb('poll');
      }
    }, 30000);
  }
}


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
      url: 'wss://placeholder-ws-gateway', 
      success: () => {  }
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
      
      setTimeout(connectWS, 3000);
    });
    socketTask.onError(() => {
      wsConnected = false;
    });
  } catch (_) {
    wsConnected = false;
  }
}
