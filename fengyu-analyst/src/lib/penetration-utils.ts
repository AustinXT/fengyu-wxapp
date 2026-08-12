export interface ProductNameObservation {
  productName: string
  currentProductName?: string
  observedAt: string
}

export interface ProductNameSummary {
  productName: string
  productNames: string[]
  missingName: boolean
  hasMultipleNames: boolean
}

export interface PenetrationFilterValues {
  productKind?: string
  categoryName?: string
  seriesName?: string
  skuId?: string
}

export function matchesPenetrationFilters(
  row: Required<PenetrationFilterValues>,
  filters: PenetrationFilterValues,
): boolean {
  return (
    (!filters.productKind || row.productKind === filters.productKind) &&
    (!filters.categoryName || row.categoryName === filters.categoryName) &&
    (!filters.seriesName || row.seriesName === filters.seriesName) &&
    (!filters.skuId || row.skuId === filters.skuId)
  )
}

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

export function safeRate(numerator: number, denominator: number): number {
  return denominator > 0 ? round4(numerator / denominator) : 0
}

function addNameCount(counts: Map<string, { count: number; latestAt: string }>, name: string, observedAt: string): void {
  const current = counts.get(name) ?? { count: 0, latestAt: "" }
  current.count += 1
  if (!current.latestAt || observedAt > current.latestAt) {
    current.latestAt = observedAt
  }
  counts.set(name, current)
}

export function summarizeProductNames(observations: ProductNameObservation[]): ProductNameSummary {
  const counts = new Map<string, { count: number; latestAt: string }>()
  const currentNameCounts = new Map<string, { count: number; latestAt: string }>()
  let missingName = observations.length === 0

  for (const observation of observations) {
    const name = observation.productName.trim()
    const currentName = observation.currentProductName?.trim()
    if (!name) {
      missingName = true
    } else {
      addNameCount(counts, name, observation.observedAt)
    }

    if (currentName) {
      addNameCount(currentNameCounts, currentName, observation.observedAt)
    }
  }

  const productNames = Array.from(counts.keys()).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
  const [currentPrimary] = Array.from(currentNameCounts.entries()).sort(([nameA, a], [nameB, b]) => {
    if (b.count !== a.count) return b.count - a.count
    const dateCompare = b.latestAt.localeCompare(a.latestAt)
    return dateCompare !== 0 ? dateCompare : nameA.localeCompare(nameB, "zh-Hans-CN")
  })
  const [primary] = Array.from(counts.entries()).sort(([nameA, a], [nameB, b]) => {
    if (b.count !== a.count) return b.count - a.count
    const dateCompare = b.latestAt.localeCompare(a.latestAt)
    return dateCompare !== 0 ? dateCompare : nameA.localeCompare(nameB, "zh-Hans-CN")
  })

  return {
    productName: currentPrimary?.[0] ?? primary?.[0] ?? "商品名缺失",
    productNames,
    missingName,
    hasMultipleNames: productNames.length > 1,
  }
}
