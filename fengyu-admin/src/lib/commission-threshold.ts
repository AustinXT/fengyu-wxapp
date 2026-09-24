/**
 * #379 提成矩阵划卡单价阈值（price_threshold）的配置规则。
 *
 * 生效范围在 DB 层由 chk_commission_matrix_price_threshold 封死：仅「服务单」的
 * 自销自耗 / 他销自耗行可有阈值；五个提成写入副本只做 max(单价, COALESCE(阈值, 0))，不判类目。
 * 本文件是 admin 表单与 Server Action 的前置校验（给出可读报错，而不是撞 CHECK 抛 500），
 * 集合须与 CHECK 一致——由 __tests__/commission-threshold.test.ts 对照 db/schema/commission.ts 守护。
 */

export const PRICE_THRESHOLD_ORDER_TYPE = '服务单'
export const PRICE_THRESHOLD_SALES_CATEGORIES = ['自销自耗', '他销自耗'] as const
/** 新建可配阈值的规则时的默认值（09-18 会议拍板：默认 100，按区域改） */
export const DEFAULT_PRICE_THRESHOLD = '100'

const MAX_PRICE_THRESHOLD = 99999999.99 // numeric(10, 2)

export function isPriceThresholdEligible(orderType: string, salesCategory: string): boolean {
  return orderType === PRICE_THRESHOLD_ORDER_TYPE
    && (PRICE_THRESHOLD_SALES_CATEGORIES as readonly string[]).includes(salesCategory)
}

/** 空串 / null → null（不启用）；否则须为 0 ~ 99999999.99、最多两位小数 */
export function parsePriceThreshold(
  raw: string | null | undefined,
): { ok: true; value: string | null } | { ok: false; message: string } {
  const s = (raw ?? '').trim()
  if (s === '') return { ok: true, value: null }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, message: '单价阈值须为非负数，最多两位小数' }
  if (Number(s) > MAX_PRICE_THRESHOLD) return { ok: false, message: '单价阈值超出上限' }
  return { ok: true, value: s }
}
