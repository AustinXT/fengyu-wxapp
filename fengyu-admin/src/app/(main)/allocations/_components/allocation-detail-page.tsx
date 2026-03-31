"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { StatusBadge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { batchSaveAllocations } from "@/actions/allocations"
import type { SaleOrder, SaleItem, SaleAllocation, Employee, CommissionRate } from "@/lib/types"

// --------------- 常量 ---------------

const PERCENTAGE_OPTIONS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const

type RoleGroup = 'beautician' | 'promoter'

const ROLE_GROUP_LABELS: Record<RoleGroup, string> = {
  beautician: '美容师/养生师业绩分配',
  promoter: '推广师业绩分配',
}

const MAX_PER_GROUP = 3

// --------------- 类型 ---------------

interface AllocationEntry {
  id: number
  employeeId: string
  ratioPercent: string  // '10' | '20' | ... | '100' | ''
  amount: string
  roleType: string      // '美容师' | '养生师' | '推广师'
}

type ItemAllocations = Record<string, {
  beautician: AllocationEntry[]
  promoter: AllocationEntry[]
}>

// --------------- 工具函数 ---------------

/** 从员工 skills 标签推断角色类型 */
function inferRoleFromSkills(employee: Employee, group: RoleGroup): string {
  if (group === 'promoter') return '推广师'
  const skills = employee.skills || []
  if (skills.includes('养生师')) return '养生师'
  return '美容师'
}

/** 角色类型 → 角色组 */
function getRoleGroup(roleType: string): RoleGroup {
  return roleType === '推广师' ? 'promoter' : 'beautician'
}

/** 根据市场、角色、销售分类、金额匹配提成比例（仅作参考显示） */
function findMatchingRate(
  rates: CommissionRate[],
  marketName: string,
  roleType: string,
  salesCategory: string | null,
  amount: number,
): CommissionRate | null {
  return rates.find((r) =>
    r.orgName === marketName &&
    r.orderType === '销售单' &&
    r.roleType === roleType &&
    r.salesCategory === (salesCategory || '') &&
    Number(r.amountTierMin) <= amount &&
    (r.amountTierMax === null || Number(r.amountTierMax) > amount)
  ) ?? null
}

/** 员工按职位排序 */
function sortEmployeesByPosition(employees: Employee[]): Employee[] {
  return [...employees].sort((a, b) =>
    (a.positionName || '').localeCompare(b.positionName || '', 'zh-CN')
  )
}

/** 计算分配金额 */
function calcAmount(ratioPercent: string, received: string): string {
  const ratio = Number(ratioPercent)
  const recv = Number(received)
  if (isNaN(ratio) || isNaN(recv) || ratio <= 0) return '0.00'
  return ((ratio / 100) * recv).toFixed(2)
}

// --------------- 初始化状态 ---------------

function initAllocations(
  items: SaleItem[],
  allocations: SaleAllocation[],
  employees: Employee[],
): ItemAllocations {
  const result: ItemAllocations = {}

  // 为每个 item 初始化空组
  for (const item of items) {
    result[item.saleItemId] = { beautician: [], promoter: [] }
  }

  // 填充已有分配
  for (const alloc of allocations) {
    const entry = result[alloc.saleItemId]
    if (!entry) continue

    const emp = employees.find((e) => e.employeeId === alloc.employeeId)
    // 确定角色组：优先用保存的 roleType，回退到 skills 推断
    let roleType = alloc.roleType
    if (!roleType && emp) {
      roleType = inferRoleFromSkills(emp, 'beautician')
      // 如果 skills 中有推广师，放到推广师组
      if (emp.skills?.includes('推广师')) roleType = '推广师'
    }
    roleType = roleType || '美容师'

    const group = getRoleGroup(roleType)
    const ratioPercent = (Number(alloc.allocationRatio) * 100).toFixed(0)

    entry[group].push({
      id: Date.now() + Math.random(),
      employeeId: alloc.employeeId,
      ratioPercent,
      amount: alloc.totalAmount,
      roleType,
    })
  }

  return result
}

// --------------- 主组件 ---------------

