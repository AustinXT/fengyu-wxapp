import { describe, expect, it } from "vitest"
import { buildCurrentPath, resolveReturnTo, withReturnTo } from "./return-context"

describe("return context", () => {
  it("保留完整列表查询参数", () => {
    const source = buildCurrentPath(
      "/products",
      new URLSearchParams("category=二级分类&status=enabled&page=2&size=50"),
    )
    const href = withReturnTo("/products/sku-1", source)
    expect(new URL(href, "https://example.test").searchParams.get("returnTo")).toBe(source)
  })

  it("保留目标地址原有参数", () => {
    const href = withReturnTo("/allocations/service/1?mode=edit", "/allocations?tab=service&page=3")
    const params = new URL(href, "https://example.test").searchParams
    expect(params.get("mode")).toBe("edit")
    expect(params.get("returnTo")).toBe("/allocations?tab=service&page=3")
  })

  it.each([
    "https://evil.example/path",
    "//evil.example/path",
    "javascript:alert(1)",
    "/safe\\evil",
  ])("拒绝非本站返回地址 %s", (raw) => {
    expect(resolveReturnTo(raw, "/products")).toBe("/products")
  })

  it("缺失或非法值时使用模块默认列表", () => {
    expect(resolveReturnTo(null, "/orders")).toBe("/orders")
    expect(resolveReturnTo("not-a-path", "/orders")).toBe("/orders")
  })
})
