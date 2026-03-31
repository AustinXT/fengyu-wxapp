"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { StatusBadge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { batchSaveServiceCommissions } from "@/actions/service-commissions"
import type { ServiceOrder, ServiceCommission, Employee, CommissionRate } from "@/lib/types"
import type { ServiceItemDetail } from "@/actions/services"

// --------------- 常量 ---------------

const SKILL_TAGS = ['美容师', '养生师', '推广师'] as const
const PERCENTAGE_OPTIONS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const
const MAX_PER_GROUP = 3

// --------------- 类型 ---------------

interface CommissionEntry {
  id: number
  skillTag: string
  employeeId: string
  ratioPercent: string
  allocAmount: string       // 分配金额 = ratioPercent/100 × unitRealPrice
  commissionRate: number    // 提成比例（从矩阵获取）
  commissionAmount: string  // 提成金额 = allocAmount × commissionRate
}

// --------------- 工具函数 ---------------

function getRoleGroup(roleType: string): string {
  return roleType === '推广师' ? 'promoter' : 'beautician'
}

function findMatchingRate(
  rates: CommissionRate[],
  marketName: string,
  roleType: string,
  salesCategory: string | null,
  amount: number,
): CommissionRate | null {
  return rates.find((r) =>
    r.orgName === marketName &&
    r.orderType === '服务单' &&
    r.roleType === roleType &&
    r.salesCategory === (salesCategory || '') &&
    Number(r.amountTierMin) <= amount &&
    (r.amountTierMax === null || Number(r.amountTierMax) > amount)
  ) ?? null
}

function sortByPosition(employees: Employee[]): Employee[] {
  return [...employees].sort((a, b) =>
    (a.positionName || '').localeCompare(b.positionName || '', 'zh-CN')
  )
}

function calcAllocAmount(ratioPercent: string, unitPrice: number): string {
  const ratio = Number(ratioPercent)
  if (isNaN(ratio) || ratio <= 0) return '0.00'
  return ((ratio / 100) * unitPrice).toFixed(2)
}

// --------------- 初始化 ---------------

function initCommissions(
  serviceItems: ServiceItemDetail[],
  commissions: ServiceCommission[],
  employees: Employee[],
  commissionRates: CommissionRate[],
  marketName: string,
): Record<string, CommissionEntry[]> {
  const result: Record<string, CommissionEntry[]> = {}
  for (const item of serviceItems) result[item.serviceItemId] = []

  for (const comm of commissions) {
    if (!result[comm.serviceItemId]) continue
    const item = serviceItems.find((i) => i.serviceItemId === comm.serviceItemId)
    const unitPrice = item ? Number(item.unitRealPrice) : 0

    const emp = employees.find((e) => e.employeeId === comm.employeeId)
    let skillTag = comm.roleType || ''
    if (!skillTag && emp) {
      const skills = emp.skills || []
      if (skills.includes('推广师')) skillTag = '推广师'
      else if (skills.includes('养生师')) skillTag = '养生师'
      else skillTag = '美容师'
    }
    skillTag = skillTag || '美容师'

    // 回退兼容：旧数据没有 allocationRatio，从 commissionAmount 反推
    let ratioPercent: string
    if (comm.allocationRatio) {
      ratioPercent = (Number(comm.allocationRatio) * 100).toFixed(0)
    } else {
      // 旧数据：直接用提成比例
      ratioPercent = '100'
    }

    const allocAmount = calcAllocAmount(ratioPercent, unitPrice)
    const rateRef = findMatchingRate(commissionRates, marketName, skillTag, item?.salesCategory ?? null, unitPrice)
    const commRate = rateRef ? Number(rateRef.commissionRate) : Number(comm.commissionRate)

    result[comm.serviceItemId].push({
      id: Date.now() + Math.random(),
      skillTag,
      employeeId: comm.employeeId,
      ratioPercent,
      allocAmount,
      commissionRate: commRate,
      commissionAmount: (Number(allocAmount) * commRate).toFixed(2),
    })
  }

  return result
}

// --------------- 主组件 ---------------