export default function AllocationDetailPageClient({
  order,
  allocations,
  employees,
  commissionRates = [],
}: {
  order: SaleOrder
  allocations: SaleAllocation[]
  employees: Employee[]
  commissionRates?: CommissionRate[]
}) {
  const activeEmployees = sortEmployeesByPosition(
    employees.filter((e) => !e.isResigned && e.storeId === order.storeId)
  )

  const items = order.items || []

  const [itemAllocs, setItemAllocs] = useState<ItemAllocations>(() =>
    initAllocations(items, allocations, employees)
  )

  const addEntry = (saleItemId: string, group: RoleGroup) => {
    setItemAllocs((prev) => {
      const current = prev[saleItemId]?.[group] || []
      if (current.length >= MAX_PER_GROUP) return prev
      return {
        ...prev,
        [saleItemId]: {
          ...prev[saleItemId],
          [group]: [
            ...current,
            {
              id: Date.now() + Math.random(),
              employeeId: '',
              ratioPercent: '',
              amount: '0.00',
              roleType: group === 'promoter' ? '推广师' : '美容师',
            },
          ],
        },
      }
    })
  }

  const updateEntry = (
    saleItemId: string,
    group: RoleGroup,
    entryId: number,
    field: 'employeeId' | 'ratioPercent',
    value: string,
  ) => {
    setItemAllocs((prev) => {
      const item = items.find((i) => i.saleItemId === saleItemId)
      const received = item?.received || '0'
      const entries = prev[saleItemId]?.[group] || []

      return {
        ...prev,
        [saleItemId]: {
          ...prev[saleItemId],
          [group]: entries.map((e) => {
            if (e.id !== entryId) return e
            const updated = { ...e, [field]: value }

            // 选择员工时自动推断角色
            if (field === 'employeeId' && value) {
              const emp = activeEmployees.find((em) => em.employeeId === value)
              if (emp) updated.roleType = inferRoleFromSkills(emp, group)
            }

            // 选择百分比时自动计算金额
            if (field === 'ratioPercent' || field === 'employeeId') {
              updated.amount = calcAmount(updated.ratioPercent, received)
            }

            return updated
          }),
        },
      }
    })
  }

  const removeEntry = (saleItemId: string, group: RoleGroup, entryId: number) => {
    setItemAllocs((prev) => ({
      ...prev,
      [saleItemId]: {
        ...prev[saleItemId],
        [group]: (prev[saleItemId]?.[group] || []).filter((e) => e.id !== entryId),
      },
    }))
  }

  return (
    <div className="space-y-6">
      {/* 页头 */}
      <div className="flex items-center gap-3">
        <Link href="/allocations" className="text-[#999999] hover:text-[var(--foreground)]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
        </Link>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">营业额分配</h1>
      </div>

      {/* 订单摘要 */}
      <Card>
        <CardHeader>
          <CardTitle>订单信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-[#999999]">订单号</span>
              <p className="font-medium mt-1">{order.saleOrderId}</p>
            </div>
            <div>
              <span className="text-[#999999]">顾客</span>
              <p className="font-medium mt-1">{order.customerName || "-"}</p>
            </div>
            <div>
              <span className="text-[#999999]">状态</span>
              <p className="mt-1"><StatusBadge status={order.status} /></p>
            </div>
            <div>
              <span className="text-[#999999]">订单金额</span>
              <p className="font-bold text-lg mt-1 text-[var(--primary)]">¥{Number(order.totalAmount).toLocaleString()}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 逐 SKU 分配卡片 */}
      {items.map((item) => (
        <ItemAllocationCard
          key={item.saleItemId}
          item={item}
          allocs={itemAllocs[item.saleItemId] || { beautician: [], promoter: [] }}
          activeEmployees={activeEmployees}
          commissionRates={commissionRates}
          marketName={order.marketName ?? ''}
          onAdd={addEntry}
          onUpdate={updateEntry}
          onRemove={removeEntry}
        />
      ))}

      {/* 保存/取消 */}
      <Card>
        <CardContent className="pt-6">
          <SaveButton orderId={order.saleOrderId} items={items} itemAllocs={itemAllocs} />
        </CardContent>
      </Card>
    </div>
  )
}

// --------------- SKU 分配卡片 ---------------

