export interface AssistantProductTermProduct {
  skuId: string
  productName: string
  productNames?: string[]
  productKind?: string
  categoryName?: string
  seriesName?: string
}

export interface AssistantCategoryPair {
  productKind: string
  categoryName: string
}

export interface AssistantProductTermOptions {
  productKinds?: string[]
  categoryNames?: string[]
  categories?: string[]
  categoryPairs?: AssistantCategoryPair[]
  seriesNames?: string[]
  products?: AssistantProductTermProduct[]
}

export interface AssistantProductTermInput {
  productKind?: string
  categoryName?: string
  category?: string
  seriesName?: string
  skuId?: string
}

export interface ResolvedAssistantProductTerms {
  productKind?: string
  categoryName?: string
  seriesName?: string
  skuId?: string
}

type ProductTermField = "productKind" | "categoryName" | "seriesName" | "skuId" | "product"

interface TermCandidate {
  field: ProductTermField
  value: string
  normalized: string
  skuId?: string
  productKind?: string
  categoryName?: string
  seriesName?: string
}

function clean(value: string | null | undefined): string | undefined {
  const text = value?.trim()
  return text || undefined
}

function normalizeTerm(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s·•,，。;；:：/／|｜_\-—–()[\]（）【】]/g, "")
}

function unique(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const text = clean(value)
    if (!text) continue
    const key = normalizeTerm(text)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(text)
  }
  return result
}

function sharedKnownValue(values: Array<string | null | undefined>): string | undefined {
  const valuesUnique = unique(values)
  return valuesUnique.length === 1 ? valuesUnique[0] : undefined
}

function parseCategoryPair(value: string): AssistantCategoryPair | null {
  const parts = value
    .split(/\s*[\/／]\s*/)
    .map((part) => clean(part))
    .filter((part): part is string => Boolean(part))
  if (parts.length < 2) return null
  return { productKind: parts[0], categoryName: parts.slice(1).join(" / ") }
}

function normalizeOptions(options: AssistantProductTermOptions): Required<AssistantProductTermOptions> {
  const parsedPairs = (options.categories ?? [])
    .map(parseCategoryPair)
    .filter((pair): pair is AssistantCategoryPair => Boolean(pair))
  const categoryPairs = [...(options.categoryPairs ?? []), ...parsedPairs]

  return {
    productKinds: unique([
      ...(options.productKinds ?? []),
      ...categoryPairs.map((pair) => pair.productKind),
    ]),
    categoryNames: unique([
      ...(options.categoryNames ?? []),
      ...categoryPairs.map((pair) => pair.categoryName),
    ]),
    categories: unique([
      ...(options.categories ?? []),
      ...categoryPairs.map((pair) => `${pair.productKind} / ${pair.categoryName}`),
    ]),
    categoryPairs: categoryPairs.filter((pair) => clean(pair.productKind) && clean(pair.categoryName)),
    seriesNames: unique(options.seriesNames ?? []),
    products: mergeProducts(options.products ?? []),
  }
}

function mergeProducts(products: AssistantProductTermProduct[]): AssistantProductTermProduct[] {
  const bySku = new Map<string, AssistantProductTermProduct>()
  for (const product of products) {
    const skuId = clean(product.skuId)
    if (!skuId) continue
    const current = bySku.get(skuId)
    const productName = clean(product.productName) ?? current?.productName ?? skuId
    const productNames = unique([
      current?.productName,
      ...(current?.productNames ?? []),
      productName,
      ...(product.productNames ?? []),
    ])
    bySku.set(skuId, {
      skuId,
      productName,
      productNames,
      productKind: clean(product.productKind) ?? current?.productKind,
      categoryName: clean(product.categoryName) ?? current?.categoryName,
      seriesName: clean(product.seriesName) ?? current?.seriesName,
    })
  }
  return Array.from(bySku.values())
}

