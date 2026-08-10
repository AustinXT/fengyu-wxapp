import { describe, expect, it } from "vitest"
import { safeRate, summarizeProductNames } from "../penetration-utils"

describe("penetration utils", () => {
  it("safeRate returns 0 when denominator is 0", () => {
    expect(safeRate(3, 0)).toBe(0)
  })

  it("summarizeProductNames merges names and chooses the most common name", () => {
    const summary = summarizeProductNames([
      { productName: "水润护理 10次卡", observedAt: "2026-01-01T00:00:00.000Z" },
      { productName: "水润护理 10次卡", observedAt: "2026-01-02T00:00:00.000Z" },
      { productName: "蜜语水润护理", observedAt: "2026-01-03T00:00:00.000Z" },
    ])

    expect(summary.productName).toBe("水润护理 10次卡")
    expect(summary.productNames).toEqual(["蜜语水润护理", "水润护理 10次卡"])
    expect(summary.hasMultipleNames).toBe(true)
    expect(summary.missingName).toBe(false)
  })

  it("summarizeProductNames prefers the current SKU name", () => {
    const summary = summarizeProductNames([
      {
        productName: "年轻态慕慕霜",
        currentProductName: "年轻态慕慕霜-TX",
        observedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        productName: "年轻态慕慕霜",
        currentProductName: "年轻态慕慕霜-TX",
        observedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        productName: "年轻态慕慕霜-TX",
        currentProductName: "年轻态慕慕霜-TX",
        observedAt: "2026-01-03T00:00:00.000Z",
      },
    ])

    expect(summary.productName).toBe("年轻态慕慕霜-TX")
    expect(summary.productNames).toEqual(["年轻态慕慕霜", "年轻态慕慕霜-TX"])
    expect(summary.hasMultipleNames).toBe(true)
    expect(summary.missingName).toBe(false)
  })

  it("summarizeProductNames keeps productNames as historical names", () => {
    const summary = summarizeProductNames([
      {
        productName: "舒畅养护(头颈/肩手/腰部/腿部)",
        currentProductName: "疼痛管理(头颈/肩手/腰部/腿部)",
        observedAt: "2026-01-01T00:00:00.000Z",
      },
    ])

    expect(summary.productName).toBe("疼痛管理(头颈/肩手/腰部/腿部)")
    expect(summary.productNames).toEqual(["舒畅养护(头颈/肩手/腰部/腿部)"])
    expect(summary.hasMultipleNames).toBe(false)
    expect(summary.missingName).toBe(false)
  })

  it("summarizeProductNames exposes empty product names", () => {
    const summary = summarizeProductNames([
      { productName: "", observedAt: "2026-01-01T00:00:00.000Z" },
      { productName: "  ", observedAt: "2026-01-02T00:00:00.000Z" },
    ])

    expect(summary.productName).toBe("商品名缺失")
    expect(summary.productNames).toEqual([])
    expect(summary.hasMultipleNames).toBe(false)
    expect(summary.missingName).toBe(true)
  })
})
