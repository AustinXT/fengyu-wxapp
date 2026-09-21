import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  INVENTORY_BUSINESS_LEVEL_LABELS,
  forwardInventoryDocReturn,
  inventoryOperationDocHref,
  parseInventoryOperationId,
  parseInventoryOperationsTab,
  resolveInventoryDocReturn,
} from './operation-return'
import { INVENTORY_OPERATION_IDS, genericOperationId } from './operation-doc-types'
import { INVENTORY_BUSINESS_LEVELS } from './business-level'
import { INVENTORY_GENERIC_DOC_TYPES } from './types'

/**
 * 办理台 ⇄ 单据详情的来源参数（#190）。
 *
 * 这个模块的全部价值是「把开放重定向的入口面压到零」：它不接收也不回显完整 URL，
 * 外部能注入的只有两个闭集枚举，路径由模块自己拼。所以这里的断言分两类 ——
 * **正向能拼对**，以及**任何脏值都回落到不渲染返回入口**。
 */
describe('resolveInventoryDocReturn（#190 返回入口）', () => {
  it('合法来源解析出办理台落点与文案', () => {
    expect(resolveInventoryDocReturn({ from: 'operations', level: 'market', op: 'market-report' }))
      .toEqual({
        href: '/inventory/operations/market?op=market-report&tab=docs',
        label: '返回市场办理台',
      })
  })

  it('三个层级各自的文案', () => {
    for (const level of INVENTORY_BUSINESS_LEVELS) {
      const back = resolveInventoryDocReturn({ from: 'operations', level, op: 'store-request' })
      expect(back?.label).toBe(`返回${INVENTORY_BUSINESS_LEVEL_LABELS[level]}办理台`)
      expect(back?.href.startsWith(`/inventory/operations/${level}?`)).toBe(true)
    }
  })

  it.each(INVENTORY_OPERATION_IDS)('内置业务 %s 能解析出办理台 href', (op) => {
    // 防将来加卡片漏白名单：漏了的话那张卡产出的单据，返回入口会静默退化成「返回单据中心」。
    const back = resolveInventoryDocReturn({ from: 'operations', level: 'market', op })
    expect(back?.href.startsWith('/inventory/operations/')).toBe(true)
    expect(back?.href).toContain(`op=${encodeURIComponent(op)}`)
  })

  it.each(INVENTORY_GENERIC_DOC_TYPES)('通用建单业务 generic:%s 也在白名单内', (docType) => {
    // 通用卡的 id 不在 INVENTORY_OPERATION_IDS 里。只查那张表的话，10 张通用卡
    // 产出的单据全都返回不回办理台 —— 而且看起来一切正常。
    const op = genericOperationId(docType)
    const back = resolveInventoryDocReturn({ from: 'operations', level: 'store', op })
    expect(back?.href.startsWith('/inventory/operations/store?')).toBe(true)
  })

  it('level 的脏值一律回落（开放重定向拒绝用例）', () => {
    for (const level of [
      'https://evil.example',
      '//evil.example',
      '../../login',
      'toString',          // 原型链成员：用 `in` 判白名单会放行
      '__proto__',
      'constructor',
      'hasOwnProperty',
      '',
      undefined,
    ]) {
      expect(
        resolveInventoryDocReturn({ from: 'operations', level, op: 'market-report' }),
        `level=${String(level)} 不该通过白名单`,
      ).toBeNull()
    }
  })

  it('op 的脏值一律回落', () => {
    for (const op of [
      'javascript:alert(1)',
      '../../../etc',
      'generic:品项公司发货',  // 业务单类型，不在通用建单白名单里
      'generic:',
      'toString',
      '',
      undefined,
    ]) {
      expect(
        resolveInventoryDocReturn({ from: 'operations', level: 'market', op }),
        `op=${String(op)} 不该通过白名单`,
      ).toBeNull()
    }
  })

  it('from 不是 operations 时回落（含大小写变体）', () => {
    for (const from of [undefined, '', 'Operations', 'OPERATIONS', 'docs']) {
      expect(resolveInventoryDocReturn({ from, level: 'market', op: 'market-report' })).toBeNull()
    }
  })

  it('整个 query 缺失时不抛（详情页单测有不传 searchParams 的调用）', () => {
    expect(resolveInventoryDocReturn(undefined)).toBeNull()
    expect(resolveInventoryDocReturn(null)).toBeNull()
    expect(resolveInventoryDocReturn({})).toBeNull()
  })
})

