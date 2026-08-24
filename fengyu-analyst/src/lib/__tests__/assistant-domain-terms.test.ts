import { describe, expect, it } from "vitest"
import {
  mergeAssistantProductTermOptions,
  resolveAssistantProductTerms,
  type AssistantProductTermOptions,
} from "../assistant-domain-terms"

const terms: AssistantProductTermOptions = {
  productKinds: ["明星", "王牌"],
  categoryNames: ["科颜美", "安吉丽"],
  categoryPairs: [
    { productKind: "明星", categoryName: "科颜美" },
    { productKind: "王牌", categoryName: "安吉丽" },
  ],
  seriesNames: ["美学类(面部)", "健康类(身体)"],
  products: [
    {
      skuId: "SKU-KEYANMEI-001",
      productName: "科颜美水光护理10次卡",
      productNames: ["科颜美水光护理十次卡"],
      productKind: "明星",
      categoryName: "科颜美",
      seriesName: "美学类(面部)",
    },
    {
      skuId: "SKU-KEYANMEI-002",
      productName: "科颜美水光护理10次卡",
      productKind: "明星",
      categoryName: "科颜美",
    },
  ],
}

describe("assistant domain terms", () => {
  it("recognizes proprietary category names from question text", () => {
    expect(resolveAssistantProductTerms({}, terms, "科颜美普及率是多少？")).toEqual({
      productKind: "明星",
      categoryName: "科颜美",
    })
  })

  it("moves a category name out of the wrong productKind field", () => {
    expect(resolveAssistantProductTerms({ productKind: "科颜美" }, terms)).toEqual({
      productKind: "明星",
      categoryName: "科颜美",
    })
  })

  it("keeps category names and fills their known parent product kind", () => {
    expect(resolveAssistantProductTerms({ categoryName: "科颜美" }, terms)).toEqual({
      productKind: "明星",
      categoryName: "科颜美",
    })
  })

  it("recognizes unique SKU aliases", () => {
    expect(resolveAssistantProductTerms({}, terms, "科颜美水光护理十次卡还有多少余次？")).toEqual({
      productKind: "明星",
      categoryName: "科颜美",
      seriesName: "美学类(面部)",
      skuId: "SKU-KEYANMEI-001",
    })
  })

  it("does not pick an arbitrary SKU when a product name maps to multiple SKU IDs", () => {
    expect(resolveAssistantProductTerms({}, terms, "科颜美水光护理10次卡普及率")).toEqual({
      productKind: "明星",
      categoryName: "科颜美",
    })
  })

  it("uses an explicit SKU ID when the user provides one", () => {
    expect(resolveAssistantProductTerms({}, terms, "SKU-KEYANMEI-001普及率")).toEqual({
      productKind: "明星",
      categoryName: "科颜美",
      seriesName: "美学类(面部)",
      skuId: "SKU-KEYANMEI-001",
    })
  })

  it("merges system terms with metric-derived historic product aliases", () => {
    const merged = mergeAssistantProductTermOptions(terms, {
      products: [
        {
          skuId: "SKU-KEYANMEI-001",
          productName: "旧名称科颜美补水护理10次",
        },
      ],
    })

    expect(resolveAssistantProductTerms({}, merged, "旧名称科颜美补水护理10次普及率")).toMatchObject({
      productKind: "明星",
      categoryName: "科颜美",
      seriesName: "美学类(面部)",
    })
  })
})