export default function ServiceCommissionDetailPageClient({
  serviceOrder,
  serviceItems,
  commissions,
  employees,
  commissionRates = [],
  marketStoreIds = [],
}: {
  serviceOrder: ServiceOrder
  serviceItems: ServiceItemDetail[]
  commissions: ServiceCommission[]
  employees: Employee[]
  commissionRates?: CommissionRate[]
  marketStoreIds?: string[]
}) {
  const allActiveEmployees = useMemo(
    () => sortByPosition(employees.filter((e) => !e.isResigned)),
    [employees],
  )

  const getFilteredEmployees = (skillTag: string) => {
    if (!skillTag) return []
    const storeScope = skillTag === '美容师'
      ? [serviceOrder.storeId]
      : marketStoreIds.length > 0 ? marketStoreIds : [serviceOrder.storeId]
    return allActiveEmployees.filter(
      (e) => e.storeId && storeScope.includes(e.storeId) && e.skills?.includes(skillTag)
    )
  }

  const marketName = serviceOrder.marketName

  const [itemComms, setItemComms] = useState<Record<string, CommissionEntry[]>>(() =>
    initCommissions(serviceItems, commissions, employees, commissionRates, marketName)
  )

  const addEntry = (serviceItemId: string) => {
    setItemComms((prev) => ({
      ...prev,
      [serviceItemId]: [
        ...(prev[serviceItemId] || []),
        {
          id: Date.now() + Math.random(),
          skillTag: '',
          employeeId: '',
          ratioPercent: '',
          allocAmount: '0.00',
          commissionRate: 0,
          commissionAmount: '0.00',
        },
      ],
    }))
  }

  const updateEntry = (
    serviceItemId: string,
    entryId: number,
    field: 'skillTag' | 'employeeId' | 'ratioPercent',
    value: string,
  ) => {
    setItemComms((prev) => {
      const item = serviceItems.find((i) => i.serviceItemId === serviceItemId)
      const unitPrice = item ? Number(item.unitRealPrice) : 0
      const entries = prev[serviceItemId] || []

      return {
        ...prev,
        [serviceItemId]: entries.map((e) => {
          if (e.id !== entryId) return e
          const updated = { ...e, [field]: value }

          if (field === 'skillTag') {
            updated.employeeId = ''
            const rateRef = findMatchingRate(commissionRates, marketName, value, item?.salesCategory ?? null, unitPrice)
            updated.commissionRate = rateRef ? Number(rateRef.commissionRate) : 0
          }

          if (field === 'employeeId' && updated.skillTag) {
            const rateRef = findMatchingRate(commissionRates, marketName, updated.skillTag, item?.salesCategory ?? null, unitPrice)
            updated.commissionRate = rateRef ? Number(rateRef.commissionRate) : 0
          }

          updated.allocAmount = calcAllocAmount(updated.ratioPercent, unitPrice)
          updated.commissionAmount = (Number(updated.allocAmount) * updated.commissionRate).toFixed(2)

          return updated
        }),
      }
    })
  }

  const removeEntry = (serviceItemId: string, entryId: number) => {
    setItemComms((prev) => ({
      ...prev,
      [serviceItemId]: (prev[serviceItemId] || []).filter((e) => e.id !== entryId),
    }))
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/allocations?tab=service" className="text-[#999999] hover:text-[var(--foreground)]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
        </Link>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">服务提成分配</h1>
      </div>

      {/* 服务单摘要 */}
      <Card>
        <CardHeader><CardTitle>服务单信息</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-[#999999]">服务单号</span>
              <p className="font-medium mt-1">{serviceOrder.serviceOrderId}</p>
            </div>
            <div>
              <span className="text-[#999999]">顾客</span>
              <p className="font-medium mt-1">{serviceOrder.customerName || "-"}</p>
            </div>
            <div>
              <span className="text-[#999999]">状态</span>
              <p className="mt-1"><StatusBadge status={serviceOrder.status} /></p>
            </div>
            <div>
              <span className="text-[#999999]">美容师</span>
              <p className="font-medium mt-1">{serviceOrder.employeeName || "-"}</p>
            </div>
            <div>
              <span className="text-[#999999]">门店</span>
              <p className="font-medium mt-1">{serviceOrder.storeName || "-"}</p>
            </div>
            <div>
              <span className="text-[#999999]">服务日期</span>
              <p className="font-medium mt-1">{serviceOrder.serviceDate}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 逐服务明细分配卡片 */}
      {serviceItems.map((item) => (
        <ServiceItemCard
          key={item.serviceItemId}
          item={item}
          entries={itemComms[item.serviceItemId] || []}
          getFilteredEmployees={getFilteredEmployees}
          onAdd={addEntry}
          onUpdate={updateEntry}
          onRemove={removeEntry}
        />
      ))}

      {/* 保存 */}
      <Card>
        <CardContent className="pt-6">
          <SaveButton
            serviceOrderId={serviceOrder.serviceOrderId}
            serviceItems={serviceItems}
            itemComms={itemComms}
          />
        </CardContent>
      </Card>
    </div>
  )
}

// --------------- 服务明细卡片 ---------------

function ServiceItemCard({
  item,
  entries,
  getFilteredEmployees,
  onAdd,
  onUpdate,
  onRemove,
}: {
  item: ServiceItemDetail
  entries: CommissionEntry[]
  getFilteredEmployees: (skillTag: string) => Employee[]
  onAdd: (serviceItemId: string) => void
  onUpdate: (serviceItemId: string, entryId: number, field: 'skillTag' | 'employeeId' | 'ratioPercent', value: string) => void
  onRemove: (serviceItemId: string, entryId: number) => void
}) {
  const unitPrice = Number(item.unitRealPrice)

  const groupSums: Record<string, number> = {}
  for (const e of entries) {
    if (!e.skillTag) continue
    const g = getRoleGroup(e.skillTag)
    groupSums[g] = (groupSums[g] || 0) + Number(e.ratioPercent || 0)
  }

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
          <span className="text-lg font-bold text-[var(--primary)]">¥{unitPrice.toLocaleString()}</span>
        </div>
        <p className="text-xs text-[#999999] mt-1">
          核销 {item.sessionUsed} 次 · 操作员: {item.employeeName || '-'}
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {entries.length > 0 ? (
          entries.map((entry) => {
            const filteredEmployees = getFilteredEmployees(entry.skillTag)

            return (
              <div key={entry.id} className="bg-[#FAFAFA] rounded-lg px-4 py-2.5 flex items-end gap-2 flex-wrap">
                {/* 技能标签 */}
                <div className="w-24 shrink-0">
                  <label className="text-[10px] text-[#999999]">技能标签</label>
                  <Select
                    value={entry.skillTag}
                    onChange={(e) => onUpdate(item.serviceItemId, entry.id, 'skillTag', e.target.value)}
                  >
                    <option value="">选择</option>
                    {SKILL_TAGS.map((tag) => (
                      <option key={tag} value={tag}>{tag}</option>
                    ))}
                  </Select>
                </div>

                {/* 员工 */}
                <div className="w-32 shrink-0">
                  <label className="text-[10px] text-[#999999]">员工</label>
                  <Select
                    value={entry.employeeId}
                    onChange={(e) => onUpdate(item.serviceItemId, entry.id, 'employeeId', e.target.value)}
                    disabled={!entry.skillTag}
                  >
                    <option value="">{entry.skillTag ? `选择(${filteredEmployees.length}人)` : '先选标签'}</option>
                    {filteredEmployees.map((emp) => (
                      <option key={emp.employeeId} value={emp.employeeId}>
                        {emp.name}
                      </option>
                    ))}
                  </Select>
                </div>

                {/* 提成比例（只读） */}
                <div className="w-16 shrink-0 text-center">
                  <label className="text-[10px] text-[#999999]">提成</label>
                  <p className="text-sm font-medium h-9 flex items-center justify-center">
                    {entry.skillTag
                      ? entry.commissionRate > 0
                        ? `${(entry.commissionRate * 100).toFixed(1)}%`
                        : <span className="text-[#D4820A]">0%</span>
                      : '-'}
                  </p>
                </div>

                {/* 分配比例 */}
                <div className="w-20 shrink-0">
                  <label className="text-[10px] text-[#999999]">分配</label>
                  <Select
                    value={entry.ratioPercent}
                    onChange={(e) => onUpdate(item.serviceItemId, entry.id, 'ratioPercent', e.target.value)}
                  >
                    <option value="">-</option>
                    {PERCENTAGE_OPTIONS.map((p) => (
                      <option key={p} value={String(p)}>{p}%</option>
                    ))}
                  </Select>
                </div>

                {/* 分配金额（只读） */}
                <div className="w-20 shrink-0 text-right">
                  <label className="text-[10px] text-[#999999]">分配额</label>
                  <p className="text-sm font-medium h-9 flex items-center justify-end">¥{Number(entry.allocAmount).toLocaleString()}</p>
                </div>

                {/* 提成金额（只读） */}
                <div className="w-20 shrink-0 text-right">
                  <label className="text-[10px] text-[#999999]">提成额</label>
                  <p className="text-sm font-medium h-9 flex items-center justify-end text-[var(--primary)]">¥{Number(entry.commissionAmount).toLocaleString()}</p>
                </div>

                {/* 删除 */}
                <Button size="sm" variant="ghost" onClick={() => onRemove(item.serviceItemId, entry.id)} className="text-[#D94040] shrink-0 px-1">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </Button>
              </div>
            )
          })
        ) : (
          <p className="text-xs text-[#999999] py-2">暂无分配，点击"添加分配"开始</p>
        )}

        <div className="flex items-center justify-between pt-1">
          <div className="flex gap-4 text-xs">
            {groupSums.beautician != null && (
              <span className={groupSums.beautician > 100 ? 'text-[#D94040] font-medium' : 'text-[#999999]'}>
                美容师/养生师: {groupSums.beautician}% / 100%
                {groupSums.beautician > 100 && ' (超出)'}
              </span>
            )}
            {groupSums.promoter != null && (
              <span className={groupSums.promoter > 100 ? 'text-[#D94040] font-medium' : 'text-[#999999]'}>
                推广师: {groupSums.promoter}% / 100%
                {groupSums.promoter > 100 && ' (超出)'}
              </span>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={() => onAdd(item.serviceItemId)}>
            + 添加分配
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// --------------- 保存按钮 ---------------

function SaveButton({
  serviceOrderId,
  serviceItems,
  itemComms,
}: {
  serviceOrderId: string
  serviceItems: ServiceItemDetail[]
  itemComms: Record<string, CommissionEntry[]>
}) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  const handleSave = () => {
    const flatCommissions: Array<{
      serviceItemId: string
      employeeId: string
      roleType: string
      allocationRatio: string
      commissionRate: string
      commissionAmount: string
    }> = []

    for (const item of serviceItems) {
      const entries = (itemComms[item.serviceItemId] || []).filter((e) => e.skillTag || e.employeeId || e.ratioPercent)

      for (const e of entries) {
        if (!e.skillTag || !e.employeeId || !e.ratioPercent) {
          toast.error('请填写完整的分配信息（技能标签、员工、分配比例）')
          return
        }
      }

      const groups: Record<string, CommissionEntry[]> = {}
      for (const e of entries) {
        const g = getRoleGroup(e.skillTag)
        ;(groups[g] ??= []).push(e)
      }

      for (const [group, gEntries] of Object.entries(groups)) {
        if (gEntries.length > MAX_PER_GROUP) {
          const label = group === 'promoter' ? '推广师' : '美容师/养生师'
          toast.error(`${item.productName || '服务'} 的${label}最多分配 3 人`)
          return
        }

        const empIds = new Set<string>()
        for (const e of gEntries) {
          if (empIds.has(e.employeeId)) {
            toast.error(`${item.productName || '服务'} 中同角色组不能重复选择同一员工`)
            return
          }
          empIds.add(e.employeeId)
        }

        const ratioSum = gEntries.reduce((s, e) => s + Number(e.ratioPercent), 0)
        if (ratioSum > 100) {
          const label = group === 'promoter' ? '推广师' : '美容师/养生师'
          toast.error(`${item.productName || '服务'} 的${label}分配比例合计超过 100%`)
          return
        }
      }

      for (const e of entries) {
        flatCommissions.push({
          serviceItemId: item.serviceItemId,
          employeeId: e.employeeId,
          roleType: e.skillTag,
          allocationRatio: (Number(e.ratioPercent) / 100).toFixed(2),
          commissionRate: e.commissionRate.toFixed(4),
          commissionAmount: e.commissionAmount,
        })
      }
    }

    startTransition(async () => {
      const res = await batchSaveServiceCommissions(serviceOrderId, flatCommissions)
      if (res.success) {
        toast.success(res.message)
        router.push('/allocations?tab=service')
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <div className="flex justify-end gap-3">
      <Link href="/allocations?tab=service">
        <Button variant="outline">取消</Button>
      </Link>
      <Button onClick={handleSave} loading={pending}>保存提成</Button>
    </div>
  )
}
