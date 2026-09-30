import { describe, expect, it } from 'vitest'
import { checkBusinessErrorProbe, checkForeignKeyInputs } from './ux-audit'

const now = Date.parse('2026-09-30T08:00:00.000Z')
const page = '/inventory/docs → 新建库存单据（期初门禁）'

describe('INV-10 审计证据', () => {
  it('新建档案的名称是自由文本，真正的供货商引用仍报告', () => {
    const controls = ['供应商名称 *', '方案名称 *', '供货商 *'].map((label) => ({
      label, tag: 'input', required: true, labelBound: true,
    }))
    expect(checkForeignKeyInputs(controls, '/inventory')).toEqual([
      expect.objectContaining({ rule: '外键类字段应提供选择器', evidence: 'label="供货商 *" control=<input>' }),
    ])
  })

  it('本轮可读业务反馈不会产生脱敏 P1', () => {
    expect(checkBusinessErrorProbe({ at: new Date(now).toISOString(), page, blocked: true,
      visibleText: '库存期初尚未导入并核验完成，暂不可办理库存业务' }, now)).toEqual([])
  })

  it('本轮复现脱敏文案时记录页面、原文和时效', () => {
    const findings = checkBusinessErrorProbe({ at: new Date(now).toISOString(), page, blocked: true,
      visibleText: 'An error occurred in the Server Components render.' }, now)
    expect(findings).toEqual([expect.objectContaining({ severity: 'P1', page,
      evidence: expect.stringContaining('An error occurred in the Server Components render.') })])
  })

  it('无证据或过期证据只报未覆盖', () => {
    expect(checkBusinessErrorProbe(null, now)[0]).toMatchObject({ severity: 'P2', rule: '业务错误提示未覆盖' })
    expect(checkBusinessErrorProbe({ at: new Date(now - 7 * 3600_000).toISOString(), page,
      blocked: true, visibleText: 'digest 1956068727' }, now)[0])
      .toMatchObject({ severity: 'P2', rule: '业务错误提示证据过期未复核' })
  })
})
