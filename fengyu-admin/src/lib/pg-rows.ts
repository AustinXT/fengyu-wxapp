
export function rowsAffected(res: unknown): number {
  const r = res as { count?: number | null; rowCount?: number | null } | null
  return r?.count ?? r?.rowCount ?? 0
}
