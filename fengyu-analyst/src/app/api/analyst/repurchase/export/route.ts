import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { hasPermission } from "@/lib/permissions"
import { getRepurchaseCustomerList, normalizeRepurchaseFilters } from "@/lib/repurchase"

const EXPORT_ACTION =
  process.env.ANALYST_EXPORT_ACTION ||
  process.env.ANALYST_VIEW_ACTION ||
  "data_center:dashboard"

function csvCell(value: unknown): string {
  const text = String(value ?? "")
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 })
  }
  if (!hasPermission(session, EXPORT_ACTION)) {
    return NextResponse.json({ error: "PERMISSION_DENIED" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const filters = normalizeRepurchaseFilters({
    year: searchParams.get("year") ?? undefined,
    category: searchParams.get("category") ?? undefined,
    productKind: searchParams.get("productKind") ?? undefined,
    categoryName: searchParams.get("categoryName") ?? undefined,
    market: searchParams.get("market") ?? undefined,
    store: searchParams.get("store") ?? undefined,
  })
  const rows = await getRepurchaseCustomerList(session, filters, "all", 1000)
  const header = ["顾客编号", "顾客姓名", "一级品项", "二级品项", "是否复购", "首购日期", "市场区域", "门店"]
  const body = rows.map((row) =>
    [
      row.customerId,
      row.customerName,
      row.productKind,
      row.categoryName,
      row.status === "复购" ? "是" : "否",
      row.firstDate,
      row.market,
      row.store,
    ]
      .map(csvCell)
      .join(","),
  )
  const csv = `\uFEFF${[header.map(csvCell).join(","), ...body].join("\n")}`

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="repurchase-summary.csv"`,
      "Cache-Control": "no-store",
    },
  })
}
