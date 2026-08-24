'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Ban, Pencil, Plus, Truck } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  createInventorySupplier,
  updateInventorySupplier,
} from '@/actions/inventory/suppliers'
import { actionErrorMessage } from '@/lib/action-error'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'
import type { InventorySupplierInput, InventorySupplierRow } from '@/lib/inventory/types'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, type Column } from '@/components/ui/data-table'
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

interface SupplierForm {
  name: string
  contactName: string
  phone: string
  address: string
  isActive: boolean
  remark: string
}

const emptyForm: SupplierForm = {
  name: '',
  contactName: '',
  phone: '',
  address: '',
  isActive: true,
  remark: '',
}

function toForm(row: InventorySupplierRow): SupplierForm {
  return {
    name: row.name,
    contactName: row.contactName ?? '',
    phone: row.phone ?? '',
    address: row.address ?? '',
    isActive: row.isActive,
    remark: row.remark ?? '',
  }
}

function optionalText(value: string): string | null {
  return value.trim() || null
}

export default function InventorySuppliersPage({
  rows,
  canCreate,
  canUpdate,
}: {
  rows: InventorySupplierRow[]
  canCreate: boolean
  canUpdate: boolean
}) {
  const router = useRouter()
  const { get, setMany } = useUrlFilters()
  const [searchInput, setSearchInput] = useState(get('q'))
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<InventorySupplierRow | null>(null)
  const [form, setForm] = useState<SupplierForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [disableTarget, setDisableTarget] = useState<InventorySupplierRow | null>(null)
  const [disabling, setDisabling] = useState(false)

  useEffect(() => () => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
  }, [])

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => setMany({ q: value }), 300)
  }, [setMany])

  function setField<K extends keyof SupplierForm>(key: K, value: SupplierForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function closeDialog(open: boolean) {
    setDialogOpen(open)
    if (!open) setEditing(null)
  }

  function openCreate() {
    setEditing(null)
    setForm(emptyForm)
    setDialogOpen(true)
  }

  function openEdit(row: InventorySupplierRow) {
    setEditing(row)
    setForm(toForm(row))
    setDialogOpen(true)
  }

  async function submit() {
    const name = form.name.trim()
    if (!name) {
      toast.error('请输入供应商名称')
      return
    }

    const input: InventorySupplierInput = {
      name,
      contactName: optionalText(form.contactName),
      phone: optionalText(form.phone),
      address: optionalText(form.address),
      isActive: form.isActive,
      remark: optionalText(form.remark),
    }

    setSaving(true)
    try {
      if (editing) {
        await updateInventorySupplier(editing.supplierId, input)
        toast.success('供应商已更新')
      } else {
        await createInventorySupplier(input)
        toast.success('供应商已创建')
      }
      closeDialog(false)
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, editing ? '更新供应商失败' : '创建供应商失败'))
    } finally {
      setSaving(false)
    }
  }

  async function disable() {
    if (!disableTarget) return
    setDisabling(true)
    try {
      await updateInventorySupplier(disableTarget.supplierId, { isActive: false })
      toast.success('供应商已停用')
      setDisableTarget(null)
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, '停用供应商失败'))
    } finally {
      setDisabling(false)
    }
  }

  const columns: Column<InventorySupplierRow>[] = [
    {
      key: 'name',
      header: '供应商名称',
      cell: (row) => <span className="font-medium">{row.name}</span>,
    },
    { key: 'contactName', header: '联系人', cell: (row) => row.contactName || '—' },
    { key: 'phone', header: '联系电话', cell: (row) => row.phone || '—' },
    { key: 'address', header: '地址', cell: (row) => row.address || '—' },
    {
      key: 'isActive',
      header: '状态',
      cell: (row) => (
        <Badge
          variant="outline"
          className={row.isActive
            ? 'border-[#3D8A5A] bg-[#F0F9F2] text-[#3D8A5A]'
            : 'border-[#888888] bg-[#F5F5F5] text-[#888888]'}
        >
          {row.isActive ? '启用' : '停用'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      cell: (row) => canUpdate ? (
        <div className="flex items-center gap-1">
          <Button variant="link" size="sm" className="h-auto px-1" onClick={() => openEdit(row)}>
            <Pencil /> 编辑
          </Button>
          {row.isActive && (
            <Button
              variant="link"
              size="sm"
              className="h-auto px-1 text-[var(--destructive)]"
              onClick={() => setDisableTarget(row)}
            >
              <Ban /> 停用
            </Button>
          )}
        </div>
      ) : '—',
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Truck className="size-5 text-[var(--primary)]" />
          <h1 className="text-xl font-medium">供应商</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={get('status')}
            onChange={(event) => setMany({ status: event.target.value })}
            className="w-28"
            aria-label="供应商状态筛选"
          >
            <option value="">全部状态</option>
            <option value="active">启用</option>
            <option value="inactive">停用</option>
          </Select>
          <Input
            className="w-64"
            placeholder="搜索名称、联系人或电话"
            value={searchInput}
            onChange={(event) => handleSearchChange(event.target.value)}
          />
          <Button variant="outline" onClick={() => {
            setSearchInput('')
            setMany({ q: '', status: '' })
          }}>
            重置
          </Button>
          {canCreate && (
            <Button onClick={openCreate}>
              <Plus /> 新建供应商
            </Button>
          )}
        </div>
      </div>

      <DataTable columns={columns} data={rows} emptyText="暂无供应商" />

      <Dialog open={dialogOpen} onOpenChange={closeDialog} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑供应商' : '新建供应商'}</DialogTitle>
        </DialogHeader>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <label className="text-sm font-medium">供应商名称 *</label>
            <Input value={form.name} onChange={(event) => setField('name', event.target.value)} />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">联系人</label>
            <Input value={form.contactName} onChange={(event) => setField('contactName', event.target.value)} />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">联系电话</label>
            <Input value={form.phone} onChange={(event) => setField('phone', event.target.value)} />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <label className="text-sm font-medium">地址</label>
            <Input value={form.address} onChange={(event) => setField('address', event.target.value)} />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <label className="text-sm font-medium">备注</label>
            <Textarea value={form.remark} onChange={(event) => setField('remark', event.target.value)} />
          </div>
          <div className="flex items-center gap-3 sm:col-span-2">
            <Switch
              checked={form.isActive}
              onCheckedChange={(value) => setField('isActive', value)}
              aria-label="供应商启用状态"
            />
            <span className="text-sm text-[#666666]">{form.isActive ? '启用' : '停用'}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => closeDialog(false)} disabled={saving}>取消</Button>
          <Button onClick={submit} loading={saving}>{editing ? '保存修改' : '创建供应商'}</Button>
        </DialogFooter>
      </Dialog>

      <AlertDialog open={!!disableTarget} onOpenChange={(open) => !open && setDisableTarget(null)}>
        <AlertDialogTitle>停用供应商</AlertDialogTitle>
        <AlertDialogDescription>
          确定停用供应商「{disableTarget?.name}」吗？历史单据不会受影响，但后续业务不应再选择该供应商。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setDisableTarget(null)} disabled={disabling}>取消</AlertDialogCancel>
          <AlertDialogAction onClick={disable} disabled={disabling}>确认停用</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>
    </div>
  )
}
