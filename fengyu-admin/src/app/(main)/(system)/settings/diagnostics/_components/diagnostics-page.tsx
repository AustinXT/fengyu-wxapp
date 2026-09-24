'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Clock3,
  DatabaseBackup,
  HardDrive,
  RefreshCw,
} from 'lucide-react'
import { toast } from 'sonner'
import { getLakalaDiagnostics, type LakalaDiagnostics, type LakalaDiagnosticStatus } from '@/actions/lakala-diagnostics'
import {
  getDatabaseBackupOverview,
  getSystemDiagnostics,
  queueManualDatabaseBackup,
  type BackupOverview,
  type DiagnosticItem,
  type DiagnosticStatus,
  type SystemDiagnostics,
} from '@/actions/system-diagnostics'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { actionErrorMessage } from '@/lib/action-error'
import { cn, formatDateTime } from '@/lib/utils'

type TabValue = 'subsystems' | 'lakala'
type VisibleStatus = DiagnosticStatus | LakalaDiagnosticStatus

const STATUS_LABEL: Record<VisibleStatus, string> = {
  ok: '正常',
  warn: '警告',
  error: '异常',
  disabled: '未启用',
}

function StatusBadge({ status }: { status: VisibleStatus }) {
  return (
    <Badge variant="outline" className={cn(
      status === 'ok' && 'border-[#3D8A5A] bg-[#F0F9F2] text-[#287342]',
      status === 'warn' && 'border-[#D4820A] bg-[#FFF8E6] text-[#A45D00]',
      status === 'error' && 'border-[#F3B8B2] bg-[#FFF8F7] text-[#D94040]',
      status === 'disabled' && 'border-[#D5D5D5] bg-[#F7F7F7] text-[#777777]',
    )}>
      {STATUS_LABEL[status]}
    </Badge>
  )
}