describe('inventoryOperationDocHref（#190 来源参数）', () => {
  it('三个 query 键齐全，docId 经过 encodeURIComponent', () => {
    const href = inventoryOperationDocHref('CGD-20260916-0001', 'market', 'market-report')
    expect(href).toBe('/inventory/docs/CGD-20260916-0001?from=operations&level=market&op=market-report')
  })

  it('通用业务 id 里的冒号与中文被正确编码', () => {
    const href = inventoryOperationDocHref('MPD-1', 'store', genericOperationId('院产品报损'))
    // 编码后仍能被详情页原样解回来（URLSearchParams 解码 → 白名单）
    const query = new URLSearchParams(href.slice(href.indexOf('?') + 1))
    expect(resolveInventoryDocReturn({
      from: query.get('from') ?? undefined,
      level: query.get('level') ?? undefined,
      op: query.get('op') ?? undefined,
    })).toEqual({
      href: `/inventory/operations/store?op=${encodeURIComponent('generic:院产品报损')}&tab=docs`,
      label: '返回门店办理台',
    })
  })

  it('docId 里的路径分隔符不会逃出 /inventory/docs/', () => {
    expect(inventoryOperationDocHref('../../login', 'market', 'market-report'))
      .toContain('/inventory/docs/..%2F..%2Flogin?')
  })
})

describe('办理台恢复侧的解析（#190）', () => {
  it('parseInventoryOperationId 与详情页共用同一道白名单', () => {
    expect(parseInventoryOperationId('market-report')).toBe('market-report')
    expect(parseInventoryOperationId(genericOperationId('市场产品报损'))).toBe('generic:市场产品报损')
    expect(parseInventoryOperationId('generic:品项公司发货')).toBeNull()
    expect(parseInventoryOperationId('toString')).toBeNull()
    expect(parseInventoryOperationId(null)).toBeNull()
    expect(parseInventoryOperationId(undefined)).toBeNull()
  })

  it('tab 只认 docs，其余一律回填报表单', () => {
    expect(parseInventoryOperationsTab('docs')).toBe('docs')
    for (const value of ['form', 'Docs', '', 'anything', null, undefined]) {
      expect(parseInventoryOperationsTab(value)).toBe('form')
    }
  })
})

describe('forwardInventoryDocReturn（血缘透传，当前未接线）', () => {
  it('来源合法时回显的是校验后的值', () => {
    expect(forwardInventoryDocReturn('CGD-2', { from: 'operations', level: 'market', op: 'market-report' }))
      .toBe('/inventory/docs/CGD-2?from=operations&level=market&op=market-report')
  })

  it('来源非法时只给裸详情页路径，不把脏值写进 href', () => {
    expect(forwardInventoryDocReturn('CGD-2', { from: 'operations', level: '//evil.example', op: 'market-report' }))
      .toBe('/inventory/docs/CGD-2')
    expect(forwardInventoryDocReturn('CGD-2', undefined)).toBe('/inventory/docs/CGD-2')
  })
})

describe('operation-return 的模块纯净度（客户端 bundle 守护）', () => {
  const source = readFileSync(resolve(__dirname, 'operation-return.ts'), 'utf8')

  it('对 business-level 只能 import type', () => {
    // 值导入会把 business-level → @/lib/permissions → @/db 拖进客户端 bundle
    // （本模块被 'use client' 的 inventory-operations-page.tsx 值导入）。
    // 这类回归 tsc 不报、单测不报，只有 bun run build 才炸。
    expect(source).toMatch(/import type \{[^}]*\} from '\.\/business-level'/)
    expect(source).not.toMatch(/^import \{[^}]*\} from '\.\/business-level'/m)
  })

  it('不接收也不回显完整 URL（开放重定向零入口面）', () => {
    // 一旦有人加了 `returnTo` / `redirect` 之类的入参，白名单就形同虚设。
    // 注释里会提到这些词（讲的正是「别这么干」），所以先把注释剥掉再断言代码本身。
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(code).not.toMatch(/returnTo/)
    expect(code).not.toMatch(/\bredirect\b/)
  })
})
