/**
 * 旧系统储值余额转入不产生新业绩；真实充值仍按款项归属日期计入。
 * 按同单首次支付的专用标记识别，兼容既有转入单，也排除其后续退款。
 * 不依赖可编辑的订单备注，也不能只检查当前退款流水的 note。
 * 与 admin lib/data-center/prepaid-performance-filter.ts 保留独立副本并做跨端守护。
 */
function excludeLegacyPrepaidInflowSql(alias = 'spe') {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) throw new Error('无效的业绩表别名')
  return `(
    ${alias}.sale_order_type <> '充值单'
    OR NOT EXISTS (
      SELECT 1 FROM sale_order_payments legacy_inflow
      WHERE legacy_inflow.sale_order_id = ${alias}.sale_order_id
        AND legacy_inflow.change_type = '首次支付'
        AND (legacy_inflow.note = '旧系统充值金转入'
          OR legacy_inflow.note LIKE '旧系统充值金转入｜%')
    )
  )`
}

module.exports = { excludeLegacyPrepaidInflowSql }
