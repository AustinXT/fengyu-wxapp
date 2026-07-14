/**
 * 寄存单退款专用服务单备注常量（clientApi 独立副本）。
 *
 * 与 staffApi/utils/consume-filter.js、fengyu-admin/src/lib/service-remark.ts、
 * fengyu-staff/miniprogram/packageService/service-create/service-create.ts 四端字面量完全一致，
 * 由 fengyu-admin/src/actions/data-center/__tests__/consistency.deposit-refund-filter.test.ts 守护。
 *
 * 用途：clientApi service-finalize.js 在顾客确认服务单时，按此常量拦截寄存单退款单的
 * service_commissions 写入（寄存退款是真扣次数、假消耗，不计提成）。
 */
const DEPOSIT_REFUND_REMARK = '寄存单退款专用 — 老系统寄存疗程卡退款核销，不计消耗业绩'

module.exports = { DEPOSIT_REFUND_REMARK }
