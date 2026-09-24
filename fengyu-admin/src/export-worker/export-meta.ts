import { fmtDateTime } from '@/lib/datetime'
import type { ExportMetaEntry } from './xlsx-writer'

/**
 * 各 view 必须给出的业务元信息（#368 / #296）。做成必填字段而不是自由数组：
 * 少写了时间区间或范围，编译期就过不去，导出件落到线下才能自证「哪个范围、哪段时间、跟谁比」。
 */
export interface ExportContextMeta {
  /** 时间区间，如「2026-09-01 ~ 2026-09-30」；仅范围型页面（剩余卡项）没有期间，显式传 null。空白串视为缺失，直接抛错 */
  period: string | null
  /** scope 类型与名称，如「市场 · 南昌凤御」「全部」 */
  scope: string
  /** 含环比列时的基期区间 */
  basePeriod?: string
  /** 其它筛选条件（如搜索词、等级），按顺序追加在后面 */
  extra?: ExportMetaEntry[]
}

function required(label: string, value: string | null | undefined): string {
  // 类型上是必填，但 view 漏传时运行时仍可能是 undefined：同样落到 INVALID_STATE，而不是一个无前缀的 TypeError
  const trimmed = (value ?? '').trim()
  // 元信息是导出件自证口径的唯一依据：空白的「时间区间 / 范围」看似字段齐全实则无法追溯，宁可让任务失败
  if (!trimmed) throw new Error(`INVALID_STATE: 导出元信息缺少${label}`)
  return trimmed
}

/**
 * 元信息收尾：业务元信息由各 view 的 ExportContent 给出，导出时间与导出人由 worker 统一追加 ——
 * 这两项只有 worker 手里的任务记录和会话快照才可信，不让各 view 各写一遍。
 *
 * content 没给 meta（旧导出类型）→ 返回 undefined，不生成「导出说明」sheet，旧导出件不变。
 *
 * 导出时间取**文件生成时刻**（数据就是在这一刻读取的），不取任务的 created_at：
 * 手工「重新导出」是原地把同一行任务改回 queued（actions/export-jobs.ts retryMyExportJob），
 * created_at 不变，拿它当时间会让 9-25 重读的数据标着 9-01。
 */
export function completeExportMeta(
  meta: ExportContextMeta | undefined,
  audit: { generatedAt: Date; exporterName: string | null | undefined },
): ExportMetaEntry[] | undefined {
  if (!meta) return undefined
  const basePeriod = meta.basePeriod?.trim()
  return [
    { label: '时间区间', value: meta.period === null ? '不限（仅按范围）' : required('时间区间', meta.period) },
    { label: '范围', value: required('范围', meta.scope) },
    ...(basePeriod ? [{ label: '基期区间', value: basePeriod }] : []),
    ...(meta.extra ?? []),
    { label: '导出时间', value: fmtDateTime(audit.generatedAt) || '—' },
    { label: '导出人', value: audit.exporterName?.trim() || '—' },
  ]
}
