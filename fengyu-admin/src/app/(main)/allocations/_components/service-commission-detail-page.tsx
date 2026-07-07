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



const SKILL_TAGS = ['美容师', '养生师', '推广师', '品项老师'] as const
const PERCENTAGE_OPTIONS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const
const MAX_PER_GROUP = 3



interface CommissionEntry {
  id: number
  skillTag: string
  employeeId: string
  ratioPercent: string
  allocAmount: string       
  commissionRate: number    
  commissionAmount: string  
}




function getPoolKey(roleType: string): string {
  return roleType
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


function perSessionPrice(item: ServiceItemDetail): number {
  return Number(item.unitRealPrice ?? 0)
}


function consumeBase(item: ServiceItemDetail): number {
  return Math.round(perSessionPrice(item) * item.sessionUsed * 100) / 100
}

function calcAllocAmount(ratioPercent: string, base: number): string {
  const ratio = Number(ratioPercent)
  if (isNaN(ratio) || ratio <= 0) return '0.00'
  return ((ratio / 100) * base).toFixed(2)
}




function deriveSkillTag(emp: Employee | undefined): string {
  const skills = emp?.skills || []
  if (skills.includes('推广师')) return '推广师'
  if (skills.includes('养生师')) return '养生师'
  return '美容师'
}


function buildEntry(
  item: ServiceItemDetail | undefined,
  skillTag: string,
  employeeId: string,
  ratioPercent: string,
  commissionRates: CommissionRate[],
  marketName: string,
  fallbackRate: number,
): CommissionEntry {
  const base = item ? consumeBase(item) : 0
  const allocAmount = calcAllocAmount(ratioPercent, base)
  const rateRef = findMatchingRate(commissionRates, marketName, skillTag, item?.salesCategory ?? null, base)
  const commRate = rateRef ? Number(rateRef.commissionRate) : fallbackRate
  return {
    id: Date.now() + Math.random(),
    skillTag,
    employeeId,
    ratioPercent,
    allocAmount,
    commissionRate: commRate,
    commissionAmount: (Number(allocAmount) * commRate).toFixed(2),
  }
}

function initCommissions(
  serviceItems: ServiceItemDetail[],
  commissions: ServiceCommission[],
  employees: Employee[],
  commissionRates: CommissionRate[],
  marketName: string,
  assignedEmployeeId?: string | null,
): Record<string, CommissionEntry[]> {
  const result: Record<string, CommissionEntry[]> = {}
  for (const item of serviceItems) result[item.serviceItemId] = []

  for (const comm of commissions) {
    if (!result[comm.serviceItemId]) continue
    const item = serviceItems.find((i) => i.serviceItemId === comm.serviceItemId)

    const emp = employees.find((e) => e.employeeId === comm.employeeId)
    const skillTag = comm.roleType || deriveSkillTag(emp)

    const ratioPercent = (Number(comm.allocationRatio) * 100).toFixed(0)
    result[comm.serviceItemId].push(
      buildEntry(item, skillTag, comm.employeeId, ratioPercent, commissionRates, marketName, Number(comm.commissionRate)),
    )
  }

  
  
  if (assignedEmployeeId) {
    const assignedEmp = employees.find((e) => e.employeeId === assignedEmployeeId)
    const assignedSkillTag = deriveSkillTag(assignedEmp)
    for (const item of serviceItems) {
      if (result[item.serviceItemId].length === 0) {
        result[item.serviceItemId].push(
          buildEntry(item, assignedSkillTag, assignedEmployeeId, '100', commissionRates, marketName, 0),
        )
      }
    }
  }

  return result
}



export default function ServiceCommissionDetailPageClient({
  serviceOrder,
  serviceItems,
  commissions,
  employees,
  commissionRates = [],
}: {
  serviceOrder: ServiceOrder
  serviceItems: ServiceItemDetail[]
  commissions: ServiceCommission[]
  employees: Employee[]
  commissionRates?: CommissionRate[]
}) {
  const allActiveEmployees = useMemo(
    () => sortByPosition(employees.filter((e) => !e.isResigned)),
    [employees],
  )

  
  
  
  const getFilteredEmployees = (skillTag: string) => {
    if (!skillTag) return []
    return allActiveEmployees.filter(
      (e) => (e.storeId === serviceOrder.storeId || e.isOnBusinessTrip) && e.skills?.includes(skillTag)
    )
  }

  const marketName = serviceOrder.marketName

  const [itemComms, setItemComms] = useState<Record<string, CommissionEntry[]>>(() =>
    initCommissions(serviceItems, commissions, employees, commissionRates, marketName, serviceOrder.assignedEmployeeId)
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
      const base = item ? consumeBase(item) : 0
      const entries = prev[serviceItemId] || []

      return {
        ...prev,
        [serviceItemId]: entries.map((e) => {
          if (e.id !== entryId) return e
          const updated = { ...e, [field]: value }

          if (field === 'skillTag') {
            updated.employeeId = ''
            const rateRef = findMatchingRate(commissionRates, marketName, value, item?.salesCategory ?? null, base)
            updated.commissionRate = rateRef ? Number(rateRef.commissionRate) : 0
          }

          if (field === 'employeeId' && updated.skillTag) {
            const rateRef = findMatchingRate(commissionRates, marketName, updated.skillTag, item?.salesCategory ?? null, base)
            updated.commissionRate = rateRef ? Number(rateRef.commissionRate) : 0
          }

          updated.allocAmount = calcAllocAmount(updated.ratioPercent, base)
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

      {}
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
              <p className="font-medium mt-1">{serviceOrder.customerName || "—"}</p>
            </div>
            <div>
              <span className="text-[#999999]">状态</span>
              <p className="mt-1"><StatusBadge status={serviceOrder.status} /></p>
            </div>
            <div>
              <span className="text-[#999999]">美容师</span>
              <p className="font-medium mt-1">{serviceOrder.employeeName || "—"}</p>
            </div>
            <div>
              <span className="text-[#999999]">门店</span>
              <p className="font-medium mt-1">{serviceOrder.storeName || "—"}</p>
            </div>
            <div>
              <span className="text-[#999999]">服务日期</span>
              <p className="font-medium mt-1">{serviceOrder.serviceDate}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {}
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

      {}
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
  const base = consumeBase(item)

  
  const groupSums: Record<string, number> = {}
  for (const e of entries) {
    if (!e.skillTag) continue
    const g = getPoolKey(e.skillTag)
    groupSums[g] = (groupSums[g] || 0) + Number(e.ratioPercent || 0)
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-baseline justify-between">
          <CardTitle className="text-base">
            {item.productName || '—'}
            {item.skuName ? ` - ${item.skuName}` : ''}
            {item.salesCategory && (
              <span className="ml-2 text-xs font-normal text-[#999999] bg-gray-100 px-2 py-0.5 rounded">
                {item.salesCategory}
              </span>
            )}
          </CardTitle>
          <span className="text-lg font-bold text-[var(--primary)]">¥{base.toLocaleString()}</span>
        </div>
        <p className="text-xs text-[#999999] mt-1">
          核销 {item.sessionUsed} 次 · 操作员: {item.employeeName || '—'}
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {entries.length > 0 ? (
          entries.map((entry) => {
            const filteredEmployees = getFilteredEmployees(entry.skillTag)

            return (
              <div key={entry.id} className="bg-[#FAFAFA] rounded-lg px-4 py-2.5 flex items-end gap-2 flex-wrap">
                {}
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

                {}
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

                {}
                <div className="w-16 shrink-0 text-center">
                  <label className="text-[10px] text-[#999999]">提成</label>
                  <p className="text-sm font-medium h-9 flex items-center justify-center">
                    {entry.skillTag
                      ? entry.commissionRate > 0
                        ? `${(entry.commissionRate * 100).toFixed(1)}%`
                        : <span className="text-[#D4820A]">0%</span>
                      : '—'}
                  </p>
                </div>

                {}
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

                {}
                <div className="w-20 shrink-0 text-right">
                  <label className="text-[10px] text-[#999999]">分配额</label>
                  <p className="text-sm font-medium h-9 flex items-center justify-end">¥{Number(entry.allocAmount).toLocaleString()}</p>
                </div>

                {}
                <div className="w-20 shrink-0 text-right">
                  <label className="text-[10px] text-[#999999]">提成额</label>
                  <p className="text-sm font-medium h-9 flex items-center justify-end text-[var(--primary)]">¥{Number(entry.commissionAmount).toLocaleString()}</p>
                </div>

                {}
                <Button size="sm" variant="ghost" onClick={() => onRemove(item.serviceItemId, entry.id)} className="text-[#D94040] shrink-0 px-1">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </Button>
              </div>
            )
          })
        ) : (
          <p className="text-xs text-[#999999] py-2">暂无分配，点击"添加分配"开始</p>
        )}

        {}
        <div className="flex items-center justify-between pt-1">
          <div className="flex gap-4 text-xs flex-wrap">
            {Object.entries(groupSums).map(([role, sum]) => (
              <span
                key={role}
                className={sum > 100 ? 'text-[#D94040] font-medium' : 'text-[#999999]'}
              >
                {role}: {sum}% / 100%
                {sum > 100 && ' (超出)'}
              </span>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={() => onAdd(item.serviceItemId)}>
            + 添加分配
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}



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

      
      const pools: Record<string, CommissionEntry[]> = {}
      for (const e of entries) {
        const g = getPoolKey(e.skillTag)
        ;(pools[g] ??= []).push(e)
      }

      for (const [roleType, poolEntries] of Object.entries(pools)) {
        if (poolEntries.length > MAX_PER_GROUP) {
          toast.error(`${item.productName || '服务'} 的${roleType}最多分配 3 人`)
          return
        }

        const empIds = new Set<string>()
        for (const e of poolEntries) {
          if (empIds.has(e.employeeId)) {
            toast.error(`${item.productName || '服务'} 中同技能标签不能重复选择同一员工`)
            return
          }
          empIds.add(e.employeeId)
        }

        const ratioSum = poolEntries.reduce((s, e) => s + Number(e.ratioPercent), 0)
        if (ratioSum > 100) {
          toast.error(`${item.productName || '服务'} 的${roleType}分配比例合计超过 100%`)
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
