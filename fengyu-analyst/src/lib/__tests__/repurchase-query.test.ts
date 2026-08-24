import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = readFileSync(new URL("../repurchase.ts", import.meta.url), "utf8")

describe("repurchase query order types", () => {
  it("uses approved deposit orders only for the entry baseline", () => {
    expect(source).toContain("so.sale_order_type IN ('销售单', '转换单', '寄存单')")
    expect(source).toContain("so.status NOT IN ('已关闭', '已作废', '未审核', '待审批', '支付失败')")
    expect(source).toContain("SUM(total_amount) FILTER (WHERE sale_order_type IN ('销售单', '转换单'))")
    expect(source).toContain("repurchase_qualified_days AS")
    expect(source).toContain("WHERE repurchase_day_amount >= ${threshold}")
    expect(source).toContain("LEFT JOIN repurchase_qualified_days r")
    expect(source).toContain("r.sale_date > f.first_date")
  })
})
