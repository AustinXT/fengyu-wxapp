import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Sidebar } from './sidebar'
import type { AuthSession } from '@/lib/types'

let pathname = '/dashboard'

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}))

vi.mock('next/image', () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a>,
}))

vi.mock('@/generated/version', () => ({
  APP_VERSION: 'test',
  APP_COMMIT: '',
  BUILD_TIME: 'test',
}))

vi.mock('@/lib/inventory-feature-flags', () => ({
  INVENTORY_ENTRY_ENABLED: true,
  INVENTORY_LINKAGE_ENABLED: true,
}))

const session: AuthSession = {
  employeeId: 'test',
  name: '测试管理员',
  phone: '13800000000',
  roles: [{ role: 'admin', scopeId: 'all', scopeType: '总部' }],
  permissions: {
    actions: [
      'dashboard:view', 'sale_order:list', 'sale_order:create', 'legacy_order:list', 'allocation:list',
      'sale_order:refund_create', 'service:list', 'appointment:list', 'pickup_record:list', 'store_unbind:list',
      'customer:list', 'sale_item:list', 'coupon:list', 'system:config', 'point_transaction:list', 'card_transaction:list',
      'product:create', 'inventory:list', 'inventory:stock_list', 'org:create', 'store:create', 'merchant:list',
      'inventory:supply_chain_operate', 'inventory:supply_chain_master_data_manage',
      'employee:create', 'commission:list', 'data_center:dashboard', 'permission:list', 'message:list', 'operation_log:list',
    ],
    scopeStoreIds: [],
  },
}

describe('Sidebar 二级菜单', () => {
  beforeEach(() => {
    pathname = '/dashboard'
  })

  it('访问子页时自动展开所属业务域并高亮叶子项', () => {
    pathname = '/inventory/suppliers'
    render(<Sidebar collapsed={false} onToggle={() => {}} session={session} />)

    expect(screen.getByRole('button', { name: '库存管理' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: '资料配置' })).toHaveClass('text-[var(--primary)]')
  })

  it('展开一个业务域会收起另一个业务域', async () => {
    const user = userEvent.setup()
    render(<Sidebar collapsed={false} onToggle={() => {}} session={session} />)

    await user.click(screen.getByRole('button', { name: '经营业务' }))
    expect(screen.getByRole('link', { name: '订单管理' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '客户运营' }))
    expect(screen.queryByRole('link', { name: '订单管理' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '顾客管理' })).toBeVisible()
  })

  it('折叠态点击库存管理显示二级菜单，Escape 关闭浮层', async () => {
    const user = userEvent.setup()
    render(<Sidebar collapsed onToggle={() => {}} session={session} />)

    const trigger = screen.getByRole('button', { name: '库存管理' })
    await user.click(trigger)
    expect(screen.getByRole('menu')).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '供应链业务' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  // 数据中心 4 板块（#212）：路径化是高亮正确的前提——itemMatchesPath 只比 pathname，
  // 若退回 `/data-center?tab=` 方案，4 个子项会同时命中高亮。
  it('访问数据中心板块时展开该域，只高亮当前板块', () => {
    pathname = '/data-center/customer'
    render(<Sidebar collapsed={false} onToggle={() => {}} session={session} />)

    expect(screen.getByRole('button', { name: '数据中心' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: '客量' })).toHaveClass('text-[var(--primary)]')
    for (const label of ['销售', '人效', '品项']) {
      expect(screen.getByRole('link', { name: label })).not.toHaveClass('text-[var(--primary)]')
    }
  })

  it('折叠态点击数据中心弹出 4 个板块浮层', async () => {
    const user = userEvent.setup()
    render(<Sidebar collapsed onToggle={() => {}} session={session} />)

    await user.click(screen.getByRole('button', { name: '数据中心' }))
    for (const label of ['销售', '客量', '人效', '品项']) {
      expect(screen.getByRole('menuitem', { name: label })).toBeVisible()
    }
  })

  it('无 data_center:dashboard 权限时整组消失', () => {
    const noDataCenter: AuthSession = {
      ...session,
      permissions: {
        ...session.permissions,
        actions: session.permissions.actions.filter((a) => a !== 'data_center:dashboard'),
      },
    }
    render(<Sidebar collapsed={false} onToggle={() => {}} session={noDataCenter} />)

    expect(screen.queryByRole('button', { name: '数据中心' })).not.toBeInTheDocument()
  })
})
