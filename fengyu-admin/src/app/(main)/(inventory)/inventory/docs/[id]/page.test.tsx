/**
 * 库存单据详情页 —— 盘点三列的**真实渲染**守护（issue #131）。
 *
 * 为什么非要渲染测试：`stocktake.ts` 的纯函数单测 + INV-06 的 DB 断言加起来，
 * 仍然挡不住「把详情页那三个 `<th>` / `<td>` 删掉」——只要 `isStocktake` 还被
 * 「盘点结论」或 min-width 用着，源码型守护和 helper 单测全都继续绿，
 * 而用户打开详情页只能看到原来的「数量」一列，直接违反 issue 的验收标准
 * 「盘点单详情页能看到账面数量与实盘数量的对照」。
 *
 * 页面是 async Server Component：直接 `await Page({params})` 拿到元素再交给 RTL 渲染。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { InventoryDocDetail } from '@/lib/inventory/types'

const { mockGetDoc, mockGetSession, mockRequireCaps } = vi.hoisted(() => ({
  mockGetDoc: vi.fn(),
  mockGetSession: vi.fn(),
  mockRequireCaps: vi.fn(),
}))

vi.mock('@/actions/inventory/docs', () => ({ getInventoryCoreDocById: mockGetDoc }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/lib/page-capability', () => ({ requireAllUiPageCapabilities: mockRequireCaps }))
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('notFound') },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
// 把 href 也渲染出来，否则断不了返回落点（与 allocations-page.test.tsx 对
// PreserveListContextLink 的既有 mock 写法一致）。
vi.mock('@/components/return-context', () => ({
  ReturnContextLink: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

import Page from './page'

function docFixture(overrides: Partial<InventoryDocDetail> = {}): InventoryDocDetail {
  return {
    id: 'MPD-20260916-0001',
    docType: '市场库存盘点',
    status: '已完成',
    sourceOrgNodeId: 'MARKET-1',
    targetOrgNodeId: 'MARKET-1',
    sourceOrgNodeName: '南昌凤御',
    targetOrgNodeName: '南昌凤御',
    docDate: '2026-09-16',
    totalQuantity: 14,
    remark: null,
    createdBy: 'INVT-ADM-01',
    lineage: [],
    fulfillmentProgress: null,
    items: [],
    ...overrides,
  } as unknown as InventoryDocDetail
}

function itemFixture(over: Record<string, unknown>) {
  return {
    id: 1,
    docId: 'MPD-20260916-0001',
    lotId: null,
    skuId: 'SKU-1',
    skuName: '测试商品',
    specName: null,
    supplier: null,
    productSeries: null,
    batchNo: '',
    expiryDate: null,
    isGift: false,
    quantity: 0,
    stockSnapshot: null,
    requestQuantity: null,
    fulfilledQuantity: null,
    promotionPlanId: null,
    promotionPlanNoSnapshot: null,
    createdAt: '2026-09-16T00:00:00.000Z',
    ...over,
  }
}

async function renderPage(
  doc: InventoryDocDetail,
  search: Record<string, string | undefined> = {},
) {
  mockGetDoc.mockResolvedValue(doc)
  render(await Page({
    params: Promise.resolve({ id: doc.id }),
    searchParams: Promise.resolve(search),
  }))
}

/** 明细表是页面最后一张表（前面还有血缘表）。 */
function itemTable(): HTMLElement {
  const tables = screen.getAllByRole('table')
  return tables[tables.length - 1]
}

/**
 * 按**表头名**取某一行的某一格。
 *
 * 不能只断「这一行里含某个文本」—— fixture 里批次ID/规格/批号/效期等列默认就是 `—`，
 * 「差异列是 —」那种断言会变成恒真。必须按列定位到具体单元格。
 */
function cellByHeader(skuId: string, header: string): string {
  const table = itemTable()
  const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent)
  const col = headers.indexOf(header)
  expect(col, `表头里找不到「${header}」`).toBeGreaterThanOrEqual(0)
  const row = within(table).getAllByRole('row').find((r) => within(r).queryByText(skuId))
  expect(row, `找不到 ${skuId} 的明细行`).toBeTruthy()
  return within(row!).getAllByRole('cell')[col].textContent ?? ''
}

