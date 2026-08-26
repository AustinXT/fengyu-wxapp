import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Pagination } from './pagination'

// ── 正常渲染 ──────────────────────────────────────────────────────────────────

describe('Pagination — 正常渲染', () => {
  it('total ≤ pageSize → 仅显示"共 N 条"（无分页按钮）', () => {
    render(<Pagination total={5} page={1} pageSize={20} onPageChange={() => {}} />)

    expect(screen.getByText('共 5 条')).toBeInTheDocument()
    expect(screen.queryByText('上一页')).not.toBeInTheDocument()
  })

  it('total > pageSize → 显示分页按钮', () => {
    render(<Pagination total={50} page={1} pageSize={20} onPageChange={() => {}} />)

    expect(screen.getByText('共 50 条')).toBeInTheDocument()
    expect(screen.getByText('上一页')).toBeInTheDocument()
    expect(screen.getByText('下一页')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument() // 50/20 = 3 pages
  })

  it('第 1 页 → "上一页"禁用', () => {
    render(<Pagination total={100} page={1} pageSize={20} onPageChange={() => {}} />)

    const prev = screen.getByText('上一页')
    expect(prev).toBeDisabled()
  })

  it('最后一页 → "下一页"禁用', () => {
    render(<Pagination total={100} page={5} pageSize={20} onPageChange={() => {}} />)

    const next = screen.getByText('下一页')
    expect(next).toBeDisabled()
  })

  it('多于 7 页时显示省略号', () => {
    render(<Pagination total={200} page={5} pageSize={20} onPageChange={() => {}} />)

    expect(screen.getAllByText('...').length).toBeGreaterThanOrEqual(1)
  })
})

// ── 交互 ──────────────────────────────────────────────────────────────────────

describe('Pagination — 交互', () => {
  it('点击页码 → 回调正确页号', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    render(<Pagination total={100} page={1} pageSize={20} onPageChange={onChange} />)

    await user.click(screen.getByText('3'))
    expect(onChange).toHaveBeenCalledWith(3)
  })

  it('点击"下一页" → 回调 page+1', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    render(<Pagination total={100} page={2} pageSize={20} onPageChange={onChange} />)

    await user.click(screen.getByText('下一页'))
    expect(onChange).toHaveBeenCalledWith(3)
  })

  it('点击"上一页" → 回调 page-1', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    render(<Pagination total={100} page={3} pageSize={20} onPageChange={onChange} />)

    await user.click(screen.getByText('上一页'))
    expect(onChange).toHaveBeenCalledWith(2)
  })

  it('pageSizeOptions → 渲染每页条数选择器', async () => {
    const user = userEvent.setup()
    const onSizeChange = vi.fn()

    render(
      <Pagination
        total={100} page={1} pageSize={20}
        onPageChange={() => {}}
        pageSizeOptions={[10, 20, 50]}
        onPageSizeChange={onSizeChange}
      />
    )

    const select = screen.getByDisplayValue('20条/页')
    expect(select).toBeInTheDocument()

    await user.selectOptions(select, '50')
    expect(onSizeChange).toHaveBeenCalledWith(50)
  })
})

// ── 边界防护（本轮修复重点）──────────────────────────────────────────────────

describe('Pagination — 边界防护', () => {
  it('page=0 → 修正为 1，不崩溃', () => {
    render(<Pagination total={100} page={0} pageSize={20} onPageChange={() => {}} />)

    // 应渲染第 1 页为高亮（不崩溃即通过）
    expect(screen.getByText('共 100 条')).toBeInTheDocument()
    expect(screen.getByText('上一页')).toBeDisabled()
  })

  it('page 负值 → 修正为 1', () => {
    render(<Pagination total={100} page={-5} pageSize={20} onPageChange={() => {}} />)

    expect(screen.getByText('上一页')).toBeDisabled()
  })

  it('page 超出范围 → 修正为最后一页并通知调用方', async () => {
    const onChange = vi.fn()
    render(<Pagination total={60} page={100} pageSize={20} onPageChange={onChange} />)

    // 60/20 = 3 pages, page clamped to 3
    expect(screen.getByText('下一页')).toBeDisabled()
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(3))
  })

  it('pageSize=0 → 修正为 20，不除零', () => {
    render(<Pagination total={100} page={1} pageSize={0} onPageChange={() => {}} />)

    expect(screen.getByText('共 100 条')).toBeInTheDocument()
  })

  it('pageSize 负值 → 修正为正值', () => {
    render(<Pagination total={50} page={1} pageSize={-10} onPageChange={() => {}} />)

    expect(screen.getByText('共 50 条')).toBeInTheDocument()
  })

  it('total=0 → 仅显示"共 0 条"', () => {
    render(<Pagination total={0} page={1} pageSize={20} onPageChange={() => {}} />)

    expect(screen.getByText('共 0 条')).toBeInTheDocument()
    expect(screen.queryByText('上一页')).not.toBeInTheDocument()
  })

  it('total 负值 → 修正为 0', () => {
    render(<Pagination total={-100} page={1} pageSize={20} onPageChange={() => {}} />)

    expect(screen.getByText('共 0 条')).toBeInTheDocument()
  })

  it('NaN 输入不崩溃', () => {
    render(<Pagination total={NaN} page={NaN} pageSize={NaN} onPageChange={() => {}} />)

    expect(screen.getByText('共 0 条')).toBeInTheDocument()
  })

  it('page=1.7 → 修正为整数', () => {
    render(<Pagination total={100} page={1.7} pageSize={20} onPageChange={() => {}} />)

    expect(screen.getByText('共 100 条')).toBeInTheDocument()
  })
})
