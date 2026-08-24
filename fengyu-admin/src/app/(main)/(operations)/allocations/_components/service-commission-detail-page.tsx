"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { StatusBadge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { batchSaveServiceCommissions } from "@/actions/service-commissions"
import type { ServiceOrder, ServiceCommission, Employee, CommissionRate, SkillTag } from "@/lib/types"
import type { ServiceItemDetail } from "@/actions/services"
import { isEmployeeInStoreAssignmentScope } from "@/lib/employee-assignment"

// --------------- 常量 ---------------

const PERCENTAGE_OPTIONS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const
const MAX_PER_GROUP = 3

// --------------- 类型 ---------------

interface CommissionEntry {
  id: number
  skillTag: string
  employeeId: string
  ratioPercent: string
  allocAmount: string       // 分配金额 = ratioPercent/100 × perSessionPrice × sessionUsed
  commissionRate: number    // 提成比例（从矩阵获取，按 consumeBase 查档）
  commissionAmount: string  // 提成金额 = allocAmount × commissionRate
  legacyEmployeeName?: string
}

// --------------- 工具函数 ---------------

/** 技能标签池键：每个 roleType 独立建池（P2-14 Q5：池间互不约束） */
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

/**
 * 单次（per-session）价格。
 * service_items.unit_real_price 是 sale_items.unit_real_price 的快照，
 * 已是 per-session 单次价，直接取用（不再 ÷session_count）。
 */
function perSessionPrice(item: ServiceItemDetail): number {
  return Number(item.unitRealPrice ?? 0)
}

/** 本次服务可分配金额基底 = perSessionPrice × sessionUsed */
function consumeBase(item: ServiceItemDetail): number {
  return Math.round(perSessionPrice(item) * item.sessionUsed * 100) / 100
}

function calcAllocAmount(ratioPercent: string, base: number): string {
  const ratio = Number(ratioPercent)
  if (isNaN(ratio) || ratio <= 0) return '0.00'
  return ((ratio / 100) * base).toFixed(2)
}

function formatServiceItemName(item: Pick<ServiceItemDetail, 'productName' | 'skuName'>): string {
  const productName = (item.productName ?? '').trim()
  const skuName = (item.skuName ?? '').trim()

  if (!productName && !skuName) return '—'
  if (!productName) return skuName
  if (!skuName || skuName === productName) return productName
  return `${productName} - ${skuName}`
}

// --------------- 初始化 ---------------

/** 按员工 skills 推导技能标签（推广师 > 养生师 > 美容师 兜底）；无员工时回退美容师 */
function deriveSkillTag(emp: Employee | undefined): string {
  const skills = emp?.skills || []
  if (skills.includes('推广师')) return '推广师'
  if (skills.includes('养生师')) return '养生师'
  return '美容师'
}

/** 按服务明细 + 比例计算一行提成条目（已分配回填 / 默认预填共用同一套算法） */
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

