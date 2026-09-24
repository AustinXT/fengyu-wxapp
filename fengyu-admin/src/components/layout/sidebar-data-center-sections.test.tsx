import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AuthSession } from '@/lib/types'

/**
 * 「数据中心」分段菜单（#367）。本单只交付骨架，报表入口在 reports.ts 里是 `menu.enabled=false`；
 * 这里把入口全部打开，验证各页面单合入后的形态：分段小标题出现、点击只高亮当前项、
 * 提成明细（下钻页）高亮员工提成日报、没有专用权限点的账号看不到对应入口。
 */

let pathname = '/dashboard'

vi.mock('next/navigation', () => ({ usePathname: () => pathname }))
vi.mock('next/image', () => ({ default: ({ alt }: { alt: string }) => <img alt={alt} /> }))
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a>,
}))
vi.mock('@/generated/version', () => ({ APP_VERSION: 'test', APP_COMMIT: '', BUILD_TIME: 'test' }))
vi.mock('@/lib/data-center/reports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/data-center/reports')>()
  return {
    ...actual,
    DATA_CENTER_REPORT_LIST: actual.DATA_CENTER_REPORT_LIST.map((report) => (
      report.menu ? { ...report, menu: { ...report.menu, enabled: true } } : report
    )),
  }
})

import { Sidebar } from './sidebar'

function session(actions: string[]): AuthSession {
  return {
    employeeId: 'test',
    name: '测试财务',
    phone: '13800000000',
    roles: [{ role: 'finance', scopeId: 'hq', scopeType: '总部' }],
    permissions: { actions, scopeStoreIds: [] },
  }
}

const full = session(['data_center:dashboard', 'data_center:customer_detail', 'data_center:staff_commission'])
const dashboardOnly = session(['data_center:dashboard'])

const REPORT_LABELS = ['日常数据一览表', '顾客频率表', '顾客剩余卡项清单', '经营数据主表', '员工提成日报']

beforeEach(() => {
  pathname = '/data-center/customer-frequency'
})

describe('数据中心分段菜单', () => {
  it('入口打开后按「看板 / 经营明细 / 员工收入」分段，顺序与登记一致', () => {
    render(<Sidebar collapsed={false} onToggle={() => {}} session={full} />)

    const region = document.getElementById('sidebar-group-数据中心')!
    const texts = Array.from(region.children).map((el) => el.textContent)
    expect(texts).toEqual([
      '看板', '销售', '客量', '人效', '品项',
      '经营明细', '日常数据一览表', '顾客频率表', '顾客剩余卡项清单', '经营数据主表',
      '员工收入', '员工提成日报',
    ])
  })

  it('点击只高亮当前项', () => {
    render(<Sidebar collapsed={false} onToggle={() => {}} session={full} />)

    expect(screen.getByRole('link', { name: '顾客频率表' })).toHaveClass('text-[var(--primary)]')
    for (const label of ['销售', '客量', ...REPORT_LABELS.filter((l) => l !== '顾客频率表')]) {
      expect(screen.getByRole('link', { name: label })).not.toHaveClass('text-[var(--primary)]')
    }
  })

  it('提成明细（不进菜单的下钻页）高亮员工提成日报', () => {
    pathname = '/data-center/commission-daily/detail'
    render(<Sidebar collapsed={false} onToggle={() => {}} session={full} />)

    expect(screen.queryByRole('link', { name: '提成明细' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '员工提成日报' })).toHaveClass('text-[var(--primary)]')
  })

  it('只有 dashboard 的账号：看不到顾客明细 / 员工提成入口，只剩两个分段时仍显示小标题', () => {
    pathname = '/data-center/sales'
    render(<Sidebar collapsed={false} onToggle={() => {}} session={dashboardOnly} />)

    for (const label of ['顾客频率表', '顾客剩余卡项清单', '员工提成日报']) {
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument()
    }
    const region = document.getElementById('sidebar-group-数据中心')!
    expect(Array.from(region.children).map((el) => el.textContent)).toEqual([
      '看板', '销售', '客量', '人效', '品项', '经营明细', '日常数据一览表', '经营数据主表',
    ])
  })

  it('折叠态浮层同样分段', async () => {
    const user = userEvent.setup()
    render(<Sidebar collapsed onToggle={() => {}} session={full} />)

    await user.click(screen.getByRole('button', { name: '数据中心' }))
    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('经营明细')).toBeVisible()
    expect(within(menu).getByText('员工收入')).toBeVisible()
    expect(within(menu).getByRole('menuitem', { name: '员工提成日报' })).toBeVisible()
  })
})
