

import type { MetricUnit } from './types'


export function metricCell(value: number | null | undefined, unit: MetricUnit): number | '' {
  if (value == null || !Number.isFinite(value)) return ''
  if (unit === 'amount') return Math.round(value * 100) / 100
  if (unit === 'percent') return Math.round(value * 10000) / 100 
  return Math.round(value) 
}


export function headerWithUnit(label: string, unit: MetricUnit): string {
  return unit === 'percent' ? `${label}(%)` : label
}
