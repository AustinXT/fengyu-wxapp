'use client'

import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogClose, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { useUnsavedChanges } from '@/lib/hooks/use-unsaved-changes'
import { getPermissionActionLabel, getPermissionGroupLabel } from '@/lib/permission-presentation'
import {
  addActionWithUiDependencies,
  getUiDependencyClosure,
  isActionGrantableForRoleDefinition,
  removeActionWithDependents,
} from '@/lib/permission-contract'
import {
  createRoleDefinition,
  deleteRoleDefinition,
  updateRoleDefinition,
} from '@/actions/role-definitions'
import type { RoleDefinition } from '@/lib/types'

interface Props {
  initialRoles: RoleDefinition[]
  allActions: string[]
  canManageCapabilities: boolean
}

const REQUIRED_SUPER_ACTIONS = ['system:config', 'permission:assign_admin', 'admin:reset_password']

function groupActions(actions: string[]) {
  const result = new Map<string, string[]>()
  for (const action of actions) {
    const group = action.split(':')[0]
    result.set(group, [...(result.get(group) ?? []), action])
  }
  return [...result.entries()]
}

export default function PermissionMatrixPage({ initialRoles, allActions, canManageCapabilities }: Props) {
  const [roles, setRoles] = useState(initialRoles)
  const [selectedKey, setSelectedKey] = useState(initialRoles[0]?.roleKey ?? '')
  const selected = roles.find((role) => role.roleKey === selectedKey) ?? null
  const [draft, setDraft] = useState<RoleDefinition | null>(selected)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [copyFrom, setCopyFrom] = useState('')
  const [pending, startTransition] = useTransition()
  const groupedActions = useMemo(() => groupActions(allActions), [allActions])
  const dirty = !!selected && !!draft && JSON.stringify(selected) !== JSON.stringify(draft)
  useUnsavedChanges(dirty)

  function selectRole(role: RoleDefinition) {
    if (dirty && !window.confirm('当前角色有未保存修改，确定切换吗？')) return
    setSelectedKey(role.roleKey)
    setDraft(role)
  }

  function toggleAction(action: string) {
    if (!draft) return
    if (!isActionGrantableForRoleDefinition(action, draft.isSuperAdmin)) return
    if (draft.actions.includes(action)) {
      const nextActions = removeActionWithDependents(draft.actions, action)
      const removed = draft.actions.filter((item) => !nextActions.includes(item) && item !== action)
      if (removed.length > 0) toast.message(`已同步取消依赖项：${removed.map(getPermissionActionLabel).join('、')}`)
      setDraft({ ...draft, actions: nextActions })
      return
    }
    const dependencies = getUiDependencyClosure(action).filter((item) => !draft.actions.includes(item))
    if (dependencies.length > 0) toast.message(`已自动补齐：${dependencies.map(getPermissionActionLabel).join('、')}`)
    setDraft({ ...draft, actions: addActionWithUiDependencies(draft.actions, action) })
  }

  function setCapability(key: 'canAccessAdmin' | 'isSuperAdmin' | 'isStoreManager', value: boolean) {
    if (!draft || !canManageCapabilities) return
    const next = { ...draft, [key]: value }
    if (key === 'isSuperAdmin' && value) {
      next.canAccessAdmin = true
      next.actions = addActionWithUiDependencies(next.actions, REQUIRED_SUPER_ACTIONS[0])
      for (const action of REQUIRED_SUPER_ACTIONS.slice(1)) {
        next.actions = addActionWithUiDependencies(next.actions, action)
      }
    }
    if (key === 'isSuperAdmin' && !value) {
      next.actions = next.actions.filter((action) => isActionGrantableForRoleDefinition(action, false))
    }
    setDraft(next)
  }

  function save() {
    if (!draft) return
    startTransition(async () => {
      try {
        const result = await updateRoleDefinition(draft.roleKey, {
          name: draft.name,
          description: draft.description,
          actions: draft.actions,
          canAccessAdmin: draft.canAccessAdmin,
          isSuperAdmin: draft.isSuperAdmin,
          isStoreManager: draft.isStoreManager,
          expectedUpdatedAt: draft.updatedAt,
        })
        if (!result.success) {
          toast.error(result.message)
          return
        }
        toast.success(result.message)
        window.location.reload()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '保存失败')
      }
    })
  }

  function create() {
    startTransition(async () => {
      try {
        const result = await createRoleDefinition({
          name: newName,
          description: newDescription,
          copyFromRoleKey: copyFrom || null,
          canAccessAdmin: true,
        })
        if (!result.success) {
          toast.error(result.message)
          return
        }
        toast.success(result.message)
        setCreateOpen(false)
        window.location.reload()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '创建失败')
      }
    })
  }

  function remove() {
    if (!selected || !canManageCapabilities) return
    if (!window.confirm(`确定删除角色“${selected.name}”吗？该操作不可撤销。`)) return
    startTransition(async () => {
      try {
        const result = await deleteRoleDefinition(selected.roleKey)
        if (!result.success) {
          toast.error(result.message)
          return
        }
        toast.success(result.message)
        setRoles((current) => current.filter((role) => role.roleKey !== selected.roleKey))
        window.location.reload()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '删除失败')
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">角色与权限</h1>
          <p className="mt-1 text-sm text-[#999999]">角色名称、权限和高级能力保存后 30 秒内生效。</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>新增角色</Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <Card>
          <CardHeader><CardTitle className="text-base">角色列表</CardTitle></CardHeader>
          <CardContent className="space-y-1 p-3 pt-0">
            {roles.map((role) => (
              <button
                key={role.roleKey}
                type="button"
                onClick={() => selectRole(role)}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${selectedKey === role.roleKey ? 'bg-[#FFF0EE] text-[#C0322A]' : 'hover:bg-gray-50'}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{role.name}</span>
                  <span className="text-xs text-[#999999]">{role.assignmentCount} 人</span>
                </span>
                <span className="mt-1 block truncate text-xs text-[#999999]">
                  内部标识：<code>{role.roleKey}</code>
                </span>
              </button>
            ))}
          </CardContent>
        </Card>

        {draft ? (
          <div className="space-y-4">
            <Card>
              <CardHeader><CardTitle>基本信息</CardTitle></CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <label className="text-sm">角色名称<Input className="mt-1" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
                <label className="text-sm">内部标识<Input className="mt-1" value={draft.roleKey} disabled /></label>
                <label className="text-sm md:col-span-2">角色说明<textarea className="mt-1 min-h-20 w-full rounded-md border border-gray-200 p-2" value={draft.description ?? ''} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>高级能力</CardTitle></CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-3">
                {([
                  ['canAccessAdmin', '允许登录管理后台'],
                  ['isSuperAdmin', '超级管理员能力'],
                  ['isStoreManager', '员工端店长能力'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 rounded-md border p-3 text-sm">
                    <input type="checkbox" checked={draft[key]} disabled={!canManageCapabilities || (key === 'canAccessAdmin' && draft.isSuperAdmin)} onChange={(event) => setCapability(key, event.target.checked)} />
                    {label}
                  </label>
                ))}
                {!canManageCapabilities && <p className="md:col-span-3 text-xs text-[#999999]">仅超级管理员可修改高级能力。</p>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>权限项（{draft.actions.length}/{allActions.length}）</CardTitle></CardHeader>
              <CardContent className="space-y-5">
                {groupedActions.map(([group, actions]) => (
                  <div key={group}>
                    <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
                      {getPermissionGroupLabel(group)}
                      <code className="text-xs font-normal text-[#999999]">{group}</code>
                    </h3>
                    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                      {actions.map((action) => {
                        const disabled = !isActionGrantableForRoleDefinition(action, draft.isSuperAdmin)
                        return (
                        <label key={action} className={`flex items-center gap-2 text-sm ${disabled ? 'cursor-not-allowed text-[#999999]' : ''}`}>
                          <input type="checkbox" checked={draft.actions.includes(action)} disabled={disabled} onChange={() => toggleAction(action)} />
                          <span>
                            {getPermissionActionLabel(action)}
                            <code className="ml-1 text-xs text-[#999999]">{action}</code>
                            {disabled && <span className="ml-1 text-xs">（仅超级管理员）</span>}
                          </span>
                        </label>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <div className="flex justify-between">
              {canManageCapabilities && <Button variant="destructive" onClick={remove} disabled={pending}>删除角色</Button>}
              <div className="ml-auto flex gap-2">
                <Button variant="outline" onClick={() => setDraft(selected)} disabled={!dirty || pending}>撤销修改</Button>
                <Button onClick={save} loading={pending} disabled={!dirty}>保存角色</Button>
              </div>
            </div>
          </div>
        ) : <Card><CardContent className="py-20 text-center text-[#999999]">暂无角色</CardContent></Card>}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogClose onOpenChange={setCreateOpen} />
        <DialogHeader><DialogTitle>新增角色</DialogTitle></DialogHeader>
        <div className="mt-4 space-y-4">
          <label className="block text-sm">角色名称<Input className="mt-1" value={newName} onChange={(event) => setNewName(event.target.value)} /></label>
          <label className="block text-sm">角色说明<textarea className="mt-1 min-h-20 w-full rounded-md border border-gray-200 p-2" value={newDescription} onChange={(event) => setNewDescription(event.target.value)} /></label>
          <label className="block text-sm">复制权限（可选）<Select className="mt-1" value={copyFrom} onChange={(event) => setCopyFrom(event.target.value)}><option value="">空权限</option>{roles.map((role) => <option key={role.roleKey} value={role.roleKey}>{role.name}</option>)}</Select></label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button>
          <Button onClick={create} loading={pending} disabled={!newName.trim()}>创建</Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}
