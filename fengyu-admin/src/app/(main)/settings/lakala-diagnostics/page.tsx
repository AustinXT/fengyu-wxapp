import Link from "next/link";
import { AlertTriangle, CheckCircle2, CircleAlert, RefreshCw } from "lucide-react";
import { getLakalaDiagnostics, type LakalaDiagnosticStatus } from "@/actions/lakala-diagnostics";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

function StatusIcon({ status }: { status: LakalaDiagnosticStatus }) {
  if (status === "ok") return <CheckCircle2 className="size-4 text-[#3D8A5A]" />;
  if (status === "warn") return <AlertTriangle className="size-4 text-[#D4820A]" />;
  return <CircleAlert className="size-4 text-[#D94040]" />;
}

function StatusBadge({ status }: { status: LakalaDiagnosticStatus }) {
  const text = status === "ok" ? "通过" : status === "warn" ? "需确认" : "未通过";
  return (
    <Badge
      variant="outline"
      className={cn(
        status === "ok" && "border-[#3D8A5A] bg-[#F0F9F2] text-[#287342]",
        status === "warn" && "border-[#D4820A] bg-[#FFF8E6] text-[#A45D00]",
        status === "error" && "border-[#F3B8B2] bg-[#FFF8F7] text-[#D94040]",
      )}
    >
      {text}
    </Badge>
  );
}

export default async function LakalaDiagnosticsPage() {
  const diagnostics = await getLakalaDiagnostics();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-[var(--foreground)]">拉卡拉联调自检</h1>
            <StatusBadge status={diagnostics.summary} />
          </div>
          <p className="mt-1 text-sm text-[#666666]">
            只检查后台门店入网实际使用的环境和连通性，不提交入网申请、不展示秘钥。
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/settings"><Button variant="outline">返回系统配置</Button></Link>
          <Link href="/settings/lakala-diagnostics"><Button><RefreshCw />重新检测</Button></Link>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">检测结果</CardTitle>
          <p className="text-xs text-[#999999]">检测时间：{formatDateTime(diagnostics.generatedAt)}</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {diagnostics.items.map((item) => (
            <div key={item.key} className="rounded-[var(--radius)] border border-[var(--border)] bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-2">
                  <StatusIcon status={item.status} />
                  <div>
                    <p className="text-sm font-medium text-[var(--foreground)]">{item.label}</p>
                    {item.detail && <p className="mt-1 text-xs text-[#999999]">{item.detail}</p>}
                  </div>
                </div>
                <div className="text-right">
                  <StatusBadge status={item.status} />
                  <p className="mt-1 font-mono text-xs text-[#666666]">{item.value}</p>
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="border-[#F6D8A8] bg-[#FFFCF5]">
        <CardContent className="p-4 text-sm text-[#8B6B32]">
          建议联调时保持 <span className="font-mono">LAKALA_ONBOARDING_CLIENT_MODE=real</span> 且{" "}
          <span className="font-mono">LAKALA_ONBOARDING_ENV=test</span>。后台入网只读取{" "}
          <span className="font-mono">LAKALA_ONBOARDING_*</span> 专用配置；缺配置会自检失败，不会回退使用支付配置。
        </CardContent>
      </Card>
    </div>
  );
}
