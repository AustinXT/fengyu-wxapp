import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getViewConfig, PgDialect } from 'drizzle-orm/pg-core'
import { saleReportablePaymentEvents, saleReportableItemEvents } from '@db/order'

// 候选 SQL 会被真库套件执行；锁住它与当前 Drizzle 定义的一致性，防止测到另一份公式。
describe('#553 体验资格视图候选交接', () => {
  it('两份候选 CREATE OR REPLACE 与实际 schema 逐字相等且没有参数', () => {
    const dialect = new PgDialect()
    const expected = [saleReportablePaymentEvents, saleReportableItemEvents].map(view => {
      const config = getViewConfig(view)
      const query = dialect.sqlToQuery(config.query!)
      expect(query.params).toEqual([])
      return `CREATE OR REPLACE VIEW "public"."${config.name}" AS (${query.sql}\n);`
    }).join('\n\n')
    const candidate = fs.readFileSync(path.resolve(__dirname, '../../../../db/rollout/requests/issue-553.sql'), 'utf8')
    expect(candidate.replace(/^--[^\n]*\n/, '').trim()).toBe(expected.trim())
  })
})
