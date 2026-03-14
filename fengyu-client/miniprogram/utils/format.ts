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
  const d = new Date(dateStr);
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
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