function ItemAllocationCard({
  item,
  allocs,
  activeEmployees,
  commissionRates,
  marketName,
  onAdd,
  onUpdate,
  onRemove,
}: {
  item: SaleItem
  allocs: { beautician: AllocationEntry[]; promoter: AllocationEntry[] }
  activeEmployees: Employee[]
  commissionRates: CommissionRate[]
  marketName: string
  onAdd: (saleItemId: string, group: RoleGroup) => void
  onUpdate: (saleItemId: string, group: RoleGroup, entryId: number, field: 'employeeId' | 'ratioPercent', value: string) => void
  onRemove: (saleItemId: string, group: RoleGroup, entryId: number) => void
}) {
  const received = Number(item.received)

  return (
    <Card>
      {/* SKU 信息头 */}
      <CardHeader className="pb-3">
        <div className="flex items-baseline justify-between">
          <CardTitle className="text-base">
            {item.productName || '-'}
            {item.skuName ? ` - ${item.skuName}` : ''}
            {item.salesCategory && (
              <span className="ml-2 text-xs font-normal text-[#999999] bg-gray-100 px-2 py-0.5 rounded">
                {item.salesCategory}
              </span>
            )}
          </CardTitle>
          <span className="text-lg font-bold text-[var(--primary)]">¥{received.toLocaleString()}</span>
        </div>
        <p className="text-xs text-[#999999] mt-1">
          单价 ¥{Number(item.unitRealPrice).toLocaleString()} × {item.quantity}
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* 美容师/养生师组 */}
        <RoleGroupSection
          label={ROLE_GROUP_LABELS.beautician}
          group="beautician"
          entries={allocs.beautician}
          received={received}
          saleItemId={item.saleItemId}
          activeEmployees={activeEmployees}
          commissionRates={commissionRates}
          marketName={marketName}
          salesCategory={item.salesCategory}
          onAdd={onAdd}
          onUpdate={onUpdate}
          onRemove={onRemove}
        />

        <Separator />

        {/* 推广师组 */}
        <RoleGroupSection
          label={ROLE_GROUP_LABELS.promoter}
          group="promoter"
          entries={allocs.promoter}
          received={received}
          saleItemId={item.saleItemId}
          activeEmployees={activeEmployees}
          commissionRates={commissionRates}
          marketName={marketName}
          salesCategory={item.salesCategory}
          onAdd={onAdd}
          onUpdate={onUpdate}
          onRemove={onRemove}
        />
      </CardContent>
    </Card>
  )
}

// --------------- 角色组区块 ---------------

