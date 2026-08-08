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

/** 优惠券面值展示：折扣券→"8.5折"，现金券/品项券→"¥10" */
export function formatDiscount(coupon: { couponType: string; discountValue: number | string }): string {
  if (coupon.couponType === '折扣券') {
    return `${(Math.round(Number(coupon.discountValue) * 100) / 10).toFixed(1).replace(/\.0$/, '')}折`;
  }
  return `¥${Number(coupon.discountValue).toFixed(2).replace(/\.?0+$/, '')}`;
}

/**
 * 结算页可用券的展示字段。折扣券只显示折数；金额型券在本单抵扣被截断时才显示实际可用金额。
 */
export function buildCouponDisplay(coupon: {
  couponType?: string;
  discountValue?: number | string;
  faceValue?: number | string;
  discount?: number | string;
}): { discountLabel: string; availableAmountLabel: string } {
  const couponType = coupon.couponType || '';
  const faceValue = Number(coupon.faceValue ?? coupon.discountValue);
  const discount = Number(coupon.discount);
  const isAmountCoupon = couponType === '现金券' || couponType === '品项券';

  return {
    discountLabel: formatDiscount({ couponType, discountValue: coupon.discountValue ?? coupon.faceValue ?? 0 }),
    availableAmountLabel: isAmountCoupon && Number.isFinite(faceValue) && Number.isFinite(discount) && discount < faceValue
      ? `本单可用 ${formatDiscount({ couponType, discountValue: discount })}`
      : '',
  };
}

/** 疗程卡进度百分比（旧接口，已用占比，仅向后兼容） */
export function calculateProgress(sessionCount: number, remainingSessions: number): number {
  if (sessionCount <= 0) return 0;
  return Math.round(((sessionCount - remainingSessions) / sessionCount) * 100);
}

/**
 * 疗程卡三段进度（剩余可用 / 已付未用 / 未付）
 * - usedPct: 已用 = (total - remaining) / total
 * - paidUnusedPct: 已付未用 = max(0, paid - used) / total
 * - unpaidPct: 未付 = max(0, total - paid) / total
 * 三段加起来 ≤ 100，剩余可用段 = 已付未用段（颜色 #C0322A 品牌主色）
 */
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
  '部分支付':   'status-partial',
  '已支付':     'status-paid',
  '已完成':     'status-completed',
  '已退款':     'status-refunded',
  '支付失败':   'status-failed',
  '已关闭':     'status-closed',
};
export function getStatusClass(status: string): string {
  return STATUS_CLASS[status] || 'status-class-done';
}

/** 订单时间格式化："2025-03-14"（YYYY-MM-DD，补前导零） */
export function formatOrderDate(dateStr: string): string {
  if (!dateStr) return '';
  const safe = String(dateStr).includes('T') ? dateStr : String(dateStr).replace(/-/g, '/');
  const d = new Date(safe);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** iOS 安全日期解析："-" → "/"（修复 iOS Safari 无法解析 "YYYY-MM-DD" 问题），无效日期返回 null */
export function safeParseDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const safe = String(dateStr).includes('T') ? dateStr : String(dateStr).replace(/-/g, '/');
  const d = new Date(safe);
  return isNaN(d.getTime()) ? null : d;
}

/** 日期时间格式化（带秒）："2025-03-14 10:30:42" */
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

/** 日期时间格式化（不带秒）："2025-03-14 10:30"（用于列表/卡片等紧凑展示位置） */
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

/** "HH:mm" 局部格式（北京墙钟，补零） */
function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 预约时段格式化 → "6月16日 09:00-10:00"（显示时段区间）
 *
 * 数据实情：`appointments.appointment_time` 是 PG `timestamp` 列，**只存时段起点**
 * （北京墙钟），经 clientApi pg 序列化后回到前端是 **UTC ISO 串**（形如
 * "2026-06-16T01:00:00.000Z"，**无空格**）。终点没有任何代码消费、也未落库。
 *
 * 时区：直接复用本文件 `safeParseDate`（`formatDateTime`/`formatDate` 同款解析，
 * 见项目记忆 pg-date-serialization-utc）把 UTC ISO 转成设备本地（北京 UTC+8）墙钟，
 * 不手搓 Date 偏移；员工端展示同一字段也走 formatDateTime，与此一致。
 *
 * 时段终点：当前所有时段固定 1 小时（09:00-10:00 … 18:00-19:00，见
 * pagesAppointment/appointment-create 的 TIME_SLOTS），故终点 = 起点 + 1 小时派生
 * （epoch 加 1 小时，时区安全）。⚠️ 若将来时段时长可变，须改这里或把终点落库。
 *
 * 换算样例：入参 "2026-06-16T01:00:00.000Z" → 北京起点 09:00 → "6月16日 09:00-10:00"。
 *
 * 兼容兜底：空串返回 ''；无法解析时原样返回；万一仍收到旧的带空格
 * "YYYY-MM-DD HH:MM-HH:MM" 时段串，按原逻辑取日期 + 整段时段直接显示（不派生）。
 */
export function formatAppointmentTime(appointmentTime: string): string {
  if (!appointmentTime) return '';

  // 兼容旧格式：带空格且时段部分是 "HH:MM-HH:MM" 区间 → 日期 + 原时段串
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

  // 主路径：UTC ISO timestamp（仅时段起点）→ 北京墙钟 + 派生 1 小时区间
  const start = safeParseDate(appointmentTime);
  if (!start) return appointmentTime;
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return `${start.getMonth() + 1}月${start.getDate()}日 ${hhmm(start)}-${hhmm(end)}`;
}
