import { describe, expect, it } from "vitest"
import { buildFormNavigationHref } from "@/lib/form-navigation"

describe("buildFormNavigationHref", () => {
  it("保留重复字段、编码中文并忽略空值", () => {
    expect(buildFormNavigationHref("/dashboard", [
      ["metric", "penetration"],
      ["scope", "market"],
      ["scopeId", "华东市场"],
      ["empty", ""],
      ["tag", "a"],
      ["tag", "b"],
    ])).toBe("/dashboard?metric=penetration&scope=market&scopeId=%E5%8D%8E%E4%B8%9C%E5%B8%82%E5%9C%BA&tag=a&tag=b")
  })

  it("无有效参数时只返回 action", () => {
    expect(buildFormNavigationHref("/dashboard", [["scopeId", ""]])).toBe("/dashboard")
  })
})