function RoleGroupSection({
  label,
  group,
  entries,
  received,
  saleItemId,
  activeEmployees,
  commissionRates,
  marketName,
  salesCategory,
  onAdd,
  onUpdate,
  onRemove,
}: {
  label: string
  group: RoleGroup
  entries: AllocationEntry[]
  received: number
  saleItemId: string
  activeEmployees: Employee[]
  commissionRates: CommissionRate[]
  marketName: string
  salesCategory: string | null
  onAdd: (saleItemId: string, group: RoleGroup) => void
  onUpdate: (saleItemId: string, group: RoleGroup, entryId: number, field: 'employeeId' | 'ratioPercent', value: string) => void
  onRemove: (saleItemId: string, group: RoleGroup, entryId: number) => void
}) {
  const sum = entries.reduce((s, e) => s + Number(e.amount), 0)
  const overLimit = sum > received + 0.01

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-medium text-[#666666]">{label}</h4>
        {entries.length < MAX_PER_GROUP && (
          <Button size="sm" variant="outline" onClick={() => onAdd(saleItemId, group)}>
            + 添加
          </Button>
        )}
      </div>

      {entries.length > 0 ? (
        <div className="space-y-2">
          {entries.map((entry) => {
            // 查找提成比例参考
            const rateRef = entry.roleType
              ? findMatchingRate(commissionRates, marketName, entry.roleType, salesCategory, received)
              : null

            return (
              <div key={entry.id} className="flex items-center gap-3 bg-[#FAFAFA] rounded-lg px-3 py-2">
                {/* 员工选择 */}
                <div className="flex-1 min-w-0">
                  <Select
                    value={entry.employeeId}
                    onChange={(e) => onUpdate(saleItemId, group, entry.id, 'employeeId', e.target.value)}
                  >
                    <option value="">选择员工</option>
                    {activeEmployees.map((emp) => (
                      <option key={emp.employeeId} value={emp.employeeId}>
                        {emp.name} ({emp.positionName || '-'})
                      </option>
                    ))}
                  </Select>
                </div>

                {/* 百分比选择 */}
                <div className="w-24 shrink-0">
                  <Select
                    value={entry.ratioPercent}
                    onChange={(e) => onUpdate(saleItemId, group, entry.id, 'ratioPercent', e.target.value)}
                  >
                    <option value="">比例</option>
                    {PERCENTAGE_OPTIONS.map((p) => (
                      <option key={p} value={String(p)}>{p}%</option>
                    ))}
                  </Select>
                </div>

                {/* 金额（只读） */}
                <div className="w-24 shrink-0 text-right">
                  <span className="text-sm font-medium">¥{Number(entry.amount).toLocaleString()}</span>
                  {rateRef && (
                    <p className="text-[10px] text-[#999999]">
                      提成 {(Number(rateRef.commissionRate) * 100).toFixed(1)}%
                    </p>
                  )}
                </div>

                {/* 删除 */}
                <Button size="sm" variant="ghost" onClick={() => onRemove(saleItemId, group, entry.id)} className="text-[#D94040] shrink-0 px-1">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </Button>
              </div>
            )
          })}

          {/* 小计 */}
          <div className={`text-xs text-right pr-10 ${overLimit ? 'text-[#D94040] font-medium' : 'text-[#999999]'}`}>
            小计: ¥{sum.toFixed(2)} / ¥{received.toFixed(2)}
            {overLimit && ' (超出实收金额)'}
          </div>
        </div>
      ) : (
        <p className="text-xs text-[#999999] py-2">暂无分配</p>
      )}
    </div>
  )
}

// --------------- 保存按钮 ---------------

function SaveButton({
  orderId,
  items,
  itemAllocs,
}: {
  orderId: string
  items: SaleItem[]
  itemAllocs: ItemAllocations
}) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  const handleSave = () => {
    // 扁平化 + 校验
    const flatAllocations: Array<{
      saleItemId: string
      employeeId: string
      roleType: string
      allocationRatio: string
      totalAmount: string
    }> = []

    for (const item of items) {
      const allocs = itemAllocs[item.saleItemId]
      if (!allocs) continue
      const received = Number(item.received)

      for (const group of ['beautician', 'promoter'] as RoleGroup[]) {
        const entries = allocs[group].filter((e) => e.employeeId || e.ratioPercent)

        // 校验完整性
        for (const e of entries) {
          if (!e.employeeId || !e.ratioPercent) {
            toast.error('请填写完整的分配信息（员工和比例）')
            return
          }
        }

        // 校验重复员工
        const empIds = new Set<string>()
        for (const e of entries) {
          if (empIds.has(e.employeeId)) {
            toast.error(`${item.productName || '商品'} 中同一角色组不能重复选择同一员工`)
            return
          }
          empIds.add(e.employeeId)
        }

        // 校验金额合计
        const sum = entries.reduce((s, e) => s + Number(e.amount), 0)
        if (sum > received + 0.01) {
          toast.error(`${item.productName || '商品'} 的${group === 'beautician' ? '美容师/养生师' : '推广师'}分配金额超出实收金额`)
          return
        }

        for (const e of entries) {
          flatAllocations.push({
            saleItemId: item.saleItemId,
            employeeId: e.employeeId,
            roleType: e.roleType,
            allocationRatio: (Number(e.ratioPercent) / 100).toFixed(2),
            totalAmount: e.amount,
          })
        }
      }
    }

    startTransition(async () => {
      const res = await batchSaveAllocations(orderId, flatAllocations)
      if (res.success) {
        toast.success(res.message)
        router.push('/allocations')
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <div className="flex justify-end gap-3">
      <Link href="/allocations">
        <Button variant="outline">取消</Button>
      </Link>
      <Button onClick={handleSave} loading={pending}>保存分配</Button>
    </div>
  )
}