export function initCommissions(
  serviceItems: ServiceItemDetail[],
  commissions: ServiceCommission[],
  employees: Employee[],
  commissionRates: CommissionRate[],
  marketName: string,
  targetStoreId: string,
  assignedEmployeeId?: string | null,
): Record<string, CommissionEntry[]> {
  const result: Record<string, CommissionEntry[]> = {}
  for (const item of serviceItems) result[item.serviceItemId] = []

  for (const comm of commissions) {
    if (!result[comm.serviceItemId]) continue
    const item = serviceItems.find((i) => i.serviceItemId === comm.serviceItemId)

    const emp = employees.find((e) => e.employeeId === comm.employeeId)
    const skillTag = comm.roleType || deriveSkillTag(emp)

    const ratioPercent = String(Number((Number(comm.allocationRatio) * 100).toFixed(1)))
    result[comm.serviceItemId].push({
      ...buildEntry(item, skillTag, comm.employeeId, ratioPercent, commissionRates, marketName, Number(comm.commissionRate)),
      legacyEmployeeName: comm.employeeName,
    })
  }

  // 未分配的服务明细默认预填 1 行：指派美容师 + 100% + 按费率算的单人提成
  // （用户可改/可加行；提交仍走 batchSaveServiceCommissions）
  if (assignedEmployeeId) {
    const assignedEmp = employees.find((e) => e.employeeId === assignedEmployeeId)
    if (!assignedEmp || !isEmployeeInStoreAssignmentScope(assignedEmp, targetStoreId, marketName)) {
      return result
    }
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

// --------------- 主组件 ---------------

export default function ServiceCommissionDetailPageClient({
  serviceOrder,
  serviceItems,
  commissions,
  employees,
  commissionRates = [],
  skillTags = [],
  canSave = false,
}: {
  serviceOrder: ServiceOrder
  serviceItems: ServiceItemDetail[]
  commissions: ServiceCommission[]
  employees: Employee[]
  commissionRates?: CommissionRate[]
  skillTags?: SkillTag[]
  canSave?: boolean
}) {
  const allActiveEmployees = useMemo(
    () => sortByPosition(employees.filter((e) => !e.isResigned)),
    [employees],
  )
  // 技能标签下拉选项：严格来自数据库 skill_tags（与 allocation-detail-page / payment-allocation-detail-page 一致，
  // 不再硬编码白名单——字典加新标签后此页立即可选）
  const skillTagNames = useMemo(() => skillTags.map((t) => t.name), [skillTags])

  // 外店出差员工仅能在服务单所属市场内参与分配。
  const getFilteredEmployees = (skillTag: string) => {
    if (!skillTag) return []
    return allActiveEmployees.filter(
      (e) => isEmployeeInStoreAssignmentScope(e, serviceOrder.storeId, serviceOrder.marketName ?? undefined)
        && e.skills?.includes(skillTag)
    )
  }

  const marketName = serviceOrder.marketName

  const [itemComms, setItemComms] = useState<Record<string, CommissionEntry[]>>(() =>
    initCommissions(
      serviceItems,
      commissions,
      employees,
      commissionRates,
      marketName,
      serviceOrder.storeId,
      serviceOrder.assignedEmployeeId,
    )
  )

  const addEntry = (serviceItemId: string) => {
    if (!canSave) return
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
    if (!canSave) return
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
    if (!canSave) return
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

      {/* 逐服务明细分配卡片 */}
      {serviceItems.map((item) => (
        <ServiceItemCard
          key={item.serviceItemId}
          item={item}
          entries={itemComms[item.serviceItemId] || []}
          skillTagOptions={skillTagNames}
          getFilteredEmployees={getFilteredEmployees}
          onAdd={addEntry}
          onUpdate={updateEntry}
          onRemove={removeEntry}
          canSave={canSave}
        />
      ))}

      {/* 保存 */}
      <Card>
        <CardContent className="pt-6">
          {canSave && (
            <SaveButton
              serviceOrderId={serviceOrder.serviceOrderId}
              serviceItems={serviceItems}
              itemComms={itemComms}
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// --------------- 服务明细卡片 ---------------

function ServiceItemCard({
  item,
  entries,
  skillTagOptions,
  getFilteredEmployees,
  onAdd,
  onUpdate,
  onRemove,
  canSave,
}: {
  item: ServiceItemDetail
  entries: CommissionEntry[]
  skillTagOptions: string[]
  getFilteredEmployees: (skillTag: string) => Employee[]
  onAdd: (serviceItemId: string) => void
  onUpdate: (serviceItemId: string, entryId: number, field: 'skillTag' | 'employeeId' | 'ratioPercent', value: string) => void
  onRemove: (serviceItemId: string, entryId: number) => void
  canSave: boolean
}) {
  const base = consumeBase(item)

  // 按 roleType 分池统计分配比例合计（P2-14 Q5：三角色独立）
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
            {formatServiceItemName(item)}
            {item.salesCategory && (
              <span className="ml-2 text-xs font-normal text-[#999999] bg-gray-100 px-2 py-0.5 rounded">
                {item.salesCategory}
              </span>
            )}
          </CardTitle>
          <span className="text-lg font-bold text-[var(--primary)]">¥{base.toLocaleString()}</span>
        </div>
        <p className="text-xs text-[#999999] mt-1">
          核销 {item.sessionUsed} {item.unit} · 操作员: {item.employeeName || '—'}
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {entries.length > 0 ? (
          entries.map((entry) => {
            const filteredEmployees = getFilteredEmployees(entry.skillTag)
            // 自定义比例：当前值非空且非档位时进入自定义模式（__custom 为刚选「自定义」尚未输入的哨兵）
            const isCustomRatio = entry.ratioPercent !== '' && entry.ratioPercent !== '__custom' && !(PERCENTAGE_OPTIONS as readonly number[]).includes(Number(entry.ratioPercent))
            const showCustomRatioInput = entry.ratioPercent === '__custom' || isCustomRatio
            const ratioSelectValue = entry.ratioPercent === '' ? '' : (showCustomRatioInput ? '__custom' : entry.ratioPercent)

            return (
              <div key={entry.id} className="bg-[#FAFAFA] rounded-lg px-4 py-2.5 flex items-end gap-2 flex-wrap">
                {/* 技能标签 */}
                <div className="w-24 shrink-0">
                  <label className="text-[10px] text-[#999999]">技能标签</label>
                  <Select
                    value={entry.skillTag}
                    onChange={(e) => onUpdate(item.serviceItemId, entry.id, 'skillTag', e.target.value)}
                    disabled={!canSave}
                  >
                    <option value="">选择</option>
                    {skillTagOptions.map((tag) => (
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
                    disabled={!canSave || !entry.skillTag}
                  >
                    <option value="">{entry.skillTag ? `选择(${filteredEmployees.length}人)` : '先选标签'}</option>
                    {entry.employeeId && !filteredEmployees.some((emp) => emp.employeeId === entry.employeeId) && (
                      <option value={entry.employeeId} disabled>
                        {entry.legacyEmployeeName || entry.employeeId}（历史跨市场）
                      </option>
                    )}
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
                      : '—'}
                  </p>
                </div>

                {/* 分配比例（档位快选 + 自定义） */}
                <div className="w-[204px] shrink-0">
                  <label className="text-[10px] text-[#999999]">分配</label>
                  <div className="flex items-center gap-1">
                    <Select
                      value={ratioSelectValue}
                      onChange={(e) => onUpdate(item.serviceItemId, entry.id, 'ratioPercent', e.target.value)}
                      className="w-[104px]"
                      disabled={!canSave}
                    >
                      <option value="">-</option>
                      {PERCENTAGE_OPTIONS.map((p) => (
                        <option key={p} value={String(p)}>{p}%</option>
                      ))}
                      <option value="__custom">✎ 自定义</option>
                    </Select>
                    {showCustomRatioInput && (
                      <Input
                        type="number"
                        step={0.1}
                        min={0.1}
                        max={100}
                        inputMode="decimal"
                        value={entry.ratioPercent === '__custom' ? '' : entry.ratioPercent}
                        onChange={(e) => onUpdate(item.serviceItemId, entry.id, 'ratioPercent', e.target.value)}
                        className="w-[88px]"
                        placeholder="%"
                        disabled={!canSave}
                      />
                    )}
                  </div>
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
                {canSave && (
                  <Button size="sm" variant="ghost" onClick={() => onRemove(item.serviceItemId, entry.id)} className="text-[#D94040] shrink-0 px-1">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </Button>
                )}
              </div>
            )
          })
        ) : (
          <p className="text-xs text-[#999999] py-2">暂无分配，点击"添加分配"开始</p>
        )}

        {/* 底部：每个技能标签独立池比例合计 + 添加按钮（P2-14 Q5） */}
        <div className="flex items-center justify-between pt-1">
          <div className="flex gap-4 text-xs flex-wrap">
            {Object.entries(groupSums).map(([role, sum]) => (
              <span
                key={role}
                className={sum > 100.01 ? 'text-[#D94040] font-medium' : 'text-[#999999]'}
              >
                {role}: {sum}% / 100%
                {sum > 100.01 && ' (超出)'}
              </span>
            ))}
          </div>
          {canSave && (
            <Button size="sm" variant="outline" onClick={() => onAdd(item.serviceItemId)}>
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
        if (!e.skillTag || !e.employeeId || !e.ratioPercent || e.ratioPercent === '__custom') {
          toast.error('请填写完整的分配信息（技能标签、员工、分配比例）')
          return
        }
      }

      // 按 (roleType) 分池校验（P2-14 Q5：三角色独立）
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
        // 容差 0.01%：仅吸收浮点漂移，不放过 ≥0.1% 真实超额（与后端 ratioSum>1.0001 同口径）
        if (ratioSum > 100.01) {
          toast.error(`${item.productName || '服务'} 的${roleType}分配比例合计超过 100%`)
          return
        }
      }

      for (const e of entries) {
        flatCommissions.push({
          serviceItemId: item.serviceItemId,
          employeeId: e.employeeId,
          roleType: e.skillTag,
          allocationRatio: (Number(e.ratioPercent) / 100).toFixed(3),
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
