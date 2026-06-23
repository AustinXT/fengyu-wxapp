/**
 * 寄存单退款专用服务单的标准化备注（数据契约）。
 *
 * 寄存单（sale_order_type='寄存单'）是上线时导入老系统历史剩余次数的初始化单据，未走收款流程，
 * 无法开正常退款单。顾客退寄存疗程卡次数时走正常服务单流程扣减次数，并在备注选此预设打标，
 * 便于后续从消耗业绩统计中过滤剔除（过滤逻辑见后续 ticket）。
 *
 * ⚠️ 须与 fengyu-staff/miniprogram/packageService/service-create/service-create.ts 的
 * DEPOSIT_REFUND_REMARK 字面量完全一致（项目禁止跨端共享代码目录，各端保留独立副本）。
 *
 * 纯字符串、无 db/server 依赖，可被 'use client' 组件安全引用（避免 server 代码进 client bundle）。
 */
export const DEPOSIT_REFUND_REMARK = '寄存单退款专用 — 老系统寄存疗程卡退款核销，不计消耗业绩'
