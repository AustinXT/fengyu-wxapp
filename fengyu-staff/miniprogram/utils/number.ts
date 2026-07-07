






function isInvalid(value: number | null | undefined): boolean {
  return value == null || !Number.isFinite(value)
}


export function formatAmount(value: number | null | undefined): string {
  if (isInvalid(value)) return '--'
  return (value as number).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}


export function formatCount(value: number | null | undefined): string {
  if (isInvalid(value)) return '--'
  return Math.round(value as number).toLocaleString('en-US')
}


export function formatPercent(value: number | null | undefined): string {
  if (isInvalid(value)) return '--'
  return ((value as number) * 100).toFixed(2) + '%'
}
