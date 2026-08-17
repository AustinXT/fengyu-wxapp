import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = readFileSync(new URL("../repurchase.ts", import.meta.url), "utf8")

describe("repurchase query order types", () => {
  it("includes approved deposit orders as repurchase entry data", () => {
    expect(source).toContain("so.sale_order_type IN ('销售单', '转换单', '寄存单')")
    expect(source).toContain("so.status NOT IN ('已关闭', '已作废', '未审核', '待审批', '支付失败')")
  })
})