describe('库存单据详情页 · 盘点三列（#131）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({ employeeId: 'E1' })
  })

  it('盘点单渲染「账面数量 / 实盘数量 / 差异」三列，且没有原来的「数量」列', async () => {
    await renderPage(docFixture({
      items: [itemFixture({ quantity: 9, stockSnapshot: 12 })],
    } as Partial<InventoryDocDetail>))

    expect(screen.getByRole('columnheader', { name: '账面数量' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '实盘数量' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '差异' })).toBeTruthy()
    expect(screen.queryByRole('columnheader', { name: '数量' })).toBeNull()
  })

  it('明细行同时给出账面、实盘与差异；盘亏带负号', async () => {
    await renderPage(docFixture({
      items: [itemFixture({ quantity: 9, stockSnapshot: 12 })],
    } as Partial<InventoryDocDetail>))

    expect(cellByHeader('SKU-1', '账面数量')).toBe('12')
    expect(cellByHeader('SKU-1', '实盘数量')).toBe('9')
    expect(cellByHeader('SKU-1', '差异')).toBe('-3')
  })

  it('盘盈带 + 号，相符显示 0，且每行用自己的账面数', async () => {
    // ⚠️ 两行的 stockSnapshot 必须**不同**：都写 12 的话，「所有行都拿 items[0] 的账面数」
    //    这种逐行映射损坏仍然会得到 +3 / 0，测试照样绿。
    await renderPage(docFixture({
      items: [
        itemFixture({ id: 1, skuId: 'SKU-UP', quantity: 15, stockSnapshot: 12 }),
        itemFixture({ id: 2, skuId: 'SKU-EQ', quantity: 4, stockSnapshot: 4 }),
      ],
    } as Partial<InventoryDocDetail>))

    expect(cellByHeader('SKU-UP', '账面数量')).toBe('12')
    expect(cellByHeader('SKU-UP', '差异')).toBe('+3')
    expect(cellByHeader('SKU-EQ', '账面数量')).toBe('4')
    expect(cellByHeader('SKU-EQ', '差异')).toBe('0')
  })

  it('历史单（账面为 NULL）差异显示「—」，不当 0 算成全额盘盈', async () => {
    await renderPage(docFixture({
      items: [itemFixture({ quantity: 7, stockSnapshot: null })],
    } as Partial<InventoryDocDetail>))

    // 按列精确定位：fixture 里批号/效期等列默认就是「—」，
    // 用「这一行含 —」去断言会变成恒真，守不住任何东西。
    expect(cellByHeader('SKU-1', '账面数量')).toBe('—')
    expect(cellByHeader('SKU-1', '差异')).toBe('—')
    expect(cellByHeader('SKU-1', '实盘数量')).toBe('7')
  })

  it('单头给出盘点结论', async () => {
    await renderPage(docFixture({
      items: [
        itemFixture({ id: 1, skuId: 'A', quantity: 15, stockSnapshot: 12 }),
        itemFixture({ id: 2, skuId: 'B', quantity: 9, stockSnapshot: 12 }),
        itemFixture({ id: 3, skuId: 'C', quantity: 12, stockSnapshot: 12 }),
        itemFixture({ id: 4, skuId: 'D', quantity: 7, stockSnapshot: null }),
      ],
    } as Partial<InventoryDocDetail>))

    expect(screen.getByText('盘点结论')).toBeTruthy()
    expect(screen.getByText('盘盈 1 项 / 盘亏 1 项 / 相符 1 项 / 未记账面 1 项')).toBeTruthy()
  })

  it('非盘点单不受影响：仍是单列「数量」，无三列、无盘点结论', async () => {
    await renderPage(docFixture({
      id: 'CGD-20260916-0001',
      docType: '采购订单',
      items: [itemFixture({ quantity: 9, stockSnapshot: 12 })],
    } as Partial<InventoryDocDetail>))

    expect(screen.getByRole('columnheader', { name: '数量' })).toBeTruthy()
    expect(screen.queryByRole('columnheader', { name: '账面数量' })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: '差异' })).toBeNull()
    expect(screen.queryByText('盘点结论')).toBeNull()
  })

  it('表头与数据格列数一致（防三列插错位置）', async () => {
    await renderPage(docFixture({
      items: [itemFixture({ quantity: 9, stockSnapshot: 12 })],
    } as Partial<InventoryDocDetail>))

    const table = itemTable()
    const headers = within(table).getAllByRole('columnheader')
    const row = within(table).getAllByRole('row').find((r) => within(r).queryByText('SKU-1'))
    expect(within(row!).getAllByRole('cell')).toHaveLength(headers.length)
  })
})

/**
 * 返回入口（#190「点单据号、新标签打开，返回要求仍然可以返回到原来的页面」）。
 *
 * 首选是点击时 window.close() 回到原标签（办理台表单一个字不丢），href 是关不掉时的降级落点。
 * 这里断的是**降级落点与文案**，以及最关键的一条：脏来源绝不能被回显成跳转目标。
 */
describe('库存单据详情页 · 返回入口（#190）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({ employeeId: 'E1' })
  })

  function backLink(): HTMLAnchorElement {
    const link = screen.getAllByRole('link').find((a) => (a.textContent ?? '').includes('返回'))
    expect(link, '找不到返回入口').toBeTruthy()
    return link as HTMLAnchorElement
  }

  it('带合法来源时落到办理台，文案点名层级', async () => {
    await renderPage(docFixture(), { from: 'operations', level: 'market', op: 'market-report' })
    const link = backLink()
    expect(link.textContent).toContain('返回市场办理台')
    expect(link.getAttribute('href')).toBe('/inventory/operations/market?op=market-report&tab=docs')
  })

  it.each([
    ['supply-chain', '返回供应链办理台'],
    ['market', '返回市场办理台'],
    ['store', '返回门店办理台'],
  ])('%s 的文案是「%s」', async (level, label) => {
    await renderPage(docFixture(), { from: 'operations', level, op: 'store-request' })
    expect(backLink().textContent).toContain(label)
  })

  it('level 是脏值时回落到单据中心（开放重定向的端到端护栏）', async () => {
    // ⚠️ 这条必须有：白名单一旦被放宽，页面照常渲染，只是返回按钮把人送去外站。
    await renderPage(docFixture(), { from: 'operations', level: 'https://evil.example', op: 'market-report' })
    const link = backLink()
    expect(link.textContent).toContain('返回')
    expect(link.textContent).not.toContain('办理台')
    expect(link.getAttribute('href')).toBe('/inventory/docs')
  })

  it('不带任何来源参数时仍是原来的「返回单据中心」', async () => {
    await renderPage(docFixture())
    const link = backLink()
    expect(link.textContent).not.toContain('办理台')
    expect(link.getAttribute('href')).toBe('/inventory/docs')
  })
})
