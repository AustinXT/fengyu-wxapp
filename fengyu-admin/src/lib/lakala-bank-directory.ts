import 'server-only'

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { LakalaBankOption } from './lakala-onboarding'

type LocalBankRow = LakalaBankOption & {
  areaCode: string
  bankNo: string
}

let localBankBranchesCache: LocalBankRow[] | null = null

function normalizeKeyword(value: string): string {
  return value.replace(/\s+/g, '').trim()
}

function keywordTokens(value: string): string[] {
  return value.trim().split(/\s+/).map(normalizeKeyword).filter(Boolean)
}

async function readLocalBankBranches(): Promise<LocalBankRow[]> {
  if (localBankBranchesCache) return localBankBranchesCache
  const candidates = [
    path.join(process.cwd(), 'public', 'data', 'lakala-bank-branches.tsv'),
    path.join(process.cwd(), 'fengyu-admin', 'public', 'data', 'lakala-bank-branches.tsv'),
  ]
  let content = ''
  for (const candidate of candidates) {
    try {
      content = await readFile(candidate, 'utf8')
      break
    } catch {
      // standalone 镜像和 monorepo 本地运行的 cwd 不同，依次尝试两个稳定位置。
    }
  }
  if (!content) return (localBankBranchesCache = [])

  const [, ...lines] = content.split(/\r?\n/)
  localBankBranchesCache = lines.flatMap((line) => {
    if (!line) return []
    const [areaCode, bankNo, branchBankName, branchBankNo, clearNo] = line.split('\t')
    return areaCode && branchBankName && branchBankNo && clearNo
      ? [{ areaCode, bankNo: bankNo || '', branchBankName, branchBankNo, clearNo }]
      : []
  })
  return localBankBranchesCache
}

export async function queryLocalLakalaBanks(input: {
  areaCode: string
  bankName: string
  limit?: number
}): Promise<LakalaBankOption[]> {
  const keyword = normalizeKeyword(input.bankName)
  if (!input.areaCode || keyword.length < 2) return []
  const rows = await readLocalBankBranches()
  return rows
    .flatMap((row) => {
      if (row.areaCode !== input.areaCode) return []
      const name = normalizeKeyword(row.branchBankName)
      if (!name.includes(keyword)) return []
      const score = name === keyword ? 0 : name.startsWith(keyword) ? 1 : name.indexOf(keyword) + 2
      return [{ row, score }]
    })
    .sort((a, b) => a.score - b.score || a.row.branchBankName.length - b.row.branchBankName.length || a.row.branchBankName.localeCompare(b.row.branchBankName, 'zh-Hans-CN'))
    .slice(0, input.limit ?? 80)
    .map(({ row }) => row)
}

export async function queryLocalLakalaBanksByAreaKeywords(input: {
  areaKeywords: string[]
  bankName: string
  limit?: number
}): Promise<LakalaBankOption[]> {
  const keyword = normalizeKeyword(input.bankName)
  const tokens = keywordTokens(input.bankName)
  const areas = input.areaKeywords.map(normalizeKeyword).filter((item) => item.length >= 2)
  if (keyword.length < 2 || !areas.length) return []
  const rows = await readLocalBankBranches()
  return rows
    .flatMap((row) => {
      const name = normalizeKeyword(row.branchBankName)
      if (!(tokens.length ? tokens.every((token) => name.includes(token)) : name.includes(keyword))) return []
      const areaIndex = areas.findIndex((area) => name.includes(area))
      if (areaIndex < 0) return []
      const score = areaIndex * 10 + (name === keyword ? 0 : name.startsWith(keyword) ? 1 : Math.max(name.indexOf(keyword), 0) + 2)
      return [{ row, score }]
    })
    .sort((a, b) => a.score - b.score || a.row.branchBankName.length - b.row.branchBankName.length || a.row.branchBankName.localeCompare(b.row.branchBankName, 'zh-Hans-CN'))
    .slice(0, input.limit ?? 80)
    .map(({ row }) => row)
}

export async function findLocalLakalaBankAreaCodes(areaKeywords: string[], limit = 5): Promise<string[]> {
  const areas = areaKeywords.map(normalizeKeyword).filter((item) => item.length >= 2)
  if (!areas.length) return []
  const rows = await readLocalBankBranches()
  const matches = new Map<string, { count: number; score: number }>()
  for (const row of rows) {
    const areaIndex = areas.findIndex((area) => normalizeKeyword(row.branchBankName).includes(area))
    if (areaIndex < 0) continue
    const current = matches.get(row.areaCode) ?? { count: 0, score: areaIndex }
    matches.set(row.areaCode, { count: current.count + 1, score: Math.min(current.score, areaIndex) })
  }
  return [...matches.entries()]
    .sort((a, b) => a[1].score - b[1].score || b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([areaCode]) => areaCode)
}