export function mergeAssistantProductTermOptions(
  ...items: AssistantProductTermOptions[]
): AssistantProductTermOptions {
  const normalized = items.map(normalizeOptions)
  return {
    productKinds: unique(normalized.flatMap((item) => item.productKinds)),
    categoryNames: unique(normalized.flatMap((item) => item.categoryNames)),
    categories: unique(normalized.flatMap((item) => item.categories)),
    categoryPairs: normalized.flatMap((item) => item.categoryPairs),
    seriesNames: unique(normalized.flatMap((item) => item.seriesNames)),
    products: mergeProducts(normalized.flatMap((item) => item.products)),
  }
}

function buildCandidates(options: AssistantProductTermOptions): TermCandidate[] {
  const normalized = normalizeOptions(options)
  const candidates: TermCandidate[] = []
  const productNameBuckets = new Map<string, { value: string; products: AssistantProductTermProduct[] }>()

  for (const value of normalized.productKinds) {
    candidates.push({ field: "productKind", value, normalized: normalizeTerm(value) })
  }
  for (const value of normalized.categoryNames) {
    candidates.push({ field: "categoryName", value, normalized: normalizeTerm(value) })
  }
  for (const value of normalized.seriesNames) {
    candidates.push({ field: "seriesName", value, normalized: normalizeTerm(value) })
  }
  for (const product of normalized.products) {
    candidates.push({
      field: "skuId",
      value: product.skuId,
      normalized: normalizeTerm(product.skuId),
      skuId: product.skuId,
      productKind: product.productKind,
      categoryName: product.categoryName,
      seriesName: product.seriesName,
    })

    for (const name of unique([product.productName, ...(product.productNames ?? [])])) {
      const key = normalizeTerm(name)
      if (!key || key === normalizeTerm(product.skuId)) continue
      const current = productNameBuckets.get(key) ?? { value: name, products: [] }
      current.products.push(product)
      productNameBuckets.set(key, current)
    }
  }

  for (const [key, bucket] of productNameBuckets) {
    const skuIds = unique(bucket.products.map((product) => product.skuId))
    const hasSingleSku = skuIds.length === 1
    candidates.push({
      field: "product",
      value: bucket.value,
      normalized: key,
      skuId: hasSingleSku ? skuIds[0] : undefined,
      productKind: sharedKnownValue(bucket.products.map((product) => product.productKind)),
      categoryName: sharedKnownValue(bucket.products.map((product) => product.categoryName)),
      seriesName: hasSingleSku ? sharedKnownValue(bucket.products.map((product) => product.seriesName)) : undefined,
    })
  }

  return candidates.filter((candidate) => candidate.normalized)
}

function fieldPriority(field: ProductTermField, preferred: ProductTermField[]): number {
  const index = preferred.indexOf(field)
  return index === -1 ? preferred.length + 1 : index
}

function findBestForValue(
  value: string | undefined,
  candidates: TermCandidate[],
  preferred: ProductTermField[],
): TermCandidate | null {
  if (!value) return null
  const normalizedValue = normalizeTerm(value)
  if (!normalizedValue) return null

  let best: { candidate: TermCandidate; score: number } | null = null
  for (const candidate of candidates) {
    let score = 0
    if (normalizedValue === candidate.normalized) {
      score = 100_000
    } else if (normalizedValue.includes(candidate.normalized)) {
      score = 50_000 + candidate.normalized.length
    } else if (candidate.normalized.includes(normalizedValue) && normalizedValue.length >= 2) {
      score = 30_000 + normalizedValue.length
    }
    if (score === 0) continue

    score -= fieldPriority(candidate.field, preferred)
    if (!best || score > best.score) best = { candidate, score }
  }
  return best?.candidate ?? null
}

function findMentionForField(
  text: string | undefined,
  candidates: TermCandidate[],
  field: ProductTermField,
): TermCandidate | null {
  if (!text) return null
  const normalizedText = normalizeTerm(text)
  if (!normalizedText) return null
  return candidates
    .filter((candidate) => candidate.field === field && normalizedText.includes(candidate.normalized))
    .sort((a, b) => b.normalized.length - a.normalized.length)
    [0] ?? null
}

