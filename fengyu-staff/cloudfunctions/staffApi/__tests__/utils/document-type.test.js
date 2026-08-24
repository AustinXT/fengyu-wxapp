const {
  DOCUMENT_TYPE_CLASSIFICATION_SQL,
  classifySaleOrderDocumentType,
} = require('../../utils/document-type')

describe('document_type 阶段冻结', () => {
  test('无顾客订单直接回退售前一次且不访问数据库', async () => {
    const tx = { query: vi.fn() }
    await expect(classifySaleOrderDocumentType(tx, null, 'FY-1')).resolves.toBe('售前一次')
    expect(tx.query).not.toHaveBeenCalled()
  })

  test('锁与分类查询分成两条语句，等待锁后读取新快照', async () => {
    const tx = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [{ document_type: '售前二次' }] }),
    }

    await expect(classifySaleOrderDocumentType(tx, 'user-1', 'FY-1')).resolves.toBe('售前二次')
    expect(tx.query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
      ['document-type:user-1'],
    )
    expect(tx.query).toHaveBeenNthCalledWith(
      2,
      DOCUMENT_TYPE_CLASSIFICATION_SQL,
      ['user-1', 'FY-1'],
    )
  })

  test('达标口径和三阶段映射固定', () => {
    expect(DOCUMENT_TYPE_CLASSIFICATION_SQL).toContain("o.status IN ('部分支付', '已支付', '已完成')")
    expect(DOCUMENT_TYPE_CLASSIFICATION_SQL).toContain("o.sale_order_type = '销售单'")
    expect(DOCUMENT_TYPE_CLASSIFICATION_SQL).toContain("o.sale_order_type = '转换单'")
    expect(DOCUMENT_TYPE_CLASSIFICATION_SQL).toContain("WHEN hit_count = 0 THEN '售前一次'")
    expect(DOCUMENT_TYPE_CLASSIFICATION_SQL).toContain("WHEN hit_count = 1 THEN '售前二次'")
    expect(DOCUMENT_TYPE_CLASSIFICATION_SQL).toContain("ELSE '售后'")
  })
})
