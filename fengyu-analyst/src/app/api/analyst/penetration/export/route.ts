import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { hasPermission } from "@/lib/permissions"
import { getPenetrationCustomerList, normalizePenetrationFilters } from "@/lib/penetration"

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
  const filters = normalizePenetrationFilters({
    productKind: searchParams.get("productKind") ?? undefined,
    categoryName: searchParams.get("categoryName") ?? undefined,
    seriesName: searchParams.get("seriesName") ?? undefined,
    skuId: searchParams.get("skuId") ?? undefined,
    market: searchParams.get("market") ?? undefined,
    store: searchParams.get("store") ?? undefined,
  })
  const rows = await getPenetrationCustomerList(session, filters, 5000)
  const header = [
    "顾客编号",
    "顾客姓名",
    "绑定市场",
    "绑定门店",
    "一级品项",
    "二级品项",
    "系列",
    "SKU",
    "当前商品名",
    "历史商品名",
    "剩余次数",
  ]
  const body = rows.map((row) =>
    [
      row.customerCode,
      row.customerName,
      row.market,
      row.store,
      row.productKind,
      row.categoryName,
      row.seriesName,
      row.skuId,
      row.productName,
      row.productNames.join(" / "),
      row.remainingSessions,
    ]
      .map(csvCell)
      .join(","),
  )
  const csv = `\uFEFF${[header.map(csvCell).join(","), ...body].join("\n")}`

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="penetration-card-holders.csv"`,
      "Cache-Control": "no-store",
    },
  })
}
