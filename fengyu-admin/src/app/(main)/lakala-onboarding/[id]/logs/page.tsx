/**
 * 拉卡拉商户入网 · API / 操作日志（plan §4）
 *
 * admin only。展示已经过 lakala-redact.ts 脱敏（PII + 费率 mask）的 jsonb 副本。
 *
 * **费率全不可见 plan §0★**：jsonb 后端已 mask（费率字段名一律 ***），UI 无解码
 */
import Link from "next/link"
import { notFound } from "next/navigation"
import { getLakalaMerchant } from "@/actions/lakala-onboarding"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export const dynamic = "force-dynamic"

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const detail = await getLakalaMerchant(id).catch(() => null)
  if (!detail) notFound()
  const m = detail.merchant as { merchantName: string }
  const logs = detail.recentLogs as Array<{
    id: number
    direction: "outbound" | "inbound_callback"
    endpoint: string
    reqBody: unknown
    respBody: unknown
    respCode: string | null
    latencyMs: number | null
    operatorUserId: number | null
    createdAt: string
  }>

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href={`/lakala-onboarding/${id}`} className="text-sm text-[var(--primary)] hover:underline">
          &larr; 返回详情
        </Link>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">API/操作日志 - {m.merchantName}</h1>
      </div>

      <div className="text-xs text-[var(--muted-foreground)]">
        本页仅展示 admin 角色可读的最近 30 条 API 调用流水。所有 PII（身份证 / 银行卡 / 手机号 / 法人证件号）与费率类字段在写入前已经过 redactPII()
        脱敏处理，UI 无法解码原文。
      </div>

      <div className="space-y-3">
        {logs.map((row) => (
          <Card key={row.id}>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-3">
                <span
                  className={
                    "px-2 py-0.5 rounded text-xs font-medium " +
                    (row.direction === "outbound"
                      ? "border border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]"
                      : "border border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]")
                  }
                >
                  {row.direction === "outbound" ? "外发请求" : "拉卡拉回调"}
                </span>
                <span className="font-mono text-xs">{row.endpoint}</span>
                <span className="ml-auto text-xs text-[var(--muted-foreground)]">
                  {row.createdAt?.slice(0, 19).replace("T", " ")} · 耗时 {row.latencyMs ?? "—"}ms · 操作人 {row.operatorUserId ?? "system"}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <div className="text-[var(--muted-foreground)] mb-1">请求 (已脱敏)</div>
                  <pre className="bg-[var(--muted)] rounded p-2 overflow-auto max-h-64 whitespace-pre-wrap break-all">
                    {JSON.stringify(row.reqBody, null, 2)}
                  </pre>
                </div>
                <div>
                  <div className="text-[var(--muted-foreground)] mb-1">
                    响应 (已脱敏，业务码 {row.respCode ?? "—"})
                  </div>
                  <pre className="bg-[var(--muted)] rounded p-2 overflow-auto max-h-64 whitespace-pre-wrap break-all">
                    {JSON.stringify(row.respBody, null, 2)}
                  </pre>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        {logs.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center text-sm text-[var(--muted-foreground)]">暂无日志</CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
