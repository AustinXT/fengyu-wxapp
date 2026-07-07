













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


const STOP_REASONS = new Set(['no_lakala_order', 'terminal']);

export interface PaymentPoller {
  promise: Promise<PaymentConfirmResult>;
  clear: () => void;
}


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
        if (settled) return; 
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
        
      }
      if (settled) return;
      if (Date.now() - start >= timeoutMs) {
        finish();
        return;
      }
      timer = setTimeout(tick, intervalMs);
    };
    
    tick();
  });

  return { promise, clear: finish };
}
