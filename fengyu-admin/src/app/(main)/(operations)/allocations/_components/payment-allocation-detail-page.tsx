"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { savePaymentAllocations } from "@/actions/allocations"
import type { AllocationEmployeeCandidate, CommissionRate, SkillTag } from "@/lib/types"
import { getAllocationEmployeesForSkill, sortAllocationEmployeeCandidates } from "@/lib/allocation-employee"
import {
  calculateGroupedAmounts,
  expandGroupedAllocationLines,
  groupPaymentItems,
  type PaymentAllocationGroup,
  type PaymentAllocationItem,
  type PaymentAllocationSignatureLine,
} from "./payment-allocation-groups"

// ============================================================================
// 销售提成「回款维度」分配详情（2026-06 需求变更）：分配单元从订单下沉到一笔回款
// （sale_payment_id）。交互沿用按 sale_item 卡片编辑，但基数 = 本笔回款各项可分配额
// （allocatableAmount / received 别名），提成档位基准 = 本次回款额 eventAmount。
// 复制自 allocation-detail-page.tsx 改造；保存调 savePaymentAllocations。
// ============================================================================

// --------------- 常量 ---------------

const PERCENTAGE_OPTIONS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const
const MAX_PER_GROUP = 3

const allocationStatusMap: Record<string, { label: string; className: string }> = {
  待分配: { label: "待分配", className: "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]" },
  已分配: { label: "已分配", className: "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]" },
}

// --------------- 类型（getPaymentAllocatables 返回结构的本地镜像） ---------------

interface PaymentExistingAllocation extends PaymentAllocationSignatureLine {
  id: number
  totalAmount: string
  employeeName: string | null
}

interface PaymentAllocatables {
  salePaymentId: number
  saleOrderId: string
  paymentAmount: number
  eventAmount: number
  paymentMethod: string
  changeType: string
  allocationStatus: string | null
  marketName: string | null
  items: PaymentAllocationItem[]
  existingAllocations: PaymentExistingAllocation[]
}

interface AllocationEntry {
  id: number
  skillTag: string        // 先选：'美容师' | '养生师' | '推广师'
  employeeId: string      // 后选：按 skillTag 筛选后的员工
  ratioPercent: string    // '10' | '20' | ... | '100' | ''
  amount: string          // 自动 = ratioPercent/100 × 可分配额
  commissionRate: number  // 自动从提成矩阵获取（基准 = 本次回款额）
  commissionAmount: string // 自动 = amount × commissionRate
  legacyEmployeeName?: string
}

// --------------- 工具函数 ---------------

/** 技能标签池键：每个 roleType 独立建池（P2-14 Q5：池间互不约束） */
function getPoolKey(roleType: string): string {
  return roleType
}

/**
 * 根据市场、角色、销售分类、金额匹配提成比例。
 * 档位基准金额传本次回款额 eventAmount（与后端 savePaymentAllocations 一致）。
 */
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
function calculateEntryAmounts(
  group: PaymentAllocationGroup,
  ratioPercent: string,
  commissionRate: number,
): { amount: string; commissionAmount: string } {
  const { allocatedAmount, commissionAmount } = calculateGroupedAmounts(
    group.sourceItems,
    Number(ratioPercent) / 100,
    commissionRate,
  )
  return { amount: allocatedAmount, commissionAmount }
}

// --------------- 初始化状态 ---------------

function initAllocations(
  groups: PaymentAllocationGroup[],
  allocations: PaymentExistingAllocation[],
  employees: AllocationEmployeeCandidate[],
  commissionRates: CommissionRate[],
  marketName: string,
  eventAmount: number,
): Record<string, AllocationEntry[]> {
  const result: Record<string, AllocationEntry[]> = {}
  for (const group of groups) result[group.groupId] = []

  const groupsBySaleItem = new Map<string, PaymentAllocationGroup>()
  for (const group of groups) {
    for (const saleItemId of group.saleItemIds) groupsBySaleItem.set(saleItemId, group)
  }

  for (const alloc of allocations) {
    const group = groupsBySaleItem.get(alloc.saleItemId)
    // A group represents one shared configuration. Read just its first source
    // row; groups with differing historical configurations were split above.
    if (!group || group.saleItemIds[0] !== alloc.saleItemId) continue

    const emp = employees.find((e) => e.employeeId === alloc.employeeId)
    let skillTag = alloc.roleType || ''
    if (!skillTag && emp) {
      const skills = emp.skills || []
      if (skills.includes('推广师')) skillTag = '推广师'
      else if (skills.includes('养生师')) skillTag = '养生师'
      else skillTag = '美容师'
    }
    skillTag = skillTag || '美容师'

    const ratioPercent = String(Number((Number(alloc.allocationRatio) * 100).toFixed(1)))
    const rateRef = findMatchingRate(commissionRates, marketName, skillTag, group.salesCategory, eventAmount)
    const commissionRate = rateRef ? Number(rateRef.commissionRate) : 0
    const { amount, commissionAmount } = calculateEntryAmounts(group, ratioPercent, commissionRate)

    result[group.groupId].push({
      id: Date.now() + Math.random(),
      skillTag,
      employeeId: alloc.employeeId,
      ratioPercent,
      amount,
      commissionRate,
      commissionAmount,
      legacyEmployeeName: alloc.employeeName ?? undefined,
    })
  }

  return result
}

