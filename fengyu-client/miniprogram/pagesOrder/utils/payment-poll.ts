// pagesOrder/utils/payment-poll.ts
// 支付结果轮询确认（issue #37）。
//
// 背景：payNotify 异步回调天生有延迟（典型 2–5s）且偶发丢失，前端 wx.requestPayment 成功后
// 立即跳转会看到"待支付"。本 helper 支付成功后轮询 order.confirmPayment（后端主动对账+补偿入账），
// 直到订单变为已支付/部分支付，或确认无需轮询（储值卡/线下单/终态），或超时。
//
// 用法：
//   const poller = pollPaymentConfirm(orderNo, { onTick: r => ... });
//   const r = await poller.promise;
//   poller.clear();                  // 页面 onUnload/onHide 调，防内存泄漏
//   // r.status ∈ {'已支付','部分支付'} → 确认完成；r.reason ∈ {'no_lakala_order','terminal'} → 无需轮询；
//   //   否则超时（status 通常仍待支付）。

import { callClientApi } from '../../utils/cloud';

export interface PaymentConfirmResult {
  status: string;
  reconciled: boolean;
  reason?: string;
  lakalaTradeState?: string;
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

/** 终止轮询的 reason：储值卡/线下单或终态，confirmPayment 不需要对账 */
const STOP_REASONS = new Set(['no_lakala_order', 'terminal']);

export interface PaymentPoller {
  promise: Promise<PaymentConfirmResult>;
  clear: () => void;
}

/**
 * 轮询 order.confirmPayment。
 * 终止条件（任一）：status 已支付/部分支付；reason ∈ {no_lakala_order, terminal}；超时；外部 clear()。
 * 超时返回最后一次结果（status 通常仍待支付，调用方据此提示"请稍后下拉刷新"）。
 *
 * clear() 置 settled + 清 timer + resolve promise：
 *   - 阻止 in-flight tick 在 await 返回后重新调度（防页面销毁后继续请求）
 *   - 让 await poller.promise 立即 resolve（防 finally 永不执行 / 调用方永久挂起）
 */
export function pollPaymentConfirm(saleOrderId: string, opts: PollOptions = {}): PaymentPoller {
  const intervalMs = opts.intervalMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastResult: PaymentConfirmResult = { status: '待支付', reconciled: false };
  let settled = false;
  let resolveFn: ((r: PaymentConfirmResult) => void) | null = null;

  const finish = () => {
    if (settled) return;
    settled = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (resolveFn) resolveFn(lastResult);
  };

  const promise = new Promise<PaymentConfirmResult>((resolve) => {
    resolveFn = resolve;
    const tick = async () => {
      if (settled) return;
      try {
        const r = await callClientApi<PaymentConfirmResult>('order.confirmPayment', { saleOrderId });
        if (settled) return; // await 期间被 clear()，不再处理 / 重新调度
        lastResult = {
          status: r.status,
          reconciled: !!r.reconciled,
          reason: r.reason,
          lakalaTradeState: r.lakalaTradeState,
        };
        if (r.status === '已支付' || r.status === '部分支付' || STOP_REASONS.has(r.reason || '')) {
          finish();
          return;
        }
      } catch (_e) {
        // 网络抖动 / 云函数异常：忽略本次，继续轮询（超时由 timeoutMs 兜底）
      }
      if (settled) return;
      if (Date.now() - start >= timeoutMs) {
        finish();
        return;
      }
      timer = setTimeout(tick, intervalMs);
    };
    // 立即发起首次查询（不等 intervalMs）
    tick();
  });

  return { promise, clear: finish };
}
