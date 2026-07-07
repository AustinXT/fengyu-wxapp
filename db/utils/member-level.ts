

export type MemberLevel = '初钻' | '星钻' | '粉钻' | '金钻' | '黑钻'


export const LEVEL_RANK: Record<string, number> = {
  null: 0,
  '初钻': 1,
  '星钻': 2,
  '粉钻': 3,
  '金钻': 4,
  '黑钻': 5,
}

function rank(level: string | null | undefined): number {
  if (!level) return 0
  return LEVEL_RANK[level] ?? 0
}


export function determineMemberLevel(spend: number, threshold: number): MemberLevel | null {
  if (spend >= 100000) return '黑钻'
  if (spend >= 60000) return '金钻'
  if (spend >= 30000) return '粉钻'
  if (spend >= 10000) return '星钻'
  if (spend >= threshold) return '初钻'
  return null
}

export function isUpgrade(from: string | null | undefined, to: string | null | undefined): boolean {
  return rank(to) > rank(from)
}

export function isDowngrade(from: string | null | undefined, to: string | null | undefined): boolean {
  return rank(to) < rank(from)
}
