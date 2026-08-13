import Link from 'next/link'
import { AlertTriangle, CheckCircle2, CircleAlert, RefreshCw } from 'lucide-react'
import { getLakalaDiagnostics, type LakalaDiagnosticStatus } from '@/actions/lakala-diagnostics'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn, formatDateTime } from '@/lib/utils'

export const dynamic = 'force-dynamic'

function StatusIcon({ status }: { status: LakalaDiagnosticStatus }) {
  if (status === 'ok') return <CheckCircle2 className="size-4 text-[#3D8A5A]" />
  if (status === 'warn') return <AlertTriangle className="size-4 text-[#D4820A]" />
  return <CircleAlert className="size-4 text-[#D94040]" />
}

function StatusBadge({ status }: { status: LakalaDiagnosticStatus }) {
  return (
    <Badge variant="outline" className={cn(
      status === 'ok' && 'border-[#3D8A5A] bg-[#F0F9F2] text-[#287342]',
      status === 'warn' && 'border-[#D4820A] bg-[#FFF8E6] text-[#A45D00]',
      status === 'error' && 'border-[#F3B8B2] bg-[#FFF8F7] text-[#D94040]',
    )}>
      {status === 'ok' ? '通过' : status === 'warn' ? '需确认' : '未通过'}
    </Badge>
  )
}

export default async function LakalaDiagnosticsPage() {
  const diagnostics = await getLakalaDiagnostics()
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">拉卡拉入网自检</h1>
            <StatusBadge status={diagnostics.summary} />
          </div>
          <p className="mt-1 text-sm text-[#666666]">只检查配置、数据库和私有目录，不提交申请、不展示密钥。</p>
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
                    <p className="text-sm font-medium">{item.label}</p>
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
    </div>
  )
}
