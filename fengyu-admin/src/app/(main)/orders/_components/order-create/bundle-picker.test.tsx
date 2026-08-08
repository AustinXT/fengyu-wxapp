import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BundlePicker } from './bundle-picker'
import type { OrderPickerBundle } from '@/actions/products'

// sonner toast：断言校验提示 + 避免真实渲染
const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}))

/**
 * 套餐夹具：一个「选3项」分组，含 1 个疗程卡 SKU + 1 个家居 SKU。
 * 无未分组、无全选组 → 加入套餐的 items 只来自该分组的数量选择。
 */
function makeBundle(): OrderPickerBundle {
  return {
    productId: 'B-01',
    name: '测试套餐',
    coverImage: null,
    price: '300.00',
    specialPrice: '270.00',
    sortOrder: 0,
    ungroupedSkus: [],
    groups: [
      {
        id: 1,
        groupName: '任选组',
        pickCount: 3,
        sortOrder: 0,
        skus: [
          {
            skuId: 'SKU-CARD',
            specName: '疗程卡A',
            productType: '疗程卡',
            sessionCount: 2,
            unit: '次',
            purchaseLimit: null,
            price: '100.00',
            bundlePrice: '90.00',
            bundleGroupId: 1,
            sortOrder: 0,
          },
          {
            skuId: 'SKU-HOME',
            specName: '家居B',
            productType: '家居产品',
            sessionCount: null,
            unit: '盒',
            purchaseLimit: null,
            price: '100.00',
            bundlePrice: '90.00',
            bundleGroupId: 1,
            sortOrder: 1,
          },
        ],
      },
    ],
  }
}

/** 取某 SKU 行的 [减, 加] 步进按钮 */
function steppersFor(specName: string): { minus: HTMLElement; plus: HTMLElement } {
  const row = screen.getByText(specName).parentElement as HTMLElement
  const btns = within(row).getAllByRole('button')
  return { minus: btns[0], plus: btns[1] }
}

describe('BundlePicker — 选N项按数量合计', () => {
  beforeEach(() => {
    toastError.mockClear()
    toastSuccess.mockClear()
  })

  it('渲染分组提示与步进器', () => {
    render(<BundlePicker bundles={[makeBundle()]} cart={[]} onAdd={() => {}} onBundleAdded={() => {}} />)
    expect(screen.getByText(/请选 3 项（已选 0\/3）/)).toBeInTheDocument()
    expect(screen.getByText('疗程卡A')).toBeInTheDocument()
    expect(screen.getByText('家居B')).toBeInTheDocument()
  })

  it('未满 pickCount 时加入被拦截，onBundleAdded 不触发', async () => {
    const onBundleAdded = vi.fn()
    render(<BundlePicker bundles={[makeBundle()]} cart={[]} onAdd={() => {}} onBundleAdded={onBundleAdded} />)

    await userEvent.click(steppersFor('疗程卡A').plus) // 合计 1，未满 3
    await userEvent.click(screen.getByRole('button', { name: '加入套餐' }))

    expect(onBundleAdded).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('需选 3 项'))
  })

  it('同一 SKU 选多次：A×2 + B×1 合计=3 → payload 按数量聚合', async () => {
    const onBundleAdded = vi.fn()
    render(<BundlePicker bundles={[makeBundle()]} cart={[]} onAdd={() => {}} onBundleAdded={onBundleAdded} />)

    const a = steppersFor('疗程卡A')
    await userEvent.click(a.plus)
    await userEvent.click(a.plus) // A = 2
    await userEvent.click(steppersFor('家居B').plus) // B = 1

    // 合计满 3
    expect(screen.getByText(/请选 3 项（已选 3\/3）/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '加入套餐' }))

    expect(onBundleAdded).toHaveBeenCalledTimes(1)
    const payload = onBundleAdded.mock.calls[0][0]
    expect(payload.bundleProductId).toBe('B-01')
    // 每个 SKU 聚合成一项，携带其数量（N 按数量统计，非种类数）
    expect(payload.items).toHaveLength(2)
    const byId = Object.fromEntries(
      payload.items.map((i: { sku: { skuId: string }; quantity: number }) => [i.sku.skuId, i.quantity]),
    )
    expect(byId['SKU-CARD']).toBe(2)
    expect(byId['SKU-HOME']).toBe(1)
    // 疗程卡次数透传（拆行/核销依赖），bundlePrice 写入 specialPrice
    const card = payload.items.find((i: { sku: { skuId: string } }) => i.sku.skuId === 'SKU-CARD').sku
    expect(card.sessionCount).toBe(2)
    expect(card.specialPrice).toBe('90.00')
  })

  it('合计达到 pickCount 后，加号按钮全部禁用（不能超选）', async () => {
    render(<BundlePicker bundles={[makeBundle()]} cart={[]} onAdd={() => {}} onBundleAdded={() => {}} />)

    const a = steppersFor('疗程卡A')
    await userEvent.click(a.plus)
    await userEvent.click(a.plus)
    await userEvent.click(a.plus) // A = 3，合计满

    expect(steppersFor('疗程卡A').plus).toBeDisabled()
    expect(steppersFor('家居B').plus).toBeDisabled()
  })

  it('减号可回退，低于 pickCount 后重新可加', async () => {
    render(<BundlePicker bundles={[makeBundle()]} cart={[]} onAdd={() => {}} onBundleAdded={() => {}} />)

    const a = steppersFor('疗程卡A')
    await userEvent.click(a.plus)
    await userEvent.click(a.plus)
    await userEvent.click(a.plus) // A = 3
    await userEvent.click(steppersFor('疗程卡A').minus) // A = 2，合计 2

    expect(screen.getByText(/已选 2\/3/)).toBeInTheDocument()
    expect(steppersFor('家居B').plus).not.toBeDisabled()
  })
})
