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
import type { Employee, CommissionRate, SkillTag } from "@/lib/types"

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

interface PaymentItem {
  saleItemId: string
  productName: string | null
  allocatableAmount: number
  /** allocatableAmount 别名：复用「实收×比例」算法的基数 */
  received: number
  salesCategory: string | null
  suggestedRate: number
}

interface PaymentExistingAllocation {
  id: number
  saleItemId: string
  employeeId: string
  roleType: string | null
  allocationRatio: string
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
  items: PaymentItem[]
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
function sortByPosition(employees: Employee[]): Employee[] {
  return [...employees].sort((a, b) =>
    (a.positionName || '').localeCompare(b.positionName || '', 'zh-CN')
  )
}

/** 计算分配金额 = 比例 × 该项可分配额 */
function calcAmount(ratioPercent: string, allocatable: number): string {
  const ratio = Number(ratioPercent)
  if (isNaN(ratio) || ratio <= 0) return '0.00'
  return ((ratio / 100) * allocatable).toFixed(2)
}

// --------------- 初始化状态 ---------------

function initAllocations(
  items: PaymentItem[],
  allocations: PaymentExistingAllocation[],
  employees: Employee[],
  commissionRates: CommissionRate[],
  marketName: string,
  eventAmount: number,
): Record<string, AllocationEntry[]> {
  const result: Record<string, AllocationEntry[]> = {}
  for (const item of items) result[item.saleItemId] = []

  for (const alloc of allocations) {
    if (!result[alloc.saleItemId]) continue
    const item = items.find((i) => i.saleItemId === alloc.saleItemId)

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
    const amount = alloc.totalAmount
    const rateRef = findMatchingRate(commissionRates, marketName, skillTag, item?.salesCategory ?? null, eventAmount)
    const commissionRate = rateRef ? Number(rateRef.commissionRate) : 0

    result[alloc.saleItemId].push({
      id: Date.now() + Math.random(),
      skillTag,
      employeeId: alloc.employeeId,
      ratioPercent,
      amount,
      commissionRate,
      commissionAmount: (Number(amount) * commissionRate).toFixed(2),
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
}: {
  payment: PaymentAllocatables
  storeId: string | null
  customerName: string | null
  employees: Employee[]
  commissionRates?: CommissionRate[]
  skillTags?: SkillTag[]
}) {
  // 技能标签下拉选项：严格来自数据库 skill_tags（is_valid + sort_order 已在 action 内处理）
  const skillTagNames = useMemo(() => skillTags.map((t) => t.name), [skillTags])
  // 所有在职员工（不区分门店，后续按 skillTag 动态筛选）
  const allActiveEmployees = useMemo(
    () => sortByPosition(employees.filter((e) => !e.isResigned)),
    [employees],
  )

  // 跨门店共享（2026-06-24）：所有角色统一为「订单门店员工 ∪ 标记出差的员工」。
  // 出差员工由 page 的 getEmployeesOnBusinessTrip 全公司补充池并入候选，跨门店可命中。
  const getFilteredEmployees = (skillTag: string) => {
    if (!skillTag) return []
    return allActiveEmployees.filter(
      (e) => (e.storeId === storeId || e.isOnBusinessTrip) && e.skills?.includes(skillTag)
    )
  }

  const items = payment.items || []
  const marketName = payment.marketName ?? ''
  const eventAmount = payment.eventAmount
  const statusInfo = allocationStatusMap[payment.allocationStatus || "待分配"] || allocationStatusMap.待分配

  const [itemAllocs, setItemAllocs] = useState<Record<string, AllocationEntry[]>>(() =>
    initAllocations(items, payment.existingAllocations, employees, commissionRates, marketName, eventAmount)
  )

  const addEntry = (saleItemId: string) => {
    setItemAllocs((prev) => ({
      ...prev,
      [saleItemId]: [
        ...(prev[saleItemId] || []),
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
    saleItemId: string,
    entryId: number,
    field: 'skillTag' | 'employeeId' | 'ratioPercent',
    value: string,
  ) => {
    setItemAllocs((prev) => {
      const item = items.find((i) => i.saleItemId === saleItemId)
      const allocatable = item ? Number(item.received) : 0
      const entries = prev[saleItemId] || []

      return {
        ...prev,
        [saleItemId]: entries.map((e) => {
          if (e.id !== entryId) return e
          const updated = { ...e, [field]: value }

          // 切换 skillTag → 清空员工（因为员工列表变了）、重查提成比例（基准 eventAmount）
          if (field === 'skillTag') {
            updated.employeeId = ''
            const rateRef = findMatchingRate(commissionRates, marketName, value, item?.salesCategory ?? null, eventAmount)
            updated.commissionRate = rateRef ? Number(rateRef.commissionRate) : 0
          }

          // 选择员工时也重查提成比例
          if (field === 'employeeId' && updated.skillTag) {
            const rateRef = findMatchingRate(commissionRates, marketName, updated.skillTag, item?.salesCategory ?? null, eventAmount)
            updated.commissionRate = rateRef ? Number(rateRef.commissionRate) : 0
          }

          // 重算金额和提成
          updated.amount = calcAmount(updated.ratioPercent, allocatable)
          updated.commissionAmount = (Number(updated.amount) * updated.commissionRate).toFixed(2)

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
      <div className="flex items-center gap-3">
        <Link href="/allocations" className="text-[#999999] hover:text-[var(--foreground)]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
        </Link>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">营业额分配（回款）</h1>
      </div>

      {/* 回款摘要 */}
      <Card>
        <CardHeader><CardTitle>回款信息</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-[#999999]">回款类型</span>
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
              <span className="text-[#999999]">本次回款额</span>
              <p className="font-bold text-lg mt-1 text-[var(--primary)]">¥{eventAmount.toLocaleString()}</p>
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
      {items.length > 0 ? (
        items.map((item) => (
          <ItemAllocationCard
            key={item.saleItemId}
            item={item}
            entries={itemAllocs[item.saleItemId] || []}
            getFilteredEmployees={getFilteredEmployees}
            skillTagNames={skillTagNames}
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

      {/* 保存 */}
      <Card>
        <CardContent className="pt-6">
          <SaveButton salePaymentId={payment.salePaymentId} items={items} itemAllocs={itemAllocs} />
        </CardContent>
      </Card>
    </div>
  )
}

// --------------- SKU 分配卡片 ---------------

function ItemAllocationCard({
  item,
  entries,
  getFilteredEmployees,
  skillTagNames,
  onAdd,
  onUpdate,
  onRemove,
}: {
  item: PaymentItem
  entries: AllocationEntry[]
  getFilteredEmployees: (skillTag: string) => Employee[]
  skillTagNames: string[]
  onAdd: (saleItemId: string) => void
  onUpdate: (saleItemId: string, entryId: number, field: 'skillTag' | 'employeeId' | 'ratioPercent', value: string) => void
  onRemove: (saleItemId: string, entryId: number) => void
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
          </CardTitle>
          <span className="text-lg font-bold text-[var(--primary)]">¥{allocatable.toLocaleString()}</span>
        </div>
        <p className="text-xs text-[#999999] mt-1">本次回款可分配额 ¥{allocatable.toLocaleString()}</p>
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
                    onChange={(e) => onUpdate(item.saleItemId, entry.id, 'skillTag', e.target.value)}
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
                    onChange={(e) => onUpdate(item.saleItemId, entry.id, 'employeeId', e.target.value)}
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
                      : '—'}
                  </p>
                </div>

                {/* 分配比例（档位快选 + 自定义） */}
                <div className="shrink-0">
                  <label className="text-[10px] text-[#999999]">分配</label>
                  <div className="flex items-center gap-1">
                    <Select
                      value={ratioSelectValue}
                      onChange={(e) => onUpdate(item.saleItemId, entry.id, 'ratioPercent', e.target.value)}
                      className="w-[68px]"
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
                        onChange={(e) => onUpdate(item.saleItemId, entry.id, 'ratioPercent', e.target.value)}
                        className="w-[60px]"
                        placeholder="%"
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
                <Button size="sm" variant="ghost" onClick={() => onRemove(item.saleItemId, entry.id)} className="text-[#D94040] shrink-0 px-1">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </Button>
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
                className={sum > 100 ? 'text-[#D94040] font-medium' : 'text-[#999999]'}
              >
                {role}: {sum}% / 100%
                {sum > 100 && ' (超出)'}
              </span>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={() => onAdd(item.saleItemId)}>
            + 添加分配
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// --------------- 保存按钮 ---------------

function SaveButton({
  salePaymentId,
  items,
  itemAllocs,
}: {
  salePaymentId: number
  items: PaymentItem[]
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
      const entries = (itemAllocs[item.saleItemId] || []).filter((e) => e.skillTag || e.employeeId || e.ratioPercent)

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
        if (ratioSum > 100) {
          toast.error(`${item.productName || '商品'} 的${roleType}分配比例合计超过 100%`)
          return
        }
      }

      for (const e of entries) {
        flatAllocations.push({
          saleItemId: item.saleItemId,
          employeeId: e.employeeId,
          roleType: e.skillTag,
          allocationRatio: (Number(e.ratioPercent) / 100).toFixed(3),
          totalAmount: e.amount,
        })
      }
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
