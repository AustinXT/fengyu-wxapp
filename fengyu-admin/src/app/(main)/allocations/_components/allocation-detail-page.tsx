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
const MAX_PER_GROUP = 3

// --------------- 类型 ---------------

interface AllocationEntry {
  id: number
  employeeId: string
  ratioPercent: string  // '10' | '20' | ... | '100' | ''
  amount: string
  roleType: string      // '美容师' | '养生师' | '推广师'
}

// --------------- 工具函数 ---------------

/** 从员工 skills 标签推断角色类型 */
function inferRoleFromSkills(employee: Employee): string {
  const skills = employee.skills || []
  if (skills.includes('推广师')) return '推广师'
  if (skills.includes('养生师')) return '养生师'
  if (skills.includes('美容师')) return '美容师'
  return '美容师'
}

/** 角色类型 → 角色组（美容师/养生师为同一组） */
function getRoleGroup(roleType: string): string {
  return roleType === '推广师' ? 'promoter' : 'beautician'
}

/** 根据市场、角色、销售分类、金额匹配提成比例 */
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
): Record<string, AllocationEntry[]> {
  const result: Record<string, AllocationEntry[]> = {}

  for (const item of items) {
    result[item.saleItemId] = []
  }

  for (const alloc of allocations) {
    if (!result[alloc.saleItemId]) continue

    const emp = employees.find((e) => e.employeeId === alloc.employeeId)
    let roleType = alloc.roleType
    if (!roleType && emp) {
      roleType = inferRoleFromSkills(emp)
    }
    roleType = roleType || '美容师'

    const ratioPercent = (Number(alloc.allocationRatio) * 100).toFixed(0)

    result[alloc.saleItemId].push({
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

  const [itemAllocs, setItemAllocs] = useState<Record<string, AllocationEntry[]>>(() =>
    initAllocations(items, allocations, employees)
  )

  const addEntry = (saleItemId: string) => {
    setItemAllocs((prev) => {
      const current = prev[saleItemId] || []
      return {
        ...prev,
        [saleItemId]: [
          ...current,
          {
            id: Date.now() + Math.random(),
            employeeId: '',
            ratioPercent: '',
            amount: '0.00',
            roleType: '',
          },
        ],
      }
    })
  }

  const updateEntry = (
    saleItemId: string,
    entryId: number,
    field: 'employeeId' | 'ratioPercent',
    value: string,
  ) => {
    setItemAllocs((prev) => {
      const item = items.find((i) => i.saleItemId === saleItemId)
      const received = item?.received || '0'
      const entries = prev[saleItemId] || []

      return {
        ...prev,
        [saleItemId]: entries.map((e) => {
          if (e.id !== entryId) return e
          const updated = { ...e, [field]: value }

          if (field === 'employeeId' && value) {
            const emp = activeEmployees.find((em) => em.employeeId === value)
            if (emp) updated.roleType = inferRoleFromSkills(emp)
          }

          if (field === 'ratioPercent' || field === 'employeeId') {
            updated.amount = calcAmount(updated.ratioPercent, received)
          }

          return updated
        }),
      }
    })
  }

  const removeEntry = (saleItemId: string, entryId: number) => {
    setItemAllocs((prev) => ({
      ...prev,
      [saleItemId]: (prev[saleItemId] || []).filter((e) => e.id !== entryId),
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
          entries={itemAllocs[item.saleItemId] || []}
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
  entries,
  activeEmployees,
  commissionRates,
  marketName,
  onAdd,
  onUpdate,
  onRemove,
}: {
  item: SaleItem
  entries: AllocationEntry[]
  activeEmployees: Employee[]
  commissionRates: CommissionRate[]
  marketName: string
  onAdd: (saleItemId: string) => void
  onUpdate: (saleItemId: string, entryId: number, field: 'employeeId' | 'ratioPercent', value: string) => void
  onRemove: (saleItemId: string, entryId: number) => void
}) {
  const received = Number(item.received)

  // 按角色组统计分配比例合计
  const groupSums: Record<string, number> = {}
  const groupCounts: Record<string, number> = {}
  for (const e of entries) {
    if (!e.roleType) continue
    const g = getRoleGroup(e.roleType)
    groupSums[g] = (groupSums[g] || 0) + Number(e.ratioPercent || 0)
    groupCounts[g] = (groupCounts[g] || 0) + 1
  }

  // 判断是否还能添加（任一角色组未满即可添加）
  const canAdd = true // 添加时不知道角色，选员工后才确定

  return (
    <Card>
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

      <CardContent className="space-y-3">
        {entries.length > 0 ? (
          entries.map((entry) => {
            // 查找提成比例
            const rateRef = entry.roleType
              ? findMatchingRate(commissionRates, marketName, entry.roleType, item.salesCategory, received)
              : null
            const commissionRate = rateRef ? Number(rateRef.commissionRate) : 0
            const commissionAmount = Number(entry.amount) * commissionRate

            return (
              <div key={entry.id} className="bg-[#FAFAFA] rounded-lg px-4 py-3">
                <div className="flex items-center gap-3">
                  {/* 员工选择 */}
                  <div className="flex-1 min-w-0">
                    <Select
                      value={entry.employeeId}
                      onChange={(e) => onUpdate(item.saleItemId, entry.id, 'employeeId', e.target.value)}
                    >
                      <option value="">选择员工</option>
                      {activeEmployees.map((emp) => (
                        <option key={emp.employeeId} value={emp.employeeId}>
                          {emp.name} ({emp.positionName || '-'})
                        </option>
                      ))}
                    </Select>
                  </div>

                  {/* 角色标签 */}
                  {entry.roleType && (
                    <span className={`text-xs px-2 py-0.5 rounded shrink-0 ${
                      entry.roleType === '推广师'
                        ? 'bg-blue-50 text-blue-700'
                        : 'bg-green-50 text-green-700'
                    }`}>
                      {entry.roleType}
                    </span>
                  )}

                  {/* 分配比例选择 */}
                  <div className="w-24 shrink-0">
                    <Select
                      value={entry.ratioPercent}
                      onChange={(e) => onUpdate(item.saleItemId, entry.id, 'ratioPercent', e.target.value)}
                    >
                      <option value="">分配</option>
                      {PERCENTAGE_OPTIONS.map((p) => (
                        <option key={p} value={String(p)}>{p}%</option>
                      ))}
                    </Select>
                  </div>

                  {/* 分配金额（只读） */}
                  <div className="w-28 shrink-0 text-right">
                    <span className="text-sm font-medium">¥{Number(entry.amount).toLocaleString()}</span>
                  </div>

                  {/* 删除 */}
                  <Button size="sm" variant="ghost" onClick={() => onRemove(item.saleItemId, entry.id)} className="text-[#D94040] shrink-0 px-1">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </Button>
                </div>

                {/* 提成信息（参考） */}
                {entry.employeeId && entry.ratioPercent && (
                  <div className="mt-1.5 text-[11px] text-[#999999] pl-1">
                    提成比例 {(commissionRate * 100).toFixed(1)}%
                    {commissionRate > 0 && (
                      <> → 预估提成 ¥{commissionAmount.toFixed(2)}</>
                    )}
                    {commissionRate === 0 && !rateRef && (
                      <span className="text-[#D4820A]">（未匹配到提成矩阵）</span>
                    )}
                  </div>
                )}
              </div>
            )
          })
        ) : (
          <p className="text-xs text-[#999999] py-2">暂无分配，点击"添加分配"开始</p>
        )}

        {/* 角色组分配比例合计 + 添加按钮 */}
        <div className="flex items-center justify-between pt-1">
          <div className="flex gap-4 text-xs">
            {(groupSums.beautician > 0 || groupCounts.beautician > 0) && (
              <span className={groupSums.beautician > 100 ? 'text-[#D94040] font-medium' : 'text-[#999999]'}>
                美容师/养生师: {groupSums.beautician || 0}%
                {groupSums.beautician > 100 && ' (超出100%)'}
              </span>
            )}
            {(groupSums.promoter > 0 || groupCounts.promoter > 0) && (
              <span className={groupSums.promoter > 100 ? 'text-[#D94040] font-medium' : 'text-[#999999]'}>
                推广师: {groupSums.promoter || 0}%
                {groupSums.promoter > 100 && ' (超出100%)'}
              </span>
            )}
          </div>
          {canAdd && (
            <Button size="sm" variant="outline" onClick={() => onAdd(item.saleItemId)}>
              + 添加分配
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
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
  itemAllocs: Record<string, AllocationEntry[]>
}) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  const handleSave = () => {
    const flatAllocations: Array<{
      saleItemId: string
      employeeId: string
      roleType: string
      allocationRatio: string
      totalAmount: string
    }> = []

    for (const item of items) {
      const entries = (itemAllocs[item.saleItemId] || []).filter((e) => e.employeeId || e.ratioPercent)

      // 校验完整性
      for (const e of entries) {
        if (!e.employeeId || !e.ratioPercent) {
          toast.error('请填写完整的分配信息（员工和比例）')
          return
        }
        if (!e.roleType) {
          toast.error('无法确定员工角色，请检查员工技能标签设置')
          return
        }
      }

      // 按角色组分组校验
      const groups: Record<string, AllocationEntry[]> = {}
      for (const e of entries) {
        const g = getRoleGroup(e.roleType)
        ;(groups[g] ??= []).push(e)
      }

      for (const [group, gEntries] of Object.entries(groups)) {
        // 最多 3 人
        if (gEntries.length > MAX_PER_GROUP) {
          const label = group === 'promoter' ? '推广师' : '美容师/养生师'
          toast.error(`${item.productName || '商品'} 的${label}最多分配 3 人`)
          return
        }

        // 同组不可重复员工
        const empIds = new Set<string>()
        for (const e of gEntries) {
          if (empIds.has(e.employeeId)) {
            toast.error(`${item.productName || '商品'} 中同角色组不能重复选择同一员工`)
            return
          }
          empIds.add(e.employeeId)
        }

        // 分配比例合计 ≤ 100%
        const ratioSum = gEntries.reduce((s, e) => s + Number(e.ratioPercent), 0)
        if (ratioSum > 100) {
          const label = group === 'promoter' ? '推广师' : '美容师/养生师'
          toast.error(`${item.productName || '商品'} 的${label}分配比例合计超过 100%`)
          return
        }
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