// --------------- 主组件 ---------------

export default function PaymentAllocationDetailPageClient({
  payment,
  storeId,
  customerName,
  employees,
  commissionRates = [],
  skillTags = [],
  canSave = false,
}: {
  payment: PaymentAllocatables
  storeId: string | null
  customerName: string | null
  employees: AllocationEmployeeCandidate[]
  commissionRates?: CommissionRate[]
  skillTags?: SkillTag[]
  canSave?: boolean
}) {
  // 技能标签下拉选项：严格来自数据库 skill_tags（is_valid + sort_order 已在 action 内处理）
  const skillTagNames = useMemo(() => skillTags.map((t) => t.name), [skillTags])
  // 所有在职员工（不区分门店，后续按 skillTag 动态筛选）
  const allActiveEmployees = useMemo(
    () => sortAllocationEmployeeCandidates(employees.filter((e) => !e.isResigned)),
    [employees],
  )

  const getFilteredEmployees = (skillTag: string) => {
    if (!storeId) return []
    return getAllocationEmployeesForSkill(allActiveEmployees, skillTag)
  }

  const items = payment.items || []
  const groups = useMemo(
    () => groupPaymentItems(items, payment.existingAllocations),
    [items, payment.existingAllocations],
  )
  const marketName = payment.marketName ?? ''
  const eventAmount = payment.eventAmount
  const statusInfo = allocationStatusMap[payment.allocationStatus || "待分配"] || allocationStatusMap.待分配
  const isRefundAllocation = payment.changeType === '退款'

  const [groupAllocs, setGroupAllocs] = useState<Record<string, AllocationEntry[]>>(() =>
    initAllocations(groups, payment.existingAllocations, employees, commissionRates, marketName, eventAmount)
  )

  const addEntry = (groupId: string) => {
    if (!canSave) return
    setGroupAllocs((prev) => ({
      ...prev,
      [groupId]: [
        ...(prev[groupId] || []),
        {
          id: Date.now() + Math.random(),
          skillTag: '',
          employeeId: '',
          ratioPercent: '',
          amount: '0.00',
          commissionRate: 0,
          commissionAmount: '0.00',
        },
      ],
    }))
  }

  const updateEntry = (
    groupId: string,
    entryId: number,
    field: 'skillTag' | 'employeeId' | 'ratioPercent',
    value: string,
  ) => {
    if (!canSave) return
    setGroupAllocs((prev) => {
      const group = groups.find((entry) => entry.groupId === groupId)
      const entries = prev[groupId] || []
      if (!group) return prev

      return {
        ...prev,
        [groupId]: entries.map((e) => {
          if (e.id !== entryId) return e
          const updated = { ...e, [field]: value }

          // 切换 skillTag → 清空员工（因为员工列表变了）、重查提成比例（基准 eventAmount）
          if (field === 'skillTag') {
            updated.employeeId = ''
            const rateRef = findMatchingRate(commissionRates, marketName, value, group.salesCategory, eventAmount)
            updated.commissionRate = rateRef ? Number(rateRef.commissionRate) : 0
          }

          // 选择员工时也重查提成比例
          if (field === 'employeeId' && updated.skillTag) {
            const rateRef = findMatchingRate(commissionRates, marketName, updated.skillTag, group.salesCategory, eventAmount)
            updated.commissionRate = rateRef ? Number(rateRef.commissionRate) : 0
          }

          const amounts = calculateEntryAmounts(group, updated.ratioPercent, updated.commissionRate)
          updated.amount = amounts.amount
          updated.commissionAmount = amounts.commissionAmount

          return updated
        }),
      }
    })
  }

  const removeEntry = (groupId: string, entryId: number) => {
    if (!canSave) return
    setGroupAllocs((prev) => ({
      ...prev,
      [groupId]: (prev[groupId] || []).filter((e) => e.id !== entryId),
    }))
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/allocations" className="text-[#999999] hover:text-[var(--foreground)]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
        </Link>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">{isRefundAllocation ? '营业额分配（退款赤字）' : '营业额分配'}</h1>
      </div>

      {/* 回款/退款摘要 */}
      <Card>
        <CardHeader><CardTitle>{isRefundAllocation ? '退款信息' : '回款信息'}</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-[#999999]">{isRefundAllocation ? '退款类型' : '回款类型'}</span>
              <p className="font-medium mt-1">{payment.changeType}</p>
            </div>
            <div>
              <span className="text-[#999999]">顾客</span>
              <p className="font-medium mt-1">{customerName || "—"}</p>
            </div>
            <div>
              <span className="text-[#999999]">订单号</span>
              <p className="font-medium mt-1">
                <Link href={`/orders/${payment.saleOrderId}`} className="text-[var(--primary)] hover:underline">
                  {payment.saleOrderId}
                </Link>
              </p>
            </div>
            <div>
              <span className="text-[#999999]">{isRefundAllocation ? '本次退款额' : '本次回款额'}</span>
              <p className={`font-bold text-lg mt-1 ${isRefundAllocation ? 'text-[#C0322A]' : 'text-[var(--primary)]'}`}>¥{eventAmount.toLocaleString()}</p>
            </div>
            <div>
              <span className="text-[#999999]">支付方式</span>
              <p className="font-medium mt-1">{payment.paymentMethod || "—"}</p>
            </div>
            <div>
              <span className="text-[#999999]">分配状态</span>
              <p className="mt-1">
                <Badge variant="outline" className={statusInfo.className}>{statusInfo.label}</Badge>
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 逐 SKU 分配卡片（基数 = 本笔回款各项可分配额） */}
      {groups.length > 0 ? (
        groups.map((item) => (
          <ItemAllocationCard
            key={item.groupId}
            item={item}
            entries={groupAllocs[item.groupId] || []}
            getFilteredEmployees={getFilteredEmployees}
            skillTagNames={skillTagNames}
            readOnly={isRefundAllocation || !canSave}
            onAdd={addEntry}
            onUpdate={updateEntry}
            onRemove={removeEntry}
          />
        ))
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-[#999999]">分配明细</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-[#999999] py-2">该回款暂无可分配的明细项</p>
          </CardContent>
        </Card>
      )}

      {isRefundAllocation || !canSave ? (
        <div className="flex justify-end">
          <Link href="/allocations">
            <Button variant="outline">返回</Button>
          </Link>
        </div>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <SaveButton salePaymentId={payment.salePaymentId} groups={groups} groupAllocs={groupAllocs} />
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// --------------- SKU 分配卡片 ---------------

function ItemAllocationCard({
  item,
  entries,
  getFilteredEmployees,
  skillTagNames,
  readOnly = false,
  onAdd,
  onUpdate,
  onRemove,
}: {
  item: PaymentAllocationGroup
  entries: AllocationEntry[]
  getFilteredEmployees: (skillTag: string) => AllocationEmployeeCandidate[]
  skillTagNames: string[]
  readOnly?: boolean
  onAdd: (groupId: string) => void
  onUpdate: (groupId: string, entryId: number, field: 'skillTag' | 'employeeId' | 'ratioPercent', value: string) => void
  onRemove: (groupId: string, entryId: number) => void
}) {
  const allocatable = Number(item.received)

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
            {item.productName || '—'}
            {item.salesCategory && (
              <span className="ml-2 text-xs font-normal text-[#999999] bg-gray-100 px-2 py-0.5 rounded">
                {item.salesCategory}
              </span>
            )}
            {item.sourceCount > 1 && (
              <span className="ml-2 text-xs font-normal text-[#3D8A5A] bg-[#F0F9F2] px-2 py-0.5 rounded">
                已合并 {item.sourceCount} 条明细
              </span>
            )}
          </CardTitle>
          <span className="text-lg font-bold text-[var(--primary)]">¥{allocatable.toLocaleString()}</span>
        </div>
        <p className="text-xs text-[#999999] mt-1">{readOnly ? '本次退款赤字分配基数' : '本次回款可分配额'} ¥{allocatable.toLocaleString()}</p>
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
                    onChange={(e) => onUpdate(item.groupId, entry.id, 'skillTag', e.target.value)}
                    disabled={readOnly}
                  >
                    <option value="">选择</option>
                    {skillTagNames.map((tag) => (
                      <option key={tag} value={tag}>{tag}</option>
                    ))}
                  </Select>
                </div>

                {/* 员工 */}
                <div className="w-32 shrink-0">
                  <label className="text-[10px] text-[#999999]">员工</label>
                  <Select
                    value={entry.employeeId}
                    onChange={(e) => onUpdate(item.groupId, entry.id, 'employeeId', e.target.value)}
                    disabled={readOnly || !entry.skillTag}
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
                      onChange={(e) => onUpdate(item.groupId, entry.id, 'ratioPercent', e.target.value)}
                      className="w-[104px]"
                      disabled={readOnly}
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
                        onChange={(e) => onUpdate(item.groupId, entry.id, 'ratioPercent', e.target.value)}
                        className="w-[88px]"
                        placeholder="%"
                        disabled={readOnly}
                      />
                    )}
                  </div>
                </div>

                {/* 分配金额（只读） */}
                <div className="w-20 shrink-0 text-right">
                  <label className="text-[10px] text-[#999999]">分配额</label>
                  <p className="text-sm font-medium h-9 flex items-center justify-end">¥{Number(entry.amount).toLocaleString()}</p>
                </div>

                {/* 提成金额（只读） */}
                <div className="w-20 shrink-0 text-right">
                  <label className="text-[10px] text-[#999999]">提成额</label>
                  <p className="text-sm font-medium h-9 flex items-center justify-end text-[var(--primary)]">¥{Number(entry.commissionAmount).toLocaleString()}</p>
                </div>

                {/* 删除 */}
                {!readOnly && (
                  <Button size="sm" variant="ghost" onClick={() => onRemove(item.groupId, entry.id)} className="text-[#D94040] shrink-0 px-1">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </Button>
                )}
              </div>
            )
          })
        ) : (
          <p className="text-xs text-[#999999] py-2">{readOnly ? '该退款暂无赤字分配' : '暂无分配，点击"添加分配"开始'}</p>
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
          {!readOnly && (
            <Button size="sm" variant="outline" onClick={() => onAdd(item.groupId)}>
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
  salePaymentId,
  groups,
  groupAllocs,
}: {
  salePaymentId: number
  groups: PaymentAllocationGroup[]
  groupAllocs: Record<string, AllocationEntry[]>
}) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  const handleSave = () => {
    const flatAllocations: Array<{
      saleItemId: string
      employeeId: string
      roleType: string
      allocationRatio: string
    }> = []

    for (const item of groups) {
      const entries = (groupAllocs[item.groupId] || []).filter((e) => e.skillTag || e.employeeId || e.ratioPercent)

      for (const e of entries) {
        if (!e.skillTag || !e.employeeId || !e.ratioPercent || e.ratioPercent === '__custom') {
          toast.error('请填写完整的分配信息（技能标签、员工、分配比例）')
          return
        }
      }

      // 按 (roleType) 分池校验（P2-14 Q5：三角色独立）
      const pools: Record<string, AllocationEntry[]> = {}
      for (const e of entries) {
        const g = getPoolKey(e.skillTag)
        ;(pools[g] ??= []).push(e)
      }

      for (const [roleType, poolEntries] of Object.entries(pools)) {
        if (poolEntries.length > MAX_PER_GROUP) {
          toast.error(`${item.productName || '商品'} 的${roleType}最多分配 3 人`)
          return
        }

        const empIds = new Set<string>()
        for (const e of poolEntries) {
          if (empIds.has(e.employeeId)) {
            toast.error(`${item.productName || '商品'} 中同技能标签不能重复选择同一员工`)
            return
          }
          empIds.add(e.employeeId)
        }

        const ratioSum = poolEntries.reduce((s, e) => s + Number(e.ratioPercent), 0)
        // 容差 0.01%：仅吸收浮点漂移，不放过 ≥0.1% 真实超额（与后端 ratioSum>1.0001 同口径）
        if (ratioSum > 100.01) {
          toast.error(`${item.productName || '商品'} 的${roleType}分配比例合计超过 100%`)
          return
        }
      }

      // The API remains receipt-level. Expand each grouped edit back to every
      // independent sale item before submitting it.
      flatAllocations.push(...expandGroupedAllocationLines(entries.map((entry) => ({
        saleItemIds: item.saleItemIds,
        employeeId: entry.employeeId,
        roleType: entry.skillTag,
        allocationRatio: (Number(entry.ratioPercent) / 100).toFixed(3),
      }))))
    }

    startTransition(async () => {
      const res = await savePaymentAllocations(salePaymentId, flatAllocations)
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
