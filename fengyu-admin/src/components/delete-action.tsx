'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { actionErrorMessage } from '@/lib/action-error'

/** 删除结果约定，与各 server action 返回值一致 */
export type DeleteResult = { success: boolean; message: string }

interface ConfirmState {
  open: boolean
  setOpen: (v: boolean) => void
  deleting: boolean
  run: () => Promise<void>
}

/**
 * 删除确认通用逻辑：弹层开关 + 调用 onConfirm + toast + 成功后跳转/刷新。
 * redirectTo 有值则成功后 router.push，否则 router.refresh()。
 */
function useDeleteConfirm(
  onConfirm: () => Promise<DeleteResult>,
  redirectTo?: string,
): ConfirmState {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)

  const run = async () => {
    if (deleting) return
    setDeleting(true)
    try {
      const result = await onConfirm()
      if (!result.success) {
        toast.error(result.message)
        return
      }
      toast.success(result.message)
      setOpen(false)
      if (redirectTo) {
        router.push(redirectTo)
      } else {
        router.refresh()
      }
    } catch (err) {
      toast.error(actionErrorMessage(err, '删除失败，请稍后重试'))
    } finally {
      setDeleting(false)
    }
  }

  return { open, setOpen, deleting, run }
}

function ConfirmDialog({
  state,
  title,
  description,
}: {
  state: ConfirmState
  title: string
  description: React.ReactNode
}) {
  return (
    <AlertDialog open={state.open} onOpenChange={(o) => !state.deleting && state.setOpen(o)}>
      <AlertDialogTitle>{title}</AlertDialogTitle>
      <AlertDialogDescription>{description}</AlertDialogDescription>
      <AlertDialogFooter>
        <AlertDialogCancel onClick={() => state.setOpen(false)} disabled={state.deleting}>
          取消
        </AlertDialogCancel>
        <AlertDialogAction onClick={state.run} disabled={state.deleting}>
          {state.deleting ? '删除中…' : '确认删除'}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialog>
  )
}

/**
 * 详情页底部「危险操作」区：弱化的边框区块 + 次要删除按钮 + 二次确认。
 * 物理删除不可恢复，入口刻意收在详情页底部，降低误触。
 */
export function DangerZoneDelete({
  onConfirm,
  entityLabel,
  description,
  redirectTo,
  buttonLabel,
}: {
  onConfirm: () => Promise<DeleteResult>
  /** 实体中文名，如「订单」 */
  entityLabel: string
  /** 确认弹层正文（含关键摘要） */
  description?: React.ReactNode
  /** 成功后跳转地址（通常为列表页） */
  redirectTo?: string
  buttonLabel?: string
}) {
  const state = useDeleteConfirm(onConfirm, redirectTo)
  return (
    <div className="mt-8 rounded-[var(--radius-lg)] border border-[var(--destructive)]/30 bg-[var(--destructive)]/[0.03] p-4">
      <div className="text-sm font-medium text-[var(--foreground)]">危险操作</div>
      <p className="mt-1 text-xs text-[var(--muted-foreground)]">
        物理删除该{entityLabel}及其从属数据，操作不可恢复，请谨慎执行。
      </p>
      <button
        type="button"
        onClick={() => state.setOpen(true)}
        className="mt-3 inline-flex items-center rounded-[var(--radius)] border border-[var(--destructive)]/50 bg-transparent px-3 py-1.5 text-sm text-[var(--destructive)] hover:bg-[var(--destructive)]/10 transition-colors"
      >
        {buttonLabel ?? `删除此${entityLabel}`}
      </button>
      <ConfirmDialog
        state={state}
        title={`确认删除${entityLabel}`}
        description={
          description ?? `确定要删除该${entityLabel}吗？此操作不可恢复。`
        }
      />
    </div>
  )
}

/**
 * 列表行「更多(⋯)」次级菜单内的删除项 + 二次确认。
 * 删除入口收在 kebab 菜单内，不在行上暴露独立删除图标，降低误触。
 */
export function RowDeleteMenu({
  onConfirm,
  entityLabel,
  description,
}: {
  onConfirm: () => Promise<DeleteResult>
  entityLabel: string
  description?: React.ReactNode
}) {
  const state = useDeleteConfirm(onConfirm)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="更多操作"
          className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius)] text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
        >
          <span className="text-lg leading-none">⋯</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => state.setOpen(true)}
            className="text-[var(--destructive)] hover:text-[var(--destructive)]"
          >
            删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        state={state}
        title={`确认删除${entityLabel}`}
        description={description ?? `确定要删除该${entityLabel}吗？此操作不可恢复。`}
      />
    </>
  )
}
