import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getViewConfig, PgDialect } from 'drizzle-orm/pg-core'
import { saleReportablePaymentEvents, saleReportableItemEvents } from '@db/order'

// 正式迁移由真库套件执行；锁住 schema、候选、正式 SQL 与 snapshot 的一致性。
const root = path.resolve(__dirname, '../../../..')
const renderViews = () => {
  const dialect = new PgDialect()
  return [saleReportablePaymentEvents, saleReportableItemEvents].map(view => {
    const config = getViewConfig(view)
    const query = dialect.sqlToQuery(config.query!)
    expect(query.params).toEqual([])
    return { name: config.name, definition: query.sql, ddl: `CREATE OR REPLACE VIEW "public"."${config.name}" AS (${query.sql}\n);` }
  })
}

describe('#553 体验资格视图正式交付', () => {
  it('两份候选 CREATE OR REPLACE 与实际 schema 逐字相等且没有参数', () => {
    const expected = renderViews().map(v => v.ddl).join('\n\n')
    const candidate = fs.readFileSync(path.resolve(__dirname, '../../../../db/rollout/requests/issue-553.sql'), 'utf8')
    expect(candidate.replace(/^--[^\n]*\n/, '').trim()).toBe(expected.trim())
  })

  it('正式迁移两视图与 schema 逐字相等；只替换视图，不删除依赖或改资金', () => {
    const source = fs.readFileSync(path.join(root, 'db/migrations/0064_experience_performance_only_trial.sql'), 'utf8')
    const views = [...source.matchAll(/CREATE OR REPLACE VIEW "public"\."(sale_reportable_(?:payment|item)_events)" AS \([\s\S]*?\n\);/g)]
    expect(views).toHaveLength(2)
    expect(views.map(v => v[0])).toEqual(renderViews().map(v => v.ddl))
    const outside = views.reduce((text, match) => text.replace(match[0], ''), source).replace(/--[^\n]*/g, '').trim()
    expect(outside).toBe("SET LOCAL lock_timeout = '3s';")
  })

  it('正式 snapshot 采用当前 schema 的视图定义，旧非视图结构和依赖链不变', () => {
    const previous = JSON.parse(fs.readFileSync(path.join(root, 'db/migrations/meta/0063_snapshot.json'), 'utf8'))
    const current = JSON.parse(fs.readFileSync(path.join(root, 'db/migrations/meta/0064_snapshot.json'), 'utf8'))
    expect(current.prevId).toBe(previous.id)
    for (const key of Object.keys(previous).filter(k => !['id', 'prevId', 'views'].includes(k))) {
      expect(current[key], key).toEqual(previous[key])
    }
    const views = renderViews()
    for (const view of views) expect(current.views['public.' + view.name].definition.trim()).toBe(view.definition.trim())
    for (const name of Object.keys(previous.views).filter(n => !views.some(v => 'public.' + v.name === n))) {
      expect(current.views[name], name).toEqual(previous.views[name])
    }
  })
})
