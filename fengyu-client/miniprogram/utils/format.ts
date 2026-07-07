


export function maskPhone(phone: string): string {
  if (!phone || phone.length < 7) return phone;
  return phone.slice(0, 3) + '****' + phone.slice(-4);
}


export function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  
  const safe = String(dateStr).includes('T') ? dateStr : String(dateStr).replace(/-/g, '/');
  const d = new Date(safe);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}


export function formatDiscount(coupon: { couponType: string; discountValue: number | string }): string {
  if (coupon.couponType === '折扣券') {
    return `${Math.round(Number(coupon.discountValue) * 10)}折`;
  }
  return `¥${Number(coupon.discountValue).toFixed(0)}`;
}


export function calculateProgress(sessionCount: number, remainingSessions: number): number {
  if (sessionCount <= 0) return 0;
  return Math.round(((sessionCount - remainingSessions) / sessionCount) * 100);
}


export function calculateTriProgress(
  sessionCount: number,
  remainingSessions: number,
  paidSessions: number
): { usedPct: number; paidUnusedPct: number; unpaidPct: number } {
  const total = Number(sessionCount) || 0;
  const remaining = Number(remainingSessions) || 0;
  const paid = Number(paidSessions) || 0;
  if (total <= 0) return { usedPct: 0, paidUnusedPct: 0, unpaidPct: 0 };
  const used = Math.max(0, total - remaining);
  const paidUnused = Math.max(0, paid - used);
  const unpaid = Math.max(0, total - paid);
  const pct = (n: number) => Math.round((n / total) * 10000) / 100;
  return {
    usedPct: pct(used),
    paidUnusedPct: pct(paidUnused),
    unpaidPct: pct(unpaid),
  };
}


export function cleanErrorMessage(msg: string): string {
  return (msg || '请求失败').replace(/^[A-Z_]+:\s*/, '');
}


export function calculateTotal(items: Array<{ price: number; quantity: number }>): number {
  return Math.round(items.reduce((sum, i) => sum + i.price * i.quantity, 0) * 100) / 100;
}


export function searchProducts<T extends { product_id: string; name: string }>(
  keyword: string,
  categoryCache: Record<string, T[]>,
  categoryKeys: string[]
): T[] {
  if (!keyword.trim()) return [];
  const lc = keyword.toLowerCase();
  const seen = new Set<string>();
  const results: T[] = [];
  for (const key of categoryKeys) {
    for (const spu of (categoryCache[key] || [])) {
      if (!seen.has(spu.product_id) && spu.name.toLowerCase().includes(lc)) {
        seen.add(spu.product_id);
        results.push(spu);
      }
    }
  }
  return results;
}


const STATUS_CLASS: Record<string, string> = {
  '待支付':     'status-pending',
  '部分支付':   'status-partial',
  '已支付':     'status-paid',
  '已完成':     'status-completed',
  '支付失败':   'status-failed',
  '已关闭':     'status-closed',
};
export function getStatusClass(status: string): string {
  return STATUS_CLASS[status] || 'status-class-done';
}


export function formatOrderDate(dateStr: string): string {
  if (!dateStr) return '';
  const safe = String(dateStr).includes('T') ? dateStr : String(dateStr).replace(/-/g, '/');
  const d = new Date(safe);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}


export function safeParseDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const safe = String(dateStr).includes('T') ? dateStr : String(dateStr).replace(/-/g, '/');
  const d = new Date(safe);
  return isNaN(d.getTime()) ? null : d;
}


export function formatDateTime(dateStr: string): string {
  const d = safeParseDate(dateStr);
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const sec = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}:${sec}`;
}


export function formatDateTimeShort(dateStr: string): string {
  const d = safeParseDate(dateStr);
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}


export function formatShortDate(dateStr: string): string {
  const d = safeParseDate(dateStr);
  if (!d) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}-${day}`;
}


export function formatRelativeTime(dateStr: string): string {
  const d = safeParseDate(dateStr);
  if (!d) return '';
  const diff = Date.now() - d.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天前`;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}-${day}`;
}


export function formatAmount(amount: number | string): string {
  const n = Number(amount) || 0;
  return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}


function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}


export function formatAppointmentTime(appointmentTime: string): string {
  if (!appointmentTime) return '';

  
  const spaceIdx = appointmentTime.indexOf(' ');
  if (spaceIdx > -1) {
    const datePart = appointmentTime.slice(0, spaceIdx);
    const slotPart = appointmentTime.slice(spaceIdx + 1).trim();
    if (/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(slotPart)) {
      const d = safeParseDate(datePart);
      if (!d) return appointmentTime;
      return `${d.getMonth() + 1}月${d.getDate()}日 ${slotPart}`;
    }
  }

  
  const start = safeParseDate(appointmentTime);
  if (!start) return appointmentTime;
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return `${start.getMonth() + 1}月${start.getDate()}日 ${hhmm(start)}-${hhmm(end)}`;
}
