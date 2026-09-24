import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExportTasksMenu } from './export-tasks-menu'
import { listMyExportJobs } from '@/actions/export-jobs'

vi.mock('@/actions/export-jobs', () => ({
  listMyExportJobs: vi.fn(),
  retryMyExportJob: vi.fn(),
}))

const mockListMyExportJobs = vi.mocked(listMyExportJobs)
const storage = new Map<string, string>()

const memoryStorage: Pick<Storage, 'clear' | 'getItem' | 'removeItem' | 'setItem'> = {
  clear: () => storage.clear(),
  getItem: (key) => storage.get(key) ?? null,
  removeItem: (key) => storage.delete(key),
  setItem: (key, value) => storage.set(key, value),
}

const readyJob = {
  id: 1,
  exportType: 'orders' as const,
  label: '订单明细',
  status: 'ready' as const,
  rowCount: 1,
  sheetCount: 1,
  fileName: 'orders.xlsx',
  errorMessage: null,
  createdAt: '2026-08-10T08:00:00.000Z',
  completedAt: '2026-08-10T08:01:00.000Z',
  expiresAt: '2026-08-17T08:01:00.000Z',
}

describe('ExportTasksMenu', () => {
  beforeEach(() => {
    storage.clear()
    mockListMyExportJobs.mockReset()
    Object.defineProperty(window, 'localStorage', { configurable: true, value: memoryStorage })
  })

  it('检测到尚未查看的新完成任务时显示红点', async () => {
    window.localStorage.clear()
    mockListMyExportJobs.mockResolvedValue([readyJob])

    render(<ExportTasksMenu employeeId="EMP-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('export-tasks-unread-indicator')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: '导出任务，有新的已完成任务' })).toBeInTheDocument()
  })

  it('打开任务菜单后将已完成任务标为已查看并清除红点', async () => {
    window.localStorage.clear()
    mockListMyExportJobs.mockResolvedValue([readyJob])
    const user = userEvent.setup()

    render(<ExportTasksMenu employeeId="EMP-2" />)

    await screen.findByTestId('export-tasks-unread-indicator')
    await user.click(screen.getByRole('button', { name: '导出任务，有新的已完成任务' }))

    await waitFor(() => {
      expect(screen.queryByTestId('export-tasks-unread-indicator')).not.toBeInTheDocument()
    })
    expect(window.localStorage.getItem('fengyu-admin:export-tasks:last-seen-ready-at:EMP-2')).toBe(String(Date.parse(readyJob.completedAt)))
  })

  it('按员工隔离已查看状态', async () => {
    window.localStorage.setItem('fengyu-admin:export-tasks:last-seen-ready-at:EMP-3', String(Date.parse(readyJob.completedAt)))
    mockListMyExportJobs.mockResolvedValue([readyJob])

    render(<ExportTasksMenu employeeId="EMP-3" />)

    await waitFor(() => {
      expect(mockListMyExportJobs).toHaveBeenCalled()
    })
    expect(screen.queryByTestId('export-tasks-unread-indicator')).not.toBeInTheDocument()
  })
})
