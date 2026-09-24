import { fmtDateTime } from '@/lib/datetime'
import type { ExportMetaEntry } from './xlsx-writer'

/**
 * 各 view 必须给出的业务元信息（#368 / #296）。做成必填字段而不是自由数组：
 * 少写了时间区间或范围，编译期就过不去，导出件落到线下才能自证「哪个范围、哪段时间、跟谁比」。
 */
export interface ExportContextMeta {
  /** 时间区间，如「2026-09-01 ~ 2026-09-30」；仅范围型页面（剩余卡项）没有期间，显式传 null */
  period: string | null
  /** scope 类型与名称，如「市场 · 南昌凤御」「全部」 */
  scope: string
  /** 含环比列时的基期区间 */
  basePeriod?: string
  /** 其它筛选条件（如搜索词、等级），按顺序追加在后面 */
  extra?: ExportMetaEntry[]
}

/**
 * 元信息收尾：业务元信息由各 view 的 ExportContent 给出，导出时间与导出人由 worker 统一追加 ——
 * 这两项只有 worker 手里的任务记录和会话快照才可信，不让各 view 各写一遍。
 *
 * content 没给 meta（旧导出类型）→ 返回 undefined，不生成「导出说明」sheet，旧导出件不变。
 * 导出时间取任务创建时刻（用户点「导出」的那一刻），不是排队后真正生成的时刻。
 */
export function completeExportMeta(
  meta: ExportContextMeta | undefined,
  audit: { requestedAt: Date; exporterName: string | null | undefined },
): ExportMetaEntry[] | undefined {
  if (!meta) return undefined
  return [
    { label: '时间区间', value: meta.period ?? '不限（仅按范围）' },
    { label: '范围', value: meta.scope.trim() || '—' },
    ...(meta.basePeriod ? [{ label: '基期区间', value: meta.basePeriod }] : []),
    ...(meta.extra ?? []),
    { label: '导出时间（申请时刻）', value: fmtDateTime(audit.requestedAt) || '—' },
    { label: '导出人', value: audit.exporterName?.trim() || '—' },
  ]
}
