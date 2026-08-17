import { resolveUnitPrice } from '@/lib/member-pricing'

export type TreatmentTierOrderType = '销售单' | '内部单' | '转换单' | '寄存单'

export interface TreatmentTierLine {
  categoryId?: string | null
  specName?: string | null
  productType?: string | null
  /** 单份 SKU 的疗程次数；行总次数会再乘 quantity。 */
  sessionCount?: number | null
  quantity?: number | null
  isExperience?: boolean | null
  isManagerSpecial?: boolean | null
  isBundle?: boolean | null
}

export interface TreatmentTierCandidate {
  categoryId?: string | null
  specName?: string | null
  productType?: string | null
  price: number | string
  specialPrice?: number | string | null
  sessionCount?: number | null
  isExperience?: boolean | null
  isManagerSpecial?: boolean | null
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

function groupKey(row: Pick<TreatmentTierLine, 'categoryId' | 'specName'>): string | null {
  if (!row.categoryId || !row.specName) return null
  return `${row.categoryId}::${row.specName}`
}

function isEligibleLine(row: TreatmentTierLine): boolean {
  return row.productType === '疗程卡'
    && row.isExperience !== true
    && row.isManagerSpecial !== true
    && row.isBundle !== true
    && Number(row.sessionCount) > 0
    && groupKey(row) !== null
}

/**
 * 按 staff 开单同口径计算疗程卡累计梯度行金额。
 *
 * 返回值与 lines 下标对齐；null 表示该行不适用梯度价，调用方继续使用原计价。
 */
export function calculateTreatmentTierLineAmounts(
  lines: TreatmentTierLine[],
  candidates: TreatmentTierCandidate[],
  buyerIsMember: boolean,
  orderType: TreatmentTierOrderType,
): Array<number | null> {
  const result = lines.map(() => null as number | null)
  if (orderType !== '销售单' && orderType !== '转换单') return result

  const groups = new Map<string, number[]>()
  lines.forEach((line, index) => {
    if (!isEligibleLine(line)) return
    const key = groupKey(line)!
    const indexes = groups.get(key) ?? []
    indexes.push(index)
    groups.set(key, indexes)
  })

  for (const [key, indexes] of groups) {
    const [categoryId, specName] = key.split('::')
    const totalSessions = indexes.reduce((sum, index) => {
      const line = lines[index]
      return sum + Number(line.sessionCount) * Math.max(1, Number(line.quantity) || 1)
    }, 0)
    if (totalSessions <= 1) continue

    const tier = candidates
      .filter((candidate) =>
        candidate.categoryId === categoryId
        && candidate.specName === specName
        && candidate.productType === '疗程卡'
        && candidate.isExperience !== true
        && candidate.isManagerSpecial !== true
        && Number(candidate.sessionCount) > 1
        && Number(candidate.sessionCount) <= totalSessions,
      )
      .map((candidate) => ({
        candidate,
        sessionCount: Number(candidate.sessionCount),
        amount: resolveUnitPrice(candidate, buyerIsMember).realUnit,
      }))
      .sort((left, right) => {
        const sessionDelta = right.sessionCount - left.sessionCount
        if (sessionDelta !== 0) return sessionDelta
        return (left.amount / left.sessionCount) - (right.amount / right.sessionCount)
      })[0]

    if (!tier || tier.sessionCount <= 1 || tier.amount <= 0) continue
    for (const index of indexes) {
      const line = lines[index]
      const lineSessions = Number(line.sessionCount) * Math.max(1, Number(line.quantity) || 1)
      result[index] = roundMoney(tier.amount * lineSessions / tier.sessionCount)
    }
  }

  return result
}
