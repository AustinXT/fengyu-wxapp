import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DataStartNotice } from './data-start-notice'

const range = { start: '2026-08-01', end: '2026-08-31' }

describe('DataStartNotice', () => {
  it('空结果、空分组、空门店都不渲染（#289 自行拼结果时不崩、不出半句提示）', () => {
    const { container } = render(
      <DataStartNotice
        results={[
          { label: '所选期间', range, groups: [] },
          { label: '较上期基期', range, groups: [{ axis: 'service', marketId: 'M1', marketName: '南昌', stores: [] }] },
        ]}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('首条逐市场列出，其余期间一句概述并按门店去重计数', () => {
    render(
      <DataStartNotice
        results={[
          {
            label: '所选期间',
            range,
            groups: [{ axis: 'performance', marketId: 'M1', marketName: '南昌', stores: [
              { storeId: 'S1', storeName: '蓝莱店', start: '2026-08-08' },
              { storeId: 'S2', storeName: '绿湖店', start: '2026-08-12' },
            ] }],
          },
          {
            label: '较上期基期',
            range: { start: '2026-07-01', end: '2026-07-31' },
            groups: [
              { axis: 'performance', marketId: 'M1', marketName: '南昌', stores: [{ storeId: 'S1', storeName: '蓝莱店', start: '2026-08-08' }] },
              { axis: 'service', marketId: 'M1', marketName: '南昌', stores: [{ storeId: 'S1', storeName: '蓝莱店', start: '2026-08-08' }] },
            ],
          },
        ]}
      />,
    )
    const note = screen.getByRole('note', { name: '数据起点提示' })
    expect(note).toHaveTextContent('业绩 · 南昌 2 家（2026-08-08 ~ 2026-08-12 起）')
    expect(note).toHaveTextContent('较上期基期（2026-07-01 ~ 2026-07-31）同样早于数据起点（涉及 1 家门店）')
  })
})
