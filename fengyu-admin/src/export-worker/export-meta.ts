import { fmtDateTime } from '@/lib/datetime'
import type { ExportMetaEntry } from './xlsx-writer'

/**
 * 导出件元信息收尾（#368 / #296）：业务元信息（时间区间、scope 类型与名称、基期区间）
 * 由各 view 的 ExportContent 给出，导出时间与导出人由 worker 统一追加 —— 这两项只有
 * worker 手里的任务记录和会话快照才可信，不让各 view 各写一遍。
 *
 * content 没给 meta（旧导出类型）→ 返回 undefined，不生成「导出说明」sheet，旧导出件不变。
 * 导出时间取任务创建时刻（用户点「导出」的那一刻），不是排队后真正生成的时刻。
 */
export function completeExportMeta(
  meta: ExportMetaEntry[] | undefined,
  audit: { requestedAt: Date; exporterName: string | null | undefined },
): ExportMetaEntry[] | undefined {
  if (!meta) return undefined
  return [
    ...meta,
    { label: '导出时间', value: fmtDateTime(audit.requestedAt) },
    { label: '导出人', value: audit.exporterName?.trim() || '—' },
  ]
}
