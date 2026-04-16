/**
 * 通用格式化工具函数
 * 从各页面提取的纯函数，便于单元测试和复用
 */

/** 手机号脱敏：138****5678 */
export function maskPhone(phone: string): string {
  if (!phone || phone.length < 7) return phone;
  return phone.slice(0, 3) + '****' + phone.slice(-4);
}

/** ISO 日期 → "YYYY-MM-DD" */
export function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  // iOS: "2025-03-14" 需替换为 "/", 但 "2025-03-14T..." ISO 格式本身安全
  const safe = String(dateStr).includes('T') ? dateStr : String(dateStr).replace(/-/g, '/');
  const d = new Date(safe);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 优惠券折扣展示：折扣券→"8折"，现金券→"¥10" */
export function formatDiscount(coupon: { couponType: string; discountValue: number | string }): string {
  if (coupon.couponType === '折扣券') {
    return `${Math.round(Number(coupon.discountValue) * 10)}折`;
  }
  return `¥${Number(coupon.discountValue).toFixed(0)}`;
}

/** 疗程卡进度百分比 */
export function calculateProgress(sessionCount: number, remainingSessions: number): number {
  if (sessionCount <= 0) return 0;
  return Math.round(((sessionCount - remainingSessions) / sessionCount) * 100);
}

/** 清理错误消息前缀（如 "INVALID_PARAMS: xxx" → "xxx"） */
export function cleanErrorMessage(msg: string): string {
  return (msg || '请求失败').replace(/^[A-Z_]+:\s*/, '');
}

/** 计算勾选商品总价（精确到分） */
export function calculateTotal(items: Array<{ price: number; quantity: number }>): number {
  return Math.round(items.reduce((sum, i) => sum + i.price * i.quantity, 0) * 100) / 100;
}

/** 跨分类搜索商品（去重） */
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

/** 订单状态 → CSS class */
const STATUS_CLASS: Record<string, string> = {
  '待支付':     'status-pending',
  '待确认收款': 'status-confirm',
  '已支付':     'status-paid',
  '已完成':     'status-completed',
  '支付失败':   'status-failed',
  '已关闭':     'status-closed',
};
export function getStatusClass(status: string): string {
  return STATUS_CLASS[status] || 'status-class-done';
}

/** 订单时间格式化："2025-3-14" */
export function formatOrderDate(dateStr: string): string {
  if (!dateStr) return '';
  const safe = String(dateStr).includes('T') ? dateStr : String(dateStr).replace(/-/g, '/');
  const d = new Date(safe);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** iOS 安全日期解析："-" → "/"（修复 iOS Safari 无法解析 "YYYY-MM-DD" 问题），无效日期返回 null */
export function safeParseDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const safe = String(dateStr).includes('T') ? dateStr : String(dateStr).replace(/-/g, '/');
  const d = new Date(safe);
  return isNaN(d.getTime()) ? null : d;
}

/** 日期时间格式化："2025-03-14 10:30" */
export function formatDateTime(dateStr: string): string {
  const d = safeParseDate(dateStr);
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}

/** 短日期格式化："03-14" */
export function formatShortDate(dateStr: string): string {
  const d = safeParseDate(dateStr);
  if (!d) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}-${day}`;
}

/** 相对时间格式化："刚刚"/"5分钟前"/"3小时前"/"2天前"/"03-14" */
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

/** 金额带符号格式化："+1.00" / "-1.00"（兼容云函数返回的 PG numeric 字符串） */
export function formatAmount(amount: number | string): string {
  const n = Number(amount) || 0;
  return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

/** 预约时间格式化："2026-03-15 09:00-11:00" → "3月15日 09:00-11:00" */
export function formatAppointmentTime(appointmentTime: string): string {
  if (!appointmentTime) return '';
  const [datePart, slotPart] = appointmentTime.split(' ');
  const d = safeParseDate(datePart);
  if (!d) return appointmentTime;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${slotPart || ''}`;
}
