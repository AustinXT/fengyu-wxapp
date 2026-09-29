import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rows, queries } = vi.hoisted(() => ({
  rows: [] as Array<[string, string, string | null, boolean | null]>,
  queries: [] as Array<{ sql: string; params: unknown[] }>,
}))
vi.mock('@/db', async () => {
  const { drizzle } = await import('drizzle-orm/pg-proxy')
  return { db: drizzle(async (sql, params) => { queries.push({ sql, params }); return { rows } }) }
})
import { scopeExportMeta } from './scope-meta'

beforeEach(() => { rows.length = 0; queries.length = 0 })
describe('#296 多店范围完整性', () => {
  it('市场/单店/全部范围无新增查询', async () => {
    expect(await scopeExportMeta({ type: 'market', id: 'M1' }, '南昌')).toEqual({ scope: '市场 · 南昌' })
    expect(await scopeExportMeta({ type: 'store', id: 'S1' }, '甲店')).toEqual({ scope: '门店 · 甲店' })
    expect(await scopeExportMeta({ type: 'all' }, '全部')).toEqual({ scope: '全部' })
    expect(queries).toEqual([])
  })
  it('200 家全名单不截断，按用户选择顺序；启用节点的关店不计停用', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `S${i + 1}`)
    rows.push(...ids.map((id, i): [string, string, string, boolean] => [id, `门店${i + 1}`, '门店', i !== 199]).reverse())
    const meta = await scopeExportMeta({ type: 'stores', ids }, '門店1、門店2、門店3 等 200 家门店')
    expect(meta.extra).toContainEqual({ label: '所选门店', value: ids.map((_, i) => `门店${i + 1}`).join('、') })
    expect(meta.extra).toContainEqual({ label: '范围提示', value: '1 家已停用未计入' })
    expect(queries).toHaveLength(1)
    expect(queries[0].params).toEqual(ids)
    expect(queries[0].sql).toContain('"is_active"')
    expect(queries[0].sql).not.toMatch(/is_closed|closed_at/)
  })
  it('全在营不显示停用提示；全停用如实提示全部未计入', async () => {
    rows.push(['S1', '甲店', '门店', true], ['S2', '乙店', '门店', true])
    const scope = { type: 'stores', ids: ['S1', 'S2'] } as const
    // Scope ids 在生产由 parser 构造为可变数组。
    const input = { type: scope.type, ids: [...scope.ids] }
    expect((await scopeExportMeta(input, '甲店、乙店')).extra).toEqual([{ label: '所选门店', value: '甲店、乙店' }])
    rows[0][3] = false; rows[1][3] = false
    expect((await scopeExportMeta(input, '甲店、乙店')).extra).toContainEqual({ label: '范围提示', value: '2 家已停用未计入' })
  })
  it.each([null, '市场'])('组织映射异常（%s）拒绝，不编造停用状态', async nodeType => {
    rows.push(['S1', '甲店', '门店', true], ['S2', '乙店', nodeType, null])
    await expect(scopeExportMeta({ type: 'stores', ids: ['S1', 'S2'] }, '甲店、乙店')).rejects.toThrow('INVALID_STATE')
  })
})
