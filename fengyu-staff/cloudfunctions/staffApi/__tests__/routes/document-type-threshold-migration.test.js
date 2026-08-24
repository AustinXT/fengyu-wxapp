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

  test('迁移只保留 schema 变更和数据回填，不包含手写函数或触发器 DDL', () => {
    expect(migration).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i)
    expect(migration).not.toMatch(/CREATE\s+TRIGGER/i)
    expect(migration).not.toMatch(/DROP\s+TRIGGER/i)
    expect(migration).toContain("WHEN ranked.stage_index <= 1 THEN '售前一次'")
    expect(migration).toContain("WHEN ranked.stage_index = 2 THEN '售前二次'")
    expect(migration).toContain("ELSE '售后'")
  })

  test('部分支付纳入存量回填统计', () => {
    expect(migration.match(/status IN \('部分支付', '已支付', '已完成'\)/g)).toHaveLength(1)
  })

  test('迁移不夹带核验 SELECT，末尾仅为允许的数据 UPDATE', () => {
    expect(migration).not.toMatch(/SELECT\s+document_type\s*,\s*COUNT/i)
    expect(migration.trim()).toMatch(/WHERE client_user_id IS NULL OR document_type IS NULL;$/)
  })
})