function StatusIcon({ status }: { status: VisibleStatus }) {
  if (status === 'ok') return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[#3D8A5A]" />
  if (status === 'warn') return <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[#D4820A]" />
  if (status === 'disabled') return <Activity className="mt-0.5 size-4 shrink-0 text-[#888888]" />
  return <CircleAlert className="mt-0.5 size-4 shrink-0 text-[#D94040]" />
}

function bytes(value?: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--'
  const units = ['B', 'MiB', 'GiB', 'TiB']
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function DiagnosticRows({ items }: { items: Array<DiagnosticItem | LakalaDiagnostics['items'][number]> }) {
  return (
    <div className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)]">
      {items.map((item) => (
        <div key={item.key} className="flex flex-wrap items-start justify-between gap-3 p-4">
          <div className="flex min-w-0 items-start gap-2">
            <StatusIcon status={item.status} />
            <div className="min-w-0">
              <p className="text-sm font-medium">{item.label}</p>
              {item.detail && <p className="mt-1 text-xs text-[#777777]">{item.detail}</p>}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <StatusBadge status={item.status} />
            <p className="mt-1 text-xs text-[#666666]">
              {item.value}
              {'latencyMs' in item && item.latencyMs !== undefined ? ` · ${item.latencyMs} ms` : ''}
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}

function BackupCard({
  overview,
  refreshing,
  onRefresh,
  onQueue,
}: {
  overview: BackupOverview
  refreshing: boolean
  onRefresh: () => void
  onQueue: () => void
}) {
  const capacity = overview.capacity
  const stale = capacity ? Date.now() - Date.parse(capacity.checkedAt) > 10 * 60_000 : true
  const blocked = overview.active || !capacity?.sufficient || stale
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base"><DatabaseBackup className="size-4" />PostgreSQL 数据库备份</CardTitle>
          <CardDescription className="mt-1">定时备份{overview.schedule}，保留 {overview.scheduledRetentionDays} 天；手动备份保留 {overview.manualRetentionDays} 天。</CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={onRefresh} loading={refreshing}><RefreshCw />刷新</Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {!capacity ? (
          <div className="rounded-[var(--radius)] border border-[#F3B8B2] bg-[#FFF8F7] p-3 text-sm text-[#D94040]">
            备份 Worker 尚未上报磁盘容量，手动备份已禁用。
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-[var(--radius)] bg-[#F7F7F7] p-3"><p className="text-xs text-[#777777]">磁盘剩余</p><p className="mt-1 font-semibold">{bytes(capacity.freeBytes)}</p></div>
              <div className="rounded-[var(--radius)] bg-[#F7F7F7] p-3"><p className="text-xs text-[#777777]">磁盘总量</p><p className="mt-1 font-semibold">{bytes(capacity.totalBytes)}</p></div>
              <div className="rounded-[var(--radius)] bg-[#F7F7F7] p-3"><p className="text-xs text-[#777777]">数据库大小</p><p className="mt-1 font-semibold">{bytes(capacity.databaseBytes)}</p></div>
              <div className="rounded-[var(--radius)] bg-[#F7F7F7] p-3"><p className="text-xs text-[#777777]">本次预留</p><p className="mt-1 font-semibold">{bytes(capacity.estimatedRequiredBytes)}</p></div>
            </div>
            {(capacity.warning || !capacity.sufficient || stale) && (
              <div className={cn(
                'flex items-start gap-2 rounded-[var(--radius)] border p-3 text-sm',
                !capacity.sufficient ? 'border-[#F3B8B2] bg-[#FFF8F7] text-[#D94040]' : 'border-[#E8C77A] bg-[#FFF8E6] text-[#8A5700]',
              )}>
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  {!capacity.sufficient
                    ? '磁盘剩余空间低于本次备份预留值，已禁止执行。'
                    : stale ? '容量数据已超过 10 分钟，请刷新并等待 Worker 重新上报。'
                      : '扣除备份预留后磁盘剩余低于 10%，请尽快扩容或清理。'}
                </span>
              </div>
            )}
          </>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-[#777777]">
            {capacity ? `容量检查：${formatDateTime(capacity.checkedAt)}` : '容量检查：--'}
          </p>
          <Button onClick={onQueue} disabled={blocked}><HardDrive />{overview.active ? '备份任务进行中' : '立即手动备份'}</Button>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">最近备份记录</p>
          {overview.statuses.length === 0 ? (
            <p className="rounded-[var(--radius)] border border-dashed p-4 text-center text-sm text-[#888888]">暂无备份记录</p>
          ) : (
            <div className="divide-y divide-[var(--border)] rounded-[var(--radius)] border">
              {overview.statuses.map((status) => (
                <div key={status.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <div>
                    <p className="font-medium">{status.kind === 'manual' ? '手动备份' : '定时备份'} · {formatDateTime(status.createdAt)}</p>
                    <p className="mt-1 text-xs text-[#777777]">{status.message || '--'}{status.sizeBytes ? ` · ${bytes(status.sizeBytes)}` : ''}</p>
                  </div>
                  <StatusBadge status={status.state === 'succeeded' ? 'ok' : status.state === 'failed' ? 'error' : 'warn'} />
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export function DiagnosticsPage({
  initialTab,
  initialSystem,
  initialBackups,
  initialLakala,
}: {
  initialTab: TabValue
  initialSystem: SystemDiagnostics
  initialBackups: BackupOverview
  initialLakala: LakalaDiagnostics
}) {
  const router = useRouter()
  const [tab, setTab] = useState<TabValue>(initialTab)
  const [system, setSystem] = useState(initialSystem)
  const [backups, setBackups] = useState(initialBackups)
  const [lakala, setLakala] = useState(initialLakala)
  const [confirmBackup, setConfirmBackup] = useState(false)
  const [refreshing, startRefresh] = useTransition()
  const [queueing, startQueue] = useTransition()

  const refreshBackups = useCallback(() => {
    startRefresh(async () => {
      try {
        setBackups(await getDatabaseBackupOverview())
      } catch (error) {
        toast.error(actionErrorMessage(error, '刷新备份状态失败'))
      }
    })
  }, [])

  useEffect(() => {
    if (!backups.active) return
    const timer = window.setInterval(() => {
      getDatabaseBackupOverview().then(setBackups).catch(() => undefined)
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [backups.active])

  function changeTab(value: string) {
    const next = value === 'lakala' ? 'lakala' : 'subsystems'
    setTab(next)
    router.replace(next === 'lakala' ? '/settings/diagnostics?tab=lakala' : '/settings/diagnostics', { scroll: false })
  }

  function refreshCurrent() {
    startRefresh(async () => {
      try {
        if (tab === 'lakala') setLakala(await getLakalaDiagnostics())
        else {
          const [nextSystem, nextBackups] = await Promise.all([getSystemDiagnostics(), getDatabaseBackupOverview()])
          setSystem(nextSystem)
          setBackups(nextBackups)
        }
        toast.success('自检结果已刷新')
      } catch (error) {
        toast.error(actionErrorMessage(error, '系统自检失败，请稍后重试'))
      }
    })
  }

  function queueBackup() {
    startQueue(async () => {
      try {
        const result = await queueManualDatabaseBackup()
        toast.success(result.message)
        setConfirmBackup(false)
        setBackups(await getDatabaseBackupOverview())
      } catch (error) {
        toast.error(actionErrorMessage(error, '创建备份任务失败'))
      }
    })
  }

  const groups: Array<{ key: DiagnosticItem['group']; title: string; description: string }> = [
    { key: 'core', title: '核心服务', description: '管理后台、数据库与常驻 Worker' },
    { key: 'cloud', title: 'CloudBase 服务', description: '已部署云函数与对象存储' },
    { key: 'external', title: '外部依赖', description: '只读连接或非计费网关可达性检查' },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><h1 className="text-2xl font-bold">系统自检</h1><StatusBadge status={tab === 'lakala' ? lakala.summary : system.summary} /></div>
          <p className="mt-1 text-sm text-[#666666]">只读检查系统依赖，敏感凭据与服务器路径不会展示。</p>
        </div>
        <Button onClick={refreshCurrent} loading={refreshing}><RefreshCw />重新检测</Button>
      </div>

      <Tabs value={tab} onValueChange={changeTab}>
        <TabsList>
          <TabsTrigger value="subsystems">子系统自检</TabsTrigger>
          <TabsTrigger value="lakala">拉卡拉自检</TabsTrigger>
        </TabsList>
        <TabsContent value="subsystems" className="space-y-4">
          <div className="flex items-center gap-2 text-xs text-[#777777]"><Clock3 className="size-3.5" />检测时间：{formatDateTime(system.generatedAt)}</div>
          {groups.map((group) => (
            <Card key={group.key}>
              <CardHeader><CardTitle className="text-base">{group.title}</CardTitle><CardDescription>{group.description}</CardDescription></CardHeader>
              <CardContent><DiagnosticRows items={system.items.filter((item) => item.group === group.key)} /></CardContent>
            </Card>
          ))}
          <BackupCard overview={backups} refreshing={refreshing} onRefresh={refreshBackups} onQueue={() => setConfirmBackup(true)} />
        </TabsContent>
        <TabsContent value="lakala" className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">拉卡拉收款与入网配置</CardTitle><CardDescription>仅检查配置、数据库表和私有附件目录，不提交入网申请。</CardDescription></CardHeader>
            <CardContent className="space-y-3"><p className="text-xs text-[#777777]">检测时间：{formatDateTime(lakala.generatedAt)}</p><DiagnosticRows items={lakala.items} /></CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <AlertDialog open={confirmBackup} onOpenChange={setConfirmBackup}>
        <AlertDialogTitle>确认创建手动备份？</AlertDialogTitle>
        <AlertDialogDescription>
          系统将再次检查磁盘空间，然后异步生成 PostgreSQL 备份并做完整性校验。备份文件保留 {backups.manualRetentionDays} 天，不提供页面下载。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setConfirmBackup(false)} disabled={queueing}>取消</AlertDialogCancel>
          <AlertDialogAction onClick={queueBackup} disabled={queueing}>{queueing ? '正在创建…' : '确认备份'}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>
    </div>
  )
}