function applyCandidate(result: ResolvedAssistantProductTerms, candidate: TermCandidate | null): void {
  if (!candidate) return
  if (candidate.field === "productKind") result.productKind = candidate.value
  if (candidate.field === "categoryName") result.categoryName = candidate.value
  if (candidate.field === "seriesName") result.seriesName = candidate.value
  if (candidate.field === "skuId" || candidate.field === "product") {
    if (candidate.field === "skuId") result.skuId = candidate.skuId ?? candidate.value
    if (candidate.field === "product" && candidate.skuId) result.skuId = candidate.skuId
    result.productKind = result.productKind ?? candidate.productKind
    result.categoryName = result.categoryName ?? candidate.categoryName
    result.seriesName = result.seriesName ?? candidate.seriesName
  }
}

function enrichCategoryProductKind(
  result: ResolvedAssistantProductTerms,
  options: AssistantProductTermOptions,
): void {
  if (!result.categoryName || result.productKind) return
  const normalizedCategory = normalizeTerm(result.categoryName)
  const pairs = normalizeOptions(options).categoryPairs.filter(
    (pair) => normalizeTerm(pair.categoryName) === normalizedCategory,
  )
  const productKinds = unique(pairs.map((pair) => pair.productKind))
  if (productKinds.length === 1) result.productKind = productKinds[0]
}

function parseLegacyCategory(
  result: ResolvedAssistantProductTerms,
  category: string | undefined,
  options: AssistantProductTermOptions,
): void {
  if (!category) return
  const pair = parseCategoryPair(category)
  if (pair) {
    result.productKind = result.productKind ?? pair.productKind
    result.categoryName = result.categoryName ?? pair.categoryName
    return
  }

  const candidates = buildCandidates(options)
  applyCandidate(result, findBestForValue(category, candidates, ["productKind", "categoryName"]))
}

function preserveUnmatchedInput(
  result: ResolvedAssistantProductTerms,
  input: AssistantProductTermInput,
): void {
  if (result.productKind || result.categoryName || result.seriesName || result.skuId) return
  result.productKind = result.productKind ?? clean(input.productKind)
  result.categoryName = result.categoryName ?? clean(input.categoryName)
  result.seriesName = result.seriesName ?? clean(input.seriesName)
  result.skuId = result.skuId ?? clean(input.skuId)
}

export function resolveAssistantProductTerms(
  input: AssistantProductTermInput,
  options: AssistantProductTermOptions,
  text?: string,
): ResolvedAssistantProductTerms {
  const candidates = buildCandidates(options)
  const result: ResolvedAssistantProductTerms = {}

  parseLegacyCategory(result, clean(input.category), options)
  applyCandidate(result, findBestForValue(input.skuId, candidates, ["skuId", "product"]))
  applyCandidate(result, findBestForValue(input.productKind, candidates, ["productKind", "categoryName", "seriesName", "product"]))
  applyCandidate(result, findBestForValue(input.categoryName, candidates, ["categoryName", "productKind", "seriesName", "product"]))
  applyCandidate(result, findBestForValue(input.seriesName, candidates, ["seriesName", "productKind", "categoryName", "product"]))

  if (text) {
    applyCandidate(result, result.productKind ? null : findMentionForField(text, candidates, "productKind"))
    applyCandidate(result, result.categoryName ? null : findMentionForField(text, candidates, "categoryName"))
    applyCandidate(result, result.seriesName ? null : findMentionForField(text, candidates, "seriesName"))
    applyCandidate(result, result.skuId ? null : findMentionForField(text, candidates, "product"))
    applyCandidate(result, result.skuId ? null : findMentionForField(text, candidates, "skuId"))
  }

  enrichCategoryProductKind(result, options)
  preserveUnmatchedInput(result, input)

  return result
}
