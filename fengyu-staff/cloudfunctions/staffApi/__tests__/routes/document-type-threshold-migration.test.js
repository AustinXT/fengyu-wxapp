const fs = require('node:fs')
const path = require('node:path')

const migration = fs.readFileSync(
  path.resolve(__dirname, '../../../../../db/migrations/0031_sale_document_threshold_stage.sql'),
  'utf8'
)

describe('销售订单 document_type 达标次数迁移', () => {
  test('销售单按净有效实收、转换单按现付参与达标', () => {
    expect(migration).toContain("o.sale_order_type = '销售单'")
    expect(migration).toContain('o.received::numeric - o.refunded_amount::numeric')
    expect(migration).toContain("o.sale_order_type = '转换单'")
    expect(migration).toContain("sop.payment_method <> '储值卡'")
  })

  test('内部单、寄存单、充值单不增加次数', () => {
    expect(migration).not.toMatch(/sale_order_type\s+IN\s*\([^)]*'内部单'/)
    expect(migration).not.toMatch(/sale_order_type\s+IN\s*\([^)]*'寄存单'/)
    expect(migration).not.toMatch(/sale_order_type\s+IN\s*\([^)]*'充值单'/)
  })

  test('顾客级事务锁、首次结清冻结和三阶段映射均存在', () => {
    expect(migration).toContain("pg_advisory_xact_lock(hashtext('document-type:' || p_client_user_id)::bigint)")
    expect(migration).toContain("OLD.status NOT IN ('已支付', '已完成')")
    expect(migration).toContain("WHEN v_hit_count <= 1 THEN '售前一次'")
    expect(migration).toContain("WHEN v_hit_count = 2 THEN '售前二次'")
    expect(migration).toContain("ELSE '售后'")
  })

  test('退款不会触发历史分类重排', () => {
    expect(migration).toContain('BEFORE INSERT OR UPDATE OF status ON sale_orders')
    expect(migration).not.toContain('UPDATE OF refunded_amount')
  })
})
