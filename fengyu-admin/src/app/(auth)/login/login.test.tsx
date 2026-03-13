import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Mock next/navigation
const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

// Mock sonner
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

import LoginPage from './page'

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('渲染标题和表单元素', () => {
    render(<LoginPage />)
    expect(screen.getByText('凤御美业管理后台')).toBeInTheDocument()
    expect(screen.getByLabelText('手机号')).toBeInTheDocument()
    expect(screen.getByLabelText('密码')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /登 录/ })).toBeInTheDocument()
  })

  it('空手机号提交显示错误', async () => {
    const user = userEvent.setup()
    render(<LoginPage />)
    await user.click(screen.getByRole('button', { name: /登 录/ }))
    expect(screen.getByText('请输入手机号')).toBeInTheDocument()
  })

  it('只填手机号空密码显示错误', async () => {
    const user = userEvent.setup()
    render(<LoginPage />)
    await user.type(screen.getByLabelText('手机号'), '13800138000')
    await user.click(screen.getByRole('button', { name: /登 录/ }))
    expect(screen.getByText('请输入密码')).toBeInTheDocument()
  })

  it('非法手机号格式显示错误', async () => {
    const user = userEvent.setup()
    render(<LoginPage />)
    await user.type(screen.getByLabelText('手机号'), '2380013800')
    await user.type(screen.getByLabelText('密码'), 'admin123')
    await user.click(screen.getByRole('button', { name: /登 录/ }))
    expect(screen.getByText('请输入正确的手机号')).toBeInTheDocument()
  })

  it('密码错误显示错误提示', async () => {
    const user = userEvent.setup()
    render(<LoginPage />)
    await user.type(screen.getByLabelText('手机号'), '13800138000')
    await user.type(screen.getByLabelText('密码'), 'wrong')
    await user.click(screen.getByRole('button', { name: /登 录/ }))
    await waitFor(() => {
      expect(screen.getByText('手机号或密码错误')).toBeInTheDocument()
    })
  })

  it('正确密码跳转到 /dashboard', async () => {
    const user = userEvent.setup()
    render(<LoginPage />)
    await user.type(screen.getByLabelText('手机号'), '13800138000')
    await user.type(screen.getByLabelText('密码'), 'admin123')
    await user.click(screen.getByRole('button', { name: /登 录/ }))
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/dashboard')
    })
  })

  it('显示首次登录提示', () => {
    render(<LoginPage />)
    expect(screen.getByText(/首次登录？请联系管理员开通权限/)).toBeInTheDocument()
  })
})
