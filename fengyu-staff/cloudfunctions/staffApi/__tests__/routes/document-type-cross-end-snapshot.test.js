const fs = require('node:fs')
const path = require('node:path')

const staff = require('../../utils/document-type')
const client = require('../../../../../fengyu-client/cloudfunctions/clientApi/utils/document-type')
const payNotify = require('../../../../../fengyu-client/cloudfunctions/payNotify/document-type')

describe('document_type 分类 SQL 跨端一致性', () => {
  test('三个 node-pg 副本字节一致', () => {
    expect(client.DOCUMENT_TYPE_CLASSIFICATION_SQL).toBe(staff.DOCUMENT_TYPE_CLASSIFICATION_SQL)
    expect(payNotify.DOCUMENT_TYPE_CLASSIFICATION_SQL).toBe(staff.DOCUMENT_TYPE_CLASSIFICATION_SQL)
  })

  test('admin 副本保留同一锁、阈值、达标口径和三阶段映射', () => {
    const adminSource = fs.readFileSync(
      path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/document-type.ts'),
      'utf8',
    )
    const markers = [
      'document-type:',
      "new_member_threshold",
      "value ~ '^\\\\s*[0-9]+(\\\\.[0-9]+)?\\\\s*$'",
      "o.status IN ('部分支付', '已支付', '已完成')",
      "o.sale_order_type = '销售单'",
      "o.sale_order_type = '转换单'",
      "WHEN hit_count = 0 THEN '售前一次'",
      "WHEN hit_count = 1 THEN '售前二次'",
      "ELSE '售后'",
    ]
    for (const marker of markers) expect(adminSource).toContain(marker)
  })
})
