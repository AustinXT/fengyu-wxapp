

const DEPOSIT_REFUND_REMARK = '寄存单退款专用 — 老系统寄存疗程卡退款核销，不计消耗业绩';


function excludeDepositRefundSql(alias = 'so') {
  return `${alias}.remark IS DISTINCT FROM '${DEPOSIT_REFUND_REMARK}'`;
}

module.exports = { DEPOSIT_REFUND_REMARK, excludeDepositRefundSql };
