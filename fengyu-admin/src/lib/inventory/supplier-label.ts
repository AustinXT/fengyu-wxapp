export function supplierDisplayName(name: string, marketName: string | null): string {
  return marketName ? `${name}（${marketName}）` : `${name}（供应链共有）`
}
